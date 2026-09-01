type Row = Record<string, unknown>;

const invalid = (field: string, expectation: string): never => {
  throw new Error(`Invalid database value for ${field}: expected ${expectation}`);
};

export const databaseRow = (value: unknown, context: string): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(context, 'row object');
  }
  return value as Row;
};

export const databaseString = (row: Row, field: string): string => {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : invalid(field, 'non-empty string');
};

export const databaseUuid = (row: Row, field: string): string => {
  const value = databaseString(row, field);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : invalid(field, 'UUID');
};

export const databaseNullableString = (row: Row, field: string): string | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : invalid(field, 'string or null');
};

export const databaseBoolean = (row: Row, field: string): boolean => {
  const value = row[field];
  return typeof value === 'boolean' ? value : invalid(field, 'boolean');
};

export const databaseStringArray = (row: Row, field: string): string[] => {
  const value = row[field];
  if (!Array.isArray(value)) return invalid(field, 'string array');
  return value.map((entry, index) =>
    typeof entry === 'string' ? entry : invalid(`${field}.${index}`, 'string'),
  );
};

export const databaseEnum = <Value extends string>(
  row: Row,
  field: string,
  values: readonly Value[],
): Value => {
  const value = row[field];
  return typeof value === 'string' && values.includes(value as Value)
    ? (value as Value)
    : invalid(field, values.join(' | '));
};

export const databaseNullableEnum = <Value extends string>(
  row: Row,
  field: string,
  values: readonly Value[],
): Value | null => {
  if (row[field] === null || row[field] === undefined) return null;
  return databaseEnum(row, field, values);
};

export const databaseTimestamp = (row: Row, field: string): string | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(databaseString(row, field));
  return Number.isNaN(date.getTime())
    ? invalid(field, 'valid timestamp or null')
    : date.toISOString();
};

export const databaseNonNegativeInteger = (row: Row, field: string): number => {
  const value = row[field];
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(number) && number >= 0 ? number : invalid(field, 'non-negative integer');
};
