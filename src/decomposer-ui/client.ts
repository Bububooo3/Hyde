export class DecomposerWorkerClient {
  private worker = this.createWorker();
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  private createWorker(): Worker {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      const { id, ok, result, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (ok) pending.resolve(result); else pending.reject(new Error(error));
    };
    worker.onerror = event => {
      for (const item of this.pending.values()) item.reject(new Error(event.message || 'Decomposer worker failed.'));
      this.pending.clear();
    };
    return worker;
  }
  call<T = any>(type: string, payload?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }
  restart(): void {
    for (const item of this.pending.values()) item.reject(new Error('CANCELED'));
    this.pending.clear(); this.worker.terminate(); this.worker = this.createWorker();
  }
  close(): void {
    for (const item of this.pending.values()) item.reject(new Error('CANCELED'));
    this.pending.clear(); this.worker.terminate();
  }
}
