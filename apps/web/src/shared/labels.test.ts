import { describe, expect, it } from 'vitest';
import { makeDefaultParties } from '@winds/protocol';
import { partyNumbersLabel } from './labels';

describe('partyNumbersLabel', () => {
  const parties = makeDefaultParties(3);
  it('joins numbers of existing parties', () => {
    expect(partyNumbersLabel(parties, [parties[1]!.id, parties[0]!.id])).toBe('1·2파티');
  });
  it('shows a deleted-party marker instead of "?" when no id resolves', () => {
    expect(partyNumbersLabel(parties, ['gone'])).toBe('(삭제된 파티)');
  });
  it('keeps the live numbers and flags the deleted remainder', () => {
    expect(partyNumbersLabel(parties, [parties[0]!.id, 'gone'])).toBe('1파티 외 삭제된 파티');
  });
});
