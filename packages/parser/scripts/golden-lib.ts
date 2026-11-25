import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Action, makeDefaultParties, type Command, type Party } from '@winds/protocol';
import { DEFAULT_DICTIONARY, parse, type ContextCommand, type ParseResult, type Dictionary } from '../src/index';

// ---------------------------------------------------------------------------
// 골든 케이스 형식 (packages/parser/README.md 참고)

export type Conf = 'HIGH' | 'MEDIUM';
export type TargetSpec = 'ALL' | number[];

export type ExpectResult =
  | {
      kind: 'ISSUE';
      confidence: Conf;
      target: TargetSpec;
      action: Action;
      location?: string;
      support?: number[];
      /** 문맥을 근거로 쓴 결과의 근거 명령 (case.context 의 1부터 센 번호, 즉 c1, c2) */
      context?: string[];
    }
  | {
      kind: 'CORRECT';
      confidence: Conf;
      patch: { target?: TargetSpec; action?: Action; location?: string; support?: number[] };
    }
  | { kind: 'CANCEL' }
  | { kind: 'NONE' };

export interface GoldenCase {
  id?: string;
  text: string;
  /** 기본 6개 파티(p1..p6). 숫자를 주면 그 개수 */
  partyCount?: number;
  /** 파티를 직접 지정. id는 `p{number}` */
  parties?: { number: number; name?: string; aliases?: string[] }[];
  /** 직전 음성 명령. ageMs 기본 3000 */
  last?: { target: TargetSpec; action: Action; location?: string; ageMs?: number };
  options?: { targetlessAsAll?: boolean };
  /** 직전 발행 명령들(문맥). id는 c1, c2 … 순서대로 붙는다. ageMs 기본 5000 */
  context?: { target: TargetSpec; action: Action; location?: string; ageMs?: number }[];
  expect: ExpectResult[];
  knownFailure?: boolean;
  reason?: string;
  source?: string; // 파일명
  line?: number;
}

export const NOW = 1_000_000;

export function loadFile(path: string): GoldenCase[] {
  const raw = readFileSync(path, 'utf8');
  const out: GoldenCase[] = [];
  const file = path.split('/').pop() ?? path;
  if (path.endsWith('.json')) {
    const arr = JSON.parse(raw) as GoldenCase[];
    arr.forEach((c, i) => out.push({ ...c, source: file, line: i + 1 }));
  } else {
    raw.split('\n').forEach((line, i) => {
      const s = line.trim();
      if (!s || s.startsWith('//') || s.startsWith('#')) return;
      try {
        out.push({ ...(JSON.parse(s) as GoldenCase), source: file, line: i + 1 });
      } catch (e) {
        throw new Error(`${file}:${i + 1} JSON 파싱 실패: ${(e as Error).message}`);
      }
    });
  }
  for (const c of out) validateCase(c);
  return out;
}

export function loadPath(path: string): GoldenCase[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
      .sort()
      .flatMap((f) => loadFile(join(path, f)));
  }
  return loadFile(path);
}

function validateCase(c: GoldenCase) {
  const where = `${c.source}:${c.line}`;
  if (typeof c.text !== 'string') throw new Error(`${where}: text 필요`);
  if (!Array.isArray(c.expect) || c.expect.length === 0) throw new Error(`${where}: expect 필요`);
  for (const e of c.expect) {
    if (!['ISSUE', 'CORRECT', 'CANCEL', 'NONE'].includes(e.kind)) throw new Error(`${where}: 알 수 없는 kind ${String(e.kind)}`);
    if ((e.kind === 'ISSUE' || e.kind === 'CORRECT') && e.confidence !== 'HIGH' && e.confidence !== 'MEDIUM')
      throw new Error(`${where}: ${e.kind}에는 confidence(HIGH|MEDIUM) 필요`);
    if (e.kind === 'ISSUE' && (!e.target || !e.action)) throw new Error(`${where}: ISSUE에는 target, action 필요`);
  }
}

// ---------------------------------------------------------------------------
// 실행

export function buildParties(c: GoldenCase): Party[] {
  if (c.parties) {
    return c.parties.map((p, i) => ({
      id: `p${p.number}`,
      number: p.number,
      name: p.name,
      aliases: p.aliases ?? [],
      color: `p${(i % 12) + 1}`,
    }));
  }
  return makeDefaultParties(c.partyCount ?? 6);
}

