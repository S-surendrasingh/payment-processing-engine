import type { Payment, PaymentTransaction, Refund } from '@prisma/client';
import type { ProcessorResult } from '../processors/payment-processor.js';
export interface Discrepancy {
  kind: string;
  paymentId?: string;
  operationId?: string;
  refundId?: string;
  internal?: unknown;
  processor?: unknown;
}
export function audit(
  payments: Payment[],
  operations: PaymentTransaction[],
  refunds: Refund[],
  receipts: ProcessorResult[],
): Discrepancy[] {
  const issues: Discrepancy[] = [];
  const add = (kind: string, data: Omit<Discrepancy, 'kind'>) => issues.push({ kind, ...data });
  const byId = new Map(operations.map((o) => [o.id, o]));
  const byPayment = new Map(payments.map((p) => [p.id, p]));
  const receiptIds = new Set<string>();
  for (const receipt of receipts) {
    if (receiptIds.has(receipt.operationId))
      add('DUPLICATE_PROCESSOR_RECORD', { operationId: receipt.operationId });
    receiptIds.add(receipt.operationId);
  }
  const external = new Map(receipts.map((r) => [r.operationId, r]));
  const refundByOperation = new Map(refunds.map((r) => [r.transactionId, r]));
  for (const operation of operations) {
    const context = { operationId: operation.id, paymentId: operation.paymentId };
    const payment = byPayment.get(operation.paymentId);
    const receipt = external.get(operation.id);
    if (!payment) add('MISSING_PAYMENT', context);
    if (!receipt) add('MISSING_PROCESSOR_TRANSACTION', context);
    else {
      if (operation.status !== receipt.status)
        add('STATUS_MISMATCH', {
          ...context,
          internal: operation.status,
          processor: receipt.status,
        });
      if (operation.amount !== receipt.amount)
        add('AMOUNT_MISMATCH', {
          ...context,
          internal: operation.amount,
          processor: receipt.amount,
        });
      if (
        operation.paymentId !== receipt.paymentId ||
        operation.type !== receipt.type ||
        payment?.currency !== receipt.currency
      )
        add('METADATA_MISMATCH', context);
    }
    if (payment && operation.type !== 'REFUND' && operation.amount !== payment.amount)
      add('PAYMENT_AMOUNT_MISMATCH', {
        ...context,
        internal: payment.amount,
        processor: operation.amount,
      });
    if (operation.type === 'REFUND' && !refundByOperation.has(operation.id))
      add('MISSING_REFUND', context);
  }
  for (const refund of refunds) {
    const operation = byId.get(refund.transactionId);
    const context = {
      refundId: refund.id,
      operationId: refund.transactionId,
      paymentId: refund.paymentId,
    };
    if (!operation) add('MISSING_REFUND_TRANSACTION', context);
    else if (
      operation.type !== 'REFUND' ||
      operation.paymentId !== refund.paymentId ||
      operation.amount !== refund.amount ||
      operation.status !== refund.status
    )
      add('REFUND_TRANSACTION_MISMATCH', context);
  }
  for (const receipt of receipts)
    if (!byId.has(receipt.operationId))
      add('MISSING_INTERNAL_TRANSACTION', {
        operationId: receipt.operationId,
        paymentId: receipt.paymentId,
      });
  for (const payment of payments) {
    const context = { paymentId: payment.id };
    const ops = operations.filter((o) => o.paymentId === payment.id);
    const success = ops.filter((o) => o.status === 'SUCCEEDED');
    const auth = success.filter((o) => o.type === 'AUTHORIZE');
    const captures = success.filter((o) => o.type === 'CAPTURE');
    const successfulRefunds = refunds.filter(
      (r) => r.paymentId === payment.id && r.status === 'SUCCEEDED',
    );
    const processorRecords = receipts.filter(
      (r) => r.paymentId === payment.id && r.status === 'SUCCEEDED',
    );
    const sum = (rows: Array<{ amount: number }>) => rows.reduce((total, r) => total + r.amount, 0);
    const captured = sum(captures);
    const refunded = sum(success.filter((o) => o.type === 'REFUND'));
    if (
      captured !== payment.capturedAmount ||
      refunded !== payment.refundedAmount ||
      sum(successfulRefunds) !== refunded ||
      sum(processorRecords.filter((r) => r.type === 'CAPTURE')) !== captured ||
      sum(processorRecords.filter((r) => r.type === 'REFUND')) !== refunded
    )
      add('PAYMENT_TOTAL_MISMATCH', {
        ...context,
        internal: {
          captured: payment.capturedAmount,
          refunded: payment.refundedAmount,
          refundHistory: sum(successfulRefunds),
        },
        processor: {
          captured: sum(processorRecords.filter((r) => r.type === 'CAPTURE')),
          refunded: sum(processorRecords.filter((r) => r.type === 'REFUND')),
        },
      });
    const pendingRefunds = sum(
      refunds.filter((r) => r.paymentId === payment.id && r.status === 'PENDING'),
    );
    if (refunded + pendingRefunds > captured) add('REFUND_RESERVATION_EXCEEDS_CAPTURE', context);
    if (['AUTHORIZED', 'CAPTURED', 'REFUNDED'].includes(payment.status) && auth.length !== 1)
      add('MISSING_OR_DUPLICATE_AUTHORIZATION', context);
    if (['CAPTURED', 'REFUNDED'].includes(payment.status) && captures.length !== 1)
      add('MISSING_OR_DUPLICATE_CAPTURE', context);
    if (captures.length && auth.length !== 1) add('CAPTURE_WITHOUT_AUTHORIZATION', context);
    if (
      payment.status === 'PROCESSING' &&
      !ops.some((o) => o.type === 'AUTHORIZE' && o.status === 'PENDING')
    )
      add('MISSING_PENDING_AUTHORIZATION', context);
    if (
      payment.status === 'FAILED' &&
      !ops.some((o) => o.type === 'AUTHORIZE' && o.status === 'FAILED')
    )
      add('MISSING_FAILED_AUTHORIZATION', context);
    const expected = captures.length
      ? refunded === captured
        ? 'REFUNDED'
        : 'CAPTURED'
      : auth.length
        ? 'AUTHORIZED'
        : ops.some((o) => o.type === 'AUTHORIZE' && o.status === 'PENDING')
          ? 'PROCESSING'
          : ops.some((o) => o.type === 'AUTHORIZE' && o.status === 'FAILED')
            ? 'FAILED'
            : 'PENDING';
    if (payment.status !== expected)
      add('PAYMENT_STATUS_MISMATCH', { ...context, internal: payment.status, processor: expected });
  }
  return issues;
}
