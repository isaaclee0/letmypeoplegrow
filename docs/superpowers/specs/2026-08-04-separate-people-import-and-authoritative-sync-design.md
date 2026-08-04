# Separate One-Time People Import from Authoritative Sync

**Status:** Approved design, pending written-spec review
**Date:** 2026-08-04

## Summary

Let My People Grow currently presents one-time people import and ongoing
provider synchronization through the same sync-batch workflow. That makes a
new administrator review substantially the same provider roster once when the
first batch source is promoted and again when the provider becomes the source
of truth.

The product will separate those concepts:

- **Import people** is an additive, reviewed People-page operation. It may be
  run more than once, creates no batch, and never grants a provider authority.
- **Sync batches** are ongoing population rules for the provider that is, or
  is being prepared to become, the church's authoritative people source.
- Creating the first authoritative batch uses one combined review. Applying
  it promotes the batch source, reconciles the people population, and enables
  authority atomically.

Both Planning Center and Elvanto may remain connected. Changing authority does
not disconnect either provider or delete provider links.

## Goals

- Give one-time import and ongoing authoritative synchronization distinct
  product language, navigation, APIs, policies, and audit intent.
- Put one-time provider import beside the other ways administrators add people.
- Retain provider person and household IDs after import so later imports and a
  future authoritative sync can avoid duplicates.
- Remove the duplicate first-batch review without allowing unreviewed authority
  or lifecycle changes.
- Make a sync batch runnable only when its provider is authoritative.
- Preserve church isolation, complete provider reads, signed reviews, stale
  plan rejection, and transactional apply.
- Keep both provider connections and their dormant links when authority changes.

## Non-goals

- Writing people, households, Lists, Categories, or Groups back to a provider.
- Disconnecting the previous provider when authority changes.
- Automatically treating a one-time import source as an ongoing sync source.
- Adding gathering membership, attendance history, or scheduling to one-time
  import.
- Letting a one-time import bypass fields or population rules owned by an
  existing authority.
- Replacing CSV import or manual person creation.

## Product terminology and invariants

### One-time import

A one-time import is a reviewed way to add people. It is not a sync batch and
is not presented under Settings as an ongoing integration feature.

An import:

- is launched from the People page;
- requires a connected provider;
- selects one Planning Center List, one Elvanto Category or Group, or the
  provider's complete importable population;
- reads a complete, paginated snapshot;
- creates new people and new households;
- links provider identities to new or existing LMPG people;
- retains those links in a dormant, non-authoritative state;
- creates no `people_sync_batches` row;
- performs no scheduled or unattended work; and
- remains available when the church already contains people.

Provider links are dormant by behavior, not duplicated into a separate link
model. The existing provider-neutral links remain the durable identity record.
Authority determines whether those links confer management or editing locks.

### Sync batch

A sync batch is an ongoing rule that says a provider-owned source defines part
of the authoritative people population.

A batch:

- belongs to exactly one provider;
- has exactly one reviewed provider-owned source;
- is operational only while that provider is authoritative;
- may retain its desired enabled and scheduling configuration while inactive;
- participates in the provider-wide authoritative population; and
- may perform reviewed or scheduled lifecycle and managed-field reconciliation.

The backend will derive an operational state rather than treating `enabled`
alone as proof that a batch may run:

- `active`: configured as enabled and its provider is authoritative;
- `prepared`: configured as enabled but its provider is not authoritative;
- `disabled`: configured as disabled; or
- `source_review_required`: its initial or replacement source draft must be
  reviewed before it can become active.

The scheduler and unattended orchestrator must require `active`. A prepared
batch must never fetch provider data or create a scheduled run.

### Authority

At most one provider is authoritative for a church. The authoritative provider:

- manages linked identity, child state, people type, family membership, and
  provider lifecycle state;
- may lock its linked people and families against conflicting local changes;
- owns the union of its active batch populations; and
- may perform unattended reconciliation according to batch schedules.

