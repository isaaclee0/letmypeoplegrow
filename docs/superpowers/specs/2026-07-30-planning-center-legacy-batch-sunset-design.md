# Planning Center Legacy Batch Sunset Design

**Date:** 2026-07-30

## Objective

Retire the pre-List Planning Center batch model while preserving its records long enough for the one affected church to inspect and delete them. Modern Planning Center batches use exactly one provider-owned List, so their visible name is always derived from that List rather than entered separately.

## Scope

This change affects Planning Center people-sync batches only. Elvanto batches, Planning Center credentials, the church's people-source authority setting, the Planning Center scheduling master switch, linked people, attendance, and existing gathering membership are not changed.

## Batch Classification

A Planning Center batch is legacy when `people_sync_batches.legacy_provider_batch_id` is non-null. This is the authoritative classification; names, creation dates, filter contents, and source presence are not used as heuristics.

A Planning Center batch with `legacy_provider_batch_id IS NULL` is modern. Modern batches have exactly one Planning Center List represented by their active source or, during initial setup, their required source draft.

## Legacy Batch Retirement

Database initialization must idempotently set `enabled = 0` and `schedule_enabled = 0` for every legacy Planning Center batch. When an old `planning_center_sync_batches` row is first backfilled into `people_sync_batches`, the new canonical row must be created disabled with scheduling off, regardless of the historical schedule values.

Disabling at the database layer prevents scheduled discovery from selecting legacy rows. Server-side guards provide defense in depth for direct calls and stale clients. All legacy batch operations other than list/read and delete must fail with HTTP 409 and code `PCO_LEGACY_BATCH_RETIRED`. Guarded operations include:

- settings updates;
- source draft creation, replacement, discard, and promotion;
- review-plan creation or refresh;
- reviewed apply;
- unattended or manual orchestration entry points.

These guards must be enforced server-side and must not rely on the current frontend hiding controls.

Planning Center remains the church's authoritative people source if it was already configured that way. The migration does not change authority, connection, or master scheduling settings; the affected administrator will adjust authority manually after deployment.

## Legacy Batch Deletion

Deleting a legacy batch permanently removes both:

1. the canonical `people_sync_batches` row; and
2. the linked `planning_center_sync_batches` row identified by the same church and `legacy_provider_batch_id`.

The two deletes occur in one church-scoped transaction. The implementation resolves and validates both identifiers before mutation so another church's row cannot be targeted. Deletion does not remove or unlink imported individuals or families, attendance, external identity links, or gathering memberships. Existing foreign keys continue setting batch-attribution columns to null where applicable.

Deleting both rows is required to prevent database initialization from backfilling the legacy batch again on a later startup.

## Modern Batch Naming

Modern batch create requests no longer accept `name`. The server resolves `sourceKind = planning_center_list` and `sourceExternalId` through the church's Planning Center connection, then uses the resolved provider-owned List name for:

- the required internal `people_sync_batches.name` value; and
- the source draft name returned to the client.

The server rejects a client-supplied `name` as an unknown field. This prevents stale or malicious clients from restoring independent naming.

Modern settings updates also omit `name`; it becomes read-only compatibility data in the DTO. Existing database and API consumers can continue reading `batch.name`.

When a modern batch receives a different List as a source draft, its displayed name remains the active List name while review is pending. The pending List name is shown separately by the existing source controls. Reviewed promotion atomically copies the draft source into the active source and updates `people_sync_batches.name` to the promoted List's trusted name. For a new batch awaiting its initial review, the UI uses the required draft List name because no active source exists yet.

Provider List renames discovered during ordinary reads should refresh the stored source display name through the existing source-health/name refresh path. The batch's derived name must be updated from that same trusted provider value so the two cannot drift.

## Frontend Experience

The modern Planning Center batch editor removes the Batch name field and its validation. Selecting a Planning Center List is sufficient to establish the batch name. Create and update payload types no longer expose `name`.

The main Planning Center integration panel renders modern and legacy batches separately:

- **Sync batches:** modern List-based batches with the existing Edit, Review & sync, source-review, scheduling, and Delete actions.
- **Retired legacy batches:** read-only historical cards labeled as retired. Each card shows its old custom name, prior configuration that is still useful for recognition, and last-run information. Edit, Review & sync, source-draft, and scheduling actions are absent.

Deleting a legacy card requires confirmation. The confirmation states that the old batch records will be permanently removed while imported people and gathering assignments remain. Modern deletion behavior is unchanged.

If a stale page attempts a retired operation and receives `PCO_LEGACY_BATCH_RETIRED`, it shows a specific message directing the administrator to reload and either inspect or delete the legacy batch.

## Error Handling

Legacy guards return a stable response:

```json
{
  "error": "This legacy Planning Center batch is retired and can only be viewed or deleted.",
  "code": "PCO_LEGACY_BATCH_RETIRED"
}
```

Deletion failures roll back both record deletions. Existing source-unavailable and authentication handling remains unchanged for modern List-based batches.

## Testing

Automated coverage must include:

- backfill creates legacy canonical rows with `enabled = 0` and `schedule_enabled = 0`;
- initialization disables already-backfilled legacy rows idempotently;
- scheduler selection excludes legacy rows;
- settings, source-draft, plan, apply, and orchestration paths reject legacy batches with the stable 409 error;
- deleting a legacy batch removes both church-scoped records in one transaction;
- legacy deletion leaves people, identity links, attendance, and gathering membership intact;
- a deleted legacy batch is not recreated on later initialization;
- modern create succeeds without `name` and stores the resolved List name;
- client-supplied names are rejected on modern create and update;
- source promotion updates the modern batch name atomically to the promoted List name;
- provider List-name refresh keeps modern batch and source display names aligned;
- the editor has no Batch name field and submits the selected List identity;
- the integration panel separates modern and retired legacy cards and exposes only Delete for legacy cards;
- legacy deletion confirmation accurately describes retained data.

## Compatibility and Rollout

The existing non-null database `name` column and response field remain in place, avoiding a destructive schema migration. Only request contracts change: modern Planning Center batch names become server-derived and read-only. Legacy rows remain visible immediately after deployment but cannot run. No automatic authority change occurs.
