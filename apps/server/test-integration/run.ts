import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = Number(process.env.WINDS_TEST_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

type Msg = { type: string; [k: string]: any };

class Client {
  ws!: WebSocket;
  msgs: Msg[] = [];
  closed = false;
  closeCode = 0;
  noPing = false;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private waiters: { pred: (m: Msg) => boolean; res: (m: Msg) => void }[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** min ms between sends; commanders pace themselves under the 5/s limit */
  constructor(public name: string, private gapMs = 0) {}
  async connect(code: string): Promise<this> {
    this.ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
    });
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      if (this.pinger) clearInterval(this.pinger);
    });
    // Real clients ping every 15s; the server treats a silent commander as half-open after 25s.
    if (!this.noPing) {
      this.pinger = setInterval(() => {
        if (this.ws.readyState === 1) this.ws.send('{"v":1,"type":"ping"}');
      }, 10_000);
    }
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    return this;
  }
  send(m: object) {
    const data = JSON.stringify({ v: 1, ...m });
    this.chain = this.chain
      .then(() => (this.gapMs ? new Promise<void>((r) => setTimeout(r, this.gapMs)) : undefined))
      .then(() => this.ws.send(data));
  }
  /** Resolves with an already-received or future message matching pred. */
  waitFor(pred: (m: Msg) => boolean, ms = 5000, from = 0): Promise<Msg> {
    const found = this.msgs.slice(from).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timeout waiting; got ${JSON.stringify(this.msgs.map((m) => m.type))}`)), ms);
      this.waiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
    });
  }
  type(t: string, ms?: number) {
    return this.waitFor((m) => m.type === t, ms);
  }
  event(kind: string, afterIdx = 0, ms?: number) {
    return this.waitFor((m) => m.type === 'event' && m.kind === kind, ms, afterIdx);
  }
  ack(id: string) {
    return this.waitFor((m) => m.type === 'ack' && m.clientCmdId === id);
  }
  waitClosed(ms = 5000) {
    return new Promise<void>((res, rej) => {
      if (this.closed) return res();
      const t = setTimeout(() => rej(new Error(`${this.name}: not closed`)), ms);
      this.ws.once('close', () => (clearTimeout(t), res()));
    });
  }
  mark() {
    return this.msgs.length;
  }
  close() {
    if (this.pinger) clearInterval(this.pinger);
    this.ws.close();
  }
}

let passed = 0;
function check(cond: unknown, label: string) {
  if (!cond) throw new Error(`FAILED: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

async function api(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, init);
}

