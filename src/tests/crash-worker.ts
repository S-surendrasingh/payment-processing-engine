import './setup.js';
import { db } from '../database/client.js';
import { MockPaymentProcessor } from '../modules/processors/mock-processor.js';
const operation = await db.paymentTransaction.findUniqueOrThrow({ where: { id: process.argv[2] } });
const payment = await db.payment.findUniqueOrThrow({ where: { id: operation.paymentId } });
await new MockPaymentProcessor(db).execute(operation, payment);
// Simulate loss of the application immediately after the independent processor commit.
process.exit(17);
