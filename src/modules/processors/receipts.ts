import { z } from 'zod';
import type { Payment, PaymentTransaction } from '@prisma/client';
import { ReceiptMismatch } from '../../shared/errors.js';
const schema = z.object({
  operationId: z.string().uuid(),
  paymentId: z.string().uuid(),
  type: z.enum(['AUTHORIZE', 'CAPTURE', 'REFUND']),
  amount: z.number().int().positive().max(2_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(['SUCCEEDED', 'FAILED']),
  failureCode: z.string().max(128).nullable(),
});
export function validateReceipt(value: unknown, operation: PaymentTransaction, payment: Payment) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ReceiptMismatch();
  const receipt = parsed.data;
  if (
    receipt.operationId !== operation.id ||
    receipt.paymentId !== operation.paymentId ||
    receipt.paymentId !== payment.id ||
    receipt.type !== operation.type ||
    receipt.amount !== operation.amount ||
    receipt.currency !== payment.currency
  )
    throw new ReceiptMismatch();
  return receipt;
}
