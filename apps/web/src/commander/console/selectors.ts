import type { Command } from '@winds/protocol';
import type { RoomData } from '../../state/roomStore';

type CmdState = Pick<RoomData, 'slots' | 'commands'>;

/**
 * Commands that are the current command of at least one party. This is read off the server-owned
 * slots; the client never recomputes slot rules. (Client-side `status` stays ACTIVE for superseded
 * commands because events carry no per-command status, so slots are the reliable source.)
 */
export function currentCommands(state: CmdState): Command[] {
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const stack of Object.values(state.slots)) {
    const id = stack[stack.length - 1];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const c = state.commands[id];
    if (c && c.status !== 'CANCELLED' && c.status !== 'CORRECTED') out.push(c);
  }
  return out;
}

/** FR-F08-6: newest current command regardless of source, skipping ids whose cancel is in flight. */
export function findLastActive(state: CmdState, exclude: ReadonlySet<string> = new Set()): Command | undefined {
  let best: Command | undefined;
  for (const c of currentCommands(state)) {
    if (exclude.has(c.id)) continue;
    if (!best || c.seq > best.seq) best = c;
  }
  return best;
}

/** The ALL line: newest ALL-target command that is still current somewhere. */
export function findCurrentAllCommand(state: CmdState): Command | undefined {
  let best: Command | undefined;
  for (const c of currentCommands(state)) {
    if (c.target.kind === 'ALL' && (!best || c.seq > best.seq)) best = c;
  }
  return best;
}
