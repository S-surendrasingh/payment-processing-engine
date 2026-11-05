const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (schema: object) => ({ 'application/json': { schema } });
const response = (description: string, schema: object) => ({
  description,
  content: content(schema),
});
const body = (schema: object) => ({ required: true, content: content(schema) });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const key = (required = true) => ({
  name: 'Idempotency-Key',
  in: 'header',
  required,
  description:
    'Reuse for retries. A different key starts a new attempt only after a confirmed failure. Default authorize/capture key: default.',
  schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
});
const paging = [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
];
const errors = Object.fromEntries(
  [
    [400, 'Invalid request'],
    [401, 'Invalid webhook signature'],
    [404, 'Not found'],
    [409, 'State or idempotency conflict'],
    [413, 'Body too large'],
    [415, 'Unsupported content encoding'],
    [429, 'Reconciliation already running'],
    [500, 'Data integrity failure'],
    [502, 'Processor receipt mismatch'],
    [422, 'Unknown customer or declined operation'],
    [503, 'Temporary failure; retry same operation key'],
  ].map(([status, description]) => [String(status), response(String(description), ref('Error'))]),
);
const amount = {
  type: 'integer',
  minimum: 1,
  maximum: 2000000000,
  description: 'Integer minor units; e.g. 1000 = USD 10.00',
};
const string = { type: 'string' };
const uuid = { type: 'string', format: 'uuid' };
const date = { type: 'string', format: 'date-time' };
const operationStatus = { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED'] };
const object = (properties: object, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const list = (name: string) =>
  object(
    {
      data: { type: 'array', items: ref(name) },
      total: { type: 'integer' },
      page: { type: 'integer' },
      limit: { type: 'integer' },
    },
    ['data', 'total', 'page', 'limit'],
  );
const action = (name: string) => ({
  summary: `${name} a payment`,
  tags: ['Payments'],
  parameters: [id, key(false)],
  responses: {
    ...errors,
    200: response('Completed operation, including replay', ref('PaymentAction')),
    422: response(
      'Confirmed processor decline; use a new key for a new attempt',
      ref('PaymentAction'),
    ),
  },
});
export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Payment Processing Engine',
    version: '1.0.0',
    description:
      'Local demonstration only. No real money or card data. Run on localhost; authentication and tenant isolation are not implemented.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/api/v1/health': {
      get: {
        summary: 'Database readiness',
        responses: {
          200: response('Ready', object({ status: string, processor: string })),
          503: errors['503'],
        },
      },
    },
    '/api/v1/payments': {
      post: {
        summary: 'Create a payment atomically with its idempotent response',
        tags: ['Payments'],
        parameters: [key()],
        requestBody: body(ref('CreatePayment')),
        responses: {
          ...errors,
          201: {
            ...response('Created or original response replayed', ref('Payment')),
            headers: { 'Idempotency-Replayed': { schema: { type: 'boolean' } } },
          },
        },
      },
    },
    '/api/v1/payments/{id}': {
      get: {
        summary: 'Get current payment',
        tags: ['Payments'],
        parameters: [id],
        responses: { ...errors, 200: response('Payment', ref('Payment')) },
      },
    },
    '/api/v1/payments/{id}/authorize': { post: action('Authorize') },
    '/api/v1/payments/{id}/capture': { post: action('Capture') },
    '/api/v1/payments/{id}/refunds': {
      post: {
        summary: 'Full or partial refund',
        tags: ['Refunds'],
        parameters: [id, key()],
        requestBody: body({ ...object({ amount }, ['amount']), additionalProperties: false }),
        responses: {
          ...errors,
          201: response('Refund or original refund replayed', ref('Refund')),
          422: response('Processor declined refund; reservation released', ref('Refund')),
        },
      },
      get: {
        summary: 'Refund history',
        tags: ['Refunds'],
        parameters: [id, ...paging],
        responses: { ...errors, 200: response('Refunds', list('Refund')) },
      },
    },
    '/api/v1/webhooks/processor': {
      post: {
        summary: 'Durably enqueue a signed processor event',
        description:
          'HMAC-SHA256 over timestamp + dot + exact raw JSON bytes. Timestamp must be within 300 seconds. Identical event IDs deduplicate; changed content conflicts.',
        tags: ['Webhooks'],
        parameters: [
          {
            name: 'X-Processor-Timestamp',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: '^\\d{10}$' },
          },
          {
            name: 'X-Processor-Signature',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          },
        ],
        requestBody: body(ref('WebhookPayload')),
        responses: {
          ...errors,
          202: response(
            'Accepted, processing is asynchronous',
            object({ eventId: string, status: string }),
          ),
        },
      },
    },
    '/api/v1/webhooks/events': {
      get: {
        summary: 'Webhook status and attempts',
        tags: ['Webhooks'],
        parameters: paging,
        responses: { ...errors, 200: response('Events', list('WebhookEvent')) },
      },
    },
    '/api/v1/reconciliation/run': {
      post: {
        summary: 'Persist a read-only reconciliation report',
        tags: ['Reconciliation'],
        responses: {
          ...errors,
          201: response(
            'Report; financial records are never modified',
            ref('ReconciliationRecord'),
          ),
        },
      },
    },
    '/api/v1/reconciliation/reports': {
      get: {
        summary: 'Reconciliation reports',
        tags: ['Reconciliation'],
        parameters: paging,
        responses: { ...errors, 200: response('Reports', list('ReconciliationRecord')) },
      },
    },
  },
  components: {
    schemas: {
      CreatePayment: {
        ...object(
          {
            amount,
            currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'INR'] },
            customerId: uuid,
            paymentMethodReference: {
              type: 'string',
              enum: [
                'pm_mock_ok',
                'pm_mock_decline',
                'pm_mock_capture_fail',
                'pm_mock_refund_fail',
                'pm_mock_retry_once',
              ],
            },
          },
          ['amount', 'currency', 'customerId', 'paymentMethodReference'],
        ),
        additionalProperties: false,
      },
      Payment: object({
        id: uuid,
        reference: string,
        amount,
        currency: string,
        customerId: uuid,
        paymentMethodReference: string,
        status: {
          type: 'string',
          enum: ['PENDING', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED'],
        },
        capturedAmount: { type: 'integer' },
        refundedAmount: { type: 'integer' },
        createdAt: date,
        updatedAt: date,
      }),
      Operation: object({
        id: uuid,
        paymentId: uuid,
        type: { type: 'string', enum: ['AUTHORIZE', 'CAPTURE', 'REFUND'] },
        amount,
        status: operationStatus,
        failureCode: { type: 'string', nullable: true },
        createdAt: date,
        updatedAt: date,
      }),
      PaymentAction: object({ payment: ref('Payment'), operation: ref('Operation') }, [
        'payment',
        'operation',
      ]),
      Refund: object({
        id: uuid,
        paymentId: uuid,
        transactionId: uuid,
        amount,
        status: operationStatus,
        createdAt: date,
        updatedAt: date,
      }),
      WebhookPayload: {
        ...object(
          {
            eventId: { type: 'string', minLength: 1, maxLength: 128 },
            operationId: uuid,
            paymentId: uuid,
            type: { type: 'string', enum: ['AUTHORIZE', 'CAPTURE', 'REFUND'] },
            amount,
            currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'INR'] },
            status: { type: 'string', enum: ['SUCCEEDED', 'FAILED'] },
          },
          ['eventId', 'operationId', 'paymentId', 'type', 'amount', 'currency', 'status'],
        ),
        additionalProperties: false,
      },
      WebhookEvent: object({
        id: uuid,
        eventId: string,
        payload: ref('WebhookPayload'),
        status: { type: 'string', enum: ['PENDING', 'PROCESSED', 'FAILED', 'DEAD'] },
        attempts: { type: 'integer' },
        nextAttemptAt: date,
        lastError: { type: 'string', nullable: true },
        createdAt: date,
        updatedAt: date,
      }),
      ReconciliationRecord: object({
        id: uuid,
        report: object({
          startedAt: date,
          finishedAt: date,
          operationCount: { type: 'integer' },
          processorCount: { type: 'integer' },
          discrepancyCount: { type: 'integer' },
          discrepancies: {
            type: 'array',
            items: object({
              kind: string,
              operationId: uuid,
              paymentId: uuid,
              internal: {},
              processor: {},
            }),
          },
        }),
        createdAt: date,
        updatedAt: date,
      }),
      Error: object(
        {
          error: object(
            {
              code: string,
              message: string,
              retryable: { type: 'boolean' },
              requestId: string,
              details: {
                type: 'array',
                items: object({ path: { type: 'array', items: {} }, message: string }),
              },
            },
            ['code', 'message'],
          ),
        },
        ['error'],
      ),
    },
  },
};