The other provider may remain connected, retain dormant links, and support
one-time imports. Its prepared batches cannot run.

## User experience

### People page: Import people

The People page gains **Import people**, alongside manual creation and CSV
import. The reviewed flow is:

1. Choose Planning Center or Elvanto.
2. Choose a population:
   - one Planning Center List;
   - one Elvanto Category or Group; or
   - everyone importable from that provider.
3. Fetch the complete provider snapshot.
4. Review new people, new households, existing matches, ambiguous matches,
   already-linked identities, and authority restrictions.
5. Resolve every required identity decision and apply once.

The "everyone" option follows the provider adapter's existing normalization
and population gates. For Elvanto, the existing contact-inclusion setting is
shown in the review so the administrator can see whether Contacts participate.
No provider-owned source is persisted merely because it was used to scope an
import.

If a provider is disconnected, its option is unavailable and links to its
connection setup in Settings. Credentials are not collected in the import
review.

### Import behavior with no authority

When the church has no authoritative provider, selected unmatched people may
be created as regulars. The review remains additive:

- matched existing people may receive a dormant provider link;
- existing established links are preserved rather than silently reassigned;
- existing names, people types, archive states, family memberships, and
  gathering memberships are not changed;
- newly imported members of the same provider household share a newly created
  LMPG family when that household has no durable family link;
- when the household already has one unambiguous durable family link, a new
  person may be created into that family without moving any existing person;
  and
- matched existing people retain their existing local family placement.

### Import behavior with an authority

When any provider is authoritative, a one-time import cannot create a regular
outside the authoritative batch population. This rule applies even when the
import uses the authoritative provider but selects a person outside its active
batch sources.

The import may:

- link a selected external identity to an existing permissible LMPG person;
- report an already-existing dormant or authoritative link; and
- create an unmatched selected person as a local visitor.

The review explicitly labels the forced visitor outcome and explains that an
administrator should add or change an authoritative sync batch if the person
should be a provider-managed regular. A non-authoritative import may not
overwrite authority-owned fields or reassign an established provider link.

### Settings: first authoritative sync batch

When no authority exists, creating the first sync batch for a provider does
not send the administrator through a normal batch review followed by a second
authority review. Instead:

1. The administrator selects the source and batch settings.
2. LMPG displays a confirmation explaining that:
   - linked people and families will become provider-managed;
   - conflicting local edit, archive, merge, and delete operations will be
     restricted;
   - schedules may update the population after activation;
   - only one provider can be authoritative; and
   - the other provider, if connected, will remain connected.
3. LMPG builds one authoritative review using the proposed source draft.
4. Applying the review atomically:
   - promotes the source draft;
   - applies the reviewed people and household reconciliation;
   - activates the provider as authority; and
   - makes the batch operational according to its saved enabled and schedule
     settings.

Nothing becomes authoritative or runnable before that apply commits.

### Additional batches for the active authority

Creating or changing a batch for the active authority uses one normal reviewed
batch flow. The review evaluates the provider-wide union using the target
batch's draft source and every other batch's active source. Successful apply
promotes only the reviewed draft and applies the resulting authoritative plan.

### Preparing and switching authority

If another provider is already authoritative, creating batches for the target
provider is presented as **Prepare switch to Planning Center** or **Prepare
switch to Elvanto**. Prepared batches retain their source drafts and settings
but cannot run.

**Switch source of truth** creates one provider-wide review using all enabled
target-provider active sources and reviewable initial drafts. Applying it in
one transaction:

- promotes every source draft covered by the signed review;
- applies the target provider's reviewed authoritative reconciliation;
- changes the church authority to the target provider;
- makes target-provider enabled batches operational;
- makes the previous provider's batches operationally inactive without
  deleting them or their desired settings; and
- preserves both provider connections, links, history, and credentials.

Disabling authority changes the current provider's enabled batches from
operationally active to prepared. Re-enabling or switching back requires a
fresh authority review because provider and local data may have changed.

