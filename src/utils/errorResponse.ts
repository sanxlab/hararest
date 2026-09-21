import { STATUS_CODES } from 'node:http';
import { AppError } from './AppError';

/** Preserve intentional client/upstream errors without disclosing internal failures. */
export function publicErrorMessage(error: unknown, statusCode: number): string {
  if (process.env.NODE_ENV === 'development' && error instanceof Error) return error.message;
  if (error instanceof AppError && statusCode !== 500) return error.message;
  return STATUS_CODES[statusCode] || 'Request failed.';
}
