# Provider-Neutral People Sync and Elvanto Source of Truth — Design Spec

**Status**: Approved design (pending written-spec review)

**Date**: 2026-07-25

**Scope**: People/family imports, authoritative people sync, Elvanto connection,
matching, filters, gathering-roster maintenance, and onboarding

**Out of scope**: Elvanto attendance-history import, bidirectional writes to
Elvanto, OAuth, and a general LMPG contact-information model

## Summary

Let My People Grow will replace its provider-specific people authority with a
provider-neutral sync core used by Planning Center Online (PCO) and Elvanto.
Both providers may be connected and retain durable links at the same time, but
only one provider may be the church's source of truth for people. The selected
provider owns managed identity and lifecycle fields and applies the same strict
editing locks that PCO uses today.

Elvanto will support two uses:

1. A reviewed one-time import, including during onboarding.
2. An ongoing, scheduled, one-way source-of-truth sync from Elvanto to LMPG.

All import paths use the same matching and plan/review/apply pipeline. The
current Elvanto importer, which copies records without retaining Elvanto IDs,
will be superseded rather than extended in place.

## Goals

- Allow PCO and Elvanto to remain connected simultaneously.
- Enforce a single church-level source of truth: `none`, `planning_center`, or
  `elvanto`.
- Give both providers durable person and family links.
- Use matching for onboarding, manual imports, and authoritative sync.
- Make all user-triggered imports reviewable before mutation.
- Support Elvanto filters based on the characteristics exposed by the connected
  account, especially group membership.
- Maintain LMPG gathering rosters from Elvanto groups without removing manual
  roster assignments.
- Move integration credentials from user preferences to church-level storage.
- Preserve current PCO behaviour during an incremental migration.
- Keep every database operation church-scoped.

## Non-Goals

- LMPG will not write people, families, groups, or statuses back to Elvanto.
- Elvanto OAuth will not be implemented in this phase. API-key authentication
  is the supported connection method.
- Email and phone will not become LMPG person fields as part of this work.
- Elvanto check-in or service attendance will not be imported in this phase.
- PCO and Elvanto filter vocabularies do not need to look identical. They share
  a sync contract, not a least-common-denominator UI.
- This work will not remove legacy PCO schema in its first release.

## Product Rules

### Connection and authority are separate

A church may connect both PCO and Elvanto. Each connection can be used for a
reviewed import and can retain links to the same LMPG people. A separate
church-level setting selects the authoritative provider.

Only the authoritative provider may:

- run unattended lifecycle reconciliation;
- lock linked records;
- archive or reactivate linked people automatically;
- keep identity, child state, people type, and family membership aligned; and
- prevent creation of regulars outside authoritative workflows.

The non-authoritative provider may still generate reviewed import plans. If an
LMPG person is already locked by the authoritative provider, a
non-authoritative plan may add its external link but may not change fields
owned by the authority.

While an authority is active, a non-authoritative import may create visitors,
but it may not create new regulars that are absent from the authoritative
provider. This preserves strict source-of-truth semantics. If neither provider
is authoritative, either provider may import regulars after review.

### Strict managed-record behaviour

When a provider is authoritative:

- linked people cannot be manually renamed;
- child/adult state cannot be manually changed;
- linked people cannot be manually archived, reactivated, deleted, or merged;
- new regulars cannot be created manually;
- visitors may still be created and managed locally; and
- family changes owned by the authority cannot be made manually when they
  would alter authoritative membership.

The user-facing error and badge must name the actual provider rather than PCO.

### Authority switching

Switching from one authority to another is staged:

1. The user selects the proposed authority.
2. LMPG fetches fresh provider data and builds a full reconciliation plan.
3. The UI shows link coverage, records that will become locked, adds, updates,
   lifecycle changes, conflicts, and unmatched local regulars.
4. The user reviews and applies the plan.
5. Only after a successful apply does the new authority become active and its
   schedules begin running.

Cancelling or failing the reconciliation leaves the previous authority
unchanged. Selecting `none` disables authority immediately after explicit
confirmation and does not remove links.

Disconnecting an authoritative provider first sets authority to `none`, stops
its schedules, and then removes the credential. Imported records and durable
links remain intact.

## Elvanto Status Semantics

The default mapping is:

| Elvanto state | LMPG result |
|---|---|
| Active | active `regular` |
| Contact | active `local_visitor` |
| Archived | archived |
| Deceased | archived |

When upstream flags overlap, projection uses this precedence: Deceased,
Archived, Contact, then Active. This prevents a deceased or archived profile
from being treated as active merely because another status flag is also set.

