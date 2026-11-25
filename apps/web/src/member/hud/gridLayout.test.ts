import { describe, expect, it } from 'vitest';
import { makeDefaultParties, type Command } from '@winds/protocol';
import { COMPACT_MIN_PARTIES, gridColumns, gridTier, orderParties, shouldCompactIdle } from './gridLayout';

const cmd = { id: 'c' } as Command;

describe('gridTier', () => {
  it('splits at 600 and 900px', () => {
    expect([360, 599, 600, 899, 900, 1400].map(gridTier)).toEqual(['phone', 'phone', 'tablet', 'tablet', 'wide', 'wide']);
  });
});

describe('gridColumns', () => {
  it('phones use 2 columns, tablets 3', () => {
    expect(gridColumns(11, 'phone')).toBe(2);
    expect(gridColumns(11, 'tablet')).toBe(3);
  });
  it('wide screens use 3 up to 6 cells, 4 beyond', () => {
    expect(gridColumns(6, 'wide')).toBe(3);
    expect(gridColumns(7, 'wide')).toBe(4);
    expect(gridColumns(12, 'wide')).toBe(4);
  });
  it('never exceeds the cell count, minimum 1', () => {
    expect(gridColumns(0, 'wide')).toBe(1);
    expect(gridColumns(1, 'phone')).toBe(1);
    expect(gridColumns(2, 'wide')).toBe(2);
  });
});

describe('orderParties', () => {
  const parties = makeDefaultParties(12);
  const has = new Set(['p3', 'p9', 'p1']);
  const commandOf = (id: string) => (has.has(id) ? cmd : null);

  it('keeps party-number order when the option is off', () => {
    expect(orderParties(parties, commandOf, false)).toBe(parties);
  });
  it('puts parties with a command first, each group in number order', () => {
    const out = orderParties(parties, commandOf, true).map((p) => p.number);
    expect(out.slice(0, 3)).toEqual([1, 3, 9]);
    expect(out.slice(3)).toEqual([2, 4, 5, 6, 7, 8, 10, 11, 12]);
  });
  it('does not mutate its input', () => {
    const before = parties.map((p) => p.number);
    orderParties(parties, commandOf, true);
    expect(parties.map((p) => p.number)).toEqual(before);
  });
});

describe('shouldCompactIdle', () => {
  it('needs the option and 8+ parties', () => {
    expect(shouldCompactIdle(COMPACT_MIN_PARTIES, true)).toBe(true);
    expect(shouldCompactIdle(COMPACT_MIN_PARTIES - 1, true)).toBe(false);
    expect(shouldCompactIdle(12, false)).toBe(false);
  });
});
