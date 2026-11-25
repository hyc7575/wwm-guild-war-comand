/**
 * P-7 load test: 1 commander + N fake members against a room server.
 * Relay latency = member receive time - commander send time (same process clock, performance.now()).
 *
 *   pnpm --filter @winds/loadtest run load [--url http://localhost:8787] [--members 60]
 *        [--commands 100] [--interval 1000] [--spawn]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { LIMITS } from '@winds/protocol';

// ---------- args ----------
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const SPAWN = arg('spawn') !== undefined;
let SPAWN_PORT = 8797; // preferred; moves to a free port if taken
const MEMBERS = Number(arg('members', '60'));
const COMMANDS = Number(arg('commands', '100'));
const INTERVAL = Number(arg('interval', '1000'));
const PING_MS = LIMITS.pingIntervalMs;
const TARGET_P95_MS = 200; // P-7 / NFR-F04-1
const SNAPSHOT_MAX_BYTES = 32 * 1024; // NFR-F04-4
if (INTERVAL < 1000 / LIMITS.commanderRatePerSec) {
  console.warn(`warning: --interval ${INTERVAL}ms is faster than the commander limit (${LIMITS.commanderRatePerSec}/s); expect RATE_LIMITED`);
}

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '../../server');
let BASE = SPAWN ? `http://127.0.0.1:${SPAWN_PORT}` : (arg('url', 'http://localhost:8787') as string).replace(/\/$/, '');
let WS_BASE = BASE.replace(/^http/, 'ws');

type Msg = { type: string; [k: string]: any };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- stats ----------
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
function summarize(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { count: s.length, p50: r(pct(s, 50)), p95: r(pct(s, 95)), p99: r(pct(s, 99)), max: r(s[s.length - 1] ?? NaN) };
}

// ---------- wrangler ----------
/** First free TCP port at or after `preferred` (other wrangler instances may hold ports/inspector ports). */
async function freePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    const ok = await new Promise<boolean>((res) => {
      const srv = createServer();
      srv.once('error', () => res(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port near ${preferred}`);
}

async function startWrangler(): Promise<ChildProcess> {
  const persist = mkdtempSync(join(tmpdir(), 'winds-loadtest-'));
  SPAWN_PORT = await freePort(SPAWN_PORT);
  const inspector = await freePort(9341);
  BASE = `http://127.0.0.1:${SPAWN_PORT}`;
  WS_BASE = `ws://127.0.0.1:${SPAWN_PORT}`;
  const child = spawn(
    join(serverRoot, 'node_modules/.bin/wrangler'),
    ['dev', '--port', String(SPAWN_PORT), '--inspector-port', String(inspector), '--local', '--persist-to', persist],
    {
      cwd: serverRoot,
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
      if ((await fetch(`${BASE}/api/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(500);
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

// ---------- client ----------
class Client {
  ws!: WebSocket;
  closedUnexpectedly = false;
  tearingDown = false;
  errors: string[] = [];
  inboundSent = 0; // billable-ish: everything except ping (ping is auto-responded by the DO)
  pingsSent = 0;
  onMsg: (m: Msg, at: number, bytes: number) => void = () => {};
  private waiters: { pred: (m: Msg) => boolean; res: (m: Msg) => void }[] = [];
  private pingTimer?: NodeJS.Timeout;
  constructor(public name: string) {}

  connect(code: string): Promise<void> {
    this.ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`);
    this.ws.on('message', (d) => {
      const at = performance.now();
      const raw = d.toString();
      const m = JSON.parse(raw) as Msg;
      if (m.type === 'error') this.errors.push(`${m.code}: ${m.message}`);
      this.onMsg(m, at, Buffer.byteLength(raw));
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
    });
    this.ws.on('close', (code, reason) => {
      clearInterval(this.pingTimer);
      if (!this.tearingDown) {
        this.closedUnexpectedly = true;
        this.errors.push(`closed unexpectedly: code=${code} reason=${reason.toString()}`);
      }
    });
    this.ws.on('error', (e) => this.errors.push(`ws error: ${e.message}`));
    return new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }
  /** returns send timestamp */
  send(m: object): number {
    const data = JSON.stringify({ v: 1, ...m });
    this.inboundSent++;
    const at = performance.now();
    this.ws.send(data);
    return at;
  }
  startPings() {
    this.pingTimer = setInterval(() => {
      this.pingsSent++;
      this.ws.send('{"v":1,"type":"ping"}');
    }, PING_MS);
    this.pingTimer.unref();
  }
  waitFor(pred: (m: Msg) => boolean, ms = 15_000): Promise<Msg> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timeout`)), ms);
      this.waiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
    });
  }
  close() {
    this.tearingDown = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------- main ----------
interface MemberState {
  client: Client;
  seqs: number[];
  recvAt: Map<number, number>;
  baseSeq: number;
}

async function main() {
  let wrangler: ChildProcess | undefined;
  const clients: Client[] = [];
  try {
    if (SPAWN) {
      console.log(`spawning wrangler dev on :${SPAWN_PORT} ...`);
      wrangler = await startWrangler();
    }
    console.log(`target ${BASE} | members ${MEMBERS} | commands ${COMMANDS} | interval ${INTERVAL}ms`);

    // create room
    // worst case for the snapshot size: the maximum number of parties, each with a full-length name and aliases
    const nParties = LIMITS.maxParties;
    const created = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parties: Array.from({ length: nParties }, () => ({ name: '가나다라마바사아자차', aliases: ['가나다라마바사아', '자차카타파하갸냐'] })) }),
    });
    if (created.status !== 201) throw new Error(`create room failed: ${created.status} ${await created.text()}`);
    const { code, commanderToken } = (await created.json()) as { code: string; commanderToken: string };
    console.log(`room ${code}`);

    // commander
    const cmd = new Client('commander');
    clients.push(cmd);
    let presence: Msg | undefined;
    const cmdEvents: { seq: number; at: number }[] = [];
    const ackAt = new Map<string, number>();
    const ackMsgs = new Map<string, Msg>();
    cmd.onMsg = (m, at) => {
      if (m.type === 'presence') presence = m;
      else if (m.type === 'event') cmdEvents.push({ seq: m.seq, at });
      else if (m.type === 'ack') {
        ackAt.set(m.clientCmdId, at);
        ackMsgs.set(m.clientCmdId, m);
      }
    };
    await cmd.connect(code);
    cmd.send({ type: 'hello', roomCode: code, clientId: 'load-cmdr', role: 'COMMANDER', commanderToken });
    const cw = await cmd.waitFor((m) => m.type === 'welcome');
    const partyIds: string[] = cw.snapshot.parties.map((p: any) => p.id);
    cmd.startPings();

    // members, connected in batches
    const members: MemberState[] = [];
    const BATCH = 10;
    const tJoin = performance.now();
    for (let start = 0; start < MEMBERS; start += BATCH) {
      await Promise.all(
        Array.from({ length: Math.min(BATCH, MEMBERS - start) }, async (_, k) => {
          const i = start + k;
          const c = new Client(`m${i}`);
          clients.push(c);
          const st: MemberState = { client: c, seqs: [], recvAt: new Map(), baseSeq: 0 };
          members.push(st);
          c.onMsg = (m, at) => {
            if (m.type === 'event') {
              st.seqs.push(m.seq);
              st.recvAt.set(m.seq, at);
            }
          };
          await c.connect(code);
          c.send({ type: 'hello', roomCode: code, clientId: `load-m${i}`, role: 'MEMBER' });
          const w = await c.waitFor((m) => m.type === 'welcome');
          st.baseSeq = w.snapshot.seq;
          c.send({ type: 'party.select', partyId: partyIds[i % partyIds.length] });
          c.startPings();
        }),
      );
    }
    console.log(`${MEMBERS} members connected in ${Math.round(performance.now() - tJoin)}ms; waiting for presence ...`);
    const settleDeadline = Date.now() + 15_000;
    while (Date.now() < settleDeadline) {
      if (presence && presence.total === MEMBERS && presence.unassigned === 0) break;
      await sleep(250);
    }
    const presenceSettled = !!presence && presence.total === MEMBERS && presence.unassigned === 0;
    console.log(`presence ${presenceSettled ? 'settled' : 'NOT settled'}: total=${presence?.total} unassigned=${presence?.unassigned}`);

    // commands
    const ACTIONS = ['GATHER', 'MOVE', 'ATTACK', 'DEFEND', 'RETREAT', 'SUPPORT', 'HOLD'];
    const LOCS = ['left', 'center', 'right', 'front', 'back'];
    const sends: { id: string; at: number }[] = [];
    const tStart = performance.now();
    for (let i = 0; i < COMMANDS; i++) {
      const action = ACTIONS[i % ACTIONS.length]!;
      const all = i % 3 === 0;
      const a = partyIds[i % partyIds.length]!;
      const b = partyIds[(i * 2 + 1) % partyIds.length]!;
      const target = all ? { kind: 'ALL' } : { kind: 'PARTIES', partyIds: a === b ? [a] : [a, b] };
      const loc = LOCS[Math.floor(i / ACTIONS.length + i) % LOCS.length]!;
      const id = `load-${i}-${Math.random().toString(36).slice(2, 7)}`;
      const at = cmd.send({
        type: 'command.issue', clientCmdId: id, target, action,
        location: { id: loc, label: loc }, source: 'MANUAL',
      });
      sends.push({ id, at });
      if (i < COMMANDS - 1) await sleep(INTERVAL);
    }
    const sendDurationMs = performance.now() - tStart;
    await sleep(2500); // drain

    // ack latency + which sends produced an event
    const ackLat: number[] = [];
    const okSends: { id: string; at: number }[] = [];
    let ackErrors = 0;
    let missingAcks = 0;
    for (const s of sends) {
      const a = ackAt.get(s.id);
      if (a === undefined) {
        missingAcks++;
        continue;
      }
      ackLat.push(a - s.at);
      if (ackMsgs.get(s.id)!.error) ackErrors++;
      else okSends.push(s);
    }
    // commander is the only sender, so its k-th event corresponds to its k-th accepted command
    const expectedSeqs = cmdEvents.map((e) => e.seq);
    const seqToSend = new Map<number, number>();
    expectedSeqs.forEach((seq, k) => {
      const s = okSends[k];
      if (s) seqToSend.set(seq, s.at);
    });
    const mapOk = expectedSeqs.length === okSends.length;

    // relay latency + completeness
    const relay: number[] = [];
    let membersMissing = 0;
    let membersOutOfOrder = 0;
    let missingTotal = 0;
    for (const m of members) {
      const got = m.seqs.filter((s) => seqToSend.has(s) || expectedSeqs.includes(s));
      const inOrder = got.every((s, i) => i === 0 || s > got[i - 1]!);
      if (!inOrder) membersOutOfOrder++;
      const set = new Set(got);
      const miss = expectedSeqs.filter((s) => !set.has(s)).length;
      if (miss) {
        membersMissing++;
        missingTotal += miss;
      }
      for (const s of expectedSeqs) {
        const sendAt = seqToSend.get(s);
        const rAt = m.recvAt.get(s);
        if (sendAt !== undefined && rAt !== undefined) relay.push(rAt - sendAt);
      }
    }

    // snapshot size, worst case: a COMMANDER's welcome (transcripts always visible) in a room whose
    // command list is full of VOICE commands carrying a 200-char Hangul transcript.
    for (let i = 0; i < LIMITS.maxCommands; i++) {
      cmd.send({
        type: 'command.issue',
        clientCmdId: `worst-${i}-${Math.random().toString(36).slice(2, 7)}`,
        target: { kind: 'ALL' }, action: 'ATTACK', supportPartyIds: partyIds.slice(0, 3),
        location: { id: `w${i}`, label: '가나다라마바사아자차카타파하갸냐댜랴먀뱌' },
        source: 'VOICE', confidence: 0.123456789, transcript: '가'.repeat(LIMITS.transcriptMax),
      });
      await sleep(220); // stay under the commander's 5/s bucket
    }
    await sleep(500);
    const worstBad = [...ackMsgs.entries()].filter(([id, m]) => id.startsWith('worst-') && (m.error || m.note));
    if (worstBad.length) throw new Error(`worst-case fill not clean: ${worstBad.slice(0, 3).map(([, m]) => m.error ?? m.note).join(',')} (${worstBad.length})`);
    cmd.close(); // the probe takes the commander seat; close on purpose so it is not counted as a drop
    await sleep(500);
    const probe = new Client('probe');
    clients.push(probe);
    let snapBytes = 0;
    probe.onMsg = (m, _at, bytes) => {
      if (m.type === 'welcome') snapBytes = bytes;
    };
    await probe.connect(code);
    probe.send({ type: 'hello', roomCode: code, clientId: 'load-probe', role: 'COMMANDER', commanderToken });
    const pw = await probe.waitFor((m) => m.type === 'welcome' || m.type === 'error');
    if (pw.type === 'error') throw new Error(`snapshot probe rejected: ${pw.code}`);
    const snapCommands = pw.snapshot.commands.length;
    probe.close();

    // disconnects / errors
    const everyone = clients.filter((c) => c !== probe);
    const disconnects = everyone.filter((c) => c.closedUnexpectedly).length;
    const errors = everyone.flatMap((c) => c.errors.map((e) => `${c.name} ${e}`));

    // ---------- billing estimate (06 D-3) ----------
    // the worst-case snapshot fill (LIMITS.maxCommands extra requests) is not part of the traffic model
    const inboundMeasured = everyone.reduce((n, c) => n + c.inboundSent, 0) - LIMITS.maxCommands;
    const pingsSent = everyone.reduce((n, c) => n + c.pingsSent, 0);
    const EST_MEMBERS = 30;
    const EST_JOINS = 3; // connections per member per session (D-3 table)
    const EST_COMMANDS = 600; // commands in one hour, assumption
    const perJoin = 2; // hello + party.select
    const estInbound = EST_MEMBERS * EST_JOINS * perJoin + EST_COMMANDS * 2 + 3 * 5; // + stt.feed per command + commander hello/status
    const estConnections = (EST_MEMBERS + 2) * EST_JOINS; // members + commander + operator
    const estRequests = Math.ceil(estInbound / 20) + estConnections;
    const estPingsIfBilled = EST_MEMBERS * (3600_000 / PING_MS);
    const estRequestsWorst = Math.ceil((estInbound + estPingsIfBilled) / 20) + estConnections;

    const relayS = summarize(relay);
    const ackS = summarize(ackLat);
    const expectedPerMember = expectedSeqs.length;
    const checks = {
      p95Under200ms: relayS.p95 <= TARGET_P95_MS,
      allMembersReceivedAll: membersMissing === 0 && relay.length === expectedPerMember * MEMBERS,
      inOrder: membersOutOfOrder === 0,
      snapshotUnder32KB: snapBytes <= SNAPSHOT_MAX_BYTES,
      noDisconnects: disconnects === 0,
      noErrors: errors.length === 0 && ackErrors === 0 && missingAcks === 0,
      presenceSettled,
      latencyMappingOk: mapOk,
    };
    const pass = Object.values(checks).every(Boolean);

    const report = {
      at: new Date().toISOString(),
      target: BASE,
      spawned: SPAWN,
      params: { members: MEMBERS, commands: COMMANDS, intervalMs: INTERVAL },
      sendDurationMs: Math.round(sendDurationMs),
      eventsExpectedPerMember: expectedPerMember,
      relayLatencyMs: relayS,
      ackLatencyMs: ackS,
      completeness: { membersMissingEvents: membersMissing, missingEventsTotal: missingTotal, membersOutOfOrder },
      snapshot: { welcomeBytes: snapBytes, commandsInSnapshot: snapCommands, limitBytes: SNAPSHOT_MAX_BYTES },
      connection: { disconnects, ackErrors, missingAcks, errors: errors.slice(0, 20) },
      inbound: { measuredMessages: inboundMeasured, pingsSent },
      doBillingEstimate: {
        assumptions: { members: EST_MEMBERS, joinsPerMember: EST_JOINS, commandsPerHour: EST_COMMANDS, pingBilled: false },
        inboundMessages: estInbound,
        connections: estConnections,
        requestsPerHour: estRequests,
        requestsPerHourIfPingsBilled: estRequestsWorst,
        formula: 'ceil(inbound / 20) + connections',
        dailyFreeLimit: 100_000,
      },
      checks,
      pass,
    };

    const dir = join(here, '../reports');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));

    const f = (s: ReturnType<typeof summarize>) => `n=${s.count} p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.max} ms`;
    console.log('\n=== Load test result ===');
    console.log(`relay latency : ${f(relayS)}`);
    console.log(`ack latency   : ${f(ackS)}`);
    console.log(`events        : ${expectedPerMember} per member expected; members missing=${membersMissing}, out-of-order=${membersOutOfOrder}`);
    console.log(`snapshot      : ${snapBytes} bytes (${snapCommands} commands) vs limit ${SNAPSHOT_MAX_BYTES}`);
    console.log(`disconnects   : ${disconnects}; errors: ${errors.length}; ack errors: ${ackErrors}; missing acks: ${missingAcks}`);
    console.log(`inbound msgs  : ${inboundMeasured} measured (+${pingsSent} pings, auto-responded, not billed)`);
    console.log(`DO requests/h : ~${estRequests} for 30 members, 1h (${EST_COMMANDS} cmds; formula ceil(inbound/20)+connections = ceil(${estInbound}/20)+${estConnections}); worst case if pings billed ~${estRequestsWorst}; free limit/day 100000`);
    for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
    console.log(`P-7 (p95 <= ${TARGET_P95_MS}ms): ${checks.p95Under200ms ? 'PASS' : 'FAIL'}   OVERALL: ${pass ? 'PASS' : 'FAIL'}`);
    console.log(`report: ${file}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    for (const c of clients) c.close();
    if (wrangler) killWrangler(wrangler);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
