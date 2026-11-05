import 'dotenv/config';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Refusing destructive tests: TEST_DATABASE_URL must end in _test');
process.env.DATABASE_URL = url;
process.env.WEBHOOK_SECRET = 'test-only-webhook-secret-32-bytes';
process.env.LOG_LEVEL = 'silent';
