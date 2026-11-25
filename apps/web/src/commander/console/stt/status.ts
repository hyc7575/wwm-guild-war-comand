import type { SttState } from '@winds/protocol';

/** Mirrors SupervisorState of @winds/stt without importing it (this file ships in the commander chunk, the lib is lazy). */
export type UiSttState =
  | 'IDLE'
  | 'PREPARING'
  | 'READY'
  | 'LISTENING'
  | 'STOPPED'
  | 'ERROR'
  | 'RECOVERING'
  | 'DISCONNECTED';

/** What members/operators are told (protocol `stt.status`). */
export function toServerState(s: UiSttState): SttState {
  switch (s) {
    case 'LISTENING':
      return 'LISTENING';
    case 'PREPARING':
    case 'READY':
    case 'RECOVERING':
      return 'STARTING';
    case 'ERROR':
    case 'DISCONNECTED':
      return 'ERROR';
    case 'IDLE':
    case 'STOPPED':
      return 'OFF';
  }
}

export interface StatusView {
  label: string;
  /** Mantine color name. Never the only signal: the label is always shown with it. */
  color: 'gray' | 'yellow' | 'green' | 'red' | 'orange';
}

/** FR-F02-3: big status = color + text. Texts match `statusLabel` of @winds/stt. */
export function statusView(s: UiSttState): StatusView {
  switch (s) {
    case 'IDLE':
    case 'PREPARING':
    case 'READY':
      return { label: '준비 중', color: 'yellow' };
    case 'LISTENING':
      return { label: '듣는 중', color: 'green' };
    case 'RECOVERING':
      return { label: '복구 중', color: 'orange' };
    case 'DISCONNECTED':
      return { label: '마이크 연결 끊김', color: 'red' };
    case 'STOPPED':
      return { label: '멈춤', color: 'gray' };
    case 'ERROR':
      return { label: '오류', color: 'red' };
  }
}

export const APP_TITLE = 'Winds Command';

/** FR-F02-5 tab title. */
export function tabTitle(s: UiSttState): string {
  return s === 'LISTENING' ? `● 듣는 중 - ${APP_TITLE}` : `${statusView(s).label} - ${APP_TITLE}`;
}

export type ErrorKind = 'permission' | 'unsupported' | 'other';

export function classifyError(message: string, code?: string): ErrorKind {
  if (/NotAllowed|not-allowed|permission|denied|권한|허용/i.test(`${code ?? ''} ${message}`)) return 'permission';
  return 'other';
}
