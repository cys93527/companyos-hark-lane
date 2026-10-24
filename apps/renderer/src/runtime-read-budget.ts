/** Renderer deadlines do not cancel ipcRenderer.invoke. Keep the physical slot
 * until that promise actually settles, including across Goal changes/timeouts. */
export const RUNTIME_READ_TIMEOUT_MS = 15_000;
export const MAX_PENDING_RUNTIME_READS = 2;

export class RuntimeReadError extends Error {
  constructor(readonly code: 'RUNTIME_READ_TIMEOUT' | 'RUNTIME_READ_BLOCKED' | 'RUNTIME_READ_CANCELLED') {
    super(code);
  }
}

export function createRuntimeReadBudget() {
  const pending = new Set<Promise<unknown>>();
  const cancelWaits = new Set<() => void>();
  return {
    async read<T>(invoke: () => Promise<T>): Promise<T> {
      if (pending.size >= MAX_PENDING_RUNTIME_READS) throw new RuntimeReadError('RUNTIME_READ_BLOCKED');
      const request = invoke();
      pending.add(request);
      const settled = () => { pending.delete(request); };
      void request.then(settled, settled);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeReadError('RUNTIME_READ_TIMEOUT')), RUNTIME_READ_TIMEOUT_MS);
        cancel = () => reject(new RuntimeReadError('RUNTIME_READ_CANCELLED'));
        cancelWaits.add(cancel);
      });
      try {
        return await Promise.race([request, deadline]);
      } finally {
        clearTimeout(timer);
        if (cancel !== undefined) cancelWaits.delete(cancel);
      }
    },
    cancelWaits() {
      // Stops local waits only. Physical requests still occupy their slots.
      for (const cancel of cancelWaits) cancel();
      cancelWaits.clear();
    },
  };
}
