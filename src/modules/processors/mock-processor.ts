import type { Payment, PaymentTransaction, PrismaClient, ProcessorRecord } from '@prisma/client';
import { lockKey } from '../../database/locks.js';
import { AppError } from '../../shared/errors.js';
import type { PaymentProcessor, ProcessorResult } from './payment-processor.js';
function result(record: ProcessorRecord): ProcessorResult {
  if (record.status === 'PENDING') throw new Error('Invalid processor receipt');
  return { ...record, status: record.status };
}
export class MockPaymentProcessor implements PaymentProcessor {
  constructor(private readonly db: PrismaClient) {}
  validatePaymentMethod(reference: string) {
    if (
      ![
        'pm_mock_ok',
        'pm_mock_decline',
        'pm_mock_capture_fail',
        'pm_mock_refund_fail',
        'pm_mock_retry_once',
      ].includes(reference)
    )
      throw new AppError(400, 'UNSUPPORTED_PAYMENT_METHOD', 'Unsupported simulated payment method');
  }
  async execute(operation: PaymentTransaction, payment: Payment): Promise<ProcessorResult> {
    // This separately committed ledger transaction models an independent remote durable ledger.
    // No merchant payment lock is held here. Identical retries return the same receipt.
    return this.db.$transaction(async (ledger) => {
      await lockKey(ledger, `mock:${payment.id}:${operation.type}`);
      const previous = await ledger.processorRecord.findUnique({
        where: { operationId: operation.id },
      });
      if (previous) return result(previous);
      const previousFailure =
        payment.paymentMethodReference === 'pm_mock_retry_once'
          ? await ledger.processorRecord.findFirst({
              where: { paymentId: payment.id, type: operation.type, status: 'FAILED' },
            })
          : null;
      const failed =
        (payment.paymentMethodReference === 'pm_mock_retry_once' && !previousFailure) ||
        payment.paymentMethodReference === 'pm_mock_decline' ||
        (payment.paymentMethodReference === 'pm_mock_capture_fail' &&
          operation.type === 'CAPTURE') ||
        (payment.paymentMethodReference === 'pm_mock_refund_fail' && operation.type === 'REFUND');
      await ledger.processorRecord.createMany({
        skipDuplicates: true,
        data: {
          operationId: operation.id,
          paymentId: payment.id,
          type: operation.type,
          amount: operation.amount,
          currency: payment.currency,
          status: failed ? 'FAILED' : 'SUCCEEDED',
          failureCode: failed ? 'MOCK_DECLINED' : null,
        },
      });
      return result(
        await ledger.processorRecord.findUniqueOrThrow({ where: { operationId: operation.id } }),
      );
    });
  }
  async lookup(operationId: string) {
    const record = await this.db.processorRecord.findUnique({ where: { operationId } });
    return record ? result(record) : null;
  }
  async list({ cursor, limit }: { cursor?: string; limit: number }) {
    const rows = await this.db.processorRecord.findMany({
      orderBy: { id: 'asc' },
      take: Math.min(limit, 500) + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const data = rows.slice(0, limit);
    return { data: data.map(result), nextCursor: rows.length > limit ? data.at(-1)!.id : null };
  }
}
