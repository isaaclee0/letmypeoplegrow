# People-sync filter rules

Planning Center and Elvanto use the same provider-neutral Boolean filter
contract. Do not add provider-specific Boolean evaluation, preview, or draft
promotion paths.

- Put all schema-v2 normalization, validation, evaluation, selected-dimension
  discovery, and summaries in
  `server/services/peopleSync/filterEngine.js`.
- Use `server/services/peopleSync/filterSnapshot.js` for PII-free provider
  facts, dimensions, and population gating; use
  `server/services/peopleSync/filterFactsCache.js` for the church/provider
  complete-snapshot cache.
- Keep previews in `server/services/peopleSync/filterPreview.js` cache-only.
  A preview must never fetch a Planning Center or Elvanto roster and must never
  return facts, external IDs, credentials, or raw provider records.
- The only filter-builder roster fetch is the explicit refresh route in
  `server/routes/integrations/filterBuilder.js`. It may replace cache content
  only with a complete full snapshot.
- Save changed criteria as a draft through
  `server/services/peopleSync/batchRepository.js`; never write them into the
  active filter directly. Promote drafts only through reviewed reconciliation
  and its atomic transaction in `server/services/peopleSync/apply.js` /
  `server/services/peopleSync/orchestrator.js`.
- Keep schema-v1 provider logic in
  `server/services/planningCenter/eligibility.js` and
  `server/services/elvanto/filter.js`. Version-1 batches and schedules remain
  active until an explicit, reviewed compatibility upgrade through
  `server/services/peopleSync/filterUpgrade.js`.
- Enforce church isolation on every cache key, route, query, snapshot, draft,
  review, and scheduled operation. Authoritative unattended sync must refuse a
  normal pending schema-v2 draft with `SYNC_FILTER_REVIEW_REQUIRED`.
