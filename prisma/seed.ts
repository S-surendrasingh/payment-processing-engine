import { db } from '../src/database/client.js';
try {
  const customer = await db.customer.upsert({
    where: { id: '11111111-1111-4111-8111-111111111111' },
    update: {},
    create: { id: '11111111-1111-4111-8111-111111111111', name: 'Demo Customer' },
  });
  console.log(`Demo customer: ${customer.id}`);
} finally {
  await db.$disconnect();
}