export function runCase(c: GoldenCase, dictionary: Dictionary = DEFAULT_DICTIONARY): ParseResult[] {
  const parties = buildParties(c);
  const idOf = (n: number) => parties.find((p) => p.number === n)?.id ?? `p${n}`;
  let lastVoiceCommand: { command: Command; issuedAt: number } | undefined;
  if (c.last) {
    const label = dictionary.locations.find((l) => l.id === c.last?.location)?.label ?? c.last.location;
    const command: Command = {
      id: 'last',
      seq: 1,
      target: c.last.target === 'ALL' ? { kind: 'ALL' } : { kind: 'PARTIES', partyIds: c.last.target.map(idOf) },
      action: c.last.action,
      location: c.last.location ? { id: c.last.location, label: label ?? c.last.location } : undefined,
      status: 'ACTIVE',
      source: 'VOICE',
      issuedAt: NOW - (c.last.ageMs ?? 3000),
      repeatCount: 0,
    };
    lastVoiceCommand = { command, issuedAt: command.issuedAt };
  }
  const context: ContextCommand[] | undefined = c.context?.map((x, i) => ({
    id: `c${i + 1}`,
    target: x.target === 'ALL' ? { kind: 'ALL' } : { kind: 'PARTIES', partyIds: x.target.map(idOf) },
    action: x.action,
    location: x.location
      ? { id: x.location, label: dictionary.locations.find((l) => l.id === x.location)?.label ?? x.location }
      : undefined,
    issuedAt: NOW - (x.ageMs ?? 5000),
  }));
  return parse(c.text, {
    parties,
    dictionary,
    lastVoiceCommand,
    now: NOW,
    options: { ...c.options, ...(context ? { context } : {}) },
  });
}

// ---------------------------------------------------------------------------
// 비교

interface Canon {
  kind: string;
  confidence?: string;
  slots: string; // 슬롯 정규형 문자열 (신뢰도 제외)
}

const tgt = (t: TargetSpec | undefined) =>
  t === undefined ? '-' : t === 'ALL' ? 'ALL' : [...t].sort((a, b) => a - b).join(',');
const sup = (s: number[] | undefined) => (s && s.length ? [...s].sort((a, b) => a - b).join(',') : '-');

function canonExpect(e: ExpectResult): Canon {
  if (e.kind === 'ISSUE')
    return {
      kind: 'ISSUE',
      confidence: e.confidence,
      slots: `T=${tgt(e.target)} A=${e.action} L=${e.location ?? '-'} S=${sup(e.support)}${e.context ? ` C=${e.context.join(',')}` : ''}`,
    };
  if (e.kind === 'CORRECT')
    return {
      kind: 'CORRECT',
      confidence: e.confidence,
      slots: `T=${tgt(e.patch.target)} A=${e.patch.action ?? '-'} L=${e.patch.location ?? '-'} S=${sup(e.patch.support)}`,
    };
  return { kind: e.kind, slots: '' };
}

function canonActual(r: ParseResult, parties: Party[]): Canon {
  const numOf = (id: string) => parties.find((p) => p.id === id)?.number ?? -1;
  const t = (x: { kind: 'ALL' } | { kind: 'PARTIES'; partyIds: string[] } | undefined): string =>
    x === undefined ? '-' : x.kind === 'ALL' ? 'ALL' : x.partyIds.map(numOf).sort((a, b) => a - b).join(',');
  const s = (ids: string[] | undefined) => (ids && ids.length ? ids.map(numOf).sort((a, b) => a - b).join(',') : '-');
  if (r.kind === 'ISSUE')
    return {
      kind: 'ISSUE',
      confidence: r.confidence,
      slots: `T=${t(r.draft.target)} A=${r.draft.action} L=${r.draft.location?.id ?? '-'} S=${s(r.draft.supportPartyIds)}${r.context ? ` C=${r.context.commandIds.join(',')}` : ''}`,
    };
  if (r.kind === 'CORRECT')
    return {
      kind: 'CORRECT',
      confidence: r.confidence,
      slots: `T=${t(r.patch.target)} A=${r.patch.action ?? '-'} L=${r.patch.location?.id ?? '-'} S=${s(r.patch.supportPartyIds)}`,
    };
  return { kind: r.kind, slots: '' };
}

const show = (c: Canon) => (c.confidence ? `${c.kind}/${c.confidence} ${c.slots}` : c.kind);

export interface CaseOutcome {
  case: GoldenCase;
  actual: ParseResult[];
  actualCanon: Canon[];
  expectCanon: Canon[];
  pass: boolean;
  isCommandCase: boolean; // expect가 NONE이 아님
  actualBadHigh: number; // HIGH인데 expect에 같은 슬롯이 없는 결과 수
  actualHigh: number;
  actualHighCorrect: number;
  autoIssuedNonCommand: boolean;
  recalled: boolean;
}

