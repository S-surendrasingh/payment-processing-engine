ALTER TABLE payment_transactions
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "recoveryBlocked" BOOLEAN NOT NULL DEFAULT false;
DROP INDEX "payment_transactions_status_createdAt_idx";
CREATE INDEX "payment_transactions_status_recoveryBlocked_nextAttemptAt_id_idx"
  ON payment_transactions(status, "recoveryBlocked", "nextAttemptAt", id);
CREATE UNIQUE INDEX "payment_transactions_id_paymentId_key" ON payment_transactions(id, "paymentId");
ALTER TABLE refunds DROP CONSTRAINT "refunds_transactionId_fkey";
ALTER TABLE refunds ADD CONSTRAINT "refunds_transactionId_paymentId_fkey"
  FOREIGN KEY ("transactionId", "paymentId") REFERENCES payment_transactions(id, "paymentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deferred checks allow financial finalization to update both rows in either order, but never commit disagreement.
CREATE FUNCTION check_refund_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'refunds' THEN operation_id := NEW."transactionId";
  ELSE operation_id := NEW.id; END IF;
  IF EXISTS (
    SELECT 1 FROM refunds r JOIN payment_transactions t ON t.id = r."transactionId"
    WHERE t.id = operation_id AND (t.type <> 'REFUND' OR r.amount <> t.amount OR r.status <> t.status OR r."paymentId" <> t."paymentId")
  ) THEN RAISE EXCEPTION 'Refund transaction invariant violated' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER refund_transaction_consistent AFTER INSERT OR UPDATE ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_transaction();
CREATE CONSTRAINT TRIGGER transaction_refund_consistent AFTER INSERT OR UPDATE ON payment_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_transaction();
-- Fail migration on preexisting inconsistent rows rather than silently accepting them.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM refunds r JOIN payment_transactions t ON t.id=r."transactionId"
    WHERE t.type <> 'REFUND' OR r.amount <> t.amount OR r.status <> t.status)
  THEN RAISE EXCEPTION 'Existing refund history requires investigation'; END IF;
END $$;
