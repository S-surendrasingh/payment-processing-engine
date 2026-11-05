import { AppError, ProcessorTimeout } from './errors.js';
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProcessorTimeout());
          controller.abort();
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
// Bound queued as well as active work. A real adapter must honor AbortSignal.
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly concurrency: number,
    private readonly maxQueue = 100,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maxQueue)
        throw new AppError(
          503,
          'PROCESSOR_BUSY',
          'Processor capacity exhausted; retry the same key',
          true,
        );
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
export const backoffMs = (attempts: number) => Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9));
