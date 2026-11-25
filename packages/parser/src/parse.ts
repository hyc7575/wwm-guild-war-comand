import {
  LIMITS,
  type Action,
  type Command,
  type CommandId,
  type Location,
  type Party,
  type PartyId,
  type Target,
} from '@winds/protocol';
import {
  buildPartyLexicon,
  compactExpression,
  WEAK_ACTION_EXPRESSIONS,
  type Dictionary,
} from './dictionary';
import { hasAdjacentNumberRun, normalize } from './normalize';

// ---------------------------------------------------------------------------
// 공개 타입 (F03)

export interface CommandDraft {
  target: Target;
  action: Action;
  location?: Location;
  supportPartyIds?: PartyId[];
}

export type MatchSlot = 'target' | 'action' | 'location' | 'support' | 'correction' | 'cancel';

/**
 * 판단 근거. `start`/`end`는 `normalize(text, dictionary)` 결과 문자열 기준 오프셋이고 `text`는 그 부분 문자열이다.
 * `value`: target → partyId 또는 'ALL', action → Action, location → location id,
 * support → partyId, correction → 정정어(정규형), cancel → 취소 표현(정규형).
 */
export interface Match {
  slot: MatchSlot;
  text: string;
  start: number;
  end: number;
  value: string;
}

/** 문맥으로 쓰는 직전 발행 명령 (F03 문맥 처리). */
export interface ContextCommand {
  id: CommandId;
  target: Target;
  action: Action;
  location?: Location;
  issuedAt: number;
}

/** 문맥 창: 이 시간(ms) 안에 발행된 명령만 쓴다. 가장 최근 2건까지. */
export const CONTEXT_WINDOW_MS = 60_000;
export const CONTEXT_MAX = 2;

export interface ParseOptions {
  /** Q1: 대상 없는 명령을 전체 대상 확신도 높음으로 본다 (방 설정 `targetlessAsAll`) */
  targetlessAsAll?: boolean;
  /** "아까 거기로", "다시", "똑같이"가 가리킬 직전 발행 명령들. 이걸로 채운 결과는 항상 MEDIUM이다 */
  context?: ContextCommand[];
}

/** 문맥에서 값을 가져온 ISSUE 결과의 근거 */
export interface ContextUse {
  /** 근거로 쓴 명령 ID (가까운 것부터) */
  commandIds: CommandId[];
  /** 문맥에서 채운 슬롯 */
  filled: ('target' | 'action' | 'location')[];
}

export interface ParseContext {
  parties: Party[];
  dictionary: Dictionary;
  lastVoiceCommand?: { command: Command; issuedAt: number };
  now: number;
  options?: ParseOptions;
}

export type Confidence = 'HIGH' | 'MEDIUM';

export type ParseResult =
  | { kind: 'ISSUE'; draft: CommandDraft; confidence: Confidence; evidence: Match[]; context?: ContextUse }
  | {
      kind: 'CORRECT';
      correctsId: CommandId;
      patch: Partial<CommandDraft>;
      confidence: Confidence;
      evidence: Match[];
    }
  | { kind: 'CANCEL'; commandId: CommandId; evidence: Match[] }
  | { kind: 'NONE'; reason: string };

// ---------------------------------------------------------------------------
// 사전 컴파일 (사전 객체별 캐시)

type DictKind = 'action' | 'all' | 'location' | 'marker';

interface DictExpr {
  expr: string;
  kind: DictKind;
  value: string;
  weak: boolean;
  /** 접속형 행동 표현("막고", "모이고"): 뒤 절이 이어질 때만 명령이다 */
  conn: boolean;
}

interface CompiledDict {
  exprs: DictExpr[];
  cancel: string[];
  locationLabel: Map<string, string>;
}

const ACTION_ORDER: Action[] = ['GATHER', 'MOVE', 'ATTACK', 'DEFEND', 'RETREAT', 'SUPPORT', 'HOLD'];

/** 단독 발화일 때만 취소로 인정하는 표현 */
const GENERIC_CANCEL = new Set(['취소해', '명령취소']);

const isConnective = (expr: string) => expr.length >= 2 && expr.endsWith('고');

const dictCache = new WeakMap<Dictionary, CompiledDict>();

