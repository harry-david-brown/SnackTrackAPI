# Frontend Expectations for Analytics Cache Invalidation

Last updated: November 14, 2025  
Owner: Snack Track App team (`snack-track-app` repo)

## 1. TL;DR
- After a user uploads an Uber CSV/ZIP file, the mobile app expects `/validation/user/:userId/summary?includeWrapped=true` to return the updated analytics within ~3 seconds (one loader cycle) so we can redirect to the Wrapped experience with accurate totals.
- Today Redis continues serving the stale payload that was cached before the upload. Because the client only retries every 15 minutes (local cache TTL), users repeatedly see old data unless they wait or manually clear storage.
- We need the backend to invalidate (or bypass) the Redis cache for both the “summary” + “wrapped analytics” keys for that user immediately after ingestion finishes.

## 2. Current Frontend Flow
1. `components/UberDataUpload.tsx` uploads the ZIP via `POST /csv/import` by calling `csvApi.importCsv(userId, file)`.
2. On success we show `components/WrappedJourneyLoader.tsx` for ~2 seconds (the loader auto-calls `onComplete` after 1500 ms).
3. Once the loader completes, `app/(tabs)/upload.tsx` executes:
   ```ts
   const summary = await analyticsApi.getUserSummary(state.user.id, true);
   setGlobalAnalytics(summary);
   router.push('/(tabs)/wrapped-journey');
   ```
4. `analyticsApi.getUserSummary` is a thin wrapper over `GET /validation/user/:id/summary?includeWrapped=true`.
5. We also cache analytics for 15 minutes via `utils/offlineCache.ts` **after** receiving a fresh payload. We do not manually clear this cache during upload because it would cause blank dashboards if the backend still returns old data.

## 3. Required Backend Behavior
- **Cache busting trigger**: Once `/csv/import` finishes parsing + persisting new receipts, invalidate the Redis entries that back the summary + wrapped response for that `userId`. If the cache key is shared across endpoints, reset both.
- **Eventual consistency budget**: The frontend waits only for one loader cycle (~2 s). If you need more time, return a 202 + “processing” body and expose a webhook/polling endpoint so we can adapt the UX. Otherwise, ensure the cache miss path completes within that window.
- **Key scope**: Include both the base analytics (`statistics.*`) and the wrapped payload (`wrappedAnalytics`). Users see incorrect totals in both the dashboard tab (`app/(tabs)/index.tsx`) and the wrapped journey.
- **API contract**: Response shape must remain the same so `analyticsApi` doesn’t need to change. If you add metadata (e.g., `dataVersion`, `generatedAt`), please append fields rather than replacing the existing ones.

## 4. Observability Requirements
- Emit structured logs/events whenever cache invalidation runs (user id, previous cache timestamp, duration).
- Add a metric for “summary cache freshness” so we can alert if >5% of summary responses are older than 1 minute during peak hours.
- Optional but helpful: include a header such as `x-snack-cache-status: hit|miss|bypassed` so we can see what users experience directly in the client logs.

## 5. Acceptance Criteria
1. Uploading a new ZIP while watching network traffic should show `GET /validation/user/:id/summary?includeWrapped=true` returning the updated totals on the first request after ingestion completes.
2. No manual cache clear should be needed on the device. Killing/restarting the app immediately after upload should also show the new data.
3. When uploads happen in quick succession, the freshest data should always win (e.g., two files back-to-back should not re-serve the first cache entry).
4. Automated backend tests (`tests/test-cache-invalidation.sh`) should cover the same scenario; please coordinate if frontend updates are required for those scripts.

Ping #snack-track-engineering in Slack when this is ready so we can remove the blocker from `LAUNCH_TODO.md`.


