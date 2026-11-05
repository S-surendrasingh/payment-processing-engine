import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const runtimePassword = randomBytes(24).toString('hex');
const webhookSecret = randomBytes(32).toString('hex');
const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const content = example
  .replaceAll('replace-runtime-password-with-generated-value', runtimePassword)
  .replaceAll('replace-webhook-secret-with-generated-value', webhookSecret);
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with fresh runtime and webhook secrets');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved');
}
