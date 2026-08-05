# Streamlined People Sync Controls

**Date:** 2026-08-05

## Problem

The integration UI currently asks an administrator to understand three overlapping controls: Planning Center automatic sync, sync batches, and a separate authoritative “source of truth” mode. Selecting batches already expresses the intent to manage people from an external provider, so the extra authority decision makes setup feel longer and less clear. Authority also currently controls whether provider-managed people can be edited locally, although those are separate policy choices.

## Goals

- Present one integration-level control for starting or pausing people sync without disconnecting the provider.
- Treat creating and approving sync batches as intent to use that provider as the authoritative people source.
- Preserve review before the first batch changes local people.
- Separate sync activity from the policy that restricts local People-page editing.
- Preserve the invariant that only one external provider can be authoritative at a time.

## User Experience

### People sync master control

Each connected provider displays a **People sync** master switch beside its Disconnect action.

- Creating the first enabled batch takes the administrator directly to the existing combined review.
- Applying that review makes the provider authoritative and turns People sync on. There is no separate “Use as source of truth” control or setup step.
- Until a first batch has been approved, the UI explains that People sync will start automatically when that review is applied; the administrator does not have to enable another setting.
- Turning People sync off pauses unattended and manual batch execution while retaining the provider connection, batches, schedules, external links, and authoritative-provider selection.
- Turning it back on resumes the existing configuration without another authority review.
- Enabling a provider while another provider is authoritative starts the existing reviewed provider-switch flow. Applying that review atomically changes the authoritative provider and leaves People sync on.
- Disconnecting the authoritative provider requires an explicit confirmation that it will stop people management. The confirmed disconnect clears that provider as authority and removes its credentials while retaining local people and external-link identifiers. If the administrator wants to preserve active people management, they must switch to the other provider first.

The existing Planning Center **Enable Planning Center sync** control is removed from the UI. Its scheduling-only meaning is absorbed by the new People sync master control. Batch-level enabled and schedule settings remain because they select which population syncs and when.

### Local editing policy

The active integration displays a separate **Lock People page editing** switch.

- It defaults on for new churches.
- Existing churches migrate with it on, preserving current behavior.
- When on, the current provider-managed restrictions remain: provider-managed identity fields and lifecycle actions are blocked, and regular-person creation follows the existing authoritative-sync restriction.
- When off, those local actions are permitted even though the provider remains authoritative and sync remains active or paused.
- The UI warns that a later sync can overwrite provider-managed local changes.

Pausing People sync does not implicitly unlock People-page editing. Changing either policy never changes the other.

## State and Backend Behavior

The backend retains `people_sync_settings.authority_provider` as the single authoritative-provider invariant. This remains an internal state concept and is no longer presented as a routine setup choice.

Add two provider-neutral settings to `people_sync_settings`:

- `sync_enabled`, default `1`, controls whether batches belonging to the authoritative provider may run.
- `people_editing_locked`, default `1`, controls whether the existing People-page/server mutation restrictions apply.

All manual, scheduled, and unattended batch entry points must require both:

1. the batch provider matches `authority_provider`; and
2. `sync_enabled = 1`.

The first-batch combined review continues to establish `authority_provider`. A provider-switch review changes `authority_provider` and sets `sync_enabled = 1`. Pausing changes only `sync_enabled`. The editing lock is checked independently of `sync_enabled` wherever the server currently enforces authority-managed mutation restrictions.

The legacy `church_settings.planning_center_sync_enabled` column remains for additive-migration compatibility but stops driving current UI or scheduler behavior. During migration, an existing authoritative Planning Center church that had this setting off is migrated with `people_sync_settings.sync_enabled = 0`; all other existing churches default to enabled. This avoids unexpectedly resuming a deliberately paused schedule.

API responses expose both provider-neutral booleans with the people-sync settings. Mutations remain admin-only and church-scoped.

## Client Behavior

- Replace `PeopleSourceControl`’s source-of-truth language and disable-authority interaction with the People sync master interaction.
- Move the compact master control into each provider’s connection header beside Disconnect.
- Remove the separate Planning Center scheduling master section.
- After a new batch is saved:
  - if its provider is already authoritative, open the ordinary batch review;
  - if no provider is authoritative, open the combined first-batch review;
  - if another provider is authoritative, open the reviewed switch flow instead of leaving a prepared batch with “switch source of truth” instructions.
- Add the editing-lock control and warning near the master control for the active provider.
- People-page permission helpers receive the editing-lock setting and stop locking mutations when it is off. Link-status filters and provider relationship information remain available regardless of the lock.

## Failure Handling

- Failed switch mutations roll the displayed toggle back to confirmed server state.
- If people-sync settings cannot be loaded, master and editing-lock mutations are disabled and a retry is shown.
- A failed provider review leaves the prior authoritative provider and sync state unchanged.
- A failed disconnect leaves both the connection and authoritative-provider state unchanged; clearing authority and removing credentials are one transaction from the user's perspective.
- A paused batch execution fails closed with a stable conflict code and does not fetch provider data or create a run.

## Testing

Focused automated coverage will verify:

- schema defaults and migration from the legacy Planning Center scheduling switch;
- manual and unattended execution reject paused sync before provider access or run creation;
- first-batch review activates the provider without a separate authority-control step;
- creating a batch for the other provider enters the reviewed switch flow;
- pausing and resuming retains authority, batches, and links;
- editing remains locked by default for new and migrated churches;
- editing can be enabled without disabling authority or sync;
- pausing sync does not unlock editing;
- the Planning Center and Elvanto panels show the unified control and no longer show source-of-truth or duplicate automatic-sync controls.

## Out of Scope

- Allowing multiple authoritative providers simultaneously.
- Removing the reviewed reconciliation required before first apply or provider switching.
- Changing batch filters, schedules, matching rules, or provider-owned source semantics.
- Removing legacy database columns in a destructive migration.
