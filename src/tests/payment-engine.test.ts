import { classifyError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import './setup.js';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { audit } from '../modules/reconciliation/audit.js';
import { ReconciliationService } from '../modules/reconciliation/reconciliation-service.js';
import { startWorker } from '../worker.js';
import { randomUUID, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { db } from '../database/client.js';
import { createApp } from '../app.js';
import { MockPaymentProcessor } from '../modules/processors/mock-processor.js';
import { PaymentService, type CreatePayment } from '../modules/payments/payment-service.js';
import { signature } from '../modules/webhooks/webhook-service.js';
import type { PaymentProcessor } from '../modules/processors/payment-processor.js';

const secret = process.env.WEBHOOK_SECRET!;
const customerId = '11111111-1111-4111-8111-111111111111';
const input: CreatePayment = {
  amount: 1000,
  currency: 'USD',
  customerId,
  paymentMethodReference: 'pm_mock_ok',
};
const processor = new MockPaymentProcessor(db);
const services = createApp(db, processor, secret);
const { app, payments, refunds, webhooks, reconciliation } = services;
const api = '/api/v1';
async function create(overrides: Partial<CreatePayment> = {}) {
  const result = await request(app)
    .post(`${api}/payments`)
    .set('Idempotency-Key', randomUUID())
    .send({ ...input, ...overrides });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body as { id: string; status: string };
}
async function captured(overrides: Partial<CreatePayment> = {}) {
  const p = await create(overrides);
  expect((await request(app).post(`${api}/payments/${p.id}/authorize`)).status).toBe(200);
  expect((await request(app).post(`${api}/payments/${p.id}/capture`)).status).toBe(200);
  return p;
}
async function sendEvent(operationId: string, eventId = randomUUID()) {
  const receipt = await processor.lookup(operationId);
  if (!receipt) throw new Error('Receipt missing');
  const payload = {
    eventId,
    operationId,
    paymentId: receipt.paymentId,
    type: receipt.type,
    amount: receipt.amount,
    currency: receipt.currency,
    status: receipt.status,
  };
  return sendRaw(JSON.stringify(payload));
}
function sendRaw(
  raw: string,
  supplied?: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  return request(app)
    .post(`${api}/webhooks/processor`)
    .set('Content-Type', 'application/json')
    .set('X-Processor-Timestamp', timestamp)
    .set('X-Processor-Signature', supplied ?? signature(Buffer.from(raw), timestamp, secret))
    .send(raw);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  const [database] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (!database?.name.endsWith('_test'))
    throw new Error('Refusing to truncate a non-test database');
  // Dedicated database only; setup.ts checks the database name before any import of db.
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE reconciliation_records, webhook_events, refunds, payment_transactions, processor_records, idempotency_keys, payments, customers CASCADE',
  );
  await db.customer.create({ data: { id: customerId, name: 'Test customer' } });
});
afterAll(async () => {
  await db.$disconnect();
});