export function evaluate(c: GoldenCase, dictionary: Dictionary = DEFAULT_DICTIONARY): CaseOutcome {
  const parties = buildParties(c);
  const actual = runCase(c, dictionary);
  const actualCanon = actual.map((r) => canonActual(r, parties));
  const expectCanon = c.expect.map(canonExpect);
  const pass =
    actualCanon.length === expectCanon.length &&
    actualCanon.every((a, i) => {
      const e = expectCanon[i] as Canon;
      return a.kind === e.kind && a.confidence === e.confidence && a.slots === e.slots;
    });
  const isCommandCase = c.expect.some((e) => e.kind !== 'NONE');
  const highs = actualCanon.filter((a) => a.confidence === 'HIGH');
  const correct = highs.filter((a) =>
    expectCanon.some((e) => e.kind === a.kind && e.slots === a.slots && e.confidence !== undefined),
  );
  return {
    case: c,
    actual,
    actualCanon,
    expectCanon,
    pass,
    isCommandCase,
    actualBadHigh: highs.length - correct.length,
    actualHigh: highs.length,
    actualHighCorrect: correct.length,
    autoIssuedNonCommand: !isCommandCase && highs.length > 0,
    recalled: isCommandCase && actualCanon.some((a) => a.kind !== 'NONE'),
  };
}

// ---------------------------------------------------------------------------
// 지표

export interface Metrics {
  total: number;
  commandCases: number;
  nonCommandCases: number;
  recall: number; // 0..1
  precision: number;
  falseIssueRate: number;
  highCount: number;
  confusion: Map<string, Map<string, number>>;
}

export const TARGETS = { recall: 0.95, precision: 0.99, falseIssue: 0.01 };

const cat = (cs: Canon[]) => cs.map((c) => (c.confidence ? `${c.kind}/${c.confidence}` : c.kind)).join('+') || '(none)';

export function computeMetrics(outs: CaseOutcome[]): Metrics {
  const cmd = outs.filter((o) => o.isCommandCase);
  const non = outs.filter((o) => !o.isCommandCase);
  const high = outs.reduce((n, o) => n + o.actualHigh, 0);
  const highOk = outs.reduce((n, o) => n + o.actualHighCorrect, 0);
  const confusion = new Map<string, Map<string, number>>();
  for (const o of outs) {
    const e = cat(o.expectCanon);
    const a = cat(o.actualCanon);
    const row = confusion.get(e) ?? new Map<string, number>();
    row.set(a, (row.get(a) ?? 0) + 1);
    confusion.set(e, row);
  }
  return {
    total: outs.length,
    commandCases: cmd.length,
    nonCommandCases: non.length,
    recall: cmd.length ? cmd.filter((o) => o.recalled).length / cmd.length : 1,
    precision: high ? highOk / high : 1,
    falseIssueRate: non.length ? non.filter((o) => o.autoIssuedNonCommand).length / non.length : 0,
    highCount: high,
    confusion,
  };
}

export function targetsMet(m: Metrics): boolean {
  return m.recall >= TARGETS.recall && m.precision >= TARGETS.precision && m.falseIssueRate < TARGETS.falseIssue;
}

export function formatMetrics(m: Metrics, title: string): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ok = (b: boolean) => (b ? 'OK  ' : 'FAIL');
  const lines = [
    `== ${title} (cases ${m.total}: command ${m.commandCases}, non-command ${m.nonCommandCases}) ==`,
    `${ok(m.recall >= TARGETS.recall)} recall            ${pct(m.recall)}   (target >= 95%)`,
    `${ok(m.precision >= TARGETS.precision)} auto-issue precision ${pct(m.precision)}   (target >= 99%, HIGH results: ${m.highCount})`,
    `${ok(m.falseIssueRate < TARGETS.falseIssue)} false-issue rate   ${pct(m.falseIssueRate)}   (target < 1%)`,
  ];
  return lines.join('\n');
}

export function formatConfusion(m: Metrics): string {
  const lines = ['-- confusion (expected -> actual : count) --'];
  for (const [e, row] of [...m.confusion.entries()].sort()) {
    const cells = [...row.entries()].sort().map(([a, n]) => `${a} x${n}`);
    lines.push(`  ${e.padEnd(28)} -> ${cells.join(', ')}`);
  }
  return lines.join('\n');
}

export function describeOutcome(o: CaseOutcome): string {
  return [
    `    expected: ${o.expectCanon.map(show).join(' | ')}`,
    `    actual:   ${o.actualCanon.map(show).join(' | ') || '(none)'}${
      o.actual[0]?.kind === 'NONE' ? `  [${(o.actual[0] as { reason: string }).reason}]` : ''
    }`,
  ].join('\n');
}
