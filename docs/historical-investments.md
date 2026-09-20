# Historical investment rollout

Status: implementation prepared; historical mode and provider refresh default to disabled.

## Provider acceptance (before any production activation)

Use Finazon US Equities Basic, as a business account. Confirm the configured plan's final price (the public $19/month is a starting price), commercial calculated-result display, storage/retention, and permitted use after cancellation. Keep the agreement with operational records. Public pages: https://finazon.io/dataset/us_stocks_essential and https://finazon.io/terms.

In an entitled environment verify `SPY` and `QQQ` daily history from 1999-03-10 (the common fund-history horizon) through the previous completed month. The adapter uses Finazon's documented `/latest/finazon/us_stocks_essential/time_series`, `adjust=all`, `prepost=false`, ascending order, and 1,000-row pages. Confirm UTC date interpretation, symbol identity, pagination, and dividend/split treatment against actual responses. Check several independently sourced total-return intervals, including dividend dates and a falling market. These live checks need an entitled API key and are not replaced by synthetic regression fixtures.

The validation calendar covers regular US market holidays and known exceptional closures since 1999. Missing expected sessions reject the entire snapshot. Unexpected future closures require a calendar update rather than guessing a price. Contributions before the common horizon omit the story; they are never silently dropped from a historical comparison.

## Deploy in order

1. Deploy migration 032 and API with `HISTORICAL_INVESTMENTS_ENABLED=false` and `MARKET_HISTORY_REFRESH_ENABLED=false`.
2. Deploy the compatible mobile app. Public names are always Nasdaq and S&P 500; provider tickers stay internal. Old apps omit the new Wrapped block and retain a working dashboard card.
3. After provider acceptance, configure `FINAZON_API_KEY` on a separate scheduler service using `railway.market-history.json`. This service runs `npm run start:market-history` daily at 08:00 UTC. Set `MARKET_HISTORY_REFRESH_ENABLED=true` there; no key is needed in the app or API read process.
4. Run the command once in that environment, inspect its `published` result and database snapshot. Both funds are published as one immutable record, only after complete validation. The refresh lease is fenced at publication; overlapping runs cannot publish with an expired lease.
5. Enable `HISTORICAL_INVESTMENTS_ENABLED=true` on the API only after verifying values and updated mobile presentation. Restart the API for configuration changes.

The job fetches only when the completed-month snapshot is missing, re-fetching full adjusted history to avoid mixing adjustment bases. A provider failure leaves the prior snapshot untouched. Inspect `market_history_refresh` failures and the published valuation date in existing logs; alert operationally if no new snapshot has published by the fifth day of the month. Never attach a provider's raw error body or key to logs.

## Behavior and failure modes

Both surfaces use one contribution-date calculator over the existing known, single-currency net-cost cohort. Each order buys at that calendar date's close, or the next market session. Orders after the valuation date are excluded; the card's count and pinned receipt drilldown match. Results are hypothetical fund-proxy returns, including reinvested dividends and fund expenses, excluding historical FX, personal taxes, and trading costs. Nasdaq means Nasdaq-100. Select the higher complete portfolio, with S&P 500 winning ties; suppress nonpositive rounded gains. Dashboard keeps its five-order / 180-day history requirement.

Historical mode with missing, invalid, or more-than-62-day-old data omits only this story. A provider outage never falls back to 7%. Current snapshots have their ID and freshness in analytics cache keys. Receipt drilldowns carry the displayed snapshot ID; existing receipt changes can still legitimately change the contributing order list.

Snapshots are shared reference data, not user account data. Keep retained snapshots while the provider agreement permits; if rights end, disable refresh and historical mode and remove provider data according to the agreement, including backups. Do not delete referenced snapshots during ordinary monthly refreshes.

Explicit rollback: set `HISTORICAL_INVESTMENTS_ENABLED=false` and restart the API. This restores the pre-existing labeled fixed-rate behavior and changes cache identity. Stop the scheduler separately if necessary. No receipt rollback or schema reversal is required.

## Verification and manual handoff

Run `npm run build` in SnackTrackAPI and `npm run type-check` in SnackTrackApp. Focused regression files cover formulas, provider validation/retries/pagination, leases, projection/cutoff consistency, cache identity, response decoding and display naming. Per repository guidance, test suites run only on explicit request.

On a user-controlled device: inspect dashboard and Wrapped with a positive result; verify both benchmark names and cutoff, long text/large font readability, screen-reader copy, both-negative omission, current-month exclusions, and the pinned View orders list across a monthly publication. Confirm no provider symbols appear. Inspect the modern six-story recap as well as the legacy slide selection.

No provider subscription, live backfill, production migration, deployment, or feature activation is implied by adding this configuration. Tiingo remains an evaluated alternative, not an automatic fallback.

## Docker Compose (development and production)

Both Compose stacks include `market-history` in their default services (no tools profile). It waits for migrations, checks the shared PostgreSQL snapshot on startup, then checks daily at 08:00 UTC, matching Railway's cron. When the completed-month snapshot exists, it makes no Finazon calls. Missing data triggers the same full-history fetch, validation, lease, and atomic publication used in production. Failures are logged and retried at the next daily check; a restart also checks immediately. This is database-state-driven, not dependent on opening the mobile app.

Development also checks immediately when the API starts (including `npm run dev` and source reloads), without delaying HTTP readiness. This uses the same refresh service and database lease as the scheduler, so concurrent starts do not duplicate a refresh. Production API startup does not fetch market data. Opening the mobile app alone does not restart the API or trigger a refresh.

Set these in the stack's `.env` after provider acceptance:

```dotenv
FINAZON_API_KEY=<your entitled key>
MARKET_HISTORY_REFRESH_ENABLED=true
HISTORICAL_INVESTMENTS_ENABLED=true
```

The existing disabled defaults remain intentional until provider acceptance; Compose does not override them. With refresh disabled, the scheduler logs that state and makes no provider calls. With refresh enabled but no key, missing data produces a logged credential failure, and the process stays alive for the next check. Current data still needs no provider key to read.

Start development with `docker compose up -d`; production Compose uses `docker compose -f docker-compose.prod.yml up -d --build`. Recreate the API and market-history containers after changing `.env` (`docker compose up -d --force-recreate api market-history` in dev). Use `docker compose logs market-history` for scheduled checks and `docker compose logs api` for the development startup check, including disabled, current, published, or failure outcomes. Production Compose runs migrations before its API and scheduler; Railway retains the existing release-migration prerequisite.

The scheduler runs the same service in both environments. Its process stays alive in Compose (`--watch`); Railway invokes it once per cron run. Shutdown cancels the daily timer and lets the active bounded refresh close its database connection.
