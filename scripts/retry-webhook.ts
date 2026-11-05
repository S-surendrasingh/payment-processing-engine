import { db } from '../src/database/client.js';
import { config } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { MockPaymentProcessor } from '../src/modules/processors/mock-processor.js';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run webhook:retry -- <event ID>');
  const { webhooks } = createApp(db, new MockPaymentProcessor(db), config.WEBHOOK_SECRET);
  console.log(await webhooks.retry(process.argv[2]));
} finally {
  await db.$disconnect();
}
