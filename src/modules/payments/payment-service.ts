import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { lockKey, lockPayment } from '../../database/locks.js';
import {
  AppError,
  conflict,
  missing,
  classifyError,
  ProcessorTimeout,
} from '../../shared/errors.js';
import { hash, json, money, uuid } from '../../shared/utils.js';
import { logger } from '../../shared/logger.js';
import { config } from '../../config/env.js';
import { Limiter, withDeadline, backoffMs } from '../../shared/async.js';
import { validateReceipt } from '../processors/receipts.js';
import type { PaymentProcessor } from '../processors/payment-processor.js';
export const createPaymentSchema = z
  .object({
    amount: money,
    currency: z.enum(['USD', 'EUR', 'GBP', 'INR']),
    customerId: uuid,
    paymentMethodReference: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_:-]+$/),
  })
  .strict();
export type CreatePayment = z.infer<typeof createPaymentSchema>;
export class PaymentService {
  private readonly limiter: Limiter;
  private readonly readLimiter: Limiter;
  constructor(
    readonly db: PrismaClient,
    readonly processor: PaymentProcessor,
    readonly timeoutMs = config.PROCESSOR_TIMEOUT_MS,
    concurrency = config.PROCESSOR_CONCURRENCY,
  ) {
    this.limiter = new Limiter(concurrency);
    this.readLimiter = new Limiter(concurrency);
  }
  callProcessor<T>(work: (signal: AbortSignal) => Promise<T>, readOnly = false): Promise<T> {
    // Hold a concurrency slot until the adapter actually settles, even if it ignores cancellation.
    return withDeadline(
      (signal) =>
        (readOnly ? this.readLimiter : this.limiter).run(() => {
          if (signal.aborted) throw new ProcessorTimeout();
          return work(signal);
        }),
      this.timeoutMs,
    );
  }
  async create(input: CreatePayment, key: string) {
    input = createPaymentSchema.parse(input);
    const requestHash = hash(input);
    return this.db.$transaction(
      async (tx) => {
        await lockKey(tx, `create:${key}`);
        const existing = await tx.idempotencyKey.findUnique({ where: { key } });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw conflict('Idempotency key has a different payload');
          return { body: existing.response, status: existing.statusCode, replayed: true };
        }
        this.processor.validatePaymentMethod?.(input.paymentMethodReference);
        if (!(await tx.customer.findUnique({ where: { id: input.customerId } })))
          throw new AppError(422, 'CUSTOMER_NOT_FOUND', 'Customer does not exist');
        const payment = await tx.payment.create({
          data: { ...input, reference: `pay_${randomUUID()}` },
        });
        const response = json(payment) as unknown as Prisma.InputJsonObject;
        await tx.idempotencyKey.create({ data: { key, requestHash, response, statusCode: 201 } });
        return { body: response, status: 201, replayed: false };
      },
      { timeout: 15000 },
    );
  }
  async get(id: string) {
    const payment = await this.db.payment.findUnique({ where: { id } });
    if (!payment) throw missing();
    return payment;
  }
  async reserve(
    id: string,
    ...args:
      | [type: 'AUTHORIZE' | 'CAPTURE', refund?: undefined, attemptKey?: string]
      | [type: 'REFUND', refund: { amount: number; key: string }]
  ) {
    const [type, refund, attemptKey = 'default'] = args;
    return this.db.$transaction(
      async (tx) => {
        const payment = await lockPayment(tx, id);
        const key =
          type === 'REFUND' ? `${id}:refund:${refund.key}` : `${id}:${type}:${attemptKey}`;
        const amount = type === 'REFUND' ? money.parse(refund.amount) : payment.amount;
        const requestHash = hash({ type, amount });
        const existing = await tx.paymentTransaction.findUnique({ where: { key } });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw conflict('Operation key has a different payload');
          return existing;
        }
        if (
          type !== 'REFUND' &&
          (await tx.paymentTransaction.findFirst({
            where: { paymentId: id, type, status: 'PENDING' },
          }))
        )
          throw conflict('An operation is already pending; retry its original key');
        if (type === 'AUTHORIZE' && !['PENDING', 'FAILED'].includes(payment.status))
          throw conflict('Only pending or failed payments may be authorized');
        if (type === 'CAPTURE' && payment.status !== 'AUTHORIZED')
          throw conflict('Only authorized payments may be captured');
        if (type === 'REFUND') {
          if (payment.status !== 'CAPTURED')
            throw conflict('Only captured payments may be refunded');
          const pending = await tx.refund.aggregate({
            where: { paymentId: id, status: 'PENDING' },
            _sum: { amount: true },
          });
          if (amount > payment.capturedAmount - payment.refundedAmount - (pending._sum.amount ?? 0))
            throw conflict('Refund exceeds available captured amount');
        }
        const operation = await tx.paymentTransaction.create({
          data: { paymentId: id, type, key, requestHash, amount },
        });
        if (type === 'AUTHORIZE')
          await tx.payment.update({ where: { id }, data: { status: 'PROCESSING' } });
        if (type === 'REFUND')
          await tx.refund.create({ data: { paymentId: id, amount, transactionId: operation.id } });
        return operation;
      },
      { timeout: 15000 },
    );
  }
  async finalize(expectedOperationId: string, value: unknown) {
    const expected = await this.db.paymentTransaction.findUniqueOrThrow({
      where: { id: expectedOperationId },
    });
    return this.db.$transaction(
      async (tx) => {
        const payment = await lockPayment(tx, expected.paymentId);
        const operation = await tx.paymentTransaction.findUnique({
          where: { id: expectedOperationId },
        });
        if (!operation) throw missing();
        const receipt = validateReceipt(value, operation, payment);
        if (operation.status !== 'PENDING') {
          if (operation.status !== receipt.status)
            throw conflict('Processor result conflicts with completed operation');
          return operation;
        }
        const succeeded = receipt.status === 'SUCCEEDED';
        if (operation.type === 'AUTHORIZE') {
          if (payment.status !== 'PROCESSING') throw conflict('Authorization state mismatch');
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: succeeded ? 'AUTHORIZED' : 'FAILED' },
          });
        } else if (operation.type === 'CAPTURE') {
          if (payment.status !== 'AUTHORIZED') throw conflict('Capture state mismatch');
          if (succeeded)
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'CAPTURED', capturedAmount: operation.amount },
            });
        } else {
          if (succeeded) {
            const refundedAmount = payment.refundedAmount + operation.amount;
            if (refundedAmount > payment.capturedAmount)
              throw conflict('Refund would exceed capture');
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                refundedAmount,
                status: refundedAmount === payment.capturedAmount ? 'REFUNDED' : 'CAPTURED',
              },
            });
          }
          await tx.refund.update({
            where: { transactionId: operation.id },
            data: { status: receipt.status },
          });
        }
        return tx.paymentTransaction.update({
          where: { id: operation.id },
          data: {
            status: receipt.status,
            failureCode: receipt.failureCode,
            lastErrorCode: null,
            recoveryBlocked: false,
          },
        });
      },
      { timeout: 15000 },
    );
  }
  async execute(operationId: string) {
    const operation = await this.db.paymentTransaction.findUniqueOrThrow({
      where: { id: operationId },
    });
    if (operation.status !== 'PENDING') return operation;
    const payment = await this.get(operation.paymentId);
    // A timeout is UNKNOWN, never a definitive decline. Keep reservation and retry this operation ID.
    try {
      const receipt = await this.callProcessor((signal) =>
        this.processor.execute(operation, payment, signal),
      );
      return await this.finalize(operationId, receipt);
    } catch (error) {
      const failure = classifyError(error);
      logger.warn(
        {
          operationId,
          paymentId: operation.paymentId,
          code: failure.code,
          retryable: failure.retryable,
        },
        'Processor operation unresolved',
      );
      await this.db.paymentTransaction.updateMany({
        where: { id: operationId, status: 'PENDING' },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + backoffMs(operation.attempts + 1)),
          lastErrorCode: failure.code,
          recoveryBlocked: !failure.retryable,
        },
      });
      throw failure;
    }
  }

  async act(id: string, type: 'AUTHORIZE' | 'CAPTURE', attemptKey = 'default') {
    const operation = await this.reserve(id, type, undefined, attemptKey);
    const result = await this.execute(operation.id);
    return { payment: await this.get(id), operation: result };
  }
  async recoverPending(limit = 50) {
    const due = {
      status: 'PENDING' as const,
      recoveryBlocked: false,
      nextAttemptAt: { lte: new Date() },
    };
    const operations = await this.db.paymentTransaction.findMany({
      where: due,
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: Math.min(limit, 100),
    });
    return Promise.allSettled(
      operations.map(async (operation) => {
        // Claim before dispatch; a crashed worker's lease expires. Financial safety still rests on processor idempotency.
        const claim = await this.db.paymentTransaction.updateMany({
          where: { id: operation.id, ...due },
          data: { nextAttemptAt: new Date(Date.now() + 120_000) },
        });
        if (claim.count === 0) return;
        return this.execute(operation.id);
      }),
    );
  }
}
