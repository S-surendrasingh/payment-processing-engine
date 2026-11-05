-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('AUTHORIZE', 'CAPTURE', 'REFUND');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "customerId" UUID NOT NULL,
    "paymentMethodReference" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "capturedAmount" INTEGER NOT NULL DEFAULT 0,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "type" "OperationType" NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processor_records" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "type" "OperationType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "OperationStatus" NOT NULL,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processor_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_records" (
    "id" UUID NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");

-- CreateIndex
CREATE INDEX "payments_customerId_createdAt_idx" ON "payments"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_transactionId_key" ON "refunds"("transactionId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_createdAt_idx" ON "refunds"("paymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_key_key" ON "payment_transactions"("key");

-- CreateIndex
CREATE INDEX "payment_transactions_paymentId_createdAt_idx" ON "payment_transactions"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_transactions_status_createdAt_idx" ON "payment_transactions"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "processor_records_operationId_key" ON "processor_records"("operationId");

-- CreateIndex
CREATE INDEX "processor_records_paymentId_idx" ON "processor_records"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_eventId_key" ON "webhook_events"("eventId");

-- CreateIndex
CREATE INDEX "webhook_events_status_nextAttemptAt_idx" ON "webhook_events"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "reconciliation_records_createdAt_idx" ON "reconciliation_records"("createdAt");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Financial invariants also apply to direct SQL writes.
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0 AND amount <= 2000000000);
ALTER TABLE payments ADD CONSTRAINT payments_balances_valid CHECK ("capturedAmount" >= 0 AND "capturedAmount" <= amount AND "refundedAmount" >= 0 AND "refundedAmount" <= "capturedAmount");
ALTER TABLE payments ADD CONSTRAINT payments_currency_valid CHECK (currency IN ('USD', 'EUR', 'GBP', 'INR'));
ALTER TABLE payments ADD CONSTRAINT payments_status_balances CHECK (
  (status IN ('PENDING','PROCESSING','AUTHORIZED','FAILED') AND "capturedAmount" = 0 AND "refundedAmount" = 0)
  OR (status = 'CAPTURED' AND "capturedAmount" = amount AND "refundedAmount" < "capturedAmount")
  OR (status = 'REFUNDED' AND "capturedAmount" = amount AND "refundedAmount" = "capturedAmount")
);
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_positive CHECK (amount > 0 AND amount <= 2000000000);
ALTER TABLE payment_transactions ADD CONSTRAINT transactions_amount_positive CHECK (amount > 0 AND amount <= 2000000000);
ALTER TABLE processor_records ADD CONSTRAINT processor_amount_positive CHECK (amount > 0 AND amount <= 2000000000);
ALTER TABLE processor_records ADD CONSTRAINT processor_terminal_status CHECK (status IN ('SUCCEEDED','FAILED'));
ALTER TABLE webhook_events ADD CONSTRAINT webhook_attempts_nonnegative CHECK (attempts >= 0);
-- Failed attempts release the slot; pending/confirmed-success attempts retain it.
CREATE UNIQUE INDEX one_active_authorization_or_capture ON payment_transactions ("paymentId", type)
  WHERE type IN ('AUTHORIZE','CAPTURE') AND status IN ('PENDING','SUCCEEDED');
