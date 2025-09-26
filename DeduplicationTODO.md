# 🛡️ Deduplication System - TODO Implementation Guide

## 🎯 **Overview**
This system is designed to be **abstract and future-ready** - it provides the infrastructure needed when we add financial aggregators and email parsing, without requiring immediate implementation.

## ⚠️ **IMPORTANT: Current Status**
**This scaffolding is NOT connected to the main application yet.** The existing CSV pipeline continues to work exactly as before. This deduplication system exists as separate, ready-to-implement components.

## 🏗️ **Architecture Components**

### **1. Data Source Priority System** (`src/config/DataSourcePriority.ts`)
- **Priority Levels**: CSV (1) > Financial (2) > Email (3)
- **Configuration**: Each source has reliability and completeness flags
- **Helper Functions**: Priority comparison and highest priority detection

### **2. Abstract Deduplication Service** (`src/services/DeduplicationService.ts`)
- **Interface**: Abstract methods for finding and resolving duplicates
- **Current Implementation**: `CsvDeduplicationService` (placeholder for CSV-only system)
- **Future Ready**: Will be extended when we add financial aggregators

### **3. Receipt Matching Logic** (`src/services/ReceiptMatcher.ts`)
- **Fuzzy Matching**: Restaurant names, dates, amounts, item counts, item names
- **Confidence Scoring**: Weighted algorithm with configurable thresholds
- **Smart Normalization**: Handles variations in restaurant names and formatting

### **4. Data Source Manager** (`src/services/DataSourceManager.ts`)
- **Orchestration**: Main controller for data source priority handling
- **Import Management**: Handles receipt imports with automatic deduplication
- **Archive Logic**: Automatically archives lower priority data when higher priority is available

## 🔄 **Data Flow Logic**

### **Priority Rules:**
1. **CSV trumps everything** - If CSV exists, archive all other sources
2. **Financial > Email** - When CSV isn't available, prefer financial over email
3. **Silent operation** - Users don't see deduplication process
4. **Data integrity** - Always maintain clean, non-duplicate data

### **All Priority Scenarios Handled:**
- **Email → Credit Card**: Credit card data takes priority, emails archived
- **Credit Card → Email**: Email data supplements credit card (if no CSV)
- **Any Source → CSV**: CSV always wins, everything else archived
- **Email → Credit Card → CSV**: CSV wins, both email and credit card archived

### **Import Process:**
1. **Check existing data** - Get current receipts for user
2. **Priority assessment** - Determine if new source has higher priority
3. **Archive if needed** - Archive lower priority receipts
4. **Find duplicates** - Match new receipts against existing ones
5. **Import unique** - Only import non-duplicate receipts
6. **Mark duplicates** - Track duplicate relationships in database

## 🎯 **Key Features**

### **Smart Matching:**
- **Restaurant Names**: Fuzzy matching with normalization
- **Order Dates**: Time tolerance (±1 hour for same order)
- **Amounts**: Percentage-based tolerance (5% or $0.50)
- **Items**: Name matching and count comparison

### **Priority Handling:**
- **Automatic archiving** when higher priority data arrives
- **Duplicate detection** across different sources
- **Source statistics** tracking for analytics

### **Future Extensibility:**
- **Abstract interfaces** ready for new data sources
- **Configurable matching** criteria
- **Database schema** supports all planned features

## 🚀 **Implementation Steps**

### **Step 1: Add Database Fields**
When ready to implement, add these fields to the `receipts` table:

```sql
-- Add deduplication fields
ALTER TABLE receipts ADD COLUMN data_source VARCHAR(50) DEFAULT 'csv';
ALTER TABLE receipts ADD COLUMN source_priority INTEGER DEFAULT 1;
ALTER TABLE receipts ADD COLUMN is_duplicate BOOLEAN DEFAULT FALSE;
ALTER TABLE receipts ADD COLUMN duplicate_of UUID REFERENCES receipts(id);
ALTER TABLE receipts ADD COLUMN archived_at TIMESTAMP;

-- Add indexes for performance
CREATE INDEX idx_receipts_data_source ON receipts(data_source);
CREATE INDEX idx_receipts_source_priority ON receipts(source_priority);
CREATE INDEX idx_receipts_is_duplicate ON receipts(is_duplicate);
CREATE INDEX idx_receipts_duplicate_of ON receipts(duplicate_of);
CREATE INDEX idx_receipts_archived_at ON receipts(archived_at);
```

### **Step 2: Update Receipt Model**
Add deduplication fields to `src/models/Receipt.ts`:

```typescript
export class Receipt {
  constructor(
    // ... existing fields ...
    public dataSource?: string,
    public sourcePriority?: number,
    public isDuplicate?: boolean,
    public duplicateOf?: string,
    public archivedAt?: Date
  ) {}
}
```

### **Step 3: Connect to Import Services**
Update CSV, email, and financial import services to use `DataSourceManager`:

```typescript
// In CsvImportService
const dataSourceManager = new DataSourceManager(postgresService);
await dataSourceManager.importReceipts(userId, 'csv', receipts);

// In email service (future)
await dataSourceManager.importReceipts(userId, 'email', receipts);

// In financial service (future)
await dataSourceManager.importReceipts(userId, 'financial', receipts);
```

### **Step 4: Update Database Queries**
Modify all receipt queries to exclude archived receipts:

```sql
-- Add this to all receipt queries
WHERE archived_at IS NULL
```

### **Step 5: Test Deduplication**
Create test scenarios with multiple data sources to verify duplicate detection works correctly.

## 📊 **Database Schema (Future)**

```sql
-- New fields to add when implementing:
data_source VARCHAR(50)      -- 'csv', 'financial', 'email'
source_priority INTEGER       -- 1, 2, 3 (lower = higher priority)
is_duplicate BOOLEAN         -- TRUE if this is a duplicate
duplicate_of UUID            -- Reference to the original receipt
archived_at TIMESTAMP        -- When this receipt was archived
```

## 🎯 **Current Status**

### **✅ Ready:**
- Complete scaffolding architecture
- Abstract service interfaces
- Fuzzy matching algorithms
- Priority management system
- TypeScript interfaces and types

### **🔄 Not Connected:**
- Database fields (removed to preserve existing functionality)
- Import service integration
- Receipt model updates
- Query modifications

### **📋 Next Steps:**
When you're ready to implement financial aggregators:

1. **Add database fields** using the SQL above
2. **Update Receipt model** with deduplication fields
3. **Connect DataSourceManager** to import services
4. **Update queries** to exclude archived receipts
5. **Test deduplication** with multiple data sources

The scaffolding is **complete and ready** - you can now focus on implementing the actual data sources without worrying about the deduplication infrastructure!