## Backend design

### Dedicated import policy

One-time import receives its own provider-neutral orchestration entry points
and plan policy rather than pretending to be a non-authoritative sync batch.
It may reuse complete provider acquisition, normalization, matching, household
projection, review-directory, signed-token, and audit helpers.

The import plan has a deliberately narrow action contract:

- `addPeople`;
- additive creation of families for newly created household members, plus
  initial placement of a new person into an unambiguously linked family; and
- `linkPeople` for identities that do not already have an established link.

It must not emit:

- managed-field updates;
- archive or reactivate actions;
- regular/visitor promotion or demotion of existing people;
- existing-family renames or moves of an existing person between families;
- gathering additions or removals;
- presence-counter changes; or
- source promotion.

The policy chooses `regular` for an unmatched addition only when authority is
`none`; otherwise it chooses `local_visitor` and records the authority reason
in the review action.

Import preview and apply are church-scoped admin operations. Their signed token
binds:

- operation kind `people_import`;
- church and provider;
- selected source kind and external ID, or the explicit `all` selection;
- connection generation;
- authority stance;
- complete snapshot identity or digest;
- local identity/link inputs that affect matching;
- the resulting plan digest; and
- expiry and token lineage for corrected match previews.

Apply re-fetches the complete provider state, recomputes the plan, validates all
required selections, rejects stale tokens, and consumes a token at most once.
Import runs use the existing `people_sync_runs` audit infrastructure with
`batch_id = NULL` and the distinct `people_import` trigger, but never create a
batch as a side effect.

### Combined authority review

The provider-neutral authority workflow will support proposed source drafts
directly. It must no longer require an initial batch-specific apply merely to
make sources visible to the authority preview.

The combined authority review receives the exact participating batch set and
uses each batch's reviewed candidate:

- its draft source when the review explicitly covers that draft; or
- its active source otherwise.

The signed review binds:

- church and provider;
- active and pending authority, including the exact preview intent;
- every participating batch ID;
- active-source and draft-source digests and revisions;
- which drafts will be promoted;
- connection generation;
- complete provider snapshot and source provenance;
- local identity, family, link, and lifecycle inputs;
- administrator identity and lifecycle selections; and
- the authoritative plan digest.

Apply re-acquires fresh state and verifies the complete token contract. One
church-scoped transaction performs all people/family/link changes, all covered
source promotions, authority activation, and consumed-token recording. A
failure rolls back every part.

### Operational batch state

Runnable state must be computed in one shared backend helper and used by batch
responses, the scheduler, unattended orchestration, and manual run controls.
No caller may infer run permission from `enabled` alone.

Manual **Review & sync** is available for active authoritative batches.
Prepared batches are reviewed only as part of the authority-switch workflow;
they cannot use a standalone apply path that would recreate a
non-authoritative sync operation.

## Error handling and concurrency

All provider reads fail closed. An unavailable source, incomplete pagination,
rate-limit exhaustion, malformed response, invalid credential, or connection
generation change produces no import, source promotion, authority change, or
lifecycle mutation.

Both import and sync apply reject with a refresh-required result when any
signed assumption changes, including:

- provider snapshot or source membership;
- local people, families, or established links used by matching;
- source draft identity or revision;
- participating batch set or enabled state;
- active or pending authority;
- connection generation; or
- a previously consumed or expired review token.

Ambiguous identity decisions are held until explicitly resolved. A one-time
import never offers established-link correction that would move an identity
from one existing person to another; that remains a separately reviewed link
management operation.

Post-commit audit or refresh failures must report that the mutation succeeded
and offer a status refresh. They must not invite a blind reapply.

## Existing-data transition

Existing batch, source, schedule, run, and link rows are retained. Operational
state is derived from the current authority:

- enabled batches for the active authority become `active`;
- enabled batches for another provider become `prepared`;
- enabled batches while authority is `none` become `prepared`; and
- disabled batches remain `disabled`.

