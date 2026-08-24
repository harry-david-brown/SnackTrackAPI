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
      version: '2.0.0',
      description: `
# 🥡 Snack Track API

A comprehensive API for tracking food delivery spending and receipts with viral-worthy analytics.

## 🚀 Features
- **JWT Authentication**: Secure user authentication with bcrypt password hashing
- **Password Reset**: OTP-based password recovery flow with email verification
- **Email Verification**: Secure email verification with 6-digit OTP codes
- **Receipt Import**: Import from CSV or ZIP files (Uber Eats data export auto-extraction)
- **Wrapped Analytics**: Spotify-style shareable insights (13 viral categories)
- **Performance**: Redis caching (36.8% faster), database optimizations
- **Spending Analytics**: Comprehensive summaries, top restaurants, monthly breakdowns
- **Security**: Production-ready rate limiting, Sentry error tracking, ownership validation

## 🎊 Wrapped Analytics (NEW!)
Get Spotify Wrapped-style analytics with \`?includeWrapped=true\`:
- **Shame**: 3am orders, lazy days, ordering streaks, chain dependency
- **Flex**: Most expensive order, coffee addiction, night owl badge
- **Comparative**: Hypothetical fixed-return opportunity-cost comparison
- **Patterns**: Peak hunger hours, weekend vs weekday patterns

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
            emailVerified: {
              type: 'boolean',
              description: 'Email verification status',
              example: false
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
        DashboardInsightBase: {
          type: 'object',
          required: ['id', 'presentation', 'category', 'icon', 'eyebrow', 'title'],
          properties: {
            id: { type: 'string' },
            presentation: { type: 'string', enum: ['hero', 'comparison', 'ranking', 'order', 'timeline', 'yearly-champions', 'locked'] },
            category: { type: 'string', enum: ['favorites', 'habits', 'extremes', 'progress'] },
            icon: { type: 'string' },
            eyebrow: { type: 'string' },
            title: { type: 'string' },
            detail: { type: 'string' },
            period: { type: 'object', required: ['startDate'], properties: { startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' } } },
            methodology: {
              type: 'object',
              properties: {
                estimated: { type: 'boolean' }, sampleSize: { type: 'integer' },
                assumption: { type: 'string' }, disclaimer: { type: 'string' }
              }
            }
          }
        },
        DashboardHeroInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'value', 'valueFormat'], properties: { presentation: { type: 'string', enum: ['hero'] }, value: { type: 'number' }, valueFormat: { type: 'string', enum: ['currency', 'number', 'percent', 'minutes', 'hours', 'days'] }, headline: { type: 'string' } } }
          ]
        },
        DashboardComparisonInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'comparison'], properties: { presentation: { type: 'string', enum: ['comparison'] }, comparison: { type: 'object', required: ['current', 'previous', 'delta', 'percentDelta', 'direction', 'valueFormat', 'currentLabel', 'previousLabel'], properties: { variant: { type: 'string', enum: ['investment'] }, current: { type: 'number' }, previous: { type: 'number' }, delta: { type: 'number' }, percentDelta: { type: 'number', nullable: true }, direction: { type: 'string', enum: ['up', 'down', 'flat'] }, valueFormat: { type: 'string', enum: ['currency', 'number'] }, currentLabel: { type: 'string' }, previousLabel: { type: 'string' }, driver: { type: 'string', enum: ['frequency', 'basket', 'outlier', 'mixed'] }, subject: { type: 'object', required: ['kind', 'name', 'occurrences'], properties: { kind: { type: 'string', enum: ['meal', 'item'] }, name: { type: 'string' }, restaurant: { type: 'string' }, occurrences: { type: 'integer', minimum: 2 } } } } } } }
          ]
        },
        DashboardRankingInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'rows'], properties: { presentation: { type: 'string', enum: ['ranking'] }, rows: { type: 'array', items: { type: 'object', required: ['label', 'count'], properties: { label: { type: 'string' }, count: { type: 'integer' }, amount: { type: 'number' }, context: { type: 'string' } } } } } }
          ]
        },
        DashboardOrderInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'order'], properties: { presentation: { type: 'string', enum: ['order'] }, order: { type: 'object', required: ['restaurant', 'amount', 'items'], properties: { restaurant: { type: 'string' }, restaurants: { type: 'array', items: { type: 'string' } }, amount: { type: 'number' }, orderedAt: { type: 'string', format: 'date-time' }, items: { type: 'array', items: { type: 'string' } } } } } }
          ]
        },
        DashboardTimelineInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'events'], properties: { presentation: { type: 'string', enum: ['timeline'] }, events: { type: 'array', items: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'number' }] }, valueFormat: { type: 'string' }, detail: { type: 'string' } } } } } }
          ]
        },
        DashboardYearlyChampionsInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'years'], properties: { presentation: { type: 'string', enum: ['yearly-champions'] }, years: { type: 'array', items: { type: 'object', required: ['year', 'winners', 'orderCount', 'currentYear'], properties: { year: { type: 'integer' }, winners: { type: 'array', items: { type: 'string' } }, orderCount: { type: 'integer' }, currentYear: { type: 'boolean' } } } } } }
          ]
        },
        DashboardLockedInsight: {
          allOf: [
            { $ref: '#/components/schemas/DashboardInsightBase' },
            { type: 'object', required: ['presentation', 'action'], properties: { presentation: { type: 'string', enum: ['locked'] }, action: { type: 'string', enum: ['open_export'] } } }
          ]
        },
        DashboardInsightEdition: {
          type: 'object',
          required: ['localDate', 'timezone', 'generatedAt', 'nextRefreshAt', 'metricVersion', 'availableCandidateCount', 'insights'],
          properties: {
            localDate: { type: 'string', format: 'date' }, timezone: { type: 'string' },
            generatedAt: { type: 'string', format: 'date-time' }, nextRefreshAt: { type: 'string', format: 'date-time' },
            metricVersion: { type: 'string' }, availableCandidateCount: { type: 'integer' },
            insights: {
              type: 'array', maxItems: 7,
              items: {
                discriminator: { propertyName: 'presentation' },
                oneOf: [
                  { $ref: '#/components/schemas/DashboardHeroInsight' },
                  { $ref: '#/components/schemas/DashboardComparisonInsight' },
                  { $ref: '#/components/schemas/DashboardRankingInsight' },
                  { $ref: '#/components/schemas/DashboardOrderInsight' },
                  { $ref: '#/components/schemas/DashboardTimelineInsight' },
                  { $ref: '#/components/schemas/DashboardYearlyChampionsInsight' },
                  { $ref: '#/components/schemas/DashboardLockedInsight' }
                ]
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
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT access token'
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for authentication. Required for admin endpoints (database, monitoring). Can also be passed as query parameter: ?apiKey=your-key'
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
        name: 'System',
        description: 'System health and status endpoints'
      },
      {
        name: 'Authentication',
        description: 'User authentication and authorization operations'
      },
      {
        name: 'Validation & Analytics',
        description: 'User analytics and Spotify Wrapped-style insights. Use ?includeWrapped=true for viral shareable analytics (13 categories).'
      },
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
        description: 'CSV and ZIP file import operations. Upload Uber Eats or DoorDash data as CSV or ZIP archive. Platform is auto-detected.'
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
