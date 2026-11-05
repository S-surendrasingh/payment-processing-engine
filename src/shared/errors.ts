export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export class ProcessorTimeout extends AppError {
  constructor() {
    super(
      503,
      'PROCESSOR_TIMEOUT',
      'Processor outcome is unknown; retry the same operation key',
      true,
    );
  }
}
export class ReceiptMismatch extends AppError {
  constructor() {
    super(
      502,
      'PROCESSOR_RECEIPT_MISMATCH',
      'Processor receipt requires investigation; operation remains reserved',
    );
  }
}
export function classifyError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const codes = new Set<string>();
  function inspect(value: unknown, depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 4) return;
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'originalCode'])
      if (typeof record[key] === 'string') codes.add(record[key]);
    for (const key of ['cause', 'meta', 'driverAdapterError']) inspect(record[key], depth + 1);
  }
  inspect(error);
  if (
    [
      '40001',
      '40P01',
      '57014',
      '55P03',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'P1001',
      'P1002',
      'P2024',
      'P2034',
    ].some((code) => codes.has(code))
  ) {
    return new AppError(
      503,
      'TEMPORARILY_UNAVAILABLE',
      'Outcome may be unknown; retry the same operation key',
      true,
    );
  }
  if (
    ['P2002', 'P2003', 'P2004', 'P2025', '23503', '23505', '23514'].some((code) => codes.has(code))
  )
    return new AppError(
      500,
      'DATA_INTEGRITY_ERROR',
      'Data integrity failure requires investigation',
    );
  if (error instanceof TypeError || error instanceof RangeError)
    return new AppError(500, 'INTERNAL_ERROR', 'Internal error requires investigation');
  return new AppError(
    503,
    'TEMPORARILY_UNAVAILABLE',
    'Outcome may be unknown; retry the same operation key',
    true,
  );
}
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const missing = () => new AppError(404, 'NOT_FOUND', 'Payment not found');
