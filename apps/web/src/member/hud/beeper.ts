/** WebAudio beep for new commands (FR-F05-5). Short (<= 0.3s) so it does not mask Discord voice. */

export const BEEP_SECONDS = 0.18;

let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor: typeof AudioContext | undefined =
    typeof window === 'undefined' ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    ctx.addEventListener('statechange', () => listeners.forEach((l) => l()));
  } catch {
    ctx = null;
  }
  return ctx;
}

/** True when audio exists but the browser has not allowed it yet (needs a user gesture). */
export function isAudioBlocked(): boolean {
  const c = getCtx();
  return !!c && c.state !== 'running';
}

export function onAudioStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Call from a user gesture. Resolves true when audio is running. */
export async function unlockAudio(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  try {
    if (c.state !== 'running') await c.resume();
  } catch {
    /* still blocked */
  }
  listeners.forEach((l) => l());
  return c.state === 'running';
}

/** Plays one short beep. Returns false when nothing could be played (blocked / unsupported). */
export function playBeep(volume: number): boolean {
  const c = getCtx();
  if (!c || c.state !== 'running') {
    if (c) void c.resume().catch(() => undefined);
    return false;
  }
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  const peak = Math.max(0.0001, Math.min(1, volume)) * 0.5;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + BEEP_SECONDS);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + BEEP_SECONDS + 0.02);
  return true;
}