async function startWrangler(port = PORT, extraArgs: string[] = []): Promise<ChildProcess> {
  const base = `http://127.0.0.1:${port}`;
  const persist = mkdtempSync(join(tmpdir(), 'winds-wrangler-'));
  const child = spawn(
    join(root, 'node_modules/.bin/wrangler'),
    ['dev', '--port', String(port), '--inspector-port', String(9339 + port - 8799), '--local', '--persist-to', persist, ...extraArgs],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('wrangler exited early:\n' + log);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killWrangler(child);
  throw new Error('wrangler did not become healthy:\n' + log);
}

function killWrangler(child: ChildProcess) {
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

let n = 0;
const cid = () => `cmd-${++n}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  const child = await startWrangler();
  const clients: Client[] = [];
  const mk = (name: string, gap = 0) => {
    const c = new Client(name, gap);
    clients.push(c);
    return c;
  };
  try {
    console.log('health / create');
    const h = (await (await api('/api/health')).json()) as any;
    check(h.ok === true, 'GET /api/health');
    const bad = await api('/api/rooms', { method: 'POST', body: '{"parties":[]}' });
    check(bad.status === 400, 'invalid create request -> 400');
    const created = await api('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parties: [{ name: '돌격' }, { name: '수비' }, {}] }),
    });
    check(created.status === 201 && created.headers.get('vary') === 'Origin', 'create room 201 + Vary: Origin');
    const { code, commanderToken, operatorToken, subCommanderToken } = (await created.json()) as any;
    check(/^[A-HJKMNP-Z2-9]{6}$/.test(code), `room code ${code}`);
    const info = await api(`/api/rooms/${code.toLowerCase()}`);
    const infoJson = (await info.json()) as any;
    check(info.status === 200 && infoJson.parties.length === 3 && infoJson.status === 'OPEN', 'GET room (lowercase code) 200');
    check((await api('/api/rooms/ZZZZZZ')).status === 404, 'unknown room 404');

    console.log('connect');
    const cmd = await mk('cmd', 250).connect(code);
    cmd.send({ type: 'hello', roomCode: code, clientId: 'cmdr', role: 'COMMANDER', commanderToken });
    const welcome = await cmd.type('welcome');
    check(welcome.role === 'COMMANDER' && welcome.snapshot.parties.length === 3, 'commander welcome with snapshot');
    const [p1, p2, p3] = welcome.snapshot.parties.map((p: any) => p.id) as string[];

    const members: Client[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await mk(`m${i}`).connect(code);
      m.send({ type: 'hello', roomCode: code.toLowerCase(), clientId: `member-${i}`, role: 'MEMBER' });
      const w = await m.type('welcome');
      check(w.role === 'MEMBER', `member ${i} welcome`);
      m.send({ type: 'party.select', partyId: [p1, p2, p3][i] });
      members.push(m);
    }
    const pres = await cmd.waitFor((m) => m.type === 'presence' && m.total === 3 && m.unassigned === 0);
    check(pres.byParty[p1!] === 1 && pres.commanderOnline === true, 'presence arrives with per-party counts');

    console.log('stt relay / status');
    cmd.send({ type: 'stt.status', state: 'LISTENING' });
    await cmd.waitFor((m) => m.type === 'presence' && m.sttState === 'LISTENING', 6000);
    check(true, 'stt.status reflected in presence');

    console.log('issue / repeat');
    const marks = members.map((m) => m.mark());
    const issueId = cid();
    cmd.send({ type: 'command.issue', clientCmdId: issueId, target: { kind: 'ALL' }, action: 'GATHER', location: { id: 'CENTER', label: '중앙' }, source: 'VOICE', transcript: '전체 중앙 집결' });
    const ack1 = await cmd.ack(issueId);
    check(!!ack1.commandId && !ack1.error, 'issue ack with commandId');
    const evs = await Promise.all(members.map((m, i) => m.event('command.issued', marks[i])));
    check(evs.every((e) => e.seq === evs[0]!.seq), 'all members receive same seq');
    check(evs.every((e) => e.payload.command.transcript === undefined), 'member events have transcript stripped');
    const cmdEv = await cmd.event('command.issued');
    check(cmdEv.payload.command.transcript === '전체 중앙 집결', 'commander event keeps transcript');
    const c1 = ack1.commandId as string;

    const rep = cid();
    const mk0 = members[0]!.mark();
    cmd.send({ type: 'command.issue', clientCmdId: rep, target: { kind: 'ALL' }, action: 'GATHER', location: { id: 'CENTER', label: '중앙' }, source: 'VOICE' });
    const rev = await members[0]!.event('command.repeated', mk0);
    check(rev.payload.commandId === c1 && rev.payload.repeatCount === 1, 'repeat -> command.repeated');
    check((await cmd.ack(rep)).note === 'REPEATED', 'repeat ack note REPEATED');

    console.log('correct / cancel');
    const c2id = cid();
    cmd.send({ type: 'command.issue', clientCmdId: c2id, target: { kind: 'PARTIES', partyIds: [p3] }, action: 'DEFEND', source: 'MANUAL' });
    const c2 = (await cmd.ack(c2id)).commandId as string;
    const corrId = cid();
    const mk1 = members[2]!.mark();
    cmd.send({ type: 'command.correct', clientCmdId: corrId, correctsId: c2, action: 'ATTACK', source: 'MANUAL' });
    const corr = await members[2]!.event('command.corrected', mk1);
    check(corr.payload.correctedId === c2 && corr.payload.command.action === 'ATTACK', 'correct -> command.corrected');
    const c2b = corr.payload.command.id as string;
    check(corr.payload.slots[p3!].at(-1) === c2b, 'corrected command takes slot');

    const cancId = cid();
    const mk2 = members[2]!.mark();
    cmd.send({ type: 'command.cancel', clientCmdId: cancId, commandId: c2b });
    const canc = await members[2]!.event('command.cancelled', mk2);
    check(canc.payload.reason === 'CHANGED', 'cancel event received (MANUAL -> auto reason CHANGED)');
    check(canc.payload.slots[p3!].at(-1) === c1, 'cancel restores previous command (ALL) for party 3');

    console.log('parties.update');
    const snapNow = await (async () => {
      const m = await mk('probe').connect(code);
      m.send({ type: 'hello', roomCode: code, clientId: 'probe', role: 'MEMBER' });
      const w = await m.type('welcome');
      m.close();
      return w.snapshot;
    })();
    const base = snapNow.partyConfigVersion as number;
    const partiesNow = snapNow.parties as any[];
    const upd = cid();
    const mk3 = members[0]!.mark();
    cmd.send({
      type: 'parties.update', clientCmdId: upd, baseVersion: base,
      parties: [{ ...partiesNow[2], name: '선봉' }, partiesNow[0], { id: 'pNew', number: 9, aliases: [], color: 'p9' }],
    });
    const pu = await members[0]!.event('parties.updated', mk3);
    check(pu.payload.partyConfigVersion === base + 1, 'parties.updated bumps version');
    check(pu.payload.parties.map((p: any) => p.number).join() === '1,2,3' && pu.payload.parties[0].name === '선봉', 'rename/reorder renumbered');
    check(Object.keys(pu.payload.slots).join() === `${p3},${p1},pNew` || Object.keys(pu.payload.slots).length === 3, 'slots follow new parties (p2 removed, pNew added)');
    check(pu.payload.slots.pNew.length === 0, 'new party has empty stack');
    const stale = cid();
    cmd.send({ type: 'parties.update', clientCmdId: stale, baseVersion: base, parties: partiesNow });
    check((await cmd.ack(stale)).error === 'VERSION_CONFLICT', 'stale baseVersion -> VERSION_CONFLICT');

    console.log('rate limit');
    const rl = members[2]!;
    const rlMark = rl.mark();
    for (let i = 0; i < 12; i++) rl.send({ type: 'party.select', partyId: null });
    await rl.waitFor((m) => m.type === 'error' && m.code === 'RATE_LIMITED', 5000, rlMark);
    check(true, 'member burst -> RATE_LIMITED');
    rl.send({ type: 'party.select', partyId: p3 });
    await new Promise((r) => setTimeout(r, 1200));

    console.log('forbidden / unauthorized / duplicate');
    const mkF = members[1]!.mark();
    members[1]!.send({ type: 'command.issue', clientCmdId: cid(), target: { kind: 'ALL' }, action: 'MOVE', source: 'MANUAL' });
    const fb = await members[1]!.waitFor((m) => m.type === 'ack' && m.error === 'FORBIDDEN');
    check(!!fb.clientCmdId, 'member command.issue -> ack {clientCmdId, error: FORBIDDEN}');
    const fb2 = cid();
    members[1]!.send({ type: 'parties.update', clientCmdId: fb2, baseVersion: 1, parties: partiesNow });
    check((await members[1]!.ack(fb2)).error === 'FORBIDDEN', 'member parties.update -> ack FORBIDDEN');
    members[1]!.send({ type: 'stt.status', state: 'LISTENING' });
    await members[1]!.waitFor((m) => m.type === 'error' && m.code === 'FORBIDDEN', 5000, mkF);
    check(true, 'request without clientCmdId still gets error');
    const bogus = await mk('bogus').connect(code);
    bogus.send({ type: 'hello', roomCode: code, clientId: 'x', role: 'COMMANDER', commanderToken: 'wrong' });
    check((await bogus.type('error')).code === 'UNAUTHORIZED', 'wrong commander token -> UNAUTHORIZED');
    await bogus.waitClosed();
    check(true, 'unauthorized connection closed');
    const first = await mk('first').connect(code);
    first.send({ type: 'party.select', partyId: null });
    check((await first.type('error')).code === 'INVALID_MESSAGE', 'first message not hello -> INVALID_MESSAGE');
    await first.waitClosed();

    const dup = cid();
    const mkd = members[0]!.mark();
    const issueMsg = { type: 'command.issue', clientCmdId: dup, target: { kind: 'PARTIES', partyIds: [p1] }, action: 'HOLD', source: 'MANUAL' };
    cmd.send(issueMsg);
    const a1 = await cmd.ack(dup);
    cmd.send(issueMsg);
    await new Promise((r) => setTimeout(r, 400));
    const dupAcks = cmd.msgs.filter((m) => m.type === 'ack' && m.clientCmdId === dup);
    const issuedEvents = members[0]!.msgs.slice(mkd).filter((m) => m.type === 'event' && m.kind === 'command.issued');
    check(dupAcks.length === 2 && dupAcks[1]!.commandId === a1.commandId, 'duplicate clientCmdId gets same ack');
    check(issuedEvents.length === 1, 'duplicate clientCmdId -> single event');

    console.log('operator');
    const op = await mk('op', 250).connect(code);
    op.send({ type: 'hello', roomCode: code, clientId: 'op1', role: 'OPERATOR', operatorToken });
    check((await op.type('welcome')).role === 'OPERATOR', 'operator welcome');
    const opCmd = cid();
    op.send({ type: 'command.issue', clientCmdId: opCmd, target: { kind: 'ALL' }, action: 'RETREAT', source: 'MANUAL' });
    check(!!(await op.ack(opCmd)).commandId, 'operator can issue');
    const opClose = cid();
    op.send({ type: 'room.close', clientCmdId: opClose });
    check((await op.ack(opClose)).error === 'FORBIDDEN', 'operator room.close -> ack FORBIDDEN');
    cmd.send({ type: 'stt.feed', entries: [{ id: 'e1', at: Date.now(), text: '집결', outcome: 'ISSUED' }] });
    const feed = await op.type('stt.feed');
    check(feed.from === 'COMMANDER' && feed.entries.length === 1, 'stt.feed relayed to operator');
    check(!members[0]!.msgs.some((m) => m.type === 'stt.feed'), 'stt.feed not sent to members');
    op.close();

    console.log('sub-commander');
    const noTok = await mk('subNoTok').connect(code);
    noTok.send({ type: 'hello', roomCode: code, clientId: 'sub0', role: 'SUB_COMMANDER' });
    check((await noTok.type('error')).code === 'UNAUTHORIZED', 'sub hello without token -> UNAUTHORIZED');
    const badTok = await mk('subBad').connect(code);
    badTok.send({ type: 'hello', roomCode: code, clientId: 'sub0', role: 'SUB_COMMANDER', subCommanderToken: 'wrong' });
    check((await badTok.type('error')).code === 'UNAUTHORIZED', 'sub hello with wrong token -> UNAUTHORIZED');
    const opTokAsSub = await mk('subOpTok').connect(code);
    opTokAsSub.send({ type: 'hello', roomCode: code, clientId: 'sub0', role: 'SUB_COMMANDER', subCommanderToken: operatorToken });
    check((await opTokAsSub.type('error')).code === 'UNAUTHORIZED', 'operator token cannot open a sub session');
    const sub = await mk('sub', 250).connect(code);
    sub.send({ type: 'hello', roomCode: code, clientId: 'sub1', role: 'SUB_COMMANDER', subCommanderToken });
    check((await sub.type('welcome')).role === 'SUB_COMMANDER', 'sub welcome');
    const subMark = members.map((m) => m.mark());
    const subCmd = cid();
    sub.send({ type: 'command.issue', clientCmdId: subCmd, target: { kind: 'ALL' }, action: 'HOLD', source: 'MANUAL', issuer: { role: 'COMMANDER' } });
    check(!!(await sub.ack(subCmd)).commandId, 'sub can issue');
    const subEv = await members[0]!.event('command.issued', subMark[0]);
    check(subEv.payload.command.issuer?.role === 'SUB_COMMANDER', 'member sees issuer.role SUB_COMMANDER (client issuer ignored)');
    const subSet = cid();
    sub.send({ type: 'room.settings', clientCmdId: subSet, settings: { shareTranscript: true } });
    check((await sub.ack(subSet)).error === 'FORBIDDEN', 'sub room.settings -> FORBIDDEN');
    const subParties = cid();
    sub.send({ type: 'parties.update', clientCmdId: subParties, baseVersion: 1, parties: welcome.snapshot.parties });
    check((await sub.ack(subParties)).error === 'FORBIDDEN', 'sub parties.update -> FORBIDDEN');
    sub.send({ type: 'stt.status', state: 'LISTENING' });
    check((await sub.type('error')).code === 'FORBIDDEN', 'sub stt.status -> FORBIDDEN');
    cmd.send({ type: 'stt.feed', entries: [{ id: 'e2', at: Date.now(), text: '집결', outcome: 'ISSUED' }] });
    check((await sub.type('stt.feed')).from === 'COMMANDER', 'stt.feed relayed to sub');
    const subPres = await cmd.waitFor((m) => m.type === 'presence' && m.subCommandersOnline === 1, 6000);
    check(subPres.subCommandersOnline === 1, 'presence.subCommandersOnline');
    sub.close();

    console.log('reconnect');
    const m0 = members[0]!;
    const lastSeq = m0.msgs.filter((m) => m.type === 'event').at(-1)!.seq as number;
    m0.close();
    await m0.waitClosed();
    cmd.send({ type: 'command.issue', clientCmdId: cid(), target: { kind: 'PARTIES', partyIds: [p3] }, action: 'MOVE', source: 'MANUAL' });
    await new Promise((r) => setTimeout(r, 300));
    const m0b = await mk('m0b').connect(code);
    m0b.send({ type: 'hello', roomCode: code, clientId: 'member-0', role: 'MEMBER', lastSeq });
    const w2 = await m0b.type('welcome');
    check(w2.snapshot.seq > lastSeq, 'reconnect with lastSeq gets fresh snapshot');
    check(Object.keys(w2.snapshot.slots).length === 3 && w2.snapshot.commands.length >= 3, 'snapshot restored (slots+commands)');
    check(w2.snapshot.commands.every((c: any) => c.transcript === undefined), 'snapshot transcripts stripped for member');

    console.log('commander replaced');
    const mkOld = cmd.mark();
    const cmd2 = await mk('cmd2', 250).connect(code);
    cmd2.send({ type: 'hello', roomCode: code, clientId: 'cmdr-tab2', role: 'COMMANDER', commanderToken });
    await cmd2.type('welcome');
    await cmd.waitFor((m) => m.type === 'session.replaced', 5000, mkOld);
    await cmd.waitClosed();
    check(true, 'old commander got session.replaced and was closed');

    console.log('same-browser tabs (clientId shared)');
    const opT = await mk('opT').connect(code);
    opT.send({ type: 'hello', roomCode: code, clientId: 'browser-1', role: 'OPERATOR', operatorToken });
    await opT.type('welcome');
    const memT = await mk('memT').connect(code);
    memT.send({ type: 'hello', roomCode: code, clientId: 'browser-1', role: 'MEMBER' });
    await memT.type('welcome');
    await new Promise((r) => setTimeout(r, 400));
    check(!opT.closed && !memT.closed, 'operator tab and member tab of one browser coexist');
    check(!opT.msgs.some((m) => m.type === 'session.replaced') && !memT.msgs.some((m) => m.type === 'session.replaced'), 'no session.replaced across roles');
    const memT2 = await mk('memT2').connect(code);
    memT2.send({ type: 'hello', roomCode: code, clientId: 'browser-1', role: 'MEMBER' });
    await memT2.type('welcome');
    await memT.type('session.replaced');
    await memT.waitClosed();
    check(!opT.closed && !memT2.closed, 'same clientId + same role: old socket gets session.replaced, new and other-role tabs stay');
    opT.close();
    memT2.close();

    console.log('rate limit -> ack error');
    const opR = await mk('opR').connect(code);
    opR.send({ type: 'hello', roomCode: code, clientId: 'opR', role: 'OPERATOR', operatorToken });
    await opR.type('welcome');
    const burst = Array.from({ length: 14 }, () => cid());
    for (const id of burst) opR.send({ type: 'command.issue', clientCmdId: id, target: { kind: 'ALL' }, action: 'HOLD', source: 'MANUAL' });
    const rlAck = await opR.waitFor((m) => m.type === 'ack' && m.error === 'RATE_LIMITED');
    check(burst.includes(rlAck.clientCmdId), 'rate-limited request -> ack {clientCmdId, error: RATE_LIMITED}');
    opR.close();

    console.log('hello timeout');
    const silent = await mk('silent').connect(code);
    const t0 = Date.now();
    await silent.waitClosed(16_000);
    check(Date.now() - t0 >= 9000, `socket without hello closed after ~10s (${Date.now() - t0}ms)`);

    console.log('room.close');
    const closeMarks = [m0b.mark(), members[1]!.mark(), members[2]!.mark()];
    cmd2.send({ type: 'room.close', clientCmdId: cid() });
    await Promise.all([m0b, members[1]!, members[2]!].map((m, i) => m.waitFor((x) => x.type === 'room.closed', 5000, closeMarks[i])));
    const rc = await members[1]!.type('room.closed');
    check(rc.reason === 'COMMANDER_CLOSED', 'all connections receive room.closed');
    await new Promise((r) => setTimeout(r, 300));
    check((await api(`/api/rooms/${code}`)).status === 404, 'GET room after close -> 404');
    let lateRejected = false;
    try {
      await mk('late').connect(code);
    } catch {
      lateRejected = true;
    }
    check(lateRejected, 'WebSocket upgrade to closed/non-existent room is refused (404)');

    console.log('half-open commander');
    const created2 = await api('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parties: [{}, {}] }),
    });
    const r2 = (await created2.json()) as any;
    const watcher = await mk('watcher').connect(r2.code);
    watcher.send({ type: 'hello', roomCode: r2.code, clientId: 'w', role: 'MEMBER' });
    await watcher.type('welcome');
    const ghost = mk('ghost');
    ghost.noPing = true; // never pings: looks like a dead network path to the server
    await ghost.connect(r2.code);
    ghost.send({ type: 'hello', roomCode: r2.code, clientId: 'g', role: 'COMMANDER', commanderToken: r2.commanderToken });
    await ghost.type('welcome');
    ghost.send({ type: 'stt.status', state: 'LISTENING' });
    await watcher.waitFor((m) => m.type === 'presence' && m.commanderOnline === true && m.sttState === 'LISTENING', 6000);
    const onMark = watcher.mark();
    const off = await watcher.waitFor((m) => m.type === 'presence' && m.commanderOnline === false && m.sttState === 'OFF', 45_000, onMark);
    check(!!off, 'silent commander detected: presence commanderOnline=false, sttState OFF');
    await ghost.waitClosed(5000);
    check(ghost.closeCode === 4009, 'stale commander socket closed (4009)');

    await guardTests();

    console.log(`\nALL PASSED (${passed} checks)`);
  } finally {
    for (const c of clients) try { c.close(); } catch { /* ignore */ }
    killWrangler(child);
  }
}

/** Origin policy and HTTP rate limit, against a second server with strict vars. */
async function guardTests() {
  console.log('dev policy (default vars)');
  const roomBody = JSON.stringify({ parties: [{}, {}] });
  const post = (base: string, origin?: string) =>
    fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: roomBody,
    });
  check((await post(BASE, 'https://evil.example')).status === 403, 'dev: foreign Origin -> 403');
  const lo = await post(BASE, 'http://localhost:5173');
  check(lo.status === 201 && lo.headers.get('access-control-allow-origin') === 'http://localhost:5173', 'dev: loopback Origin allowed, echoed');
  check(lo.headers.get('vary') === 'Origin', 'dev: Vary: Origin');
  check((await post(BASE, BASE)).status === 201, 'dev: same-origin allowed');
  check((await post(BASE)).status === 201, 'dev: no Origin allowed');
  const pre = await fetch(`${BASE}/api/rooms`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  check(pre.status === 204 && pre.headers.get('access-control-allow-methods')?.includes('POST') === true, 'dev: preflight 204');
  check((await fetch(`${BASE}/api/rooms`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status === 403, 'dev: preflight from foreign Origin -> 403');
  check((await fetch(`${BASE}/api/rooms/ABCDEF`, { headers: { origin: 'https://evil.example' } })).status === 403, 'dev: GET room foreign Origin -> 403');
  const wsStatus = (url: string, origin: string) =>
    new Promise<number>((res) => {
      const ws = new WebSocket(url, { headers: { origin } });
      ws.on('unexpected-response', (_q, r) => (res(r.statusCode ?? 0), ws.terminate()));
      ws.on('open', () => (res(101), ws.close()));
      ws.on('error', () => undefined);
    });
  const created = (await (await post(BASE)).json()) as any;
  check((await wsStatus(`${WS_BASE}/api/rooms/${created.code}/ws`, 'https://evil.example')) === 403, 'dev: WebSocket upgrade foreign Origin -> 403');
  check((await wsStatus(`${WS_BASE}/api/rooms/${created.code}/ws`, 'http://localhost:5173')) === 101, 'dev: WebSocket upgrade loopback Origin -> 101');

  console.log('strict vars (ALLOWED_ORIGINS list, HTTP_RATE_LIMIT 2,3)');
  const port2 = PORT + 10;
  const b2 = `http://127.0.0.1:${port2}`;
  const child2 = await startWrangler(port2, ['--var', 'ALLOWED_ORIGINS:https://good.example', '--var', 'HTTP_RATE_LIMIT:2,3']);
  try {
    check((await post(b2, 'http://localhost:5173')).status === 403, 'list: loopback not in list -> 403');
    const ok = await post(b2, 'https://good.example');
    check(ok.status === 201 && ok.headers.get('access-control-allow-origin') === 'https://good.example', 'list: listed Origin allowed');
    const room = (await ok.json()) as any;
    check((await fetch(`${b2}/api/rooms/${room.code}`, { headers: { origin: 'https://good.example' } })).status === 200, 'list: GET room allowed (read 1/3)');
    check((await wsStatus(`ws://127.0.0.1:${port2}/api/rooms/${room.code}/ws`, 'https://evil.example')) === 403, 'list: WebSocket foreign Origin -> 403');
    check((await wsStatus(`ws://127.0.0.1:${port2}/api/rooms/${room.code}/ws`, 'https://good.example')) === 101, 'list: WebSocket listed Origin -> 101 (read 2/3)');
    check((await post(b2)).status === 201, 'rate: create 2/2');
    const over = await post(b2);
    check(over.status === 429 && Number(over.headers.get('retry-after')) >= 1, 'rate: create 3rd -> 429 + Retry-After');
    check((await fetch(`${b2}/api/rooms/${room.code}`)).status === 200, 'rate: read 3/3');
    const over2 = await fetch(`${b2}/api/rooms/${room.code}`);
    check(over2.status === 429, 'rate: GET room 4th -> 429');
    check((await wsStatus(`ws://127.0.0.1:${port2}/api/rooms/${room.code}/ws`, 'https://good.example')) === 429, 'rate: WebSocket upgrade over limit -> 429');
    check((await fetch(`${b2}/api/health`)).status === 200, 'health is not limited');
  } finally {
    killWrangler(child2);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
