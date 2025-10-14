# 🎊 Wrapped Analytics Specification

**Created:** October 14, 2025  
**Purpose:** Spotify Wrapped-style analytics for viral sharing  
**Target:** Shame + Flex balance for maximum social media engagement

---

## 🎯 Product Vision

**Goal:** Create shareable, meme-worthy analytics that make users want to share their food delivery shame/flex with friends.

**Inspiration:** Spotify Wrapped, Strava Year in Review, Duolingo Year in Review  
**Tone:** Self-deprecating humor + occasional flex moments  
**Shareability:** Each slide should be screenshot-worthy

---

## 📊 Analytics Categories

### 🔴 Shame-Based Analytics (Meme Gold)

#### 1. "3am Regret Orders"
**Calculation:** Filter orders where hour is 0-6am  
**Data Required:** `Request_Time_Local` hour  
**Output:**
```json
{
  "lateNightOrders": {
    "count": 23,
    "totalSpent": 847.32,
    "latestOrder": "4:37 AM",
    "worstOffender": {
      "restaurant": "McDonald's",
      "time": "3:42 AM",
      "amount": 47.89,
      "items": ["Big Mac", "Large Fries", "Oreo McFlurry"]
    }
  }
}
```

#### 2. "Lazy Sundays"
**Calculation:** Group by date, find max orders in single day  
**Data Required:** `Request_Time_Local` date  
**Output:**
```json
{
  "laziestDay": {
    "date": "2025-07-14",
    "dayOfWeek": "Sunday",
    "orderCount": 7,
    "totalSpent": 143.67,
    "restaurants": ["McDonald's", "Starbucks", "Chipotle", "McDonald's", "Starbucks", "Taco Bell", "McDonald's"],
    "message": "7 orders in one day? Go outside."
  }
}
```

#### 3. "Serial Orderer"
**Calculation:** Find longest consecutive day streak  
**Data Required:** `Request_Time_Local` dates  
**Output:**
```json
{
  "longestStreak": {
    "days": 14,
    "startDate": "2025-06-01",
    "endDate": "2025-06-14",
    "totalSpent": 623.45,
    "message": "14 days straight without cooking"
  }
}
```

#### 4. "Just One Item Orders"
**Calculation:** Count orders with 1-2 items, under $20  
**Data Required:** Items per order, `Order_Price`  
**Output:**
```json
{
  "singleItemOrders": {
    "count": 458,
    "totalSpent": 3247.89,
    "averageAmount": 7.09,
    "message": "458 times you couldn't just go get it",
    "mostCommon": "Coffee (87 times)"
  }
}
```

#### 5. "McDonald's Dependency" (Chain Tracking)
**Calculation:** Filter by major chain names, rank by frequency  
**Data Required:** `Restaurant_Name` pattern matching  
**Output:**
```json
{
  "chainDependency": {
    "worstOffender": "McDonald's",
    "orderCount": 67,
    "totalSpent": 1247.89,
    "percentage": 33,
    "message": "1/3 of your orders were McDonald's",
    "allChains": [
      { "name": "McDonald's", "count": 67, "spent": 1247.89 },
      { "name": "Starbucks", "count": 45, "spent": 678.23 },
      { "name": "Chipotle", "count": 23, "spent": 456.78 }
    ]
  }
}
```

---

### 🟢 Flex-Worthy Analytics (Shareable Highs)

#### 6. "Bougie Budget"
**Calculation:** Find most expensive single order  
**Data Required:** Max `Order_Price`, items from that order  
**Output:**
```json
{
  "mostExpensiveOrder": {
    "amount": 147.89,
    "restaurant": "The Keg Steakhouse",
    "date": "2025-05-12",
    "items": [
      { "name": "Filet Mignon", "price": 89.99 },
      { "name": "Caesar Salad", "price": 12.99 },
      { "name": "Wine", "price": 35.00 }
    ],
    "message": "You once spent $147.89 on a single order"
  }
}
```

#### 7. "Coffee Addict Tax"
**Calculation:** Pattern match coffee-related items  
**Data Required:** `Item_Name` contains: coffee, latte, espresso, cappuccino, americano, mocha, frappe, cold brew  
**Output:**
```json
{
  "coffeeAddiction": {
    "orderCount": 87,
    "totalSpent": 623.45,
    "averagePrice": 7.17,
    "mostOrdered": "Iced Caramel Macchiato (23 times)",
    "message": "You spent $623 on coffee",
    "disclaimer": "This doesn't even count the Starbucks® ones"
  }
}
```

