import { createHash } from 'node:crypto';
import { z } from 'zod';
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const money = z.number().int().positive().max(2_000_000_000);
export const uuid = z.string().uuid();
export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