describe('Creation and validation', () => {
  it('creates a persisted payment with integer minor units and unique reference', async () => {
    const p = await create();
    expect(await payments.get(p.id)).toMatchObject({
      amount: 1000,
      status: 'PENDING',
      reference: expect.stringMatching(/^pay_/),
    });
    expect((await request(app).get(`${api}/payments/${p.id}`)).status).toBe(200);
  });
  it('replays the original response even after payment state changes', async () => {
    const key = randomUUID();
    const first = await request(app)
      .post(`${api}/payments`)
      .set('Idempotency-Key', key)
      .send(input);
    await payments.act(first.body.id, 'AUTHORIZE');
    const second = await request(app).post(`${api}/payments`).set('Idempotency-Key', key).send({
      paymentMethodReference: input.paymentMethodReference,
      customerId,
      currency: 'USD',
      amount: 1000,
    });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(await db.payment.count()).toBe(1);
  });
  it('rejects reuse of a creation key with a different payload', async () => {
    const key = randomUUID();
    await request(app).post(`${api}/payments`).set('Idempotency-Key', key).send(input).expect(201);
    await request(app)
      .post(`${api}/payments`)
      .set('Idempotency-Key', key)
      .send({ ...input, amount: 999 })
      .expect(409);
  });
  it('serializes 16 concurrent identical creation requests in PostgreSQL', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        request(app).post(`${api}/payments`).set('Idempotency-Key', key).send(input),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(16).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.payment.count()).toBe(1);
    expect(await db.idempotencyKey.count()).toBe(1);
  });
  it('rejects invalid money, unsupported currencies, missing keys and card data', async () => {
    for (const data of [
      { ...input, amount: 0 },
      { ...input, amount: 1.2 },
      { ...input, amount: 2_000_000_001 },
      { ...input, currency: 'XXX' },
      { ...input, cardNumber: 'not-allowed' },
    ]) {
      await request(app)
        .post(`${api}/payments`)
        .set('Idempotency-Key', randomUUID())
        .send(data)
        .expect(400);
    }
    await request(app).post(`${api}/payments`).send(input).expect(400);
    await request(app)
      .post(`${api}/payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...input, customerId: randomUUID() })
      .expect(422);
    expect(await db.payment.count()).toBe(0);
  });
});

describe('Authorization, capture and failure recovery', () => {
  it('authorizes and captures separately', async () => {
    const p = await create();
    await request(app).post(`${api}/payments/${p.id}/capture`).expect(409);
    expect((await payments.act(p.id, 'AUTHORIZE')).payment.status).toBe('AUTHORIZED');
    const result = await payments.act(p.id, 'CAPTURE');
    expect(result.payment).toMatchObject({ status: 'CAPTURED', capturedAmount: 1000 });
    expect(await db.processorRecord.count()).toBe(2);
  });
  it('serializes 12 concurrent authorization requests', async () => {
    const p = await create();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => request(app).post(`${api}/payments/${p.id}/authorize`)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(await db.paymentTransaction.count({ where: { type: 'AUTHORIZE' } })).toBe(1);
    expect(await db.processorRecord.count({ where: { type: 'AUTHORIZE' } })).toBe(1);
  });
  it('serializes 12 concurrent capture requests', async () => {
    const p = await create();
    await payments.act(p.id, 'AUTHORIZE');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => request(app).post(`${api}/payments/${p.id}/capture`)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(await db.processorRecord.count({ where: { type: 'CAPTURE' } })).toBe(1);
    expect(await db.paymentTransaction.count({ where: { type: 'CAPTURE' } })).toBe(1);
  });
  it('does not allow a different key to bypass a pending capture reservation', async () => {
    const p = await create();
    await payments.act(p.id, 'AUTHORIZE');
    await payments.reserve(p.id, 'CAPTURE', undefined, 'first');
    await expect(payments.act(p.id, 'CAPTURE', 'second')).rejects.toMatchObject({ status: 409 });
    await payments.act(p.id, 'CAPTURE', 'first');
    expect(await db.processorRecord.count({ where: { type: 'CAPTURE' } })).toBe(1);
  });
  it('records a definitive authorization decline and returns it idempotently', async () => {
    const p = await create({ paymentMethodReference: 'pm_mock_decline' });
    await request(app).post(`${api}/payments/${p.id}/authorize`).expect(422);
    await request(app).post(`${api}/payments/${p.id}/authorize`).expect(422);
    expect((await payments.get(p.id)).status).toBe('FAILED');
    expect(await db.processorRecord.count()).toBe(1);
  });
  it('allows a new authorization/capture/refund attempt after a confirmed failure', async () => {
    const p = await create({ paymentMethodReference: 'pm_mock_retry_once' });
    expect((await payments.act(p.id, 'AUTHORIZE', 'a1')).operation.status).toBe('FAILED');
    expect((await payments.act(p.id, 'AUTHORIZE', 'a1')).operation.status).toBe('FAILED');
    expect((await payments.act(p.id, 'AUTHORIZE', 'a2')).payment.status).toBe('AUTHORIZED');
    expect((await payments.act(p.id, 'CAPTURE', 'c1')).operation.status).toBe('FAILED');
    expect((await payments.act(p.id, 'CAPTURE', 'c2')).payment.status).toBe('CAPTURED');
    expect((await refunds.create(p.id, 1000, 'r1')).status).toBe('FAILED');
    expect((await refunds.create(p.id, 1000, 'r2')).status).toBe('SUCCEEDED');
    expect((await payments.get(p.id)).status).toBe('REFUNDED');
    expect(await db.processorRecord.count()).toBe(6);
  });
  it('retries after processor success and a lost application response without duplicating a charge', async () => {
    const p = await create();
    await payments.act(p.id, 'AUTHORIZE');
    let loseResponse = true;
    const unreliable: PaymentProcessor = {
      lookup: (id) => processor.lookup(id),
      list: (options) => processor.list(options),
      execute: async (op, payment) => {
        const result = await processor.execute(op, payment);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('timeout after success');
        }
        return result;
      },
    };
    const retryApp = createApp(db, unreliable, secret);
    await request(retryApp.app).post(`${api}/payments/${p.id}/capture`).expect(503);
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
    await request(retryApp.app).post(`${api}/payments/${p.id}/capture`).expect(200);
    expect(await db.processorRecord.count({ where: { type: 'CAPTURE' } })).toBe(1);
    expect((await payments.get(p.id)).capturedAmount).toBe(1000);
  });
  it('multiple worker instances recover one pending charge and refund exactly once', async () => {
    const p = await create();
    await payments.act(p.id, 'AUTHORIZE');
    await payments.reserve(p.id, 'CAPTURE');
    const workers = Array.from(
      { length: 8 },
      () => new PaymentService(db, new MockPaymentProcessor(db)),
    );
    const captures = (await Promise.all(workers.map((w) => w.recoverPending()))).flat();
    expect(captures.every((r) => r.status === 'fulfilled')).toBe(true);
    await payments.reserve(p.id, 'REFUND', { amount: 1000, key: 'recovery' });
    const results = (await Promise.all(workers.map((w) => w.recoverPending()))).flat();
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await db.processorRecord.count({ where: { type: 'CAPTURE' } })).toBe(1);
    expect(await db.processorRecord.count({ where: { type: 'REFUND' } })).toBe(1);
    expect((await payments.get(p.id)).refundedAmount).toBe(1000);
  });
  it('does not hold a payment row lock during a processor call', async () => {
    const p = await create();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: PaymentProcessor = {
      lookup: (id) => processor.lookup(id),
      list: (options) => processor.list(options),
      execute: async (op, payment) => {
        entered();
        await gate;
        return processor.execute(op, payment);
      },
    };
    const work = new PaymentService(db, slow).act(p.id, 'AUTHORIZE');
    await started;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${p.id}::uuid FOR UPDATE`;
      });
    } finally {
      release();
    }
    await work;
  });
});