`Include Elvanto contacts` is a church-level setting and defaults to on. When
off, Contacts do not enter the combined authoritative population. A previously
linked Contact that no longer qualifies is proposed for archive, not deletion.

`Keep people type aligned with Elvanto status` is also church-level and defaults
to on:

- On: Active becomes `regular`; Contact becomes `local_visitor` on each sync.
- Off: Active/Contact determines people type only when the person is first
  imported. Later transitions do not change LMPG people type.

Archived and Deceased states still control active/archive lifecycle whenever
Elvanto is authoritative, regardless of the people-type alignment option.

## Data Model

All new tables include `church_id`, and every unique constraint that refers to
provider data is church-scoped.

### `integration_connections`

One row per church and provider:

- `id`
- `church_id`
- `provider` (`planning_center` or `elvanto`)
- `auth_type` (`oauth` or `api_key`)
- `credential_ciphertext`
- encryption nonce/authentication-tag fields
- `connection_status`
- `connected_by`
- `connected_at`
- `last_validated_at`
- `last_error_code`
- `metadata` (sanitized JSON only)
- timestamps

Elvanto API keys are encrypted using an application-level key supplied by a
deployment environment variable. The key is write-only through the API and is
never returned to the client, placed in logs, or included in takeout/admin
exports. The UI can report `connected`, `invalid`, or `validation unavailable`,
but API-key authentication does not provide a reliable Elvanto account name.

Production must refuse to store a new integration secret if credential
encryption is not configured. Development may use an explicit, documented
development key; there is no implicit plaintext fallback.

### `external_person_links`

- `id`
- `church_id`
- `provider`
- `external_person_id`
- `individual_id`
- `link_source` (`matched`, `created`, or `manual`)
- `linked_at`
- `last_seen_at`
- `missing_full_sync_count`
- optional provider-specific review-declined state
- timestamps

Unique constraints:

- `(church_id, provider, external_person_id)`
- `(church_id, provider, individual_id)`

One LMPG person may therefore have one PCO link and one Elvanto link, but never
two links from the same provider.

### `external_family_links`

The same structure links LMPG families to PCO households or Elvanto family IDs,
with equivalent church/provider uniqueness rules.

### `people_sync_settings`

One row per church:

- `authority_provider` (`none`, `planning_center`, or `elvanto`)
- `pending_authority_provider`, used during reviewed switching
- `elvanto_include_contacts`, default `1`
- `elvanto_align_people_type`, default `1`
- provider-independent notification/reconciliation settings
- timestamps

### `people_sync_batches`

- `id`
- `church_id`
- `provider`
- `name`
- `enabled`
- `filter_schema_version`
- `filter_config` (validated provider-specific JSON)
- `default_people_type`
- `gathering_type_id`
- `gathering_auto_remove_enabled`
- schedule fields
- last-run fields
- timestamps

Provider-specific JSON is validated at API and service boundaries. Unknown
keys or unsupported filter versions are rejected rather than silently ignored.

### Gathering provenance

`gathering_lists` gains a generic `added_by_sync_batch_id`. A batch may remove
only roster memberships carrying its own provenance. Manual assignments and
memberships added by another batch are never removed by that batch.

The legacy `added_by_pco_batch_id` remains during migration and is backfilled
to the generic field.

### Sync runs and audit

`people_sync_runs` records:

- church, provider, trigger, and optional batch;
- start/end timestamps and outcome;
- whether the fetch was incremental or full;
- sanitized counts for every plan bucket;
- whether review was required;
- sanitized error codes/messages; and
- the last external modification watermark when applicable.

Secrets and raw provider payloads are not stored in the audit row.

## Provider-Neutral Architecture

The shared sync core is composed of small provider-independent services:

- **Connection store** — retrieves church-level credentials and validates
  provider connections.
- **Provider adapter contract** — fetches people/families and metadata, then
  projects them into a normalized model.
- **Filter evaluator** — delegates provider-specific predicates but returns a
  provider-independent eligible population.
- **Matcher** — matches normalized external records to LMPG people/families.
- **Diff engine** — creates a deterministic, side-effect-free sync plan.
- **Review serializer** — returns safe plan data without credentials or entire
  upstream payloads.
- **Apply service** — applies accepted plan actions transactionally and
  church-scoped.
- **Authority service** — owns lock decisions and provider-aware messages.
- **Scheduler** — runs enabled batches and periodic full reconciliations.

PCO and Elvanto each implement an adapter and filter schema. Shared code must
not branch repeatedly on provider names; provider-specific behaviour belongs
behind adapter/filter interfaces.

