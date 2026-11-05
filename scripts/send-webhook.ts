import { randomUUID } from 'node:crypto';
import { db } from '../src/database/client.js';
import { config } from '../src/config/env.js';
import { signature } from '../src/modules/webhooks/webhook-service.js';
try {
  const operationId = process.argv[2];
  if (!operationId) throw new Error('Usage: npm run webhook:send -- <operation UUID> [event ID]');
  const receipt = await db.processorRecord.findUniqueOrThrow({ where: { operationId } });
  const body = Buffer.from(
    JSON.stringify({
      eventId: process.argv[3] ?? randomUUID(),
      operationId,
      paymentId: receipt.paymentId,
      type: receipt.type,
      amount: receipt.amount,
      currency: receipt.currency,
      status: receipt.status,
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`http://127.0.0.1:${config.PORT}/api/v1/webhooks/processor`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Processor-Timestamp': timestamp,
      'X-Processor-Signature': signature(body, timestamp, config.WEBHOOK_SECRET),
    },
    body,
  });
  console.log(response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
