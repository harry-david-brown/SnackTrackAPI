# Snack Track API Flow

## Request Flow
```
1. POST /users/create
   ↓
2. DatabaseService.createUser()
   ↓
3. Returns user ID

4. POST /users/:id/update-receipts
   ↓
5. DatabaseService.updateUserReceiptsForUser()
   ↓
6. LookupService.getUserReceipts()
   ↓
7. GmailClient.getEmails() [or mock data]
   ↓
8. Email.toReceipt() [parsing logic]
   ↓
9. Store receipts in DatabaseService
   ↓
10. Return total spending

11. GET /users/:id/totalSpent
    ↓
12. DatabaseService.getUserTotalSpent()
    ↓
13. Sum all receipts for user
```

## Key Components

### 1. Entry Point: `src/index.ts`
- Express server setup
- Routes mounting
- Error handling

### 2. Routes: `src/routes/users.ts`
- `/users/create` - Create new user
- `/users/:id/update-receipts` - Fetch emails and parse receipts
- `/users/:id/totalSpent` - Get spending total
- `/users/:id/debug/emails` - Debug endpoint to see raw data

### 3. Services: `src/services/`
- **DatabaseService**: In-memory storage, user management
- **LookupService**: Orchestrates email fetching
- **GmailClient**: Gmail API integration (with mock fallback)

### 4. Models: `src/models/`
- **User**: User data structure
- **Email**: Email with parsing logic
- **Receipt**: Parsed purchase data
- **CreateUserDTO**: User creation input

## Data Flow Example

```
Input: {"email": "test@example.com"}
↓
User Created: {id: "uuid", email: "test@example.com", type: "Gmail"}
↓
Fetch Emails: [Email objects with body text]
↓
Parse Emails: [Receipt objects with items and amounts]
↓
Store Receipts: In-memory array
↓
Calculate Total: Sum of all receipt amounts
```
