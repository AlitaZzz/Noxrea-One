export class SessionChangedError extends Error {
  constructor() {
    super("Session changed");
    this.name = "SessionChangedError";
  }
}

let controller = new AbortController();
const listeners = new Set<() => void>();

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Invalidate work before resetting account-owned caches. */
export function changeSession(): void {
  const previous = controller;
  controller = new AbortController();
  previous.abort(new SessionChangedError());
  for (const listener of listeners) listener();
}

export function captureSession() {
  const signal = controller.signal;
  const assertCurrent = () => {
    if (signal.aborted) throw new SessionChangedError();
  };
  return {
    signal,
    assertCurrent,
    async run<T>(task: () => Promise<T>): Promise<T> {
      assertCurrent();
      try {
        return await task();
      } finally {
        // Also discard failures: an old request must not affect the new session.
        assertCurrent();
      }
    },
  };
}
