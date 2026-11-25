import type { SttEventName, SttEvents, SttState } from './types';

type Listener<K extends SttEventName> = (payload: SttEvents[K]) => void;

/** 엔진 공통 이벤트 발행기. 리스너 예외가 다른 리스너를 막지 않게 한다 */
export class EngineEmitter {
  private listeners = new Map<SttEventName, Set<Listener<never>>>();
  private _state: SttState = 'IDLE';

  get state(): SttState {
    return this._state;
  }

  on<K extends SttEventName>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb as Listener<never>);
    return () => set.delete(cb as Listener<never>);
  }

  protected emit<K extends SttEventName>(event: K, payload: SttEvents[K]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      try {
        (cb as Listener<K>)(payload);
      } catch (e) {
        console.error('[stt] listener error', e);
      }
    }
  }

  protected setState(next: SttState): void {
    if (this._state === next) return;
    this._state = next;
    this.emit('state', next);
  }
}
