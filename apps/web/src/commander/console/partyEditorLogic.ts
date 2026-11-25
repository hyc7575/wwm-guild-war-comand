import { LIMITS, PARTY_COLORS, type Party } from '@winds/protocol';
import { parseAliases } from '../CreateRoomPage';
import type { PartyDraft } from '../lastConfig';

/** One editable row. `id` is set for parties that already exist on the server. */
export interface EditorRow {
  key: string;
  id?: string;
  name: string;
  aliasText: string;
}

let keyCounter = 0;
export const newKey = () => `row-${++keyCounter}`;

export function rowsFromParties(parties: Party[]): EditorRow[] {
  return parties.map((p) => ({ key: newKey(), id: p.id, name: p.name ?? '', aliasText: p.aliases.join(', ') }));
}

export function addRow(rows: EditorRow[]): EditorRow[] {
  return rows.length >= LIMITS.maxParties ? rows : [...rows, { key: newKey(), name: '', aliasText: '' }];
}

export function removeRow(rows: EditorRow[], index: number): EditorRow[] {
  return rows.length <= LIMITS.minParties ? rows : rows.filter((_, i) => i !== index);
}

export function moveRow(rows: EditorRow[], index: number, delta: -1 | 1): EditorRow[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function validateRows(rows: EditorRow[]): Array<string | null> {
  return rows.map((r) => {
    if (r.name.trim().length > LIMITS.partyNameMax) return `이름은 ${LIMITS.partyNameMax}자까지`;
    const aliases = parseAliases(r.aliasText);
    if (aliases.length > LIMITS.maxAliasesPerParty) return `별칭은 ${LIMITS.maxAliasesPerParty}개까지`;
    if (aliases.some((a) => a.length > LIMITS.partyAliasMax)) return `별칭은 ${LIMITS.partyAliasMax}자까지`;
    return null;
  });
}

export function rowsValid(rows: EditorRow[]): boolean {
  return rows.length >= LIMITS.minParties && rows.length <= LIMITS.maxParties && validateRows(rows).every((e) => e === null);
}

/** Existing parties keep id and color (so member screens do not flicker); new ones get a fresh id and an unused color. */
export function buildPartiesPayload(rows: EditorRow[], existing: Party[], newId: () => string = defaultId): Party[] {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const usedColors = new Set(rows.flatMap((r) => (r.id && byId.get(r.id) ? [byId.get(r.id)!.color] : [])));
  const usedIds = new Set(existing.map((p) => p.id));
  return rows.map((r, i) => {
    const name = r.name.trim();
    const aliases = parseAliases(r.aliasText);
    const prev = r.id ? byId.get(r.id) : undefined;
    let id = prev?.id;
    let color = prev?.color;
    if (!prev) {
      do id = newId();
      while (usedIds.has(id));
      usedIds.add(id);
      color = PARTY_COLORS.find((c) => !usedColors.has(c)) ?? PARTY_COLORS[i % PARTY_COLORS.length]!;
      usedColors.add(color);
    }
    return { id: id!, number: i + 1, ...(name ? { name } : {}), aliases, color: color! };
  });
}

function defaultId(): string {
  return `p${Math.random().toString(36).slice(2, 8)}`;
}

/** Existing parties removed by these rows, with what would be lost (FR: warn before deleting). */
export function removalImpact(
  rows: EditorRow[],
  existing: Party[],
  memberCount: (partyId: string) => number,
  activeCommandCount: (partyId: string) => number,
): Array<{ party: Party; members: number; commands: number }> {
  const kept = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  return existing
    .filter((p) => !kept.has(p.id))
    .map((p) => ({ party: p, members: memberCount(p.id), commands: activeCommandCount(p.id) }))
    .filter((x) => x.members > 0 || x.commands > 0);
}

export function toLastConfig(parties: Party[]): PartyDraft[] {
  return parties.map((p) => ({ name: p.name ?? '', aliases: p.aliases }));
}
