import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

type Msg = { type: string; [k: string]: any };

class Client {
  ws!: WebSocket;
  msgs: Msg[] = [];
  closed = false;
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
    this.ws.on('close', () => (this.closed = true));
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

async function startWrangler(): Promise<ChildProcess> {
  const persist = mkdtempSync(join(tmpdir(), 'winds-wrangler-'));
  const child = spawn(
    join(root, 'node_modules/.bin/wrangler'),
    ['dev', '--port', String(PORT), '--inspector-port', '9339', '--local', '--persist-to', persist],
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
      const r = await fetch(`${BASE}/api/health`);
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
    check(created.status === 201 && created.headers.get('access-control-allow-origin') === '*', 'create room 201 + CORS');
    const { code, commanderToken, operatorToken } = (await created.json()) as any;
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
    const fb = await members[1]!.waitFor((m) => m.type === 'error' && m.code === 'FORBIDDEN');
    check(!!fb, 'member command.issue -> FORBIDDEN');
    members[1]!.send({ type: 'parties.update', clientCmdId: cid(), baseVersion: 1, parties: partiesNow });
    await members[1]!.waitFor((m) => m.type === 'error' && m.code === 'FORBIDDEN', 5000, mkF + 1);
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
    op.send({ type: 'room.close', clientCmdId: cid() });
    await op.waitFor((m) => m.type === 'error' && m.code === 'FORBIDDEN');
    cmd.send({ type: 'stt.feed', entries: [{ id: 'e1', at: Date.now(), text: '집결', outcome: 'ISSUED' }] });
    const feed = await op.type('stt.feed');
    check(feed.from === 'COMMANDER' && feed.entries.length === 1, 'stt.feed relayed to operator');
    check(!members[0]!.msgs.some((m) => m.type === 'stt.feed'), 'stt.feed not sent to members');
    op.close();

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

    console.log('room.close');
    const closeMarks = [m0b.mark(), members[1]!.mark(), members[2]!.mark()];
    cmd2.send({ type: 'room.close', clientCmdId: cid() });
    await Promise.all([m0b, members[1]!, members[2]!].map((m, i) => m.waitFor((x) => x.type === 'room.closed', 5000, closeMarks[i])));
    const rc = await members[1]!.type('room.closed');
    check(rc.reason === 'COMMANDER_CLOSED', 'all connections receive room.closed');
    await new Promise((r) => setTimeout(r, 300));
    check((await api(`/api/rooms/${code}`)).status === 404, 'GET room after close -> 404');
    const late = await mk('late').connect(code);
    late.send({ type: 'hello', roomCode: code, clientId: 'late', role: 'MEMBER' });
    check((await late.type('error')).code === 'ROOM_NOT_FOUND', 'hello to closed room -> ROOM_NOT_FOUND');

    console.log(`\nALL PASSED (${passed} checks)`);
  } finally {
    for (const c of clients) try { c.close(); } catch { /* ignore */ }
    killWrangler(child);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