The first implementation phase establishes these contracts around current PCO
behaviour. It must not be a wholesale rewrite of every PCO module. Existing PCO
modules can be wrapped, then migrated incrementally when sharing reduces real
duplication.

## Elvanto Adapter

### Authentication

Elvanto uses HTTP Basic authentication with the API key as username and a dummy
password. Connecting performs a small authenticated request before the encrypted
key is saved. A failed validation does not replace an existing working key.

### Normalized person projection

The adapter projects at least:

- stable Elvanto person ID;
- first, preferred, and last names;
- `date_modified`;
- Active/Contact/Archived/Deceased state;
- category ID;
- family ID and family relationship;
- birthday-derived child state where available;
- group memberships;
- demographics;
- departments;
- service types;
- locations; and
- configured custom-field values.

Elvanto can return a single object where an array is expected. Normalization
must convert all list-shaped responses consistently before business logic sees
them.

Child state is tri-state in the normalized projection: `true`, `false`, or
`unknown`. An explicit child family relationship is sufficient for `true`.
Birthday-derived child status requires a documented church-level age boundary;
until LMPG exposes that setting, birthday alone is not used to guess. `unknown`
never overwrites an existing LMPG value, and a newly created person with no
explicit child evidence defaults to adult. This avoids a missing Elvanto field
silently changing children into adults.

Family naming follows the existing LMPG convention: an Elvanto Primary Contact
is listed first, followed by a spouse when present; children do not contribute
to the generated family name. If no Primary Contact exists, the first
non-child family member is used. If every member has unknown/child state, the
review plan proposes a name and asks for confirmation rather than guessing.

### Metadata

The adapter loads the characteristics available in the connected account:

- people categories;
- groups;
- demographics;
- departments;
- service types;
- locations; and
- custom-field definitions and allowed values.

Metadata is cached with a timestamp and can be manually refreshed. A stale
cache may render the filter editor, but plan generation validates saved filter
IDs against fresh/fetched data and reports removed upstream options.

### Pagination and change detection

- Initial imports and user-reviewed reconciliations fully paginate people.
- Scheduled runs may use Elvanto `people/search` with `date_modified` in UTC.
- Incremental watermarks overlap slightly and de-duplicate by person ID so a
  boundary timestamp cannot drop a change.
- A periodic full reconciliation is mandatory even when incrementals succeed.
- Only a complete, validated full response may establish that a linked person
  is absent from Elvanto.

Elvanto Archived and Contact people are intentionally included in fetches so
that lifecycle transitions are visible.

## Filters and Batches

Elvanto batch filters support the obvious account characteristics:

- status;
- people category;
- groups;
- demographics;
- departments;
- service types;
- locations; and
- custom fields.

Multiple selected groups support an explicit `any` or `all` operator, defaulting
to `any`. Other multi-value filters likewise declare their operator rather than
depending on hidden behaviour. Different filter dimensions are combined with
AND: for example, `(category is Member) AND (group is Youth OR Young Adults)`.

The union of all enabled batches for a provider is the provider's combined
authoritative population. Failing one batch never archives a person who still
qualifies for another. Gathering-roster eligibility remains batch-specific.

Each batch may target one LMPG gathering. Qualifying people are added with batch
provenance. If auto-remove is enabled, people who stop qualifying are removed
only from provenance owned by that batch; they are not necessarily archived
from LMPG.

## Matching

Every import path uses the same matcher:

1. Existing durable provider link.
2. Exact normalized first/last name with a single candidate.
3. Child/adult narrowing when multiple name candidates exist.
4. Family/household corroboration using other member names.
5. Manual review when ambiguity remains.

Elvanto exposes email and phone, and these are potentially stronger evidence.
However, current LMPG individuals do not store those fields. This design does
not pretend they are available for matching. Email/mobile matching can be added
later when LMPG adopts an intentional contact-information model. Shared family
contact values must never be treated as unique without checking collisions.

Matching never guesses among unresolved candidates. Reviewers can:

- link a suggested existing person;
- choose another existing person;
- create a new person when permitted;
- skip the external person; or
- mark a recurring suggestion as declined where the provider workflow supports
  that state.

The same rules apply during onboarding, later manual imports, and authority
reconciliation.

## Plan Generation

The diff engine is pure: given normalized external data, local data, batches,
and church settings, it returns a deterministic plan without writing data.

Plan buckets include:

