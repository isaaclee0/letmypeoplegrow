# AI Credits System - Future Feature Plan

**Status**: Planning / Not Yet Implemented
**Target**: Phase 4 (Post-refactoring)
**Last Updated**: 2026-02-10

## Overview

This document outlines the plan to transition Let My People Grow's AI Insights feature from a BYOM (Bring Your Own Model) system to a managed AI credits system. This will simplify the user experience, create a revenue stream, and give us better control over costs and usage.

## Current State (v1.5.3)

- **Model**: BYOM - Users provide their own OpenAI or Anthropic API keys
- **Configuration**: Per-church AI config stored in `user_preferences` table
- **Models Used**:
  - OpenAI: `gpt-4o-mini` (default)
  - Anthropic: `claude-haiku-4-5-20251001` (default)
- **Cost**: Varies by user's API usage, paid directly to OpenAI/Anthropic
- **Limitations**:
  - Friction for users (need to create API accounts)
  - No revenue for us
  - Hard to predict/control costs
  - Can't easily offer premium models

## Why Move to Credits?

### User Benefits
1. **Simpler Setup**: No API keys to manage
2. **Predictable Pricing**: Fixed monthly cost, not per-token billing
3. **Unified Billing**: One subscription covers AI + app features
4. **Better Models**: Access to premium models without separate accounts
5. **Usage Visibility**: Clear credit balance and usage tracking

### Business Benefits
1. **Revenue Stream**: Margin on API costs + value-added features
2. **Cost Control**: We manage API costs centrally, can optimize
3. **Upsell Opportunity**: Tiered subscriptions with different credit allowances
4. **Usage Analytics**: Better understanding of feature adoption
5. **Competitive Moat**: Integrated AI becomes a differentiator

### Technical Benefits
1. **Centralized API Management**: One set of API keys to maintain
2. **Rate Limiting**: Prevent abuse at the application level
3. **Model Flexibility**: Easily add/remove models without user config changes
4. **Quality Control**: We control which models are available
5. **Batch Optimization**: Potential for request batching and caching

## Model Tiers & Slash Commands

### Tier Structure

Users can select model tier per request using slash commands:

```
/low    - Fast, cheap models (default)
/med    - Balanced performance and cost
/high   - Premium models for complex analysis
```

**Examples:**
```
/low Who missed last Sunday?
/med Analyze attendance trends for the past 6 months
/high Predict next month's attendance patterns considering weather and holidays
```

### Model Selection by Tier

| Tier | OpenAI Model | Anthropic Model | Credits | Use Case |
|------|--------------|-----------------|---------|----------|
| **Low** | gpt-4o-mini | claude-haiku-4-5 | 1 | Quick questions, simple lookups |
| **Med** | gpt-4o | claude-sonnet-4 | 5 | Trend analysis, multi-week patterns |
| **High** | o1-preview | claude-opus-4-6 | 20 | Complex predictions, deep insights |

**Default**: `/low` for all requests unless specified

### Cost Structure

Based on approximate API costs (as of 2026-02):

| Tier | Our API Cost | Credit Value | Margin |
|------|--------------|--------------|--------|
| Low | ~$0.001/request | 1 credit = $0.02 | 20x |
| Med | ~$0.01/request | 5 credits = $0.10 | 10x |
| High | ~$0.05/request | 20 credits = $0.40 | 8x |

*Note: Actual API costs vary by request length. These are estimates for typical church attendance queries.*

## Database Schema

### Credits Balance Table

