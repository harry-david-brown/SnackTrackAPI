/** Canonical examples reused by OpenAPI generation and transport contract tests. */
export const CONTRACT_IDS = {
  user: '5f586923-18d5-4bc8-b5eb-ea52ae35284c',
  receipt: '1785120c-8d5e-4d99-9734-1d3b8f72e3a1',
  request: '11111111-1111-4111-8111-111111111111',
} as const;

export const AUTH_SESSION_FIXTURE = {
  userId: CONTRACT_IDS.user,
  email: 'person@example.com',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: CONTRACT_IDS.user,
    email: 'person@example.com',
    emailVerified: true,
    createdAt: '2026-08-31T00:00:00.000Z',
  },
} as const;

export const ERROR_ENVELOPE_FIXTURE = {
  error: {
    version: '1',
    code: 'VALIDATION_ERROR',
    message: 'Validation Error for email: Invalid email format',
    details: { field: 'email' },
    statusCode: 400,
    timestamp: '2026-08-31T00:00:00.000Z',
    path: '/auth/register',
    method: 'POST',
    requestId: CONTRACT_IDS.request,
  },
} as const;

export const RECEIPT_PAGE_FIXTURE = {
  items: [
    {
      id: CONTRACT_IDS.receipt,
      userId: CONTRACT_IDS.user,
      restaurantName: 'Example Kitchen',
      amountSpent: 25.99,
      orderDate: '2026-08-30T18:30:00.000Z',
      items: [{ name: 'Dinner', quantity: 1, price: 25.99 }],
      receiptType: 'doordash',
      dataSource: 'email',
    },
  ],
  pageInfo: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasMore: false,
    nextPage: null,
  },
} as const;

export const CSV_IMPORT_FIXTURE = {
  message: 'CSV imported successfully',
  importedCount: 1,
  totalAmount: 25.99,
  fileType: 'csv',
  provider: 'doordash',
} as const;