function compileDict(d: Dictionary): CompiledDict {
  const hit = dictCache.get(d);
  if (hit) return hit;
  const exprs: DictExpr[] = [];
  for (const a of ACTION_ORDER) {
    for (const e of d.actions[a]) {
      const expr = compactExpression(e);
      if (!expr) continue;
      exprs.push({ expr, kind: 'action', value: a, weak: WEAK_ACTION_EXPRESSIONS.has(expr), conn: isConnective(expr) });
    }
  }
  for (const e of d.targetAll) {
    const expr = compactExpression(e);
    if (expr) exprs.push({ expr, kind: 'all', value: 'ALL', weak: false, conn: false });
  }
  const locationLabel = new Map<string, string>();
  for (const l of d.locations) {
    locationLabel.set(l.id, l.label);
    for (const e of [l.label, ...l.aliases]) {
      const expr = compactExpression(e);
      if (expr) exprs.push({ expr, kind: 'location', value: l.id, weak: false, conn: false });
    }
  }
  for (const e of d.correctionMarkers) {
    const expr = compactExpression(e);
    if (expr) exprs.push({ expr, kind: 'marker', value: expr, weak: false, conn: false });
  }
  const compiled: CompiledDict = {
    exprs,
    cancel: d.cancelPhrases.map(compactExpression).filter(Boolean),
    locationLabel,
  };
  dictCache.set(d, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// 경계 휴리스틱
//
// 길이 3 이상 표현: 어디서든 매칭 ("중앙으로모여"처럼 STT가 붙여 쓴 경우를 살린다).
// 길이 2 표현: 뒤가 "조사·어미"로만 이어지다 어절이 끝나야 한다 ("공격력", "지원군", "전체적으로"를 걸러낸다).
// 길이 1 표현(다, 가, 좌, 우, 와, 빼, 쳐 …): 어절 시작이거나 직전 매칭(+조사) 바로 뒤에서 시작하고,
//   뒤는 위와 같이 조사·어미 뒤 어절 끝이어야 한다.
// 이 조사·어미 목록 밖의 글자가 이어지면 다른 단어로 본다.

const PARTICLES = [
  '으로', '로', '에서', '에게', '한테', '에', '은', '는', '이', '가', '을', '를', '도', '만', '의',
  '랑', '이랑', '하고', '과', '와', '들', '께', '까지', '쪽', '쪽으로',
];
const TAILS = [
  '요', '라', '줘', '주세요', '세요', '셔', '해', '해요', '해라', '해줘', '해주세요', '하세요', '하라',
  '하자', '합시다', '합니다', '하십시오', '시오', '자', '서', '주라', '주십시오', '버려', '놔', '놔라',
  '줄래', '시죠', '십시오', '시다', '세여', '하세여', '해여',
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SUFFIX_UNITS = [...PARTICLES, ...TAILS].sort((a, b) => b.length - a.length);
const END_OK = new RegExp(`^(?:${SUFFIX_UNITS.map(esc).join('|')})*(?: |$)`, 'u');

// ---------------------------------------------------------------------------
// 멘션

type MentionKind = 'party' | 'unknown' | 'all' | 'action' | 'location' | 'marker';

interface Mention {
  kind: MentionKind;
  cs: number; // compact 오프셋
  ce: number;
  start: number; // 정규화 문자열 오프셋
  end: number;
  text: string;
  value: string; // partyId | 'ALL' | Action | locationId | marker
  weak: boolean;
  conn?: boolean;
  label?: string;
  /** 파티 뒤에 한테/에게/쪽으로가 붙은 경우: 행동 주체가 아니라 도착지일 수 있다 */
  dest?: boolean;
}

interface Cand {
  kind: MentionKind;
  cs: number;
  ce: number;
  value: string;
  weak: boolean;
  conn?: boolean;
  prio: number;
}

const PRIO: Record<MentionKind, number> = { party: 0, unknown: 0, location: 1, action: 2, all: 3, marker: 4 };

function collectMentions(t: string, parties: readonly Party[], cd: CompiledDict, d: Dictionary): Mention[] {
  // compact 텍스트와 오프셋 지도
  let c = '';
  const map: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== ' ') {
      c += t[i];
      map.push(i);
    }
  }
  if (!c) return [];

  const startsAtToken = (cs: number) => cs === 0 || t[(map[cs] ?? 0) - 1] === ' ';
  const endOk = (ce: number) => END_OK.test(t.slice((map[ce - 1] ?? 0) + 1));

  const cands: Cand[] = [];
  const singles: Cand[] = [];
  const deferred: Cand[] = [];
  const push = (cand: Cand, len: number) => {
    if (len === 1) singles.push(cand);
    else if (len === 2 && !endOk(cand.ce)) deferred.push(cand);
    else cands.push(cand);
  };

  // 번호 표현 N파티 (방에 없는 번호도 잡아 FR-F03-9에 쓴다)
  const byNumber = new Map(parties.map((p) => [p.number, p.id]));
  for (const m of c.matchAll(/(?<!\d)(\d{1,2})파티/g)) {
    const n = Number(m[1]);
    const id = byNumber.get(n);
    cands.push({
      kind: id ? 'party' : 'unknown',
      cs: m.index,
      ce: m.index + m[0].length,
      value: id ?? String(n),
      weak: false,
      prio: 0,
    });
  }

  // 파티 이름·별칭 (번호 형태는 위 정규식이 처리)
  for (const e of buildPartyLexicon(parties, d.partySuffixes)) {
    if (e.kind === 'number') continue;
    for (let i = c.indexOf(e.expression); i >= 0; i = c.indexOf(e.expression, i + 1)) {
      push({ kind: 'party', cs: i, ce: i + e.expression.length, value: e.partyId, weak: false, prio: 0 }, e.expression.length);
    }
  }

  for (const e of cd.exprs) {
    for (let i = c.indexOf(e.expr); i >= 0; i = c.indexOf(e.expr, i + 1)) {
      let prio = PRIO[e.kind];
      // 파티 이름과 행동 표현이 같을 때("수비"): 뒤에 "해/하"가 오면 행동으로 본다
      if (e.kind === 'action' && /^[해하]/.test(c.slice(i + e.expr.length))) prio = -1;
      push({ kind: e.kind, cs: i, ce: i + e.expr.length, value: e.value, weak: e.weak, conn: e.conn, prio }, e.expr.length);
    }
  }

  // 긴 것 우선, 같으면 우선순위, 그다음 앞쪽. 겹치면 버린다.
  const order = (a: Cand, b: Cand) => b.ce - b.cs - (a.ce - a.cs) || a.prio - b.prio || a.cs - b.cs;
  cands.sort(order);
  const taken: Cand[] = [];
  const overlaps = (x: Cand) => taken.some((y) => x.cs < y.ce && y.cs < x.ce);
  for (const x of cands) if (!overlaps(x)) taken.push(x);

  // 위치 pos에서 조사 사슬을 따라 닿을 수 있는 위치들 (pos 자신 포함)
  const reach = (pos: number): Set<number> => {
    const seen = new Set<number>();
    const q = [pos];
    while (q.length) {
      const p = q.pop() as number;
      if (seen.has(p)) continue;
      seen.add(p);
      const rest = c.slice(p);
      for (const part of PARTICLES) if (rest.startsWith(part)) q.push(p + part.length);
    }
    return seen;
  };

  // 길이 2 표현 중 뒤가 조사·어미가 아닌 것: 바로 뒤에 다른 매칭이 붙어 있으면(띄어쓰기 없는 STT 출력) 살린다
  for (let changed = true; changed; ) {
    changed = false;
    for (const x of deferred.sort(order)) {
      if (taken.includes(x) || overlaps(x)) continue;
      const r = reach(x.ce);
      if (r.has(c.length) || taken.some((y) => r.has(y.cs))) {
        taken.push(x);
        changed = true;
      }
    }
  }

  // 한 글자 표현: 어절 시작이거나 직전 매칭(+조사) 바로 뒤여야 한다
  if (singles.length) {
    // 조사를 하나 이상 지난 위치만 인정한다. 바로 붙은 "3파티가"의 가는 조사다.
    const allowed = new Set<number>();
    for (const y of taken) {
      const r = reach(y.ce);
      r.delete(y.ce);
      for (const p of r) allowed.add(p);
    }
    singles.sort(order);
    for (const x of singles) {
      if (overlaps(x)) continue;
      if (!(startsAtToken(x.cs) || allowed.has(x.cs))) continue;
      if (!endOk(x.ce)) continue;
      taken.push(x);
    }
  }

  taken.sort((a, b) => a.cs - b.cs);
  return taken.map((x) => {
    const start = map[x.cs] ?? 0;
    const end = (map[x.ce - 1] ?? 0) + 1;
    return {
      kind: x.kind,
      cs: x.cs,
      ce: x.ce,
      start,
      end,
      text: t.slice(start, end),
      value: x.value,
      weak: x.weak,
      conn: x.conn,
      label: x.kind === 'location' ? cd.locationLabel.get(x.value) : undefined,
      dest: x.kind === 'party' && /^(?:한테|에게|쪽으로)/.test(c.slice(x.ce)),
    };
  });
}

// ---------------------------------------------------------------------------
// 절 나누기·조립

interface Clause {
  ms: Mention[];
  borrowed: Mention[]; // 뒤 절에서 채워 온 행동
  reordered: boolean;
}

const isTarget = (m: Mention) => m.kind === 'party' || m.kind === 'unknown' || m.kind === 'all';

function flags(ms: Mention[]) {
  return {
    hasAction: ms.some((m) => m.kind === 'action'),
    hasLoc: ms.some((m) => m.kind === 'location'),
    hasTarget: ms.some(isTarget),
  };
}

/** 대상 뒤에 위치가 나왔는가 ("1파티 중앙 ..."). 위치가 먼저인 "중앙으로 1파티 2파티"와 구분한다. */
function locAfterTarget(ms: Mention[]): boolean {
  const firstTarget = ms.findIndex(isTarget);
  return firstTarget >= 0 && ms.some((m, i) => i > firstTarget && m.kind === 'location');
}

/** 대상이 나올 때마다 절을 나눈다. 단, 앞 절에 아직 행동·위치가 없으면(= 여러 파티 나열) 같은 절이다. */
function splitClauses(ms: Mention[]): Clause[] {
  const clauses: Clause[] = [];
  let cur: Clause = { ms: [], borrowed: [], reordered: false };
  for (const m of ms) {
    if (isTarget(m)) {
      const f = flags(cur.ms);
      if (f.hasAction || locAfterTarget(cur.ms)) {
        clauses.push(cur);
        cur = { ms: [], borrowed: [], reordered: false };
      }
    }
    cur.ms.push(m);
  }
  if (cur.ms.length) clauses.push(cur);

  // 순서가 뒤바뀐 발화 합치기: "1파티 지원 2파티", "중앙으로 모여 1파티 2파티"
  const out: Clause[] = [];
  for (const c of clauses) {
    const prev = out[out.length - 1];
    const f = flags(c.ms);
    const targetOnly = f.hasTarget && !f.hasAction && !f.hasLoc;
    if (prev && targetOnly) {
      const pf = flags(prev.ms);
      const prevParties = prev.ms.filter((m) => m.kind === 'party').length;
      const prevSupport = prev.ms.some((m) => m.kind === 'action' && m.value === 'SUPPORT');
      if ((prevSupport && prevParties < 2) || (pf.hasAction && !pf.hasTarget)) {
        prev.ms = [...prev.ms, ...c.ms];
        prev.reordered = true;
        continue;
      }
    }
    out.push(c);
  }

  // 행동이 뒤에 한 번만 나오면 앞의 행동 없는 절에 적용
  let next: Mention[] | null = null;
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i] as Clause;
    const acts = c.ms.filter((m) => m.kind === 'action');
    if (acts.length) next = acts;
    else if (next) c.borrowed = next;
  }
  // 행동 생략: "1파티 중앙으로 모이고 2파티는 후방"처럼 뒤 절에 행동이 없으면 앞 절의 행동을 이어 쓴다 (위치가 있을 때만)
  for (let i = 1; i < out.length; i++) {
    const c = out[i] as Clause;
    if (c.borrowed.length || c.ms.some((m) => m.kind === 'action') || !c.ms.some((m) => m.kind === 'location')) continue;
    const prev = out[i - 1] as Clause;
    const acts = prev.ms.filter((m) => m.kind === 'action');
    if (acts.length) c.borrowed = acts;
  }
  return out;
}