describe('Refunds', () => {
  it('supports partial then remaining full refund and history', async () => {
    const p = await captured();
    await request(app)
      .post(`${api}/payments/${p.id}/refunds`)
      .set('Idempotency-Key', 'part')
      .send({ amount: 300 })
      .expect(201);
    expect(await payments.get(p.id)).toMatchObject({ status: 'CAPTURED', refundedAmount: 300 });
    await request(app)
      .post(`${api}/payments/${p.id}/refunds`)
      .set('Idempotency-Key', 'rest')
      .send({ amount: 700 })
      .expect(201);
    expect(await payments.get(p.id)).toMatchObject({ status: 'REFUNDED', refundedAmount: 1000 });
    const history = await request(app)
      .get(`${api}/payments/${p.id}/refunds?limit=1&page=2`)
      .expect(200);
    expect(history.body.total).toBe(2);
    expect(history.body.data).toHaveLength(1);
  });
  it('supports a single full refund', async () => {
    const p = await captured();
    await refunds.create(p.id, 1000, 'full');
    expect((await payments.get(p.id)).status).toBe('REFUNDED');
  });
  it('rejects uncaptured and excessive refunds', async () => {
    const pending = await create();
    await expect(refunds.create(pending.id, 1, 'bad')).rejects.toMatchObject({ status: 409 });
    const p = await captured();
    await expect(refunds.create(p.id, 1001, 'bad')).rejects.toMatchObject({ status: 409 });
    expect(await db.refund.count()).toBe(0);
  });
  it('serializes concurrent distinct refunds and never exceeds capture', async () => {
    const p = await captured();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post(`${api}/payments/${p.id}/refunds`)
          .set('Idempotency-Key', `refund-${i}`)
          .send({ amount: 300 }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect((await payments.get(p.id)).refundedAmount).toBe(900);
    expect(await db.processorRecord.count({ where: { type: 'REFUND' } })).toBe(3);
  });
  it('deduplicates concurrent identical refunds and rejects changed amounts', async () => {
    const p = await captured();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app)
          .post(`${api}/payments/${p.id}/refunds`)
          .set('Idempotency-Key', 'same')
          .send({ amount: 1000 }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.processorRecord.count({ where: { type: 'REFUND' } })).toBe(1);
    await request(app)
      .post(`${api}/payments/${p.id}/refunds`)
      .set('Idempotency-Key', 'same')
      .send({ amount: 999 })
      .expect(409);
  });
  it('keeps unknown refund outcomes reserved and recovers after a lost response', async () => {
    const p = await captured();
    const op = await payments.reserve(p.id, 'REFUND', { amount: 800, key: 'unknown' });
    await processor.execute(op, await payments.get(p.id)); // remote success, local crash before finalize
    await expect(refunds.create(p.id, 300, 'other')).rejects.toMatchObject({ status: 409 });
    await payments.recoverPending();
    expect((await payments.get(p.id)).refundedAmount).toBe(800);
    expect(await db.processorRecord.count({ where: { type: 'REFUND' } })).toBe(1);
    await refunds.create(p.id, 200, 'remainder');
    expect((await payments.get(p.id)).status).toBe('REFUNDED');
  });
});

