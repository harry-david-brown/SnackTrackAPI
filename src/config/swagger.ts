import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import { config } from './AppConfig';

// Swagger/OpenAPI configuration
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Snack Track API',
      version: '1.0.0',
      description: `
# 🥡 Snack Track API

A comprehensive API for tracking food delivery spending and receipts.

## 🚀 Features
- **User Management**: Create and manage users
- **Receipt Import**: Import receipts from CSV files
- **Email Integration**: Parse receipts from email receipts
- **Spending Analytics**: Track spending patterns and insights
- **Data Validation**: Comprehensive data integrity checks

      `,
      contact: {
        name: 'Snack Track Support',
        email: 'support@snacktrack.app'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      {
        url: config.isProduction() 
          ? 'https://api.snacktrack.app' 
          : 'http://localhost:3000',
        description: config.isProduction() ? 'Production server' : 'Development server'
      }
    ],
    components: {
      schemas: {
        User: {
          type: 'object',
          required: ['id', 'email', 'createdAt'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Unique user identifier',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            email: {
              type: 'string',
              format: 'email',
              description: 'User email address',
              example: 'user@example.com'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'User creation timestamp',
              example: '2023-09-27T04:30:00.000Z'
            }
          }
        },
        Receipt: {
          type: 'object',
          required: ['id', 'userId', 'restaurantName', 'amountSpent', 'orderDate', 'dataSource'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Unique receipt identifier',
              example: '550e8400-e29b-41d4-a716-446655440001'
            },
            userId: {
              type: 'string',
              format: 'uuid',
              description: 'User who made the order',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            restaurantName: {
              type: 'string',
              description: 'Name of the restaurant',
              example: 'Papa Johns Pizza'
            },
            amountSpent: {
              type: 'number',
              format: 'float',
              description: 'Total amount spent on the order',
              example: 25.99
            },
            orderDate: {
              type: 'string',
              format: 'date-time',
              description: 'Date and time of the order',
              example: '2023-09-27T04:30:00.000Z'
            },
            items: {
              type: 'array',
              description: 'List of items ordered',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    example: 'Create Your Own Pizza'
                  },
                  price: {
                    type: 'number',
                    example: 18.99
                  },
                  quantity: {
                    type: 'integer',
                    example: 1
                  }
                }
              }
            },
            dataSource: {
              type: 'string',
              enum: ['csv', 'email', 'api'],
              description: 'Source of the receipt data',
              example: 'csv'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Receipt creation timestamp',
              example: '2023-09-27T04:30:00.000Z'
            }
          }
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['message', 'statusCode', 'timestamp'],
              properties: {
                message: {
                  type: 'string',
                  description: 'Error message',
                  example: 'Validation Error for email: Invalid email format'
                },
                statusCode: {
                  type: 'integer',
                  description: 'HTTP status code',
                  example: 400
                },
                timestamp: {
                  type: 'string',
                  format: 'date-time',
                  description: 'Error timestamp',
                  example: '2023-09-27T04:30:00.000Z'
                },
                path: {
                  type: 'string',
                  description: 'Request path',
                  example: '/users/create'
                },
                method: {
                  type: 'string',
                  description: 'HTTP method',
                  example: 'POST'
                }
              }
            }
          }
        },
        CreateUserRequest: {
          type: 'object',
          required: ['email'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              description: 'User email address',
              example: 'user@example.com'
            }
          }
        },
        CreateUserResponse: {
          type: 'object',
          required: ['id', 'message'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Created user ID',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            message: {
              type: 'string',
              description: 'Success message',
              example: 'User created successfully'
            }
          }
        },
        CSVImportRequest: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: {
              type: 'string',
              format: 'uuid',
              description: 'User ID to associate receipts with',
              example: '550e8400-e29b-41d4-a716-446655440000'
            }
          }
        },
        CSVImportResponse: {
          type: 'object',
          required: ['message', 'importedCount'],
          properties: {
            message: {
              type: 'string',
              description: 'Import result message',
              example: 'CSV imported successfully'
            },
            importedCount: {
              type: 'integer',
              description: 'Number of receipts imported',
              example: 150
            }
          }
        },
        DatabaseStats: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                totalUsers: { type: 'integer', example: 1250 },
                totalReceipts: { type: 'integer', example: 15420 },
                usersWithReceipts: { type: 'integer', example: 1180 },
                totalAmountAllUsers: { type: 'number', format: 'float', example: 125000.75 },
                averageReceiptAmount: { type: 'number', format: 'float', example: 8.12 }
              }
            },
            tableSizes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  table: { type: 'string', example: 'receipts' },
                  size: { type: 'string', example: '728 kB' }
                }
              }
            },
            recentActivity: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  table: { type: 'string', example: 'users' },
                  recentCount: { type: 'integer', example: 7 }
                }
              }
            },
            health: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'HEALTHY' },
                timestamp: { type: 'string', format: 'date-time', example: '2025-09-27T05:40:09.876Z' }
              }
            }
          }
        },
        UserSummary: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            summary: {
              type: 'object',
              properties: {
                totalReceipts: { type: 'integer', example: 45 },
                uniqueRestaurants: { type: 'integer', example: 12 },
                totalSpent: { type: 'number', format: 'float', example: 1250.75 },
                averageOrderValue: { type: 'number', format: 'float', example: 27.79 }
              }
            },
            topRestaurants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'Papa Johns Pizza' },
                  orderCount: { type: 'integer', example: 8 },
                  totalSpent: { type: 'number', format: 'float', example: 185.50 }
                }
              }
            }
          }
        },
        CSVPreviewResponse: {
          type: 'object',
          properties: {
            rowCount: { type: 'integer', example: 150 },
            sampleRows: {
              type: 'array',
              items: { type: 'object' }
            },
            columns: {
              type: 'array',
              items: { type: 'string' },
              example: ['Order Date', 'Restaurant', 'Amount', 'Items']
            }
          }
        },
        EmailAnalysis: {
          type: 'object',
          properties: {
            email: { type: 'string', example: 'user@example.com' },
            totalEmails: { type: 'integer', example: 45 },
            parsedReceipts: { type: 'integer', example: 38 },
            totalSpent: { type: 'number', format: 'float', example: 1250.75 }
          }
        }
      },
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for authentication (optional for most endpoints)'
        }
      },
      responses: {
        RateLimitExceeded: {
          description: 'Rate limit exceeded',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                error: {
                  message: 'Too many requests, please try again later',
                  statusCode: 429,
                  timestamp: '2023-09-27T04:30:00.000Z',
                  path: '/users/create',
                  method: 'POST',
                  retryAfter: 300
                }
              }
            }
          }
        },
        ValidationError: {
          description: 'Validation error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                error: {
                  message: 'Validation Error for email: Invalid email format',
                  statusCode: 400,
                  timestamp: '2023-09-27T04:30:00.000Z',
                  path: '/users/create',
                  method: 'POST'
                }
              }
            }
          }
        },
        NotFound: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              },
              example: {
                error: {
                  message: 'User with ID 550e8400-e29b-41d4-a716-446655440000 not found',
                  statusCode: 404,
                  timestamp: '2023-09-27T04:30:00.000Z',
                  path: '/users/550e8400-e29b-41d4-a716-446655440000/totalSpent',
                  method: 'GET'
                }
              }
            }
          }
        }
      }
    },
    tags: [
      {
        name: 'Users',
        description: 'User management operations'
      },
      {
        name: 'Receipts',
        description: 'Receipt management operations'
      },
      {
        name: 'CSV Import',
        description: 'CSV file import operations'
      },
      {
        name: 'Database',
        description: 'Database management operations'
      }
    ]
  },
  apis: [
    './src/routes/*.ts', // Path to the API files
    './src/index.ts'
  ]
};

const specs = swaggerJsdoc(options);

export const setupSwagger = (app: Express) => {
  // Swagger UI setup
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(specs, {
    customCss: `
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info .title { color: #ff6b35; }
      .swagger-ui .scheme-container { background: #f8f9fa; padding: 15px; border-radius: 5px; }
    `,
    customSiteTitle: 'Snack Track API Documentation',
    customfavIcon: '/favicon.ico',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true
    }
  }));

  // JSON endpoint for the OpenAPI spec
  app.get('/docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(specs);
  });
};