interface Built {
  target?: Target;
  action?: Action;
  location?: Location;
  supportPartyIds?: PartyId[];
  conflict: boolean;
  weak: boolean;
  /** 행동이 접속형("막고")으로 끝난다 */
  connective: boolean;
  filled: boolean;
  reordered: boolean;
  /** 전체와 파티가 함께 나왔거나 파티가 도착지 표현이라 대상이 불확실하다 */
  mixed: boolean;
  unknown?: string;
  evidence: Match[];
}

function toMatch(m: Mention, slot: MatchSlot): Match {
  return { slot, text: m.text, start: m.start, end: m.end, value: m.value };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function buildClause(cl: Clause): Built {
  const ms = cl.ms;
  const unknown = ms.find((m) => m.kind === 'unknown');
  // 강한 행동이 있으면 약한 행동("이쪽으로", "와" …)은 부가어로 보고 무시한다
  const ownAll = ms.filter((m) => m.kind === 'action');
  const own = ownAll.some((m) => !m.weak) ? ownAll.filter((m) => !m.weak) : ownAll;
  const filled = own.length === 0 && cl.borrowed.length > 0;
  const actionMs = own.length ? own : cl.borrowed;
  const locMs = ms.filter((m) => m.kind === 'location');
  const evidence: Match[] = [];

  const action = actionMs.length ? (actionMs[actionMs.length - 1]?.value as Action) : undefined;
  const conflictA = uniq(own.map((m) => m.value)).length > 1;
  const weak = actionMs.length > 0 && actionMs.filter((m) => m.value === action).every((m) => m.weak);
  const locValue = locMs.length ? locMs[locMs.length - 1] : undefined;
  const conflictL = uniq(locMs.map((m) => m.value)).length > 1;

  // 대상
  let tms = ms.filter((m) => m.kind === 'party' || m.kind === 'all');
  let mixed = false;
  if (action !== 'SUPPORT') {
    // "다들 1파티 쪽으로 모여": 파티+한테/에게/쪽으로는 대상이 아니다
    if (tms.some((m) => m.dest)) {
      tms = tms.filter((m) => !m.dest);
      mixed = true;
    }
    // 전체와 파티가 섞이면 어느 쪽이 대상인지 모른다
    // ("1파티 2파티 전원 모여"처럼 전체가 파티 뒤에서 덧붙는 말은 제외)
    const firstAll = tms.find((m) => m.kind === 'all');
    if (firstAll && tms.some((m) => m.kind === 'party' && m.cs > firstAll.cs)) mixed = true;
  }
  const partyMs = tms.filter((m) => m.kind === 'party');
  let target: Target | undefined;
  let supportIds: PartyId[] | undefined;
  let supportMs: Mention[] = [];
  let actorMs: Mention[] = tms;
  if (action === 'SUPPORT' && tms.length) {
    const first = tms[0] as Mention;
    if (first.kind === 'all') {
      target = { kind: 'ALL' };
      supportMs = partyMs;
      actorMs = [first];
    } else {
      target = { kind: 'PARTIES', partyIds: [first.value] };
      supportMs = partyMs.filter((m) => m !== first && m.value !== first.value);
      actorMs = [first];
    }
    const ids = uniq(supportMs.map((m) => m.value));
    if (ids.length) supportIds = ids;
    supportMs = supportMs.filter((m, i, a) => a.findIndex((x) => x.value === m.value) === i);
  } else if (partyMs.length) {
    target = { kind: 'PARTIES', partyIds: uniq(partyMs.map((m) => m.value)) };
    actorMs = partyMs;
  } else if (tms.length) {
    target = { kind: 'ALL' };
  }

  for (const m of actorMs) evidence.push(toMatch(m, 'target'));
  for (const m of supportMs) evidence.push(toMatch(m, 'support'));
  for (const m of locMs) evidence.push(toMatch(m, 'location'));
  for (const m of actionMs) evidence.push(toMatch(m, 'action'));
  evidence.sort((a, b) => a.start - b.start);

  const location: Location | undefined = locValue
    ? { id: locValue.value, label: locValue.label ?? locValue.value }
    : undefined;

  return {
    target,
    action,
    location,
    supportPartyIds: supportIds,
    conflict: conflictA || conflictL,
    weak,
    connective: !!actionMs[actionMs.length - 1]?.conn,
    filled,
    reordered: cl.reordered,
    mixed,
    unknown: unknown?.value,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 정정·취소

function sameTarget(a: Target, b: Target): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ALL') return true;
  const bb = b as Extract<Target, { kind: 'PARTIES' }>;
  const x = [...a.partyIds].sort().join('|');
  const y = [...bb.partyIds].sort().join('|');
  return x === y;
}

function tryCorrect(
  ctx: ParseContext,
  before: Mention[],
  after: Mention[],
  markers: Mention[],
  strongMarker: boolean,
  softCap: boolean,
  exclude?: PartyId[],
): ParseResult | 'none' | { unknown: string } {
  const last = ctx.lastVoiceCommand as NonNullable<ParseContext['lastVoiceCommand']>;
  const aClauses = splitClauses(after);
  const first = aClauses[0];
  if (!first) return 'none';
  const b = buildClause(first);
  if (b.unknown) return { unknown: b.unknown };
  if (exclude && (!b.target || b.target.kind === 'ALL')) {
    const rest = ctx.parties.map((p) => p.id).filter((id) => !exclude.includes(id));
    if (!rest.length) return 'none';
    b.target = { kind: 'PARTIES', partyIds: rest };
  }
  const patch: Partial<CommandDraft> = {};
  if (b.target) patch.target = b.target;
  if (b.action && !b.filled) patch.action = b.action;
  if (b.location) patch.location = b.location;
  if (b.supportPartyIds) patch.supportPartyIds = b.supportPartyIds;
  if (Object.keys(patch).length === 0) return 'none';

  // 말고 앞쪽이 직전 명령의 값과 같은지 확인
  let verified = false;
  const bClauses = splitClauses(before);
  const bf = bClauses[0];
  if (bf && strongMarker) {
    const bb = buildClause({ ...bf, borrowed: [] });
    if (!bb.unknown) {
      const lc = last.command;
      const checks: boolean[] = [];
      if (bb.target) checks.push(lc.target !== undefined && sameTarget(bb.target, lc.target));
      if (bb.action) checks.push(bb.action === lc.action);
      if (bb.location) checks.push(bb.location.id === lc.location?.id);
      verified = checks.length > 0 && checks.every(Boolean);
    }
  }
  // 본 발행(issue)과 같은 상한: 제외·붙여 쓴 숫자·문맥 표현(softCap), 전체·파티 혼합, 접속형으로 끝나는 행동
  const high =
    verified &&
    aClauses.length === 1 &&
    !b.conflict &&
    !(patch.action && b.weak) &&
    !softCap &&
    !b.mixed &&
    !(patch.action && b.connective);
  const evidence = [...markers.map((m) => toMatch(m, 'correction')), ...b.evidence].sort((x, y) => x.start - y.start);
  return {
    kind: 'CORRECT',
    correctsId: last.command.id,
    patch,
    confidence: high ? 'HIGH' : 'MEDIUM',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// parse

export function parse(text: string, ctx: ParseContext): ParseResult[] {
  const d = ctx.dictionary;
  const cd = compileDict(d);
  const t = normalize(text, d);
  if (!t) return [{ kind: 'NONE', reason: '빈 발화' }];

  // 부정 표현("하지마", "안 돼", "중지", "금지")은 반대 뜻이라 명령으로 발행하지 않는다
  if (/하지마|하지말|안돼|안되|중지|금지/.test(t.replace(/ /g, ''))) {
    const hasCancel = cd.cancel.some((p) => t.replace(/ /g, '').includes(p));
    if (!hasCancel) return [{ kind: 'NONE', reason: '부정 표현' }];
  }

  const all = collectMentions(t, ctx.parties, cd, d);

  // 접속형 뒤에 "있-"+서술 어미("막고 있네요")는 진행 중인 상황 보고다
  for (const m of all) {
    if (m.conn && PROGRESSIVE.test(t.slice(m.end).replace(/ /g, ''))) return [{ kind: 'NONE', reason: '진행형 보고' }];
  }

  // 취소: 긴 표현부터. "취소해"·"명령 취소"는 단독 발화일 때만, 나머지는 같이 말한 대상·행동이 직전 명령과 같을 때만 인정한다.
  {
    const compact = t.replace(/ /g, '');
    const map: number[] = [];
    for (let i = 0; i < t.length; i++) if (t[i] !== ' ') map.push(i);
    const phrases = [...cd.cancel].sort((a, b) => b.length - a.length);
    for (const phrase of phrases) {
      const i = compact.indexOf(phrase);
      if (i < 0) continue;
      if (!ctx.lastVoiceCommand) return [{ kind: 'NONE', reason: 'no previous command' }];
      const start = map[i] ?? 0;
      const end = (map[i + phrase.length - 1] ?? 0) + 1;
      const rest = compact.slice(0, i) + compact.slice(i + phrase.length);
      const standalone = /^(?:요|줘|주세요|좀|제발|해|해줘|해주세요|라|좀요)*$/.test(rest);
      if (!standalone) {
        if (GENERIC_CANCEL.has(phrase)) return [{ kind: 'NONE', reason: '취소는 단독 발화일 때만' }];
        const others = all.filter((m) => m.kind !== 'marker' && !(m.start < end && start < m.end));
        const b = buildClause({ ms: others, borrowed: [], reordered: false });
        const lc = ctx.lastVoiceCommand.command;
        const same =
          !b.unknown &&
          (b.target || b.action || b.location) &&
          (!b.target || (lc.target !== undefined && sameTarget(b.target, lc.target))) &&
          (!b.action || b.action === lc.action) &&
          (!b.location || b.location.id === lc.location?.id);
        if (!same) return [{ kind: 'NONE', reason: '취소 대상이 직전 명령과 다름' }];
      }
      return [
        {
          kind: 'CANCEL',
          commandId: ctx.lastVoiceCommand.command.id,
          evidence: [{ slot: 'cancel', text: t.slice(start, end), start, end, value: phrase }],
        },
      ];
    }
  }

  // 띄어 쓴 한/두/세/네 파티는 개수 표현이라 어느 파티인지 모른다
  // ("두 파티 쳐"처럼 단순한 번호 표현은 그대로 둔다. "…만"이거나 전체 표현이 함께 나올 때만)
  let textCap = false;
  if (
    /(?:^|\s)(?:한|두|세|네)\s+(?:파티|팟)/u.test(text.normalize('NFKC')) &&
    (/(?:한|두|세|네)\s+(?:파티|팟)\s*만/u.test(text.normalize('NFKC')) || all.some((m) => m.kind === 'all'))
  )
    textCap = true;

  // 일이파티처럼 숫자 말을 붙여 쓴 것은 1·2파티로 읽지만 추측이다
  if (hasAdjacentNumberRun(text, d)) textCap = true;

  // 문맥 표현·장소 지시어: 어절 경계로 읽고, 반복어는 슬롯 없이 말만 길면 인정하지 않는다
  const anaphora = ANAPHORA.test(t);
  const repeat = REPEAT_WORDS.test(t) && repeatIsShort(t, all);
  const deictic = DEICTIC.test(t);

  // "1파티 빼고", "제외": 파티 목록을 알면 나머지 파티를 대상으로 하되 후보로만 둔다. 제외 표현은 자동 발행하지 않는다.
  const ex = findExclusion(t);
  if (ex) textCap = true;

  const markers = all.filter((m) => m.kind === 'marker');
  let body = all.filter((m) => m.kind !== 'marker');
  let capMedium = false;

  if (markers.length) {
    const lastMarker = markers[markers.length - 1] as Mention;
    const before = all.filter((m) => m.kind !== 'marker' && m.ce <= lastMarker.cs);
    const after = all.filter((m) => m.kind !== 'marker' && m.cs >= lastMarker.ce);
    const hasSlots = after.some((m) => m.kind !== 'marker');
    if (hasSlots) {
      const lv = ctx.lastVoiceCommand;
      if (lv && ctx.now - lv.issuedAt <= LIMITS.correctionWindowMs) {
        const strong = markers.some((m) => m.value !== '아니');
        let cAfter = after;
        let cExclude: PartyId[] | undefined;
        if (ex) {
          const ar = applyExclusion(after, ex, ctx.parties);
          cAfter = ar.body;
          cExclude = ar.exclude;
        }
        const r = tryCorrect(ctx, before, cAfter, markers, strong, textCap || anaphora || repeat || deictic, cExclude);
        if (typeof r === 'object' && 'kind' in r) return [r];
        if (typeof r === 'object' && 'unknown' in r)
          return [{ kind: 'NONE', reason: `방에 없는 파티: ${r.unknown}` }];
      }
      // 정정이 아니면 정정어 뒤쪽만 새 명령으로 본다 (앞쪽은 부정된 내용).
      // 앞쪽에 내용이 있었다면(무엇을 부정하는지 모르므로) 확신도는 중간으로 제한한다.
      body = after;
      capMedium = before.length > 0 && markers.some((m) => m.value !== '아니');
    } else if (before.length > 0) {
      // "1파티 공격 말고": 정정어로 끝나 뒤에 슬롯이 없으면 앞부분은 부정된 내용이다
      return [{ kind: 'NONE', reason: '정정어 뒤에 내용 없음 (앞부분은 부정됨)' }];
    }
  }

  // 상대 상황을 말하는 혼잣말 ("상대 공격 들어오네요")은 명령이 아니다
  if (body.some((m) => m.kind === 'action') && !body.some(isTarget) && isEnemyNarration(t)) return [{ kind: 'NONE', reason: '상대 상황 서술' }];

  let exclude: PartyId[] | undefined;
  if (ex) {
    const r = applyExclusion(body, ex, ctx.parties);
    body = r.body;
    exclude = r.exclude;
  }

  const res = issue(body, ctx, { exclude, anaphora, repeat, deictic, context: pickContext(ctx) });
  if (!capMedium && !textCap) return res;
  return res.map((r) => (r.kind === 'ISSUE' ? { ...r, confidence: 'MEDIUM' as const } : r));
}

/** 슬롯을 빌려 올 곳: 같은 문장의 앞 절(local) 또는 직전 발행 명령 */
interface Source {
  id?: CommandId;
  target?: Target;
  action: Action;
  location?: Location;
}

/**
 * 문맥에서 빠진 슬롯을 채운다. 같은 문장의 앞 절(`local`)을 직전 발행 명령보다 먼저 쓴다.
 * 채운 게 있으면 근거를 돌려준다(앞 절만 쓴 경우 commandIds는 비어 있다).
 */
function fillFromContext(b: Built, x: IssueExtras, local?: Source): ContextUse | undefined {
  const filled: ContextUse['filled'] = [];
  const ids: CommandId[] = [];
  const sources: Source[] = [...(local ? [local] : []), ...x.context];
  const use = (c: Source) => {
    if (c.id && !ids.includes(c.id)) ids.push(c.id);
  };
  const recent = sources[0];
  if (!recent) return undefined;
  if (!b.location && (x.anaphora || x.repeat)) {
    const withLoc = sources.find((c) => c.location);
    if (withLoc?.location) {
      b.location = withLoc.location;
      filled.push('location');
      use(withLoc);
    }
  }
  if (x.repeat) {
    if (!b.action) {
      b.action = recent.action;
      b.weak = false;
      filled.push('action');
      use(recent);
    }
    // 같은 행동을 다시 하라는 뜻일 때만 대상도 가져온다 (다른 행동이면 누구에게인지 알 수 없다)
    if (!b.target && recent.target && b.action === recent.action) {
      b.target = recent.target;
      filled.push('target');
      use(recent);
    }
  }
  if (!filled.length) return undefined;
  return { commandIds: ids, filled };
}

interface IssueExtras {
  /** 제외 표현으로 빠진 파티. 대상이 전체이거나 없으면 나머지 파티로 바꾼다 */
  exclude?: PartyId[];
  /** 문맥 표현 사용 여부 */
  anaphora: boolean;
  repeat: boolean;
  /** 사전에 없는 장소 지시어("저기", "여기")가 있다 */
  deictic: boolean;
  context: ContextCommand[];
}

// ---------------------------------------------------------------------------
// 제외 표현·문맥 표현·상대 서술

/** 어절 경계에서만 읽는다: "이거 기다려"의 "거기", "다 시작해"의 "다시"를 문맥 표현으로 보지 않는다. */
const UNITS = SUFFIX_UNITS.map(esc).join('|');
const wordRe = (body: string) => new RegExp(`(?:^|\\s)(?:${body})(?:${UNITS})*(?=\\s|$)`, 'u');
const ANAPHORA = wordRe('거기|그쪽|그곳|그\\s?자리|그\\s?위치|아까\\s?(?:그\\s?)?(?:위치|자리)|아까처럼');
const REPEAT_WORDS = wordRe('다시|똑같이|똑같은|한\\s?번\\s?더|한\\s?번만\\s?더|또\\s?한\\s?번');
/** 사전에 없는 장소 지시어: 위치로 채울 수 없으니 위치가 비면 자동 발행하지 않는다 */
const DEICTIC = wordRe('저기|여기|저쪽|이곳|저곳');
/** 접속형 뒤 "있-"+서술 어미 */
const PROGRESSIVE = /^있(?:네|습|어요|아요|죠|지요|는|군|구나|다|었|던)/;
const REPEAT_FILLER = new RegExp(`^(?:${UNITS}|좀|더|한번|그대로)*$`, 'u');

/** 반복어가 슬롯 없이 다른 말 사이에 낀 경우("아 다시 말할게요", "다들 한번 더 힘내요")를 걸러낸다. 남는 말이 조사·어미뿐일 때만 반복 명령이다. */
function repeatIsShort(t: string, ms: Mention[]): boolean {
  let s = t;
  for (const m of [...ms].sort((a, b) => b.start - a.start)) s = s.slice(0, m.start) + ' ' + s.slice(m.end);
  s = s.replace(REPEAT_WORDS, ' ');
  return s
    .split(/\s+/)
    .filter(Boolean)
    .every((tk) => REPEAT_FILLER.test(tk));
}

function pickContext(ctx: ParseContext): ContextCommand[] {
  return (ctx.options?.context ?? [])
    .filter((c) => ctx.now - c.issuedAt <= CONTEXT_WINDOW_MS)
    .sort((a, b) => b.issuedAt - a.issuedAt)
    .slice(0, CONTEXT_MAX);
}

const ENEMY_SUBJECT = /(?:^|\s)(?:상대방?|상대편|적군?|저쪽)(?:이|가|은|는|들)?(?=\s|$)/;
const NARRATIVE_END = /(?:네요?|는데요?|던데요?|왔다|왔어요?|온다|오는데요?|오고있)$/;

function isEnemyNarration(t: string): boolean {
  return ENEMY_SUBJECT.test(t) && NARRATIVE_END.test(t.replace(/ /g, ''));
}

function findExclusion(t: string): { start: number; end: number } | undefined {
  const m = /빼고|제외|빼면|말구/.exec(t);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}

/**
 * 제외 표현 앞(또는 "다 모여 1파티 빼고"처럼 뒤)에 붙은 파티 나열을 빼낸다.
 * 남은 말에 대상 파티가 없으면 `exclude`를 돌려주고, issue()가 전체에서 그 파티를 뺀 나머지를 대상으로 한다.
 * 파티 목록이 없거나 방에 없는 파티가 섞이면 손대지 않는다(후보 유지).
 */
function applyExclusion(
  body: Mention[],
  ex: { start: number; end: number },
  parties: readonly Party[],
): { body: Mention[]; exclude?: PartyId[] } {
  if (!parties.length) return { body };
  const ms = body.filter((m) => !(m.start < ex.end && ex.start < m.end));
  const before = ms.filter((m) => m.end <= ex.start);
  const after = ms.filter((m) => m.start >= ex.end);
  let i = before.length;
  while (i > 0 && before[i - 1]?.kind === 'party') i--;
  const run = before.slice(i);
  if (!run.length) return { body };
  const rest = [...before.slice(0, i), ...after];
  // "1파티 빼고 2파티 3파티 모여"처럼 남은 말에 대상이 있으면 그대로 쓴다
  if (rest.some((m) => m.kind === 'party' || m.kind === 'unknown')) return { body: rest };
  return { body: rest, exclude: uniq(run.map((m) => m.value)) };
}

function issue(ms: Mention[], ctx: ParseContext, x: IssueExtras): ParseResult[] {
  const useContext = x.anaphora || x.repeat;
  if (ms.length === 0 && !(useContext && x.context.length)) return [{ kind: 'NONE', reason: '명령 표현 없음' }];
  const asAll = ctx.options?.targetlessAsAll === true;
  const results: ParseResult[] = [];
  let unknownParty: string | undefined;
  let weakOnly = false;
  const clauses = splitClauses(ms);
  if (!clauses.length) clauses.push({ ms: [], borrowed: [], reordered: false });

  let local: Source | undefined;
  let droppedTarget = false;
  for (const [ci, cl] of clauses.entries()) {
    const b = buildClause(cl);
    if (b.unknown) {
      unknownParty ??= b.unknown;
      continue;
    }
    const used = useContext ? fillFromContext(b, x, local) : undefined;
    // 대상만 있고 행동이 없어 버려지는 절("1파티 모이고 2파티")은 후보로 남긴다: 이 문장의 다른 결과도 중간으로 낮춘다
    if (!b.action && b.target) droppedTarget = true;
    if (!b.action) continue;
    local = { target: b.target, action: b.action, location: b.location };
    if (x.exclude && (!b.target || b.target.kind === 'ALL')) {
      const rest = ctx.parties.map((p) => p.id).filter((id) => !x.exclude?.includes(id));
      if (!rest.length) continue;
      b.target = { kind: 'PARTIES', partyIds: rest };
    }
    if (b.weak && !b.target && !b.location) {
      weakOnly = true;
      continue;
    }
    const targetless = !b.target;
    const supportMissing = b.action === 'SUPPORT' && !b.supportPartyIds && !b.location;
    // 문맥 표현("거기", "다시")이 있는데 채울 문맥이 없어 빠진 채 남았으면 자동 발행하지 않는다
    const unresolved = useContext && ((x.anaphora && !b.location) || (x.repeat && !b.target));
    // 접속형("막고")은 뒤 절이 이어질 때만 명령이다. 장소 지시어는 위치가 비면 알 수 없다.
    const connTail = b.connective && ci === clauses.length - 1;
    const deicticMissing = x.deictic && !b.location;
    const high =
      !used &&
      !connTail &&
      !deicticMissing &&
      !unresolved &&
      !b.weak &&
      !b.conflict &&
      !b.filled &&
      !b.reordered &&
      !b.mixed &&
      !supportMissing &&
      (!targetless || asAll);
    const draft: CommandDraft = { target: b.target ?? { kind: 'ALL' }, action: b.action };
    if (b.location) draft.location = b.location;
    if (b.supportPartyIds) draft.supportPartyIds = b.supportPartyIds;
    const evidence = b.evidence;
    results.push({
      kind: 'ISSUE',
      draft,
      confidence: high ? 'HIGH' : 'MEDIUM',
      evidence,
      ...(used && used.commandIds.length ? { context: used } : {}),
    });
  }
  if (results.length) {
    if (!droppedTarget) return results;
    return results.map((r) => (r.kind === 'ISSUE' ? { ...r, confidence: 'MEDIUM' as const } : r));
  }
  if (unknownParty) return [{ kind: 'NONE', reason: `방에 없는 파티: ${unknownParty}` }];
  if (weakOnly) return [{ kind: 'NONE', reason: '모호한 행동 표현뿐 (대상·위치 없음)' }];
  return [{ kind: 'NONE', reason: '행동 없음' }];
}
