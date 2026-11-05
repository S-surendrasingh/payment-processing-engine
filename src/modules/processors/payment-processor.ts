import type { OperationType, Payment, PaymentTransaction } from '@prisma/client';
export interface ProcessorResult {
  operationId: string;
  paymentId: string;
  type: OperationType;
  amount: number;
  currency: string;
  status: 'SUCCEEDED' | 'FAILED';
  failureCode: string | null;
}
export interface ProcessorPage {
  data: ProcessorResult[];
  nextCursor: string | null;
}
export interface PaymentProcessor {
  validatePaymentMethod?(reference: string): void;
  // Must be durably idempotent on operation.id, including concurrent calls and process restarts.
  execute(
    operation: PaymentTransaction,
    payment: Payment,
    signal?: AbortSignal,
  ): Promise<ProcessorResult>;
  lookup(operationId: string, signal?: AbortSignal): Promise<ProcessorResult | null>;
  list(options: { cursor?: string; limit: number }, signal?: AbortSignal): Promise<ProcessorPage>;
}
