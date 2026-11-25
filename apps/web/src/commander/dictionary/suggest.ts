import { compactExpression, type Dictionary } from '@winds/parser';
import type { TuningEntry } from '../pipeline/tuningLog';

export interface Suggestion {
  word: string;
  count: number;
  examples: string[];
}

function known(d: Dictionary): Set<string> {
  const s = new Set<string>();
  const add = (e: string) => s.add(compactExpression(e));
  for (const list of Object.values(d.actions)) list.forEach(add);
  [...d.targetAll, ...d.partySuffixes, ...d.correctionMarkers].forEach(add);
  for (const l of d.locations) [l.label, ...l.aliases].forEach(add);
  Object.keys(d.numberWords).forEach(add);
  return s;
}

/**
 * FR-F09-8: words that keep showing up in discarded utterances and are not in the dictionary yet.
 * A word counts once per utterance. Only words seen at least `minCount` times are suggested.
 */
export function suggestFromTuningLog(entries: readonly TuningEntry[], merged: Dictionary, minCount = 2, limit = 12): Suggestion[] {
  const inDict = known(merged);
  const byWord = new Map<string, Suggestion>();
  for (const e of entries) {
    const words = new Set(
      e.text
        .split(/[\s.,!?~…·:;"'()[\]{}]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0 && !/^\d+$/.test(w)),
    );
    for (const w of words) {
      const k = compactExpression(w);
      if (!k || inDict.has(k) || /^\d+(파티|팟|파)?$/.test(k)) continue;
      const cur = byWord.get(k) ?? { word: w, count: 0, examples: [] };
      cur.count++;
      if (cur.examples.length < 2 && !cur.examples.includes(e.text)) cur.examples.push(e.text);
      byWord.set(k, cur);
    }
  }
  return [...byWord.values()]
    .filter((s) => s.count >= minCount)
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}