```sql
CREATE TABLE ai_credits (
  church_id VARCHAR(255) PRIMARY KEY,
  credits_balance INT NOT NULL DEFAULT 0,
  credits_lifetime_used INT NOT NULL DEFAULT 0,
  subscription_tier ENUM('free', 'basic', 'pro', 'enterprise') DEFAULT 'free',
  monthly_credit_allowance INT DEFAULT 0,
  last_credit_refresh DATE,
  low_balance_warning_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
  INDEX idx_subscription_tier (subscription_tier),
  INDEX idx_last_refresh (last_credit_refresh)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Transaction Log Table

```sql
CREATE TABLE ai_credit_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  church_id VARCHAR(255) NOT NULL,
  user_id INT NOT NULL,
  credits_change INT NOT NULL COMMENT 'Negative for usage, positive for purchase',
  balance_after INT NOT NULL,
  transaction_type ENUM('usage', 'purchase', 'subscription_renewal', 'admin_adjustment', 'refund', 'rollover') NOT NULL,
  model_tier ENUM('low', 'med', 'high'),
  model_used VARCHAR(100) COMMENT 'Actual model name (e.g., gpt-4o-mini)',
  conversation_id BIGINT,
  message_id BIGINT,
  request_tokens INT COMMENT 'Approximate input tokens',
  response_tokens INT COMMENT 'Approximate output tokens',
  metadata JSON COMMENT 'Additional context: question, provider, error details, etc.',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (church_id) REFERENCES church_settings(church_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES ai_chat_conversations(id) ON DELETE SET NULL,

  INDEX idx_church_date (church_id, created_at),
  INDEX idx_user_date (user_id, created_at),
  INDEX idx_transaction_type (transaction_type),
  INDEX idx_model_tier (model_tier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Subscription Plans Table

```sql
CREATE TABLE ai_subscription_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tier_name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  monthly_credits INT NOT NULL,
  price_cents INT NOT NULL COMMENT 'Price in cents (e.g., 999 = $9.99)',
  rollover_allowed BOOLEAN DEFAULT FALSE,
  max_rollover_credits INT COMMENT 'Maximum credits that can roll over each month',
  overage_allowed BOOLEAN DEFAULT FALSE COMMENT 'Allow negative balance (pay-as-you-go)',
  max_overage_credits INT COMMENT 'Maximum negative balance allowed',
  features JSON COMMENT 'Additional features for this tier',
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_active_sort (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Seed Data for Subscription Plans

```sql
INSERT INTO ai_subscription_plans
  (tier_name, display_name, description, monthly_credits, price_cents, rollover_allowed, max_rollover_credits, sort_order)
VALUES
  ('free', 'Free Trial', 'Try AI Insights with limited credits', 100, 0, FALSE, 0, 1),
  ('basic', 'Basic', 'Perfect for small churches', 500, 900, FALSE, 0, 2),
  ('pro', 'Professional', 'For growing churches with regular AI usage', 2000, 2900, TRUE, 1000, 3),
  ('enterprise', 'Enterprise', 'Unlimited AI insights for large organizations', -1, 0, FALSE, 0, 4);
```

## Migration Path

### Phase 1: Dual Mode (BYOM + Credits Coexist)

**Timeline**: 3-4 months
**Goal**: Introduce credits without disrupting existing users

**Features:**
- Add AI credits tables to database
- Create credits management UI in Settings
- Implement credit purchase/top-up system
- Add credit balance display in AI Insights page
- Support both BYOM and credits mode
- Free tier: 100 credits/month for all churches (try before you buy)

**User Experience:**
```
Settings → AI Configuration:
  ○ Use My Own API Key (current system)
  ● Use AI Credits (recommended)

  Current Balance: 487 credits
  Monthly Allowance: 500 credits (Pro Plan)

  [Upgrade Plan] [Purchase Credits]
```

**Backend Changes:**
- `server/routes/ai.js`: Check credits before API call
- New endpoint: `POST /api/ai/use-credits` (deduct credits, log transaction)
- New endpoint: `GET /api/ai/credits/balance`
- New endpoint: `GET /api/ai/credits/transactions` (usage history)

### Phase 2: Credit Packages & Subscriptions

**Timeline**: 6-9 months
**Goal**: Build out full subscription and payment system

**Features:**
- Stripe/payment integration for credit purchases
- Subscription tiers (Basic, Pro, Enterprise)
- Monthly credit refresh (1st of each month)
- Credit rollover for Pro+ tiers
- Usage analytics dashboard
- Low balance warnings (email notifications at 20%, 10%, 5%)
- Admin tools for credit adjustments

**Credit Packages (One-Time Purchase):**
```
  $10  →  500 credits  (20% bonus vs subscription)
  $30  → 2000 credits  (33% bonus)
  $90  → 7500 credits  (50% bonus)
```

**Subscription Tiers:**
```
FREE TRIAL
  - 100 credits/month
  - /low tier only
  - No rollover
  - No support

BASIC - $9/month
  - 500 credits/month (~500 /low requests)
  - All tiers available
  - No rollover
  - Email support

PRO - $29/month
  - 2000 credits/month (~2000 /low requests)
  - All tiers available
  - 50% rollover (max 1000 credits)
  - Priority email support
  - Usage analytics

ENTERPRISE - Custom pricing
  - Unlimited credits
  - All tiers available
  - Priority model access (first access to new models)
  - Dedicated support
  - Custom integrations
  - SSO/SAML
```

**Billing Flow:**
1. User selects plan or credit package
2. Stripe checkout
3. Webhook confirms payment
4. Credits added to `ai_credits` table
5. Transaction logged in `ai_credit_transactions`
6. Email confirmation sent

### Phase 3: Deprecate BYOM

**Timeline**: 12-15 months
**Goal**: Full transition to credits system

**Process:**
1. **6-Month Notice**: Email all BYOM users about deprecation
2. **Migration Bonus**: Offer 500 bonus credits for switching
3. **Gradual Sunset**:
   - Month 1-3: Show deprecation warnings in UI
   - Month 4-6: Disable new BYOM setups, existing continue working
   - Month 7: Full deprecation, BYOM users auto-migrated to Free tier
4. **Enterprise Exception**: Keep BYOM option for self-hosted enterprise installs

**Communication:**
```
Subject: Important: AI Insights Moving to Credit System

Hi [Church Name],

We're excited to announce improvements to AI Insights!

Starting [Date], we're replacing the "Bring Your Own API Key" system
with a simpler AI Credits system. Benefits include:

✓ No API key setup required
✓ Predictable monthly pricing
✓ Access to premium AI models
✓ Better usage tracking

Your transition bonus: 500 free credits (worth $10)!

[Learn More] [Switch Now]
```

## Implementation Details

### Frontend Components

#### Credit Balance Widget (AiInsightsPage.tsx)

```typescript
// Display credit balance in header
<div className="flex items-center space-x-2 text-sm">
  <SparklesIcon className="h-4 w-4" />
  <span>{creditsBalance} credits</span>
  {subscription && (
    <span className="text-gray-500">
      ({subscription.monthly_allowance}/month)
    </span>
  )}
  <button onClick={() => navigate('/settings/ai-credits')}>
    Add Credits
  </button>
</div>
```

#### Model Tier Selector

```typescript
// Optional: Show model tier selector (default is /low via slash command)
<div className="flex space-x-2 mb-2">
  <button
    className={tierClass('low')}
    onClick={() => setTier('low')}
  >
    Fast (1 credit)
  </button>
  <button
    className={tierClass('med')}
    onClick={() => setTier('med')}
  >
    Balanced (5 credits)
  </button>
  <button
    className={tierClass('high')}
    onClick={() => setTier('high')}
  >
    Premium (20 credits)
  </button>
</div>
```

#### Usage Analytics Page

New page: `client/src/pages/AiCreditsPage.tsx`

Features:
- Credit balance and subscription tier
- Monthly usage chart (Chart.js)
- Transaction history table
- Top-up/upgrade buttons
- Usage by user (for admins)
- Usage by model tier

### Backend Implementation

#### Credit Check Middleware

```javascript
// server/middleware/aiCredits.js
async function checkCredits(req, res, next) {
  const { church_id } = req.user;
  const { tier = 'low' } = req.body;

  const creditCost = {
    'low': 1,
    'med': 5,
    'high': 20
  }[tier];

  const [balance] = await Database.query(
    'SELECT credits_balance FROM ai_credits WHERE church_id = ?',
    [church_id]
  );

  if (!balance || balance.credits_balance < creditCost) {
    return res.status(402).json({
      error: 'Insufficient credits',
      balance: balance?.credits_balance || 0,
      required: creditCost
    });
  }

  req.creditCost = creditCost;
  next();
}
```

#### Deduct Credits Function

```javascript
// server/utils/aiCredits.js
async function deductCredits(churchId, userId, tier, modelUsed, conversationId, metadata) {
  const creditCost = { 'low': 1, 'med': 5, 'high': 20 }[tier];

  // Start transaction
  await Database.query('START TRANSACTION');

  try {
    // Deduct credits
    const [result] = await Database.query(
      `UPDATE ai_credits
       SET credits_balance = credits_balance - ?,
           credits_lifetime_used = credits_lifetime_used + ?
       WHERE church_id = ?`,
      [creditCost, creditCost, churchId]
    );

    if (result.affectedRows === 0) {
      throw new Error('Church credits not found');
    }

    // Get new balance
    const [balance] = await Database.query(
      'SELECT credits_balance FROM ai_credits WHERE church_id = ?',
      [churchId]
    );

    // Log transaction
    await Database.query(
      `INSERT INTO ai_credit_transactions
       (church_id, user_id, credits_change, balance_after, transaction_type,
        model_tier, model_used, conversation_id, metadata)
       VALUES (?, ?, ?, ?, 'usage', ?, ?, ?, ?)`,
      [
        churchId,
        userId,
        -creditCost,
        balance.credits_balance,
        tier,
        modelUsed,
        conversationId,
        JSON.stringify(metadata)
      ]
    );

    await Database.query('COMMIT');

    return {
      success: true,
      balance: balance.credits_balance,
      cost: creditCost
    };
  } catch (error) {
    await Database.query('ROLLBACK');
    throw error;
  }
}
```

#### Monthly Credit Refresh (Cron Job)

```javascript
// server/jobs/refreshMonthlyCredits.js
// Run daily at 00:01 UTC

async function refreshMonthlyCredits() {
  const today = new Date().toISOString().split('T')[0];
  const firstOfMonth = today.endsWith('-01');

  if (!firstOfMonth) return;

  const churches = await Database.query(`
    SELECT
      ac.church_id,
      ac.credits_balance,
      ac.monthly_credit_allowance,
      asp.rollover_allowed,
      asp.max_rollover_credits
    FROM ai_credits ac
    JOIN ai_subscription_plans asp ON ac.subscription_tier = asp.tier_name
    WHERE ac.subscription_tier != 'free'
      AND (ac.last_credit_refresh IS NULL
           OR ac.last_credit_refresh < DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
  `);

  for (const church of churches) {
    let newBalance = church.monthly_credit_allowance;

    // Handle rollover
    if (church.rollover_allowed && church.credits_balance > 0) {
      const rollover = Math.min(
        church.credits_balance,
        church.max_rollover_credits || 0
      );
      newBalance += rollover;

      // Log rollover transaction
      await Database.query(`
        INSERT INTO ai_credit_transactions
        (church_id, user_id, credits_change, balance_after, transaction_type, metadata)
        VALUES (?, 1, ?, ?, 'rollover', ?)
      `, [
        church.church_id,
        rollover,
        newBalance,
        JSON.stringify({ from_balance: church.credits_balance })
      ]);
    }

    // Update balance
    await Database.query(`
      UPDATE ai_credits
      SET credits_balance = ?,
          last_credit_refresh = CURDATE(),
          low_balance_warning_sent = FALSE
      WHERE church_id = ?
    `, [newBalance, church.church_id]);

    // Log subscription renewal
    await Database.query(`
      INSERT INTO ai_credit_transactions
      (church_id, user_id, credits_change, balance_after, transaction_type, metadata)
      VALUES (?, 1, ?, ?, 'subscription_renewal', ?)
    `, [
      church.church_id,
      church.monthly_credit_allowance,
      newBalance,
      JSON.stringify({ renewal_date: today })
    ]);
  }

  logger.info(`Monthly credit refresh completed for ${churches.length} churches`);
}
```

### Slash Command Parser

```typescript
// client/src/utils/aiSlashCommands.ts

export interface ParsedCommand {
  tier: 'low' | 'med' | 'high';
  message: string;
  hasExplicitTier: boolean;
}

export function parseSlashCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  // Check for /low, /med, /high at start
  const tierMatch = trimmed.match(/^\/(low|med|high)\s+(.+)/i);

  if (tierMatch) {
    return {
      tier: tierMatch[1].toLowerCase() as 'low' | 'med' | 'high',
      message: tierMatch[2].trim(),
      hasExplicitTier: true
    };
  }

  // Default to low tier
  return {
    tier: 'low',
    message: trimmed,
    hasExplicitTier: false
  };
}

export function getCreditCost(tier: 'low' | 'med' | 'high'): number {
  return { low: 1, med: 5, high: 20 }[tier];
}

export function getTierDescription(tier: 'low' | 'med' | 'high'): string {
  return {
    low: 'Fast response (1 credit)',
    med: 'Balanced analysis (5 credits)',
    high: 'Deep insights (20 credits)'
  }[tier];
}
```

## API Endpoints

### Credits Management

```
GET    /api/ai/credits/balance
       Returns current credit balance and subscription info

GET    /api/ai/credits/transactions?limit=50&offset=0
       Returns transaction history with pagination

POST   /api/ai/credits/purchase
       Body: { package_id: number }
       Initiates Stripe checkout for credit purchase

POST   /api/ai/credits/subscribe
       Body: { plan_id: number }
       Initiates Stripe checkout for subscription

POST   /api/ai/credits/cancel-subscription
       Cancels current subscription (effective end of billing period)

GET    /api/ai/subscription/plans
       Returns available subscription plans

POST   /api/ai/admin/adjust-credits (admin only)
       Body: { church_id: string, credits: number, reason: string }
       Manual credit adjustment by admin
```

### Modified AI Endpoints

```
POST   /api/ai/ask
       Body: { question: string, tier?: 'low'|'med'|'high' }
       Now checks and deducts credits before making API call
       Returns 402 Payment Required if insufficient credits
```

## Rate Limiting

### Per-Church Limits

```javascript
// Prevent abuse even with credits available
const RATE_LIMITS = {
  per_minute: 10,    // Max 10 AI requests per minute
  per_hour: 100,     // Max 100 AI requests per hour
  per_day: 500       // Max 500 AI requests per day
};
```

### Implementation

Use existing rate limit middleware, add church-specific tracking:

```javascript
// server/middleware/rateLimitAI.js
const aiRequestCounts = new Map(); // church_id -> { minute: [], hour: [], day: [] }

function checkAIRateLimit(req, res, next) {
  const { church_id } = req.user;
  const now = Date.now();

  // Get or create tracking for this church
  if (!aiRequestCounts.has(church_id)) {
    aiRequestCounts.set(church_id, { minute: [], hour: [], day: [] });
  }

  const counts = aiRequestCounts.get(church_id);

  // Clean old timestamps
  counts.minute = counts.minute.filter(t => now - t < 60000);
  counts.hour = counts.hour.filter(t => now - t < 3600000);
  counts.day = counts.day.filter(t => now - t < 86400000);

  // Check limits
  if (counts.minute.length >= RATE_LIMITS.per_minute) {
    return res.status(429).json({
      error: 'Rate limit exceeded: Maximum 10 requests per minute'
    });
  }
  if (counts.hour.length >= RATE_LIMITS.per_hour) {
    return res.status(429).json({
      error: 'Rate limit exceeded: Maximum 100 requests per hour'
    });
  }
  if (counts.day.length >= RATE_LIMITS.per_day) {
    return res.status(429).json({
      error: 'Rate limit exceeded: Maximum 500 requests per day'
    });
  }

  // Add current request
  counts.minute.push(now);
  counts.hour.push(now);
  counts.day.push(now);

  next();
}
```

## Low Balance Notifications

### Email Warnings

Send automated emails when credits run low:

```javascript
// server/jobs/checkLowBalances.js
// Run every 6 hours

async function checkLowBalances() {
  const churches = await Database.query(`
    SELECT
      ac.church_id,
      ac.credits_balance,
      ac.monthly_credit_allowance,
      ac.low_balance_warning_sent,
      cs.church_name,
      u.email,
      u.first_name
    FROM ai_credits ac
    JOIN church_settings cs ON ac.church_id = cs.church_id
    JOIN users u ON ac.church_id = u.church_id
    WHERE u.role = 'admin'
      AND ac.subscription_tier != 'enterprise'
      AND ac.low_balance_warning_sent = FALSE
  `);

  for (const church of churches) {
    const percentRemaining = (church.credits_balance / church.monthly_credit_allowance) * 100;

    let shouldWarn = false;
    let warningLevel = '';

    if (percentRemaining <= 5) {
      shouldWarn = true;
      warningLevel = 'critical'; // 5% or less
    } else if (percentRemaining <= 10) {
      shouldWarn = true;
      warningLevel = 'urgent'; // 10% or less
    } else if (percentRemaining <= 20) {
      shouldWarn = true;
      warningLevel = 'warning'; // 20% or less
    }

    if (shouldWarn) {
      // Send email via Brevo
      await sendLowBalanceEmail(church, warningLevel);

      // Mark as warned
      await Database.query(
        'UPDATE ai_credits SET low_balance_warning_sent = TRUE WHERE church_id = ?',
        [church.church_id]
      );
    }
  }
}
```

### In-App Warnings

Show banner in AI Insights page:

```typescript
{creditsBalance < 50 && (
  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
    <div className="flex items-center">
      <ExclamationTriangleIcon className="h-5 w-5 text-red-500 mr-3" />
      <div className="flex-1">
        <p className="font-medium text-red-800">
          Low AI Credits
        </p>
        <p className="text-sm text-red-600">
          You have {creditsBalance} credits remaining.
          {subscription?.subscription_tier === 'free' &&
            ' Upgrade to a paid plan for more credits.'
          }
        </p>
      </div>
      <button
        onClick={() => navigate('/settings/ai-credits')}
        className="bg-red-600 text-white px-4 py-2 rounded-md"
      >
        Add Credits
      </button>
    </div>
  </div>
)}
```

## Analytics Dashboard

### Metrics to Track

1. **Usage Metrics**
   - Total requests per day/week/month
   - Requests by tier (low/med/high)
   - Credits consumed
   - Average credits per user
   - Most active users

2. **Financial Metrics**
   - Monthly recurring revenue (MRR)
   - Average revenue per church (ARPC)
   - Churn rate
   - Credit package vs subscription ratio
   - Upgrade rate (free → paid)

3. **Model Metrics**
   - Requests by provider (OpenAI vs Anthropic)
   - Average response time by model
   - Error rate by model
   - Token usage vs credit cost

### Admin Dashboard

New page: `client/src/pages/admin/AiAnalyticsPage.tsx`

Charts:
- Daily active churches using AI
- Credit consumption over time
- Subscription tier distribution (pie chart)
- Top 10 churches by usage
- Revenue projection based on current usage

## Security Considerations

### Abuse Prevention

1. **Rate Limiting**: Hard limits per minute/hour/day
2. **Church Isolation**: Credits are per-church, not per-user
3. **Request Validation**: Sanitize inputs, check question length
4. **Model Access Control**: Only allow configured models
5. **Audit Logging**: Log all credit transactions with metadata

### Credit Fraud Prevention

1. **Payment Verification**: Validate Stripe webhooks with signature
2. **Duplicate Transaction Check**: Prevent double-spending
3. **Admin Alerts**: Notify if unusual credit patterns detected
4. **Refund Policy**: Clear policy to prevent abuse
5. **Enterprise Verification**: Vet enterprise customers before unlimited access

### Data Privacy

1. **No PII in Metadata**: Don't log sensitive church data in transactions
2. **Question Content**: Store question hash, not full text (unless user opts in)
3. **Analytics Aggregation**: Church-level analytics, not individual user tracking
4. **GDPR Compliance**: Allow churches to export/delete credit history

## Refund & Credits Policy

### Refund Scenarios

1. **Service Outage**: Full credit refund if AI unavailable > 24 hours
2. **Failed Requests**: Automatic credit refund for API errors
3. **Billing Errors**: Full refund within 30 days if overcharged
4. **Subscription Cancellation**: Prorated refund if canceled mid-cycle (optional)

### Failed Request Handling

```javascript
// In ai.js route
try {
  const answer = await callOpenAI(...);
  res.json({ answer });
} catch (error) {
  // Refund credits on error
  await refundCredits(req.user.church_id, req.user.id, req.creditCost, {
    reason: 'API error',
    error: error.message
  });

  res.status(500).json({
    error: 'AI request failed. Your credits have been refunded.'
  });
}
```

## Testing Strategy

### Unit Tests

- Credit deduction logic
- Balance calculations
- Rollover calculations
- Rate limit enforcement
- Slash command parsing

### Integration Tests

- Full purchase flow (with Stripe test mode)
- Monthly credit refresh job
- Low balance notifications
- Failed request refunds
- Subscription tier changes

### Load Tests

- 1000 concurrent AI requests
- Credit balance contention (multiple users, same church)
- Transaction log volume (millions of records)

### User Acceptance Tests

- Purchase credits flow
- Subscribe to plan flow
- Upgrade/downgrade plan
- Cancel subscription
- Use slash commands
- View usage history

## Migration Checklist

### Pre-Launch (Phase 1)

- [ ] Create database tables (`ai_credits`, `ai_credit_transactions`, `ai_subscription_plans`)
- [ ] Seed subscription plans
- [ ] Build credits API endpoints
- [ ] Update AI routes to check credits
- [ ] Add credit balance display in UI
- [ ] Create usage history page
- [ ] Implement rate limiting
- [ ] Test with test churches
- [ ] Documentation for users

### Payment Integration (Phase 2)

- [ ] Set up Stripe account
- [ ] Create Stripe products/prices
- [ ] Build checkout flow (credits + subscriptions)
- [ ] Implement Stripe webhooks
- [ ] Build subscription management page
- [ ] Test purchases in Stripe test mode
- [ ] Add billing history page
- [ ] Implement refund logic
- [ ] Set up monthly refresh cron job
- [ ] Set up low balance alerts
- [ ] Compliance review (PCI DSS, GDPR)

### BYOM Deprecation (Phase 3)

- [ ] Send 6-month deprecation notice
- [ ] Add migration bonus credits
- [ ] Update documentation to remove BYOM references
- [ ] Show deprecation warnings in UI
- [ ] Disable new BYOM setups
- [ ] Auto-migrate remaining BYOM users
- [ ] Remove BYOM code (keep for enterprise)
- [ ] Update README and docs

## Open Questions

1. **Credit Sharing**: Should credits be shared across users in same church, or per-user?
   - **Recommendation**: Per-church (simpler billing, encourages collaboration)

2. **Overage Handling**: Allow negative balance (overage) or hard stop at 0?
   - **Recommendation**: Hard stop for Free/Basic, allow small overage for Pro/Enterprise

3. **Family Accounts**: Should family churches (same organization) share credits?
   - **Recommendation**: No sharing initially, add as enterprise feature later

4. **Free Tier Abuse**: How to prevent sign-ups for free credits?
   - **Recommendation**: 100 credits once per email/phone, require email verification

5. **Credit Expiration**: Should unused credits expire?
   - **Recommendation**: No expiration for purchased credits, rollover limits for subscription

6. **Model Selection UI**: Slash commands, dropdown, or both?
   - **Recommendation**: Both - slash commands for power users, dropdown for discoverability

7. **Partner Discounts**: Offer discounts to church networks/denominations?
   - **Recommendation**: Yes, negotiate bulk pricing for 10+ churches

## Future Enhancements

### Beyond Phase 3

1. **AI Model Marketplace**: Let users choose specific models (GPT-4o, Claude 3.5, etc.)
2. **Custom Training**: Fine-tune models on church's historical data (premium feature)
3. **AI Features Beyond Insights**:
   - Auto-generate follow-up emails for absent members
   - Sermon summary generation
   - Prayer request categorization
   - Event planning suggestions
4. **API Access**: Let churches use credits for custom integrations
5. **White-Label**: Let denominations resell AI features under their brand
6. **Multi-Language Support**: Expand to non-English churches
7. **Voice Interface**: Ask AI questions via voice (Whisper API)

## Revenue Projections

### Conservative Estimate (Year 1)

```
Total Churches: 100
Conversion Rate: 30% (30 paid churches)
Average Tier: Mix of Basic (50%), Pro (40%), Enterprise (10%)

Monthly Revenue:
- Basic (15 churches × $9):   $135
- Pro (12 churches × $29):    $348
- Enterprise (3 × $200):      $600
Total MRR:                    $1,083
Annual Revenue:               $12,996

+ Credit Top-Ups (est. 20% additional): $2,600

Year 1 Total:                 ~$15,600
```

### Optimistic Estimate (Year 2)

```
Total Churches: 500
Conversion Rate: 40% (200 paid churches)

Monthly Revenue:
- Basic (80 churches × $9):   $720
- Pro (100 churches × $29):   $2,900
- Enterprise (20 × $200):     $4,000
Total MRR:                    $7,620
Annual Revenue:               $91,440

+ Credit Top-Ups (est. 25% additional): $22,860

Year 2 Total:                 ~$114,300
```

### Cost Structure

```
Our AI API Costs (average per church/month):
- Basic tier: ~$2 (78% margin)
- Pro tier: ~$8 (72% margin)
- Enterprise: ~$50 (75% margin)

Infrastructure:
- Stripe fees: 2.9% + $0.30 per transaction
- Server costs: Minimal increase (caching helps)
- Support: Scales with customer count

Net Margin: 60-70% after fees and costs
```

## Conclusion

The AI Credits System transforms a user-provided feature into a sustainable revenue stream while simplifying the user experience. By implementing this in phases, we can validate demand, iterate on pricing, and ensure a smooth transition for existing users.

Key success factors:
1. **Generous Free Tier**: Let users experience value before paying
2. **Clear Pricing**: Simple credit costs, transparent tier benefits
3. **Smooth Migration**: Don't break existing BYOM users
4. **Quality Models**: Use cost-effective models that still deliver value
5. **Usage Analytics**: Help users understand and optimize their credit usage

This system positions Let My People Grow as a premium church management platform with integrated AI capabilities, rather than just a BYOM wrapper around OpenAI/Anthropic.

---

**Next Steps**: Review this plan with stakeholders, validate pricing with beta users, and prioritize Phase 1 features after completing the refactoring work outlined in the main roadmap.
