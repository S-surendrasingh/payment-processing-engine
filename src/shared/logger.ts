import pino from 'pino';
import { config } from '../config/env.js';
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-processor-signature"]',
    'req.headers["idempotency-key"]',
  ],
});
