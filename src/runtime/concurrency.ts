interface Waiter {
  grant: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** Bound active work and queue growth across every database instance. */
export class QueryGate {
  private active = 0;
  private queue: Waiter[] = [];
  constructor(
    private maximum = 8,
    private queueLimit = 64
  ) {}
  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active >= this.maximum) {
      if (this.queue.length >= this.queueLimit)
        throw new Error('Query queue is full; retry after current queries finish');
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          grant: resolve,
          reject,
          timer: setTimeout(() => {
            const index = this.queue.indexOf(waiter);
            if (index >= 0) this.queue.splice(index, 1);
            reject(new Error('Query queue wait timed out'));
          }, timeoutMs),
        };
        this.queue.push(waiter);
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant();
      } else this.active--;
    };
  }
}
