import { AppError } from './AppError';

export function queryInteger(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AppError(`Parameter "${name}" must be an integer between 1 and ${max}.`, 400);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new AppError(`Parameter "${name}" must be an integer between 1 and ${max}.`, 400);
  }
  return number;
}
