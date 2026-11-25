import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CommandDraft } from '@winds/parser';
import { useRoomSession } from '../../net/RoomSession';
import { useRoomStore } from '../../state/roomStore';
import type { Candidate, PipelineSnapshot, SubtitleLine } from '../pipeline/CommandPipeline';
import { SessionMetrics } from '../metrics';
import { SessionSummaryCollector, type CollectorSource } from '../summary/collector';
import { defaultSummaryStore } from '../summary/store';
import { ConsoleController, type ConsoleStore } from './ConsoleController';
import type { TrackedRequest } from './IssueTracker';

const Ctx = createContext<ConsoleController | null>(null);

export function useConsole(): ConsoleController {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConsole must be used inside <ConsoleProvider>');
  return c;
}

/** Test seam: provide a prebuilt controller. */
export function ConsoleControllerProvider({ controller, children }: { controller: ConsoleController; children: ReactNode }) {
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

/** Creates the per-room controller from the RoomSession client and the zustand store. */
export function ConsoleProvider({ children }: { children: ReactNode }) {
  const { client } = useRoomSession();
  const [controller, setController] = useState<ConsoleController | null>(null);
  useEffect(() => {
    const metrics = new SessionMetrics();
    const roomCode = useRoomStore.getState().roomCode;
    const summary = roomCode
      ? new SessionSummaryCollector({
          roomCode,
          source: useRoomStore as unknown as CollectorSource,
          store: defaultSummaryStore(),
          getMetrics: () => metrics.snapshot(),
        })
      : undefined;
    const c = new ConsoleController({
      client,
      store: useRoomStore as unknown as ConsoleStore,
      metrics,
      summary,
    });
    void summary?.start();
    setController(c);
    return () => {
      summary?.dispose();
      c.dispose();
      setController(null);
    };
  }, [client]);
  if (!controller) return null;
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

export interface CommandPipelineApi {
  /** Called by the STT engine with each final transcript. */
  onFinal(text: string, opts?: { endedAt?: number }): void;
  onPartial(text: string): void;
  subtitles: SubtitleLine[];
  partial: string;
  candidates: Candidate[];
  publishCandidate(id: string): void;
  /** Removes the candidate and returns the draft the button panel should show. */
  editCandidate(id: string): Partial<CommandDraft> | undefined;
  dismissCandidate(id: string): void;
}

export function useCommandPipeline(): CommandPipelineApi {
  const { pipeline } = useConsole();
  const snap: PipelineSnapshot = useSyncExternalStore(
    useCallback((fn) => pipeline.subscribe(fn), [pipeline]),
    () => pipeline.getSnapshot(),
  );
  return useMemo(
    () => ({
      onFinal: (text, opts) => pipeline.onFinalTranscript(text, { endedAt: opts?.endedAt ?? Date.now() }),
      onPartial: (text) => pipeline.onPartialTranscript(text),
      subtitles: snap.subtitles,
      partial: snap.partial,
      candidates: snap.candidates,
      publishCandidate: (id) => pipeline.publishCandidate(id),
      editCandidate: (id) => pipeline.editCandidate(id),
      dismissCandidate: (id) => pipeline.dismissCandidate(id),
    }),
    [pipeline, snap],
  );
}

/** Tracked requests (newest last) re-rendered on every change, plus a 500ms clock for the 2s "전송 지연" rule. */
export function useTrackedRequests(): { entries: TrackedRequest[]; now: number } {
  const { tracker } = useConsole();
  const entries = useSyncExternalStore(
    useCallback((fn) => tracker.subscribe(fn), [tracker]),
    () => tracker.getEntries(),
  );
  const [now, setNow] = useState(() => Date.now());
  const pending = entries.some((e) => !e.ack);
  useEffect(() => {
    setNow(Date.now());
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [pending, entries]);
  return { entries, now };
}
