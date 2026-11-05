import type { Prisma } from '@prisma/client';
import { missing } from '../shared/errors.js';
export async function lockPayment(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUnique({ where: { id } });
  if (!payment) throw missing();
  return payment;
}
// Transaction-scoped advisory locks serialize absent-row creation; UNIQUE constraints remain the final guard.
export async function lockKey(tx: Prisma.TransactionClient, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}
