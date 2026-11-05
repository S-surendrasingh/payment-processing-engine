import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, classifyError } from '../shared/errors.js';
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        retryable: false,
        message: 'Invalid request',
        details: error.issues.map((i) => ({ path: i.path, message: i.message })),
        requestId: req.id,
      },
    });
    return;
  }
  if (error instanceof AppError) {
    if (error.status >= 500)
      req.log.error(
        { code: error.code, retryable: error.retryable },
        'Operation requires retry or investigation',
      );
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        requestId: req.id,
      },
    });
    return;
  }
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
  if (status === 400 || status === 413 || status === 415) {
    res.status(status).json({
      error: {
        code: 'INVALID_BODY',
        retryable: false,
        message: 'Invalid or oversized request body',
        requestId: req.id,
      },
    });
    return;
  }
  // Do not log raw exceptions: database/processor errors can embed credentials or sensitive data.
  const failure = classifyError(error);
  req.log.error(
    { requestId: req.id, code: failure.code, retryable: failure.retryable },
    'Request failed',
  );
  res.status(failure.status).json({
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      requestId: req.id,
    },
  });
};