This transition requires no schema migration, automatic source deletion, or
provider disconnect. Operational state is always derived and is not cached in
the database.

Existing provider links remain usable for import duplicate prevention and
future reconciliation. Existing audit history is not relabelled as import
history because the old intent cannot be inferred safely.

## UI and API boundaries

- The People page owns one-time import entry, source selection, review, and
  completion feedback.
- Integration panels own connection status, authority, prepared/active batch
  configuration, scheduling, and provider switching.
- Shared review primitives render both workflows, but receive an explicit
  operation kind and only expose actions allowed by that operation.
- One-time import uses:
  - `GET /api/people-imports/:provider/sources` for source discovery;
  - `POST /api/people-imports/:provider/preview` for a fresh signed review; and
  - `POST /api/people-imports/:provider/apply` for reviewed apply.
- Sync batches and authority keep their existing integration route family. The
  existing authority preview/apply endpoints are extended to cover every
  enabled prepared batch and its reviewable draft for the target provider.
- An import route cannot accept a batch ID, schedule settings, or an authority
  mutation.
- Existing batch routes reject standalone review/apply for a prepared
  non-authoritative batch and direct the client to the authority-switch flow.

## Verification strategy

### Import service and routes

- A PCO List, Elvanto Category/Group, and each provider's `all` selection read
  every page before planning.
- Incomplete or failed reads discard partial results.
- Import with no authority creates reviewed regulars and new households.
- Import with an authority forces unmatched additions to local visitors.
- Imports never create or update a sync batch.
- Imports never update, archive, reactivate, promote, demote, lock, schedule,
  or change gathering membership.
- Existing provider links prevent duplicate creation.
- An established link cannot be reassigned through import.
- Cross-church provider source, person, review token, and apply attempts fail.
- Changed provider, local, connection, or authority state rejects stale apply
  without partial writes.
- Applied tokens cannot be replayed.

### Authority and batch services

- A first-batch authority preview reads the initial source draft without first
  promoting it.
- One apply atomically promotes the draft, reconciles people, consumes the
  token, and activates authority.
- Any failure rolls back people, source, token, and authority changes.
- Additional active-authority batches use one reviewed promotion.
- Prepared batches cannot run manually or unattended.
- A provider switch reviews all participating target batches, promotes every
  covered initial draft, activates the target, and makes the old provider
  operationally inactive.
- Switching and disabling authority preserve both connections, dormant links,
  batch settings, and history.
- Scheduled work requires derived `active` state before run creation or
  provider fetch.
- Concurrent source edits, batch changes, preview replacement, timeout, and
  authority changes fail stale rather than applying an older intent.

### Client

- People-page import is available with existing rosters and clearly separated
  from sync setup.
- Disconnected providers link to connection setup.
- Source choices are List, Category/Group, or all as appropriate.
- Review language distinguishes regular imports, forced visitors, dormant
  links, and blocked authority-owned changes.
- The first batch for a church with no authority opens one combined review and
  never asks for an immediate second review.
- A provider with another active authority shows prepared/switch language and
  exposes no run control.
- Authority warnings accurately say that the other provider remains connected.
- Refresh-after-commit failures do not expose a second apply action.

## Acceptance criteria

- One-time provider import exists on the People page and creates no sync batch.
- Imported provider identities are retained as dormant links.
- One-time import is additive and cannot perform authoritative lifecycle work.
- Imports remain available with an existing roster and respect an existing
  authority's regular-population ownership.
- Every operational sync batch belongs to the active authoritative provider.
- Prepared non-authoritative batches cannot fetch or run.
- Creating and approving the first authoritative batch requires exactly one
  review.
- That apply atomically promotes the source, applies the reconciliation, and
  activates authority.
- Switching authority uses one target-provider-wide review and preserves both
  connections and all links.
- No stale, partial, cross-church, or replayed operation can partially mutate
  people, sources, batches, or authority.
