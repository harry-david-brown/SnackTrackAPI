import { Request, Response, NextFunction } from 'express';
import { ValidationError } from './errorHandler';

// Email validation
export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// UUID validation
export const validateUUID = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

// User creation validation
export const validateUserCreation = (req: Request, res: Response, next: NextFunction) => {
  const { email } = req.body;

  if (!email) {
    throw new ValidationError('Email is required', 'email');
  }

  if (typeof email !== 'string') {
    throw new ValidationError('Email must be a string', 'email');
  }

  if (!validateEmail(email)) {
    throw new ValidationError('Invalid email format', 'email');
  }

  next();
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
    const limitNum = parseInt(limit as string);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
      throw new ValidationError('Limit must be a number between 1 and 1000', 'limit');
    }
  }

  if (offset !== undefined) {
    const offsetNum = parseInt(offset as string);
    if (isNaN(offsetNum) || offsetNum < 0) {
      throw new ValidationError('Offset must be a non-negative number', 'offset');
    }
  }

  next();
};

// CSV import validation
export const validateCSVImport = (req: Request, res: Response, next: NextFunction) => {
  const { userId } = req.body;

  if (!userId) {
    throw new ValidationError('userId is required for CSV import', 'userId');
  }

  if (!validateUUID(userId)) {
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
  const { userId, restaurantName, amountSpent, orderDate } = req.body;

  if (!userId) {
    throw new ValidationError('userId is required', 'userId');
  }

  if (!validateUUID(userId)) {
    throw new ValidationError('Invalid userId format', 'userId');
  }

  if (!restaurantName || typeof restaurantName !== 'string') {
    throw new ValidationError('restaurantName is required and must be a string', 'restaurantName');
  }

  if (amountSpent === undefined || amountSpent === null) {
    throw new ValidationError('amountSpent is required', 'amountSpent');
  }

  const amountNum = parseFloat(amountSpent);
  if (isNaN(amountNum) || amountNum < 0) {
    throw new ValidationError('amountSpent must be a non-negative number', 'amountSpent');
  }

  if (orderDate) {
    const date = new Date(orderDate);
    if (isNaN(date.getTime())) {
      throw new ValidationError('orderDate must be a valid date', 'orderDate');
    }
  }

  next();
};
