# Elvanto Provider-Owned Batch Names Design

**Date:** 2026-07-30

## Objective

Remove independent batch naming from the Elvanto people-sync integration. Every Elvanto batch is backed by exactly one provider-owned Group or Category, so the visible and stored batch name must be derived from that source rather than entered separately.

## Naming Contract

For Elvanto batches, `people_sync_batches.name` remains a required compatibility and display column, but it is read-only to clients. Its value is derived from the trusted Elvanto source name.

- A new batch is named from the server-resolved Group or Category selected by `sourceKind` and `sourceExternalId`.
- A batch with an active source is named from that active source.
- A new batch awaiting its initial source review is named from its required initial source draft because no active source exists yet.
- A replacement source draft does not rename an existing batch while review is pending.
- Reviewed source promotion atomically updates the batch name to the promoted Group or Category name.
- A successful provider refresh that discovers a source rename updates both the stored source name and batch name from the same trusted value.

The source kinds `elvanto_group` and `elvanto_category` follow the same rules.

## Existing Batch Migration

Database initialization idempotently aligns every existing Elvanto batch name with its trusted stored source name. It uses `source_name` when an active source exists. It uses `draft_source_name` only when the batch has no active source, which covers initial-review batches without allowing a pending replacement draft to rename an active batch early.

The migration does not change source identity, source revision, draft state, scheduling, gathering assignment, people type, authority, or connection settings. It requires no destructive schema change.

## API and Repository Boundaries

Elvanto create and update request contracts no longer accept `name`.

On create, the server resolves the submitted source identity through the church's Elvanto connection and supplies that resolved source name as the internal batch name. A client-supplied `name` is rejected as an unknown field rather than silently ignored.

On update, settings remain writable but `name` is rejected. The repository must not expose a normal Elvanto rename path; name changes occur only through trusted create, migration, reviewed promotion, and source-refresh flows. Church-scoped provider lookups remain mandatory throughout.

The response DTO retains `batch.name` so existing displays and audit records remain compatible.

## Frontend Experience

The Elvanto batch editor removes the Batch name field, local name state, and name validation. Selecting a Group or Category establishes the batch name. Create and update payload types omit `name`.

Batch cards continue displaying `batch.name`. Initial-review UI may also show the selected draft source through the existing source controls. Existing gathering-name fields are unrelated and remain editable.

## Error Handling

Malformed or stale create/update requests containing `name` receive HTTP 400 through the existing Elvanto batch-body validation path. Provider lookup, authentication, source-review, and missing-source errors retain their existing behavior.

Failed source resolution, promotion, or refresh must not partially rename a batch. A pending or failed replacement draft leaves the active batch name unchanged.

## Testing

Automated coverage must verify:

- database initialization renames existing active-source Elvanto batches from their source name;
- initialization uses the draft name only for batches without an active source;
- initialization does not let a pending replacement draft rename an active batch;
- repeated initialization is idempotent and preserves unrelated batch configuration;
- create succeeds without `name` and stores the server-resolved Group or Category name;
- create and update reject client-supplied `name`;
- settings updates preserve the derived name;
- saving a replacement source draft leaves the active batch name unchanged;
- reviewed promotion updates the batch name atomically to the promoted source name;
- provider source-name refresh keeps the Elvanto batch and active source names aligned;
- the editor has no Batch name field or validation and submits no name on create or update;
- existing Elvanto batch cards continue displaying the derived name.

## Compatibility and Rollout

Existing custom Elvanto batch names intentionally change to their current Group or Category names on the first database initialization after deployment. No legacy custom-name view is retained. The database column and response field remain for compatibility, but all future Elvanto names are provider-owned.