#### 8. "Night Owl Badge"
**Calculation:** Count orders after 10pm  
**Data Required:** `Request_Time_Local` hour >= 22  
**Output:**
```json
{
  "nightOwl": {
    "percentage": 34,
    "count": 68,
    "totalSpent": 1234.56,
    "latestOrder": "2:47 AM",
    "message": "34% of your orders were after 10pm"
  }
}
```

---

### 💰 Comparative Analytics (Shock Value)

#### 9. "You Could Have Bought..."
**Calculation:** Convert total spending to relatable items  
**Data Required:** Total spent  
**Output:**
```json
{
  "couldHaveBought": {
    "totalSpent": 5136.23,
    "comparisons": [
      { "item": "Used Honda Civic", "quantity": 0.5, "message": "Half a used car" },
      { "item": "Round-trip flights to Europe", "quantity": 3, "message": "3 trips to Europe" },
      { "item": "Months of groceries", "quantity": 17, "message": "17 months of actual food" },
      { "item": "iPhone 15 Pro Max", "quantity": 4, "message": "4 brand new iPhones" }
    ]
  }
}
```

#### 10. "What You Could Have Invested"
**Calculation:** S&P 500 returns from first order date to now  
**Data Required:** Total spent, first order date  
**Output:**
```json
{
  "missedInvestment": {
    "amountSpent": 5136.23,
    "firstOrderDate": "2024-01-15",
    "daysElapsed": 638,
    "sp500Return": 18.7,
    "wouldBeWorth": 6096.76,
    "missedGains": 960.53,
    "message": "If you'd invested this in the S&P 500, you'd have an extra $960"
  }
}
```

#### 11. "Cost Per Meal"
**Calculation:** Average order value vs grocery cost  
**Data Required:** Total spent, receipt count  
**Output:**
```json
{
  "costPerMeal": {
    "deliveryAverage": 25.43,
    "groceryEstimate": 7.50,
    "difference": 17.93,
    "annualWaste": 13234.56,
    "message": "You paid $17.93 extra per meal for convenience"
  }
}
```

---

### 📈 Pattern-Based Analytics

#### 12. "Peak Hunger Hour"
**Calculation:** Group by hour, find most common  
**Data Required:** `Request_Time_Local` hour  
**Output:**
```json
{
  "peakHungerHour": {
    "hour": 19,
    "hourDisplay": "7:00 PM",
    "orderCount": 45,
    "percentageOfTotal": 22,
    "message": "You're hungriest at 7 PM"
  }
}
```

#### 13. "Weekend Warrior"
**Calculation:** Weekend (Sat/Sun) vs weekday ratio  
**Data Required:** `Request_Time_Local` day of week  
**Output:**
```json
{
  "weekendWarrior": {
    "weekendOrders": 78,
    "weekdayOrders": 124,
    "weekendSpending": 2134.56,
    "weekdaySpending": 3001.67,
    "ratio": 0.63,
    "message": "You spend more on weekdays (cooking challenged all week)"
  }
}
```

#### 14. "Waiting Game"
**Calculation:** Final_Delivery_Time - Request_Time  
**Data Required:** Both time fields  
**Output:**
```json
{
  "deliveryWaits": {
    "averageMinutes": 28,
    "longestWait": {
      "minutes": 103,
      "restaurant": "Five Guys",
      "amount": 12.34,
      "message": "You once waited 1hr 43min for a $12 order"
    },
    "fastestDelivery": {
      "minutes": 8,
      "restaurant": "McDonald's"
    }
  }
}
```

---

## 🏗️ Backend Implementation Plan

### New Endpoint Structure

**Expand existing endpoint:**
```
GET /validation/user/:userId/summary
```

**Current Response:** Basic analytics (total, avg, top restaurants, monthly)  
**New Response:** Add `wrappedAnalytics` object with all categories

### Response Structure

