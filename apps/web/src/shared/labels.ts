import type { Action, CancelReason, CommandStatus, Party, Target } from '@winds/protocol';
import type { ConnectionStatus } from '../net/RoomClient';

export const ACTION_ORDER: Action[] = ['GATHER', 'MOVE', 'ATTACK', 'DEFEND', 'RETREAT', 'SUPPORT', 'HOLD'];

/** F05 표시 문구 */
export const ACTION_LABEL: Record<Action, string> = {
  GATHER: '집결',
  MOVE: '이동',
  ATTACK: '공격',
  DEFEND: '방어',
  RETREAT: '후퇴',
  SUPPORT: '지원',
  HOLD: '대기',
};

/** Quick location presets (F08). Location ids are free-form; these are just defaults. */
export const LOCATION_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'left', label: '좌측' },
  { id: 'center', label: '중앙' },
  { id: 'right', label: '우측' },
  { id: 'front', label: '앞' },
  { id: 'back', label: '뒤' },
];

export const STATUS_LABEL: Record<CommandStatus, string> = {
  ACTIVE: '유효',
  SUPERSEDED: '덮임',
  CORRECTED: '정정됨',
  CANCELLED: '취소됨',
};

export const CANCEL_REASON_LABEL: Record<CancelReason, string> = {
  MISRECOGNIZED: '오인식 취소',
  CHANGED: '취소',
  PARTY_REMOVED: '파티 삭제로 취소',
};

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  CONNECTING: '연결 중…',
  CONNECTED: '연결됨',
  RECONNECTING: '다시 연결 중… 화면의 명령이 최신이 아닐 수 있습니다',
  OFFLINE: '인터넷 연결 없음',
  CLOSED: '오더방이 종료되었습니다',
  REPLACED: '다른 탭에서 열렸습니다',
};

export function partyLabel(p: Pick<Party, 'number' | 'name'>): string {
  return p.name ? `${p.number}파티 ${p.name}` : `${p.number}파티`;
}

export function partyById(parties: Party[], id: string): Party | undefined {
  return parties.find((p) => p.id === id);
}

export function targetLabel(target: Target, parties: Party[]): string {
  if (target.kind === 'ALL') return '전체';
  return target.partyIds
    .map((id) => {
      const p = partyById(parties, id);
      return p ? `${p.number}파티` : '?';
    })
    .join('·');
}
