import { errorMessage } from "../types";

export type OnceState<T> = { value?: T; error: string; loading: boolean };

/**
 * A resource read once and kept, shared by everyone who asks for it. A failure is
 * kept to be shown, but the next request reads it again.
 */
export class Once<T> {
  private state: OnceState<T> = { error: "", loading: false };
  private controller?: AbortController;
  private listeners = new Set<() => void>();

  constructor(private readonly read: (signal: AbortSignal) => Promise<T>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(state: OnceState<T>) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** Starts reading unless it is read or being read. */
  load() {
    if (this.state.loading || this.state.value !== undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ ...this.state, loading: true });
    this.read(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) this.set({ value, error: "", loading: false });
      },
      (error) => {
        if (!controller.signal.aborted) this.set({ error: errorMessage(error), loading: false });
      },
    );
  }

  /** Forgets the value and stops a read under way. */
  clear() {
    this.controller?.abort();
    this.controller = undefined;
    this.set({ error: "", loading: false });
  }
}
