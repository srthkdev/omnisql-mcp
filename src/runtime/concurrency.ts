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

/** Concurrent readers, with queued writes excluding both readers and other writers. */
export class ReadWriteGate {
  private writer: Promise<void> = Promise.resolve();
  private readers = new Set<Promise<void>>();
  async acquire(write: boolean, timeoutMs: number): Promise<() => void> {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const wait = write ? Promise.all([this.writer, ...this.readers]) : this.writer;
    if (write) this.writer = wait.then(() => done);
    else this.readers.add(done);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      this.readers.delete(done);
      finish();
    };
    try {
      await Promise.race([
        wait,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Database file lock wait timed out')),
            timeoutMs
          );
        }),
      ]);
      return release;
    } catch (error) {
      release();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
