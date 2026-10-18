/** A timed-out acquisition must return any later lease to its owner. */
export async function acquireLease<T>(
  pending: Promise<T>,
  timeout: number,
  release: (lease: T) => void
): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('Database connection acquisition timed out'));
    }, timeout);
  });
  void pending
    .then(
      (lease) => {
        if (expired) release(lease);
      },
      () => {}
    )
    .catch(() => {});
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Reject the caller even if a driver's cancellation never completes. */
export async function withDeadline<T>(
  work: Promise<T>,
  timeout: number,
  abort: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        abort();
      } catch {
        // Cancellation can itself fail; the caller still receives the deadline error.
      } finally {
        reject(new Error(`Database operation timed out after ${timeout}ms`));
      }
    }, timeout);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
