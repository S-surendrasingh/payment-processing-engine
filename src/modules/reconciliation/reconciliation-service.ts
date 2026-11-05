import { Prisma } from '@prisma/client';
import { AppError } from '../../shared/errors.js';
import type { PaymentService } from '../payments/payment-service.js';
import type { ProcessorResult } from '../processors/payment-processor.js';
import { audit } from './audit.js';
export class ReconciliationService {
  private running = false;
  constructor(
    private readonly payments: PaymentService,
    private readonly maxRecords = 2000,
    private readonly pageSize = 200,
  ) {}
  async run() {
    if (this.running)
      throw new AppError(
        429,
        'RECONCILIATION_BUSY',
        'A reconciliation run is already active',
        true,
      );
    this.running = true;
    const startedAt = new Date();
    try {
      const receipts: ProcessorResult[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        if (Date.now() - startedAt.getTime() > 30000)
          throw new AppError(
            503,
            'RECONCILIATION_TIMEOUT',
            'Reconciliation exceeded its time budget; no report saved',
            true,
          );
        const page = await this.payments.callProcessor(
          (signal) => this.payments.processor.list({ cursor, limit: this.pageSize }, signal),
          true,
        );
        if (page.data.length > this.pageSize || (page.data.length === 0 && page.nextCursor))
          throw new AppError(502, 'INVALID_PROCESSOR_PAGE', 'Processor exceeded the page limit');
        receipts.push(...page.data);
        if (receipts.length > this.maxRecords) throw this.limitError();
        if (page.nextCursor && seen.has(page.nextCursor))
          throw new AppError(502, 'INVALID_PROCESSOR_PAGE', 'Processor cursor did not advance');
        cursor = page.nextCursor ?? undefined;
        if (cursor) seen.add(cursor);
      } while (cursor);
      const snapshot = await this.payments.db.$transaction(
        async (tx) => {
          // Each query has a hard ceiling; oversize snapshots fail explicitly and never produce a falsely clean report.
          const take = this.maxRecords + 1;
          const payments = await tx.payment.findMany({ take, orderBy: { id: 'asc' } });
          const operations = await tx.paymentTransaction.findMany({ take, orderBy: { id: 'asc' } });
          const refunds = await tx.refund.findMany({ take, orderBy: { id: 'asc' } });
          if ([payments, operations, refunds].some((rows) => rows.length > this.maxRecords))
            throw this.limitError();
          return { payments, operations, refunds };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 },
      );
      const discrepancies = audit(
        snapshot.payments,
        snapshot.operations,
        snapshot.refunds,
        receipts,
      );
      const report = {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        operationCount: snapshot.operations.length,
        processorCount: receipts.length,
        refundCount: snapshot.refunds.length,
        discrepancyCount: discrepancies.length,
        discrepancies,
      };
      return await this.payments.db.reconciliationRecord.create({
        data: { report: report as unknown as Prisma.InputJsonObject },
      });
    } finally {
      this.running = false;
    }
  }
  private limitError() {
    return new AppError(
      422,
      'RECONCILIATION_LIMIT_EXCEEDED',
      'Demo reconciliation capacity exceeded; no partial report was saved',
    );
  }
  async list(page: number, limit: number) {
    const [data, total] = await this.payments.db.$transaction(
      [
        this.payments.db.reconciliationRecord.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.payments.db.reconciliationRecord.count(),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { data, total, page, limit };
  }
}
