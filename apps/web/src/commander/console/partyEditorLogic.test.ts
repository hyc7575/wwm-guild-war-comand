import { describe, expect, it } from 'vitest';
import { makeDefaultParties } from '@winds/protocol';
import { addRow, buildPartiesPayload, moveRow, removalImpact, removeRow, rowsFromParties, rowsValid, validateRows } from './partyEditorLogic';

const base = () => makeDefaultParties(3);

describe('party editor logic', () => {
  it('unchanged rows produce the same parties (ids and colors kept)', () => {
    const parties = base();
    expect(buildPartiesPayload(rowsFromParties(parties), parties)).toEqual(parties);
  });

  it('rename + aliases + reorder: ids/colors follow the party, numbers follow the position', () => {
    const parties = base();
    let rows = rowsFromParties(parties);
    rows[0] = { ...rows[0]!, name: '본대', aliasText: '본진, 메인' };
    rows = moveRow(rows, 0, 1);
    const out = buildPartiesPayload(rows, parties);
    expect(out.map((p) => [p.id, p.number, p.color])).toEqual([['p2', 1, 'p2'], ['p1', 2, 'p1'], ['p3', 3, 'p3']]);
    expect(out[1]).toMatchObject({ name: '본대', aliases: ['본진', '메인'] });
  });

  it('new party gets a fresh id and an unused color; delete removes it from the payload', () => {
    const parties = base();
    let rows = removeRow(rowsFromParties(parties), 0); // delete p1
    rows = addRow(rows);
    const out = buildPartiesPayload(rows, parties, () => 'new1');
    expect(out.map((p) => p.id)).toEqual(['p2', 'p3', 'new1']);
    expect(out[2]!.color).toBe('p1');
    expect(out.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('enforces min 1 / max 12 and name length', () => {
    expect(removeRow(rowsFromParties(makeDefaultParties(1)), 0)).toHaveLength(1);
    let rows = rowsFromParties(makeDefaultParties(12));
    expect(addRow(rows)).toHaveLength(12);
    rows = rowsFromParties(base());
    rows[0] = { ...rows[0]!, name: '12345678901' };
    expect(validateRows(rows)[0]).toMatch(/10자/);
    expect(rowsValid(rows)).toBe(false);
  });

  it('removalImpact lists only deleted parties that have members or active commands', () => {
    const parties = base();
    const rows = rowsFromParties(parties).slice(1); // p1 deleted
    expect(removalImpact(rows, parties, () => 0, () => 0)).toEqual([]);
    const hit = removalImpact(rows, parties, (id) => (id === 'p1' ? 4 : 0), () => 1);
    expect(hit).toEqual([{ party: parties[0], members: 4, commands: 1 }]);
  });
});
