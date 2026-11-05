-- Use an explicit short name to avoid PostgreSQL's 63-byte truncation disagreeing with Prisma's generated name.
ALTER INDEX "payment_transactions_status_recoveryBlocked_nextAttemptAt_id_id"
  RENAME TO payment_transactions_recovery_due_idx;
