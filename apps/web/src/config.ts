/** API base. Empty string = same origin (Vite proxies /api in dev). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

/** 음성 인식 모델 다운로드 base. 비우면 패키지 기본(Hugging Face 고정 리비전). 끝 슬래시는 패키지가 정리한다 */
export const STT_MODEL_BASE: string = import.meta.env.VITE_STT_MODEL_BASE ?? '';

/** @winds/stt를 불러온 직후 한 번 호출해 환경 변수를 주입한다 */
export function applySttConfig(stt: { setModelBase(base: string | undefined): void }): void {
  stt.setModelBase(STT_MODEL_BASE || undefined);
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** ws(s) URL for a room. Works for same-origin and absolute VITE_API_BASE. */
export function wsUrl(code: string, base: string = API_BASE, loc: Pick<Location, 'origin'> = location): string {
  const origin = base || loc.origin;
  return `${origin.replace(/^http/, 'ws')}/api/rooms/${encodeURIComponent(code)}/ws`;
}
