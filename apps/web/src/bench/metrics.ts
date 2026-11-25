/** 한글 CER: 공백을 뺀 글자 단위 편집 거리 / 기준 길이 */
export function cer(ref: string, hyp: string): number {
  const a = [...ref.replace(/\s+/g, '')];
  const b = [...hyp.replace(/\s+/g, '')];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return (prev[b.length] ?? 0) / a.length;
}

export interface EvalCaseIn {
  id?: string;
  /** 음성이 없으면 이 텍스트를 그대로 파서에 넣는다. 음성이 있으면 기준 전사(CER 계산용) */
  text?: string;
  audioUrl?: string;
  expect: unknown[];
  [k: string]: unknown;
}

/** JSONL(또는 // # 주석 줄 포함) 파싱 */
export function parseCasesJsonl(raw: string): EvalCaseIn[] {
  const out: EvalCaseIn[] = [];
  raw.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('//') || s.startsWith('#')) return;
    let obj: EvalCaseIn;
    try {
      obj = JSON.parse(s) as EvalCaseIn;
    } catch (e) {
      throw new Error(`${i + 1}행 JSON 파싱 실패: ${(e as Error).message}`);
    }
    if (!Array.isArray(obj.expect) || obj.expect.length === 0)
      throw new Error(`${i + 1}행: expect 필요`);
    if (typeof obj.text !== 'string' && typeof obj.audioUrl !== 'string')
      throw new Error(`${i + 1}행: text 또는 audioUrl 필요`);
    out.push(obj);
  });
  return out;
}

export interface EvalRowOut {
  id?: string;
  /** 파서에 넣을 텍스트(음성 케이스는 인식 결과) */
  text: string;
  expect: unknown[];
  /** 음성 케이스의 기준 전사(있을 때) */
  ref?: string;
  cer?: number;
  stt?: { engine: string; audioMs: number; decodeMs: number; rtf: number };
  [k: string]: unknown;
}

/** 파서 골든 러너(`pnpm --filter @winds/parser golden -- file.jsonl`)가 읽을 수 있는 JSONL */
export function toGoldenJsonl(rows: EvalRowOut[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** 파일명(경로 제외)으로 선택한 WAV 파일을 찾는다 */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop()?.split('?')[0] ?? p;
}
