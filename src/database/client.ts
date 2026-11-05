import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/env.js';
export const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: 20,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  }),
});