- `linkPeople`
- `linkFamilies`
- `addPeople`
- `addFamilies`
- `updateManagedFields`
- `promoteToRegular`
- `demoteToLocalVisitor`
- `archive`
- `reactivate`
- `moveFamily`
- `renameFamily`
- `addToGathering`
- `removeFromGathering`
- `ambiguousPeople`
- `familyConflicts`
- `unmatchedLocalRegulars`
- `skipped`

Every destructive action carries a reason suitable for the UI and audit log.
The plan includes stable action identifiers so review decisions can be applied
to the exact fetched snapshot.

Before apply, LMPG verifies that the plan has not expired and that relevant
local rows have not changed since it was generated. If either side is stale, it
regenerates the plan rather than applying old decisions.

## Apply Behaviour

All accepted changes are applied within the church database context and inside
a transaction. A critical failure rolls back the run. Optional gathering
changes may be reported separately only if the plan explicitly treats them as
non-critical; person/family linking and creation must never partially commit.

### User-triggered operations

- Onboarding import always requires review.
- Manual import always requires review.
- `Review & sync` always fetches fresh data and requires review.
- `Run now` may apply deterministic, non-destructive linked updates, but it may
  not silently apply ambiguous links, unmatched-local archives, family
  conflicts, hard-absence archives, or other destructive decisions.

### Scheduled authoritative operations

Scheduled runs may automatically apply deterministic changes to already-linked
records and unambiguous eligible additions. Ambiguous matches and blocked or
destructive first-time decisions are held for review and surfaced to church
administrators.

The initial authority reconciliation must be reviewed. It establishes the
baseline for handling unmatched local regulars. Subsequent automatic archival
is allowed only when the local record is durably linked and the upstream
lifecycle state or confirmed eligibility transition is unambiguous.

### Missing and deleted Elvanto records

A missing record in an incremental response means nothing. A missing record in
a partial or failed full response also means nothing.

A linked Elvanto record may be proposed for archive due to disappearance only
after two consecutive successful full reconciliations confirm absence. The
counter resets whenever the record is seen. LMPG archives rather than deletes.

## Onboarding Experience

Elvanto is available as an optional people-import source during onboarding:

1. The administrator pastes an API key.
2. LMPG validates and securely stores it at church level.
3. LMPG loads available Elvanto metadata.
4. The administrator chooses filters or starts with all Active people plus
   Contacts (the default).
5. The administrator optionally maps Elvanto groups to LMPG gatherings.
6. LMPG builds a matching/import plan.
7. The administrator resolves ambiguities and reviews changes.
8. LMPG applies the import.
9. The administrator may then nominate Elvanto as source of truth; doing so
   requires the reviewed authority reconciliation described above.

Skipping Elvanto never blocks onboarding. A failed connection can be retried or
left for Settings later.

## Settings and Review UI

### Integration overview

PCO and Elvanto appear as independent connection cards. Connection status and
authority status are distinct. Elvanto shows API-key connection health, last
validation, last sync, pending reviews, and batch count.

### Elvanto panel

The panel provides:

- connect/replace/disconnect API key;
- metadata refresh;
- batch list and editor;
- qualifying-population preview split by Elvanto state;
- `Review & sync`;
- constrained `Run now`;
- recent sanitized sync results; and
- pending-review notices.

The API key is never displayed after save. Replacing it requires entering a new
key and validating it before the old credential is discarded.

### Filter editor

The editor renders only metadata actually available from the account. It
supports status, category, groups, demographics, departments, service types,
locations, and custom fields. Group selection includes visible `any`/`all`
semantics. Each batch may select a gathering and auto-remove option.

### Source-of-truth control

A separate control offers:

- None
- Planning Center
- Elvanto

Before switching, the UI explains:

- how many LMPG people already have links;
- how many records will become locked;
- that only one authority can operate;
- which fields/lifecycle actions the provider will own; and
- that the first reconciliation requires review.

Managed badges and lock messages use the generic authority service and display
the actual provider name.

## Security and Isolation

- All connection, link, batch, plan, apply, and audit operations require admin
  role and church context.
- All unique constraints and queries include `church_id`.
- Background work uses `Database.queryForChurch` or
  `Database.setChurchContext`.
- Provider IDs received from clients are revalidated against server-fetched
  provider data before apply.
- API keys are encrypted at rest, write-only through HTTP, redacted from logs,
  and omitted from exports.
- Debug endpoints must never return raw Elvanto payloads in production and the
  current debug-dump endpoint must be removed or development-gated.
- Review tokens/action IDs are church-scoped, short-lived, and bound to the
  fetched snapshot.
- WebSocket or notification events, if added, are church-room scoped.

## Error Handling and Observability

Failures are classified as:

