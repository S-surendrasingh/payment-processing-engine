import 'dotenv/config';
import { z } from 'zod';
export const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    WEBHOOK_SECRET: z
      .string()
      .min(24)
      .refine(
        (value) => !value.startsWith('replace-') && value !== 'local-demo-webhook-secret-change-me',
        'Generate a webhook secret with npm run env:init',
      ),
    PROCESSOR_TIMEOUT_MS: z.coerce.number().int().min(10).max(60000).default(5000),
    PROCESSOR_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
    WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  })
  .parse(process.env);
