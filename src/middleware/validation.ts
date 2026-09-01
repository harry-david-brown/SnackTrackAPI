import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../core/errors';
import { isUuid, parseQueryInteger, requireObject } from '../http/validation/requestValues';

// Email validation
export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// UUID validation
export const validateUUID = (uuid: string): boolean => {
  return isUuid(uuid);
};

// UUID parameter validation
export const validateUUIDParam = (paramName: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const uuid = req.params[paramName];

    if (!uuid) {
      throw new ValidationError(`${paramName} parameter is required`, paramName);
    }

    if (!validateUUID(uuid)) {
      throw new ValidationError(`Invalid ${paramName} format`, paramName);
    }

    next();
  };
};

// Pagination validation
export const validatePagination = (req: Request, res: Response, next: NextFunction) => {
  const { limit, offset } = req.query;

  if (limit !== undefined) {
    parseQueryInteger(limit, 'limit', { minimum: 1, maximum: 1000 });
  }

  if (offset !== undefined) {
    parseQueryInteger(offset, 'offset', { minimum: 0 });
  }

  next();
};

// CSV import validation
export const validateCSVImport = (req: Request, res: Response, next: NextFunction) => {
  const { userId } = requireObject(req.body as unknown);

  if (!userId) {
    throw new ValidationError('userId is required for CSV import', 'userId');
  }

  if (typeof userId !== 'string' || !validateUUID(userId)) {
    throw new ValidationError('Invalid userId format', 'userId');
  }

  // Check if file was uploaded
  if (!req.file) {
    throw new ValidationError('CSV file is required', 'file');
  }

  // Check file type
  if (req.file.mimetype !== 'text/csv' && !req.file.originalname.endsWith('.csv')) {
    throw new ValidationError('File must be a CSV file', 'file');
  }

  // Check file size (max 10MB)
  if (req.file.size > 10 * 1024 * 1024) {
    throw new ValidationError('File size must be less than 10MB', 'file');
  }

  next();
};

// Receipt creation validation
export const validateReceiptCreation = (req: Request, res: Response, next: NextFunction) => {
  const { userId, restaurantName, amountSpent, orderDate } = requireObject(req.body as unknown);

  if (!userId) {
    throw new ValidationError('userId is required', 'userId');
  }

  if (typeof userId !== 'string' || !validateUUID(userId)) {
    throw new ValidationError('Invalid userId format', 'userId');
  }

  if (!restaurantName || typeof restaurantName !== 'string') {
    throw new ValidationError('restaurantName is required and must be a string', 'restaurantName');
  }

  if (amountSpent === undefined || amountSpent === null) {
    throw new ValidationError('amountSpent is required', 'amountSpent');
  }

  const amountNum =
    typeof amountSpent === 'number'
      ? amountSpent
      : typeof amountSpent === 'string'
        ? Number(amountSpent)
        : Number.NaN;
  if (isNaN(amountNum) || amountNum < 0) {
    throw new ValidationError('amountSpent must be a non-negative number', 'amountSpent');
  }

  if (orderDate) {
    if (typeof orderDate !== 'string' && typeof orderDate !== 'number') {
      throw new ValidationError('orderDate must be a valid date', 'orderDate');
    }
    const date = new Date(orderDate);
    if (isNaN(date.getTime())) {
      throw new ValidationError('orderDate must be a valid date', 'orderDate');
    }
  }

  next();
};
