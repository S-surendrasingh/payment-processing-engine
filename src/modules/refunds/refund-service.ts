import { Prisma } from '@prisma/client';
import type { PaymentService } from '../payments/payment-service.js';
export class RefundService {
  constructor(private readonly payments: PaymentService) {}
  async create(paymentId: string, amount: number, key: string) {
    const operation = await this.payments.reserve(paymentId, 'REFUND', { amount, key });
    await this.payments.execute(operation.id);
    return this.payments.db.refund.findUniqueOrThrow({ where: { transactionId: operation.id } });
  }
  async list(paymentId: string, page: number, limit: number) {
    await this.payments.get(paymentId);
    const where = { paymentId };
    const [data, total] = await this.payments.db.$transaction(
      [
        this.payments.db.refund.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.payments.db.refund.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { data, page, limit, total };
  }
}
