import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentService, createPaymentSchema } from './modules/payments/payment-service.js';
import { RefundService } from './modules/refunds/refund-service.js';
import { WebhookService } from './modules/webhooks/webhook-service.js';
import { ReconciliationService } from './modules/reconciliation/reconciliation-service.js';
import type { PaymentProcessor } from './modules/processors/payment-processor.js';
import { errorHandler } from './middlewares/error-handler.js';
import { idempotencyKey, money, pagination, uuid } from './shared/utils.js';
import { logger } from './shared/logger.js';
import { openapi } from './routes/openapi.js';
export function createApp(db: PrismaClient, processor: PaymentProcessor, webhookSecret: string) {
  const payments = new PaymentService(db, processor);
  const refunds = new RefundService(payments);
  const webhooks = new WebhookService(payments, webhookSecret);
  const reconciliation = new ReconciliationService(payments);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', String(req.id));
    next();
  });
  app.post(
    '/api/v1/webhooks/processor',
    express.raw({ type: 'application/json', limit: '64kb', inflate: false }),
    async (req, res) => {
      res
        .status(202)
        .json(
          await webhooks.ingest(
            Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            req.get('X-Processor-Timestamp'),
            req.get('X-Processor-Signature'),
          ),
        );
    },
  );
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/v1/health', async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', processor: 'simulated' });
  });
  app.post('/api/v1/payments', async (req, res) => {
    const result = await payments.create(
      createPaymentSchema.parse(req.body),
      idempotencyKey.parse(req.get('Idempotency-Key')),
    );
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    res.status(result.status).json(result.body);
  });
  app.get('/api/v1/payments/:id', async (req, res) =>
    res.json(await payments.get(uuid.parse(req.params.id))),
  );
  for (const action of ['authorize', 'capture'] as const)
    app.post(`/api/v1/payments/:id/${action}`, async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const result = await payments.act(
        uuid.parse(req.params.id),
        action === 'authorize' ? 'AUTHORIZE' : 'CAPTURE',
        idempotencyKey.parse(req.get('Idempotency-Key') ?? 'default'),
      );
      res.status(result.operation.status === 'FAILED' ? 422 : 200).json(result);
    });
  app.post('/api/v1/payments/:id/refunds', async (req, res) => {
    const input = z.object({ amount: money }).strict().parse(req.body);
    const result = await refunds.create(
      uuid.parse(req.params.id),
      input.amount,
      idempotencyKey.parse(req.get('Idempotency-Key')),
    );
    res.status(result.status === 'FAILED' ? 422 : 201).json(result);
  });
  app.get('/api/v1/payments/:id/refunds', async (req, res) => {
    const { page, limit } = pagination.parse(req.query);
    res.json(await refunds.list(uuid.parse(req.params.id), page, limit));
  });
  app.get('/api/v1/webhooks/events', async (req, res) => {
    const { page, limit } = pagination.parse(req.query);
    res.json(await webhooks.list(page, limit));
  });
  app.post('/api/v1/reconciliation/run', async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    res.status(201).json(await reconciliation.run());
  });
  app.get('/api/v1/reconciliation/reports', async (req, res) => {
    const { page, limit } = pagination.parse(req.query);
    res.json(await reconciliation.list(page, limit));
  });
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
  app.use((req, res) =>
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        retryable: false,
        message: 'Route not found',
        requestId: req.id,
      },
    }),
  );
  app.use(errorHandler);
  return { app, payments, refunds, webhooks, reconciliation };
}
