import { ValidationError } from '../../core/errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IntegerQueryOptions {
  readonly defaultValue?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const optionalQueryString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ValidationError('Must be a string', field);
  const normalized = value.trim();
  return normalized || undefined;
};

export const parseQueryInteger = (
  value: unknown,
  field: string,
  options: IntegerQueryOptions = {},
): number | undefined => {
  if (value === undefined) return options.defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError('Must be an integer', field);
  }
  const parsed = Number(value);
  const minimum = options.minimum ?? Number.MIN_SAFE_INTEGER;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const message =
      options.minimum !== undefined && options.maximum !== undefined
        ? `Must be an integer between ${minimum} and ${maximum}`
        : options.minimum !== undefined
          ? `Must be an integer greater than or equal to ${minimum}`
          : `Must be an integer less than or equal to ${maximum}`;
    throw new ValidationError(message, field);
  }
  return parsed;
};

export const parseQueryNumber = (value: unknown, field: string): number | undefined => {
  const text = optionalQueryString(value, field);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new ValidationError('Must be a finite number', field);
  return parsed;
};

export const parseQueryBoolean = (
  value: unknown,
  field: string,
  defaultValue?: boolean,
): boolean | undefined => {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError('Must be true or false', field);
};

export const optionalBooleanField = (body: unknown, field: string): boolean | undefined => {
  const value = requireObject(body)[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError('Must be a boolean', field);
  return value;
};

export const optionalIntegerField = (
  body: unknown,
  field: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number | undefined => {
  const value = requireObject(body)[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new ValidationError('Must be an integer', field);
  const parsed = value as number;
  if (options.minimum !== undefined && parsed < options.minimum) {
    throw new ValidationError(`Must be at least ${options.minimum}`, field);
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    throw new ValidationError(`Must be at most ${options.maximum}`, field);
  }
  return parsed;
};

export const parseQueryDate = (value: unknown, field: string): Date | undefined => {
  const text = optionalQueryString(value, field);
  if (text === undefined) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError('Must be a valid date', field);
  return parsed;
};

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new ValidationError('Must be a valid UUID', field);
  }
  return value;
};

export type UnknownRecord = Record<string, unknown>;

export const requireObject = (value: unknown, field = 'body'): UnknownRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Must be an object', field);
  }
  return value as UnknownRecord;
};

export const requireStringField = (
  value: unknown,
  field: string,
  options: { readonly trim?: boolean; readonly allowEmpty?: boolean } = {},
): string => {
  const candidate = requireObject(value)[field];
  if (typeof candidate !== 'string') {
    throw new ValidationError('Must be a string', field);
  }
  const parsed = options.trim === false ? candidate : candidate.trim();
  if (!options.allowEmpty && parsed.length === 0) {
    throw new ValidationError('Is required', field);
  }
  return parsed;
};
