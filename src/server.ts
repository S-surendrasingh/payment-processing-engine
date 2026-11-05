import { db } from './database/client.js';
import { config } from './config/env.js';
import { createApp } from './app.js';
import { MockPaymentProcessor } from './modules/processors/mock-processor.js';
import { logger } from './shared/logger.js';
import { startWorker } from './worker.js';
await db.$connect();
const { app, payments, webhooks } = createApp(
  db,
  new MockPaymentProcessor(db),
  config.WEBHOOK_SECRET,
);
const server = app.listen(config.PORT, config.HOST, () =>
  logger.info({ port: config.PORT, host: config.HOST }, 'Payment demo listening'),
);
const stopWorker = startWorker(payments, webhooks, config.WORKER_INTERVAL_MS);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
    stopWorker(),
  ]);
  await db.$disconnect();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