```typescript
interface UserSummary {
  // Existing fields (keep for backward compatibility)
  userId: string;
  totalSpent: number;
  totalReceipts: number;
  averageOrderValue: number;
  topRestaurants: Array<{...}>;
  monthlyBreakdown: Array<{...}>;
  
  // NEW: Wrapped Analytics
  wrappedAnalytics: {
    shame: {
      lateNightOrders: {...},
      laziestDay: {...},
      longestStreak: {...},
      singleItemOrders: {...},
      chainDependency: {...}
    },
    flex: {
      mostExpensiveOrder: {...},
      coffeeAddiction: {...},
      nightOwl: {...}
    },
    comparative: {
      couldHaveBought: {...},
      missedInvestment: {...},
      costPerMeal: {...}
    },
    patterns: {
      peakHungerHour: {...},
      weekendWarrior: {...},
      deliveryWaits: {...}
    }
  }
}
```

---

## 🔧 Implementation Steps

### Step 1: Create Analytics Calculator Service (2-3 days)

**Files to Create:**
- `src/services/analytics/WrappedAnalyticsService.ts` - Main calculator
- `src/services/analytics/TimeAnalyzer.ts` - Time-based patterns
- `src/services/analytics/PatternMatcher.ts` - Coffee, chains, cuisine detection
- `src/services/analytics/ComparativeCalculator.ts` - Investment, equivalents

### Step 2: Update Validation Route (1 day)

**Files to Modify:**
- `src/routes/validation.ts` - Add wrapped analytics calculation
- Make it optional (query param: `?includeWrapped=true`)
- Backward compatible (existing apps don't break)

### Step 3: Testing & Refinement (1-2 days)

**Test with real data:**
- Verify all calculations accurate
- Check for edge cases (no data, single order, etc)
- Optimize performance (caching recommended)
- Tune the "roast" messages for humor

---

## 📝 Technical Considerations

### Performance
- **Concern:** These calculations could be expensive (15+ separate analyses)
- **Solution:** 
  - Cache wrapped analytics (15min TTL, same as current summary)
  - Calculate on demand (optional query param)
  - Consider pre-calculating on CSV import

### Data Limitations
- **Delivery distance:** Not available in Uber data (skip this one)
- **Tips/fees:** Might be calculable as `Order_Price - sum(Item_Price)` (verify first)
- **Cuisine type:** Need pattern matching or external API (keep simple)

### Backward Compatibility
- **Critical:** Don't break existing frontend
- **Solution:** Add `wrappedAnalytics` as optional field
- **Default:** Only calculate if `?includeWrapped=true` query param present

---

## 🚀 Rollout Strategy

### Phase 1: Backend Implementation (1 week)
1. Build analytics service
2. Test with real data
3. Add to summary endpoint (optional)
4. Document new response format

### Phase 2: Frontend Integration (1 week)
1. Update frontend to request wrapped analytics
2. Design beautiful slide layouts
3. Implement swipe/scroll journey
4. Test shareability

### Phase 3: Polish & Launch (3-5 days)
1. Tune roast messages
2. A/B test different messages
3. Add more categories based on user feedback
4. Launch Wrapped feature!

---

## 📋 Next Steps

**Option A: Implement Now** (Before Phase 2)
- Pros: Complete product feature, test with frontend
- Cons: Delays database optimization
- Timeline: +1 week before Phase 2

**Option B: After Phase 2** (Recommended)
- Pros: Optimize database first, then add analytics
- Cons: Frontend has to wait
- Timeline: Phase 2 (2 weeks) → Wrapped (1 week)

**Option C: Parallel Development**
- You: Phase 2 (database/Redis)
- Create: Wrapped analytics spec + test data
- Frontend: Implements UI with mock data
- Then: Integrate real backend analytics

---

## 💡 My Recommendation

**Do Wrapped Analytics AFTER Phase 2**

**Why:**
1. **Database indexes needed** - 15+ analytics queries will be slow without optimization
2. **Redis caching essential** - Wrapped analytics are expensive, cache is critical
3. **Better product** - Fast analytics > slow analytics, even if viral
4. **Parallel work** - Frontend can design/mock while you optimize backend

**Timeline:**
- Week 3-4: Phase 2 (database + Redis) 
- Week 5: Wrapped analytics implementation
- Week 6: Frontend integration + polish
- Week 7-8: Launch prep

**This way, when users share their Wrapped, the analytics load instantly!**

What do you think? Should we proceed with Phase 2 first, or jump straight into Wrapped analytics?



