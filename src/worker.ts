import type { PaymentService } from './modules/payments/payment-service.js';
import type { WebhookService } from './modules/webhooks/webhook-service.js';
import { logger } from './shared/logger.js';
function loop(name: string, task: () => Promise<unknown>, interval: number) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void>;
  async function tick() {
    try {
      await task();
    } catch {
      logger.error({ worker: name }, 'Worker batch failed');
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          inFlight = tick();
        }, interval);
    }
  }
  inFlight = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
}
export function startWorker(payments: PaymentService, webhooks: WebhookService, interval: number) {
  const stopRecovery = loop(
    'recovery',
    async () => {
      const results = await payments.recoverPending();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) logger.warn({ count: failed }, 'Operations require retry or investigation');
    },
    interval,
  );
  const stopWebhooks = loop('webhooks', () => webhooks.processBatch(), interval);
  return async () => {
    await Promise.all([stopRecovery(), stopWebhooks()]);
  };
}