- authentication/credential;
- provider availability;
- rate/usage limit;
- malformed provider response;
- stale metadata/filter;
- ambiguous matching;
- local concurrency/stale plan;
- database/apply; or
- authorization/isolation.

Authentication and provider failures abort mutation. Partial pagination aborts
mutation. Ambiguity is a review state, not a run failure. Logs contain provider,
church ID, run ID, endpoint category, status, and sanitized counts, never
credentials or full people payloads.

The admin UI shows actionable summaries while preserving detailed sanitized
diagnostics for operators.

## Migration Strategy

This is an additive migration:

1. Add provider-neutral tables and generic gathering provenance.
2. Backfill PCO person/family links from existing PCO ID columns.
3. Backfill PCO batches and gathering provenance.
4. Wrap current PCO services behind the provider-neutral contracts.
5. Dual-read or dual-write PCO link/batch state during a compatibility window.
6. Move PCO lock checks to the generic authority service while retaining exact
   current PCO behaviour.
7. Move the current user-owned Elvanto API key into encrypted church-level
   connection storage after successful validation.
8. Build the new Elvanto adapter, matcher integration, plans, and UI.
9. Route legacy Elvanto import entry points to the new reviewed pipeline.
10. Remove dual-write paths only after migration and regression tests pass.

Legacy columns and tables are not dropped in this project. Cleanup is a later,
separately reviewed migration.

If multiple users in one church currently hold different Elvanto API keys, the
migration does not guess. An administrator must choose/reconnect the church-level
credential.

## Testing Strategy

### Unit tests

- Provider adapter normalization, including single-object/list variants.
- Elvanto state projection and child derivation.
- Filter schemas and combinations.
- `any`/`all` group evaluation.
- Provider-neutral matching and ambiguity.
- Combined-population union across overlapping batches.
- Pure diff buckets and reason codes.
- Provider-aware authority locks and messages.
- Missing-record confirmation counter.
- Credential encryption/redaction helpers.

### Database integration tests

- Church-scoped link uniqueness for both providers.
- One individual linked to both providers.
- Transactional plan apply and rollback.
- Family create/link/move/rename behaviour.
- Active/Contact/Archived/Deceased transitions.
- People-type alignment on and off.
- Gathering provenance and safe auto-removal.
- Authority switch pending/commit/cancel behaviour.
- Non-authoritative writes blocked on authority-managed records.
- Background execution under explicit church context.
- Legacy PCO and Elvanto migration/backfill.

### Route and UI tests

- API-key connect, replace, invalid key, and disconnect.
- Secret never returned or logged.
- Onboarding import and retry/skip.
- Manual reviewed import.
- Review expiration and regeneration.
- Batch editor metadata and stale-filter handling.
- Source-of-truth switching and confirmation copy.
- Managed badges and provider-specific lock messages.
- Persistent review-required notices.

### Regression tests

All existing PCO matching, plan/apply, batch, background-check, gathering,
source-of-truth lock, and scheduling tests must remain green before the generic
authority service becomes canonical.

## Acceptance Criteria

- A church can connect both PCO and Elvanto concurrently.
- Only one provider can be authoritative.
- Selecting Elvanto as authority produces the same strict managed-record locks
  as PCO, with Elvanto-specific messages.
- Elvanto onboarding and later imports both use matching and review.
- Elvanto person and family IDs persist after import.
- Re-importing linked people proposes updates rather than duplicates.
- Elvanto Contacts are included by default as local visitors and can be
  excluded church-wide.
- People-type alignment defaults on and can be disabled church-wide.
- Elvanto batches filter by account metadata, including groups with any/all
  logic.
- Batches can maintain gathering rosters without removing manual assignments.
- Scheduled authoritative sync safely updates, archives, and reactivates linked
  people.
- Missing upstream records cannot cause archive until two successful full
  reconciliations confirm absence.
- Elvanto credentials are encrypted at church level and never exposed after
  submission.
- PCO behaviour remains unchanged throughout the compatibility migration.

## API Capability References

The design relies on Elvanto's documented support for API-key authentication,
stable person/family identifiers, person states, `date_modified` searching,
family fields, groups, categories, optional people fields, and custom-field
definitions:

- [Getting Started and authentication](https://www.elvanto.com/api/getting-started/)
- [People fields](https://www.elvanto.com/api/people-fields/)
- [People search and modification timestamps](https://www.elvanto.com/api/people/search/)
- [Groups](https://www.elvanto.com/api/groups/getAll/)
- [People categories](https://www.elvanto.com/api/people/categories/getAll/)
- [Custom-field definitions](https://www.elvanto.com/api/people/customFields/getAll/)
