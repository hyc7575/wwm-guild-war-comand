export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

export const MIC_STORAGE_KEY = 'winds.stt.deviceId';

/** 라벨은 마이크 권한을 받은 뒤에야 채워진다. 없으면 번호로 대신한다 */
export async function listMicrophones(
  md: Pick<MediaDevices, 'enumerateDevices'> | undefined = globalThis.navigator?.mediaDevices,
): Promise<MicrophoneInfo[]> {
  if (!md) return [];
  const all = await md.enumerateDevices();
  let n = 0;
  return all
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || `마이크 ${++n}` }));
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // 접근 차단(시크릿 모드 등)
  }
}

export function getRememberedMic(s: StorageLike | undefined = storage()): string | undefined {
  try {
    return s?.getItem(MIC_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberMic(
  deviceId: string | undefined,
  s: StorageLike | undefined = storage(),
): void {
  try {
    if (!s) return;
    if (deviceId) s.setItem(MIC_STORAGE_KEY, deviceId);
    else s.removeItem(MIC_STORAGE_KEY);
  } catch {
    /* 저장 실패는 무시: 기억만 못 할 뿐이다 */
  }
}

/** 기억해 둔 장치가 지금 목록에 있을 때만 돌려준다(없으면 시스템 기본 마이크) */
export async function resolveRememberedMic(
  md?: Pick<MediaDevices, 'enumerateDevices'>,
  s?: StorageLike,
): Promise<string | undefined> {
  const id = getRememberedMic(s);
  if (!id) return undefined;
  const mics = await listMicrophones(md);
  return mics.some((m) => m.deviceId === id) ? id : undefined;
}
