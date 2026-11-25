import type { Action, Location, Party, PartyId, Target } from '@winds/protocol';
import type { CommandDraft } from '@winds/parser';
import { ACTION_LABEL, partyById } from '../shared/labels';

/** "3파티 방어 우측", "전체 집결 중앙", "1·2파티 이동". */
export function describeDraft(
  d: { target: Target; action: Action; location?: Location | null },
  parties: Party[],
): string {
  const t =
    d.target.kind === 'ALL'
      ? '전체'
      : d.target.partyIds
          .map((id: PartyId) => {
            const p = partyById(parties, id);
            return p ? `${p.number}` : '?';
          })
          .join('·') + '파티';
  return [t, ACTION_LABEL[d.action], d.location?.label].filter(Boolean).join(' ');
}

/** Patch of a correction, e.g. "→ 우측 이동". */
export function describePatch(patch: Partial<CommandDraft>, parties: Party[]): string {
  const bits: string[] = [];
  if (patch.target) bits.push(describeDraft({ target: patch.target, action: 'HOLD' }, parties).replace(/ 대기$/, ''));
  if (patch.action) bits.push(ACTION_LABEL[patch.action]);
  if (patch.location) bits.push(patch.location.label);
  return bits.join(' ') || '정정';
}

const ERROR_TEXT: Record<string, string> = {
  FORBIDDEN: '권한 없음',
  RATE_LIMITED: '요청이 너무 많음',
  UNKNOWN_PARTY: '없는 파티',
  UNKNOWN_COMMAND: '이미 사라진 명령',
  VERSION_CONFLICT: '다른 변경이 먼저 적용됨',
  INVALID_MESSAGE: '잘못된 요청',
  UNAUTHORIZED: '인증 실패',
  ROOM_NOT_FOUND: '방을 찾을 수 없음',
  ROOM_FULL: '방이 가득 참',
};

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? code;
}

export const NOTE_TEXT = {
  CORRECTION_AS_NEW: '정정 대상이 이미 바뀌어 새 명령으로 발행했습니다',
  REPEATED: '재강조',
  ALREADY_CANCELLED: '이미 취소된 명령입니다',
} as const;
