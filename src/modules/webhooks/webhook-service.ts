import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { logger } from '../../shared/logger.js';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, conflict, classifyError, ReceiptMismatch } from '../../shared/errors.js';
import { hash, money, uuid } from '../../shared/utils.js';
import type { PaymentService } from '../payments/payment-service.js';
export const webhookSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    operationId: uuid,
    paymentId: uuid,
    type: z.enum(['AUTHORIZE', 'CAPTURE', 'REFUND']),
    amount: money,
    currency: z.enum(['USD', 'EUR', 'GBP', 'INR']),
    status: z.enum(['SUCCEEDED', 'FAILED']),
  })
  .strict();
export function signature(body: Buffer, timestamp: string, secret: string) {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}
export class WebhookService {
  constructor(
    private readonly payments: PaymentService,
    private readonly secret: string,
  ) {}
  async ingest(body: Buffer, timestamp?: string, supplied?: string) {
    if (
      !timestamp ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !supplied ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(
        Buffer.from(signature(body, timestamp, this.secret), 'hex'),
        Buffer.from(supplied, 'hex'),
      )
    ) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid or expired webhook signature');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new AppError(400, 'INVALID_JSON', 'Invalid JSON');
    }
    const payload = webhookSchema.parse(parsed);
    const requestHash = hash(payload);
    await this.payments.db.webhookEvent.createMany({
      skipDuplicates: true,
      data: { eventId: payload.eventId, payload, requestHash },
    });
    const event = await this.payments.db.webhookEvent.findUniqueOrThrow({
      where: { eventId: payload.eventId },
    });
    if (event.requestHash !== requestHash) throw conflict('Event ID has a different payload');
    return { eventId: event.eventId, status: event.status };
  }
  async processBatch(limit = 50) {
    const db = this.payments.db;
    const candidates = await db.webhookEvent.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
    });
    for (const candidate of candidates) {
      // Atomic claim with a lease; a crashed worker becomes eligible again in 30 seconds.
      const claimToken = randomUUID();
      const claim = await db.webhookEvent.updateMany({
        where: {
          id: candidate.id,
          attempts: candidate.attempts,
          status: { in: ['PENDING', 'FAILED'] },
          nextAttemptAt: { lte: new Date() },
        },
        data: {
          claimToken,
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      if (claim.count === 0) continue;
      try {
        const event = webhookSchema.parse(candidate.payload);
        const receipt = await this.payments.callProcessor(
          (signal) => this.payments.processor.lookup(event.operationId, signal),
          true,
        );
        if (!receipt)
          throw new AppError(
            503,
            'PROCESSOR_RECEIPT_UNAVAILABLE',
            'Processor receipt not yet available',
            true,
          );
        if (
          receipt.operationId !== event.operationId ||
          receipt.paymentId !== event.paymentId ||
          receipt.type !== event.type ||
          receipt.amount !== event.amount ||
          receipt.currency !== event.currency ||
          receipt.status !== event.status
        )
          throw new ReceiptMismatch();
        // Trust a verified processor receipt, not arrival order or a webhook's claimed payment state.
        await this.payments.finalize(event.operationId, receipt);
        await db.webhookEvent.updateMany({
          where: { id: candidate.id, claimToken, status: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'PROCESSED', lastError: null, claimToken: null },
        });
      } catch (error) {
        const failure = classifyError(error);
        logger.warn(
          { eventId: candidate.eventId, code: failure.code, retryable: failure.retryable },
          'Webhook processing failed',
        );
        const attempts = candidate.attempts + 1;
        await db.webhookEvent.updateMany({
          where: { id: candidate.id, claimToken, status: { in: ['PENDING', 'FAILED'] } },
          data: {
            claimToken: null,
            status: !failure.retryable || attempts >= 8 ? 'DEAD' : 'FAILED',
            lastError: failure.code,
            nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** attempts)),
          },
        });
      }
    }
  }
  async retry(eventId: string) {
    return this.payments.db.webhookEvent.updateMany({
      where: { eventId, status: { in: ['FAILED', 'DEAD'] } },
      data: {
        status: 'PENDING',
        claimToken: null,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
  }
  async list(page: number, limit: number) {
    const [data, total] = await this.payments.db.$transaction(
      [
        this.payments.db.webhookEvent.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.payments.db.webhookEvent.count(),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { data, total, page, limit };
  }
}