describe('Webhook authenticity and reliability', () => {
  it('verifies the exact raw bytes, including whitespace, before JSON parsing', async () => {
    const p = await create();
    const op = await payments.reserve(p.id, 'AUTHORIZE');
    const receipt = await processor.execute(op, await payments.get(p.id));
    const payload = {
      eventId: randomUUID(),
      operationId: op.id,
      paymentId: p.id,
      type: receipt.type,
      amount: 1000,
      currency: 'USD',
      status: 'SUCCEEDED',
    };
    const pretty = JSON.stringify(payload, null, 2);
    await sendRaw(pretty).expect(202);
    const timestamp = String(Math.floor(Date.now() / 1000));
    await sendRaw(
      pretty,
      signature(Buffer.from(JSON.stringify(payload)), timestamp, secret),
      timestamp,
    ).expect(401);
    await webhooks.processBatch();
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
  });
  it('accepts an independently calculated HMAC signature', async () => {
    const p = await create();
    const op = await payments.act(p.id, 'AUTHORIZE');
    const raw = JSON.stringify({
      eventId: randomUUID(),
      operationId: op.operation.id,
      paymentId: p.id,
      type: 'AUTHORIZE',
      amount: 1000,
      currency: 'USD',
      status: 'SUCCEEDED',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(Buffer.concat([Buffer.from(timestamp + '.', 'utf8'), Buffer.from(raw, 'utf8')]))
      .digest('hex');
    await sendRaw(raw, digest, timestamp).expect(202);
  });
  it('rejects malformed, invalid and expired signatures', async () => {
    await sendRaw('{}', 'a'.repeat(64)).expect(401);
    await sendRaw('{}', 'not-hex').expect(401);
    await sendRaw('{}', undefined, String(Math.floor(Date.now() / 1000) - 600)).expect(401);
    await request(app).post(`${api}/webhooks/processor`).send({}).expect(401);
    expect(await db.webhookEvent.count()).toBe(0);
  });
  it('rejects compressed webhook bodies instead of signing inflated bytes', async () => {
    await request(app)
      .post(`${api}/webhooks/processor`)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(Buffer.from('{}')))
      .expect(415);
    expect(await db.webhookEvent.count()).toBe(0);
  });
  it('fences a stale webhook worker after lease expiry and operator retry', async () => {
    const p = await create();
    const op = await payments.reserve(p.id, 'AUTHORIZE');
    await processor.execute(op, await payments.get(p.id));
    await sendEvent(op.id);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(processor, 'lookup').mockImplementationOnce(async () => {
      entered();
      await gate;
      throw new Error('late worker failure');
    });
    const stale = webhooks.processBatch();
    await started;
    try {
      const event = await db.webhookEvent.findFirstOrThrow();
      await db.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', nextAttemptAt: new Date(0) },
      });
      await webhooks.retry(event.eventId);
      await webhooks.processBatch();
      expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('PROCESSED');
    } finally {
      release();
      await stale;
    }
    expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('PROCESSED');
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
  });
  it('deduplicates concurrent delivery and does not apply refund updates twice', async () => {
    const p = await captured();
    const op = await payments.reserve(p.id, 'REFUND', { amount: 300, key: 'webhook' });
    await processor.execute(op, await payments.get(p.id));
    const eventId = randomUUID();
    const delivered = await Promise.all(Array.from({ length: 8 }, () => sendEvent(op.id, eventId)));
    expect(delivered.map((r) => r.status)).toEqual(Array(8).fill(202));
    await Promise.all(Array.from({ length: 4 }, () => webhooks.processBatch()));
    await sendEvent(op.id, eventId);
    await webhooks.processBatch();
    expect(await db.webhookEvent.count()).toBe(1);
    expect((await payments.get(p.id)).refundedAmount).toBe(300);
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { eventId } })).status).toBe(
      'PROCESSED',
    );
  });
  it('deduplicates the same operation across different event IDs', async () => {
    const p = await captured();
    const op = await payments.reserve(p.id, 'REFUND', { amount: 1000, key: 'events' });
    await processor.execute(op, await payments.get(p.id));
    await sendEvent(op.id);
    await sendEvent(op.id);
    await webhooks.processBatch();
    expect((await payments.get(p.id)).refundedAmount).toBe(1000);
    expect(await db.webhookEvent.count({ where: { status: 'PROCESSED' } })).toBe(2);
  });
  it('retries internal failure after backoff without losing the event', async () => {
    const p = await create();
    const op = await payments.reserve(p.id, 'AUTHORIZE');
    await processor.execute(op, await payments.get(p.id));
    await sendEvent(op.id);
    vi.spyOn(processor, 'lookup').mockRejectedValueOnce(new Error('temporary outage'));
    await webhooks.processBatch();
    let event = await db.webhookEvent.findFirstOrThrow();
    expect(event).toMatchObject({ status: 'FAILED', attempts: 1 });
    await webhooks.processBatch();
    expect((await db.webhookEvent.findFirstOrThrow()).attempts).toBe(1);
    await db.webhookEvent.update({ where: { id: event.id }, data: { nextAttemptAt: new Date(0) } });
    await webhooks.processBatch();
    event = await db.webhookEvent.findFirstOrThrow();
    expect(event).toMatchObject({ status: 'PROCESSED', attempts: 2 });
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
  });
  it('dead letters repeated failures and supports explicit replay', async () => {
    const p = await create();
    const op = await payments.reserve(p.id, 'AUTHORIZE');
    await processor.execute(op, await payments.get(p.id));
    await sendEvent(op.id);
    const spy = vi.spyOn(processor, 'lookup').mockRejectedValue(new Error('outage'));
    for (let i = 0; i < 8; i++) {
      await db.webhookEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
      await webhooks.processBatch();
    }
    const event = await db.webhookEvent.findFirstOrThrow();
    expect(event).toMatchObject({ status: 'DEAD', attempts: 8 });
    spy.mockRestore();
    await webhooks.retry(event.eventId);
    await webhooks.processBatch();
    expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('PROCESSED');
  });
  it('handles out-of-order authorization/capture events after a full refund', async () => {
    const p = await captured();
    await refunds.create(p.id, 1000, 'full');
    const ops = await db.paymentTransaction.findMany({ where: { paymentId: p.id } });
    for (const type of ['REFUND', 'CAPTURE', 'AUTHORIZE']) {
      await sendEvent(ops.find((o) => o.type === type)!.id);
      await webhooks.processBatch();
      expect((await payments.get(p.id)).status).toBe('REFUNDED');
    }
    expect(await db.webhookEvent.count({ where: { status: 'PROCESSED' } })).toBe(3);
  });
  it('does not regress after a delayed failed attempt event arrives after a successful retry', async () => {
    const p = await create({ paymentMethodReference: 'pm_mock_retry_once' });
    const failed = await payments.act(p.id, 'AUTHORIZE', 'first');
    await payments.act(p.id, 'AUTHORIZE', 'second');
    await sendEvent(failed.operation.id);
    await webhooks.processBatch();
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
  });
  it('rejects event ID payload changes and refuses events that conflict with processor receipts', async () => {
    const p = await create();
    const result = await payments.act(p.id, 'AUTHORIZE');
    const eventId = randomUUID();
    await sendEvent(result.operation.id, eventId);
    const altered = {
      eventId,
      operationId: result.operation.id,
      paymentId: p.id,
      type: 'AUTHORIZE',
      amount: 999,
      currency: 'USD',
      status: 'SUCCEEDED',
    };
    await sendRaw(JSON.stringify(altered)).expect(409);
    await sendRaw(JSON.stringify({ ...altered, eventId: randomUUID() })).expect(202);
    await webhooks.processBatch();
    expect(await db.webhookEvent.count({ where: { status: 'DEAD' } })).toBe(1);
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
  });
});

describe('Database integrity and reconciliation', () => {
  it('rolls back payment creation when idempotency persistence fails', async () => {
    await db.$executeRawUnsafe(
      `CREATE FUNCTION test_reject_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER test_reject_key BEFORE INSERT ON idempotency_keys FOR EACH ROW EXECUTE PROCEDURE test_reject_key()',
    );
    try {
      await expect(payments.create(input, 'rollback')).rejects.toThrow();
      expect(await db.payment.count()).toBe(0);
      expect(await db.idempotencyKey.count()).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_reject_key ON idempotency_keys');
      await db.$executeRawUnsafe('DROP FUNCTION test_reject_key()');
    }
  });
  it('rolls back finalization atomically and recovers an already successful processor operation', async () => {
    const p = await captured();
    const op = await payments.reserve(p.id, 'REFUND', { amount: 400, key: 'rollback' });
    await db.$executeRawUnsafe(
      `CREATE FUNCTION test_reject_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'SUCCEEDED' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END; $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER test_reject_finalize BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE PROCEDURE test_reject_finalize()',
    );
    try {
      await expect(payments.execute(op.id)).rejects.toThrow();
      expect((await payments.get(p.id)).refundedAmount).toBe(0);
      expect((await db.refund.findUniqueOrThrow({ where: { transactionId: op.id } })).status).toBe(
        'PENDING',
      );
      expect((await processor.lookup(op.id))?.status).toBe('SUCCEEDED');
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_reject_finalize ON payment_transactions');
      await db.$executeRawUnsafe('DROP FUNCTION test_reject_finalize()');
    }
    await payments.execute(op.id);
    expect((await payments.get(p.id)).refundedAmount).toBe(400);
    expect(await db.processorRecord.count({ where: { type: 'REFUND' } })).toBe(1);
  });
  it('enforces financial balance constraints and active-operation uniqueness at database level', async () => {
    const p = await captured();
    await expect(
      db.payment.update({ where: { id: p.id }, data: { refundedAmount: 1001 } }),
    ).rejects.toThrow();
    await expect(
      db.paymentTransaction.create({
        data: {
          paymentId: p.id,
          type: 'CAPTURE',
          amount: 1000,
          key: 'bypass',
          requestHash: 'bypass',
        },
      }),
    ).rejects.toThrow();
    expect((await payments.get(p.id)).refundedAmount).toBe(0);
  });
  it('reports a clean reconciliation without mutating payments', async () => {
    const p = await captured();
    await refunds.create(p.id, 200, 'part');
    const before = await payments.get(p.id);
    const result = await reconciliation.run();
    expect(result.report).toMatchObject({ discrepancyCount: 0 });
    expect(await payments.get(p.id)).toEqual(before);
  });
  it('reports amount/status mismatches and missing transactions on both sides', async () => {
    const p = await captured();
    const capture = await db.processorRecord.findFirstOrThrow({ where: { type: 'CAPTURE' } });
    await db.processorRecord.update({
      where: { id: capture.id },
      data: { amount: 999, status: 'FAILED' },
    });
    await db.processorRecord.deleteMany({ where: { type: 'AUTHORIZE' } });
    await db.processorRecord.create({
      data: {
        operationId: randomUUID(),
        paymentId: randomUUID(),
        type: 'AUTHORIZE',
        amount: 20,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    const before = await payments.get(p.id);
    const result = await reconciliation.run();
    const report = result.report as { discrepancies: { kind: string }[] };
    expect(report.discrepancies.map((d) => d.kind)).toEqual(
      expect.arrayContaining([
        'AMOUNT_MISMATCH',
        'STATUS_MISMATCH',
        'MISSING_PROCESSOR_TRANSACTION',
        'MISSING_INTERNAL_TRANSACTION',
        'PAYMENT_TOTAL_MISMATCH',
      ]),
    );
    expect(await payments.get(p.id)).toEqual(before);
  });
  it('serves health, API docs, paginated events/reports and consistent errors', async () => {
    await request(app).get(`${api}/health`).expect(200);
    const docs = await request(app).get('/openapi.json').expect(200);
    expect(Object.keys(docs.body.paths)).toHaveLength(10);
    await request(app).get('/docs/').expect(200);
    await request(app).post(`${api}/reconciliation/run`).expect(201);
    expect((await request(app).get(`${api}/reconciliation/reports?limit=1`)).body.total).toBe(1);
    await request(app).get(`${api}/webhooks/events?page=1&limit=10`).expect(200);
    await request(app).get(`${api}/webhooks/events?limit=101`).expect(400);
    await request(app).get(`${api}/payments/not-a-uuid`).expect(400);
    await request(app).get(`${api}/payments/${randomUUID()}`).expect(404);
    const error = await request(app).get('/missing').expect(404);
    expect(error.body.error.requestId).toBeTruthy();
  });
});

describe('Review regression coverage', () => {
  const delegated = (execute: PaymentProcessor['execute']): PaymentProcessor => ({
    execute,
    lookup: (id, signal) => processor.lookup(id),
    list: (options) => processor.list(options),
  });
  it('rejects a wrong-operation receipt instead of reporting capture success', async () => {
    const p = await create();
    const authorization = await payments.act(p.id, 'AUTHORIZE');
    const receipt = (await processor.lookup(authorization.operation.id))!;
    const bad = new PaymentService(
      db,
      delegated(async () => receipt),
    );
    await expect(bad.act(p.id, 'CAPTURE')).rejects.toMatchObject({
      code: 'PROCESSOR_RECEIPT_MISMATCH',
      retryable: false,
    });
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
    expect(
      await db.paymentTransaction.findFirst({ where: { paymentId: p.id, type: 'CAPTURE' } }),
    ).toMatchObject({ status: 'PENDING', recoveryBlocked: true });
  });
  it('rejects wrong-payment, type, amount, currency and malformed status receipts', async () => {
    for (const change of [
      { paymentId: randomUUID() },
      { type: 'CAPTURE' },
      { amount: 999 },
      { currency: 'EUR' },
      { status: 'PENDING' },
    ]) {
      const p = await create();
      const bad = new PaymentService(
        db,
        delegated(
          async (operation, payment) =>
            ({
              operationId: operation.id,
              paymentId: payment.id,
              type: operation.type,
              amount: operation.amount,
              currency: payment.currency,
              status: 'SUCCEEDED',
              failureCode: null,
              ...change,
            }) as Awaited<ReturnType<PaymentProcessor['execute']>>,
        ),
      );
      await expect(bad.act(p.id, 'AUTHORIZE')).rejects.toMatchObject({
        code: 'PROCESSOR_RECEIPT_MISMATCH',
      });
      expect((await payments.get(p.id)).status).toBe('PROCESSING');
    }
  });
  it('binds webhook lookup to the event operation ID', async () => {
    const p = await captured();
    await refunds.create(p.id, 100, 'a');
    await refunds.create(p.id, 100, 'b');
    const ops = await db.paymentTransaction.findMany({
      where: { type: 'REFUND' },
      orderBy: { key: 'asc' },
    });
    const otherReceipt = (await processor.lookup(ops[1]!.id))!;
    await sendEvent(ops[0]!.id);
    vi.spyOn(processor, 'lookup').mockResolvedValueOnce(otherReceipt);
    await webhooks.processBatch();
    expect(await db.webhookEvent.findFirst()).toMatchObject({
      status: 'DEAD',
      lastError: 'PROCESSOR_RECEIPT_MISMATCH',
    });
    expect((await payments.get(p.id)).refundedAmount).toBe(200);
  });
  it('detects missing refund records and rejects inconsistent refunds at commit', async () => {
    const p = await captured();
    const refund = await refunds.create(p.id, 300, 'audit');
    await expect(
      db.refund.update({ where: { id: refund.id }, data: { amount: 301 } }),
    ).rejects.toThrow();
    const snapshot = {
      payments: await db.payment.findMany(),
      operations: await db.paymentTransaction.findMany(),
      refunds: await db.refund.findMany(),
      receipts: (await processor.list({ limit: 100 })).data,
    };
    const corrupt = snapshot.refunds.map((r) => ({ ...r, amount: 301 }));
    expect(
      audit(snapshot.payments, snapshot.operations, corrupt, snapshot.receipts).map((d) => d.kind),
    ).toContain('REFUND_TRANSACTION_MISMATCH');
    await db.refund.delete({ where: { id: refund.id } });
    const report = (await reconciliation.run()).report as { discrepancies: { kind: string }[] };
    expect(report.discrepancies.map((d) => d.kind)).toEqual(
      expect.arrayContaining(['MISSING_REFUND', 'PAYMENT_TOTAL_MISMATCH']),
    );
  });
  it('rejects cross-payment refund ownership and non-refund transaction links', async () => {
    const a = await captured();
    const b = await captured();
    const operation = await payments.reserve(a.id, 'REFUND', { amount: 100, key: 'owned' });
    await expect(
      db.refund.update({ where: { transactionId: operation.id }, data: { paymentId: b.id } }),
    ).rejects.toThrow();
    const authorization = await db.paymentTransaction.findFirstOrThrow({
      where: { paymentId: b.id, type: 'AUTHORIZE' },
    });
    await expect(
      db.refund.create({
        data: {
          paymentId: b.id,
          transactionId: authorization.id,
          amount: authorization.amount,
          status: authorization.status,
        },
      }),
    ).rejects.toThrow();
  });
  it('reports missing authorization evidence and payment/authorization amount drift', async () => {
    const p = await create();
    await db.payment.update({ where: { id: p.id }, data: { status: 'AUTHORIZED' } });
    const a = await create();
    await payments.act(a.id, 'AUTHORIZE');
    await db.payment.update({ where: { id: a.id }, data: { amount: 1001 } });
    const report = (await reconciliation.run()).report as { discrepancies: { kind: string }[] };
    expect(report.discrepancies.map((d) => d.kind)).toEqual(
      expect.arrayContaining([
        'MISSING_OR_DUPLICATE_AUTHORIZATION',
        'PAYMENT_STATUS_MISMATCH',
        'PAYMENT_AMOUNT_MISMATCH',
      ]),
    );
  });
  it('times out unknown outcomes, retains reservations and honors recovery backoff', async () => {
    const p = await captured();
    let aborted = false;
    const slow = delegated(async (op, payment, signal) => {
      await processor.execute(op, payment);
      return new Promise((_, reject) => {
        signal!.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    });
    const bounded = new PaymentService(db, slow, 100);
    const op = await bounded.reserve(p.id, 'REFUND', { amount: 800, key: 'timeout' });
    await expect(bounded.execute(op.id)).rejects.toMatchObject({
      code: 'PROCESSOR_TIMEOUT',
      retryable: true,
    });
    expect(aborted).toBe(true);
    expect((await payments.get(p.id)).refundedAmount).toBe(0);
    await expect(refunds.create(p.id, 300, 'too-much')).rejects.toMatchObject({ status: 409 });
    await payments.recoverPending();
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      'PENDING',
    );
    await db.paymentTransaction.update({
      where: { id: op.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await payments.recoverPending();
    expect((await payments.get(p.id)).refundedAmount).toBe(800);
    expect(await db.processorRecord.count({ where: { operationId: op.id } })).toBe(1);
  });
  it('bounds processor execution concurrency', async () => {
    let active = 0,
      maximum = 0;
    const slow = delegated(async (op, payment) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await processor.execute(op, payment);
      } finally {
        active--;
      }
    });
    const service = new PaymentService(db, slow, 5000, 2);
    const ps = await Promise.all(Array.from({ length: 8 }, () => create()));
    await Promise.all(ps.map((p) => service.act(p.id, 'AUTHORIZE')));
    expect(maximum).toBe(2);
  });
  it('retains capacity for adapters that ignore abort rather than launching unbounded calls', async () => {
    let starts = 0;
    const service = new PaymentService(
      db,
      delegated(async () => {
        starts++;
        return new Promise(() => {});
      }),
      20,
      1,
    );
    const ps = await Promise.all(Array.from({ length: 4 }, () => create()));
    const outcomes = await Promise.allSettled(ps.map((p) => service.act(p.id, 'AUTHORIZE')));
    expect(outcomes.every((r) => r.status === 'rejected')).toBe(true);
    expect(starts).toBe(1);
    expect(await db.paymentTransaction.count({ where: { status: 'PENDING' } })).toBe(4);
  });
  it('continues webhook scheduling when recovery is stalled', async () => {
    let release!: (value: Awaited<ReturnType<PaymentService['recoverPending']>>) => void;
    const gate = new Promise<Awaited<ReturnType<PaymentService['recoverPending']>>>((resolve) => {
      release = resolve;
    });
    vi.spyOn(payments, 'recoverPending').mockImplementation(async () => gate);
    const webhookSpy = vi.spyOn(webhooks, 'processBatch').mockResolvedValue();
    const stop = startWorker(payments, webhooks, 10);
    try {
      await vi.waitFor(() => expect(webhookSpy.mock.calls.length).toBeGreaterThan(1));
    } finally {
      release([]);
      await stop();
    }
  });
  it('recovers safely using separate PostgreSQL clients and processor instances', async () => {
    const p = await captured();
    const op = await payments.reserve(p.id, 'REFUND', { amount: 1000, key: 'independent' });
    const clients = Array.from(
      { length: 4 },
      () =>
        new PrismaClient({
          adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL!, max: 3 }),
        }),
    );
    try {
      const services = clients.map(
        (client) => new PaymentService(client, new MockPaymentProcessor(client)),
      );
      const results = await Promise.all(services.map((service) => service.execute(op.id)));
      expect(results.every((r) => r.status === 'SUCCEEDED')).toBe(true);
      expect(await db.processorRecord.count({ where: { operationId: op.id } })).toBe(1);
      expect((await payments.get(p.id)).refundedAmount).toBe(1000);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
  it('recovers after a child process exits following processor success', async () => {
    const p = await create();
    await payments.act(p.id, 'AUTHORIZE');
    const op = await payments.reserve(p.id, 'CAPTURE');
    let exitStatus: unknown;
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'src/tests/crash-worker.ts', op.id], {
        env: process.env,
        stdio: 'pipe',
      });
    } catch (error) {
      exitStatus = (error as { status: unknown }).status;
    }
    expect(exitStatus).toBe(17);
    expect((await payments.get(p.id)).status).toBe('AUTHORIZED');
    expect((await processor.lookup(op.id))?.status).toBe('SUCCEEDED');
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
    });
    try {
      await new PaymentService(client, new MockPaymentProcessor(client)).recoverPending();
    } finally {
      await client.$disconnect();
    }
    expect((await payments.get(p.id)).status).toBe('CAPTURED');
    expect(await db.processorRecord.count({ where: { operationId: op.id } })).toBe(1);
  });
  it('bounds reconciliation pages and refuses partial reports when over capacity', async () => {
    await captured();
    const limited = new ReconciliationService(payments, 1, 1);
    await expect(limited.run()).rejects.toMatchObject({ code: 'RECONCILIATION_LIMIT_EXCEEDED' });
    expect(await db.reconciliationRecord.count()).toBe(0);
    const paged = new ReconciliationService(payments, 20, 1);
    expect((await paged.run()).report).toMatchObject({ processorCount: 2, discrepancyCount: 0 });
  });
  it('rejects overlapping reconciliation requests', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(processor, 'list').mockImplementationOnce(async () => {
      entered();
      await gate;
      return { data: [], nextCursor: null };
    });
    const running = reconciliation.run();
    await started;
    try {
      await expect(reconciliation.run()).rejects.toMatchObject({ code: 'RECONCILIATION_BUSY' });
    } finally {
      release();
      await running;
    }
  });
});

describe('Error classification and safe diagnostics', () => {
  it('treats database timeouts/deadlocks and network failures as retryable', () => {
    for (const code of ['57014', '40P01', '40001', 'ECONNRESET']) {
      expect(
        classifyError({
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: code } } },
        }),
      ).toMatchObject({ retryable: true, status: 503 });
    }
    expect(
      classifyError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })),
    ).toMatchObject({ retryable: true });
    expect(classifyError({ code: 'P2010', meta: { code: '23514' } })).toMatchObject({
      retryable: false,
      code: 'DATA_INTEGRITY_ERROR',
    });
  });
  it('does not expose raw processor exception text in logs or HTTP errors', async () => {
    const p = await create();
    const marker = 'sensitive-processor-payload-do-not-log';
    const spy = vi.spyOn(logger, 'warn');
    const bad: PaymentProcessor = {
      execute: async () => {
        throw new Error(marker);
      },
      lookup: (id) => processor.lookup(id),
      list: (options) => processor.list(options),
    };
    const alternate = createApp(db, bad, secret);
    const response = await request(alternate.app)
      .post(`${api}/payments/${p.id}/authorize`)
      .expect(503);
    expect(response.body.error.retryable).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(marker);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
  });
});
