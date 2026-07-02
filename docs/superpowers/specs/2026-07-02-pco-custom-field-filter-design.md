# Planning Center Custom Field Sync Filter

## Problem

The Planning Center sync currently gates which PCO people get imported using a single
built-in attribute: `membership`, via a per-church allow-list
(`church_settings.planning_center_membership_allowlist`, edited through
`MembershipAllowlistEditor`). Some churches organize eligibility using PCO's **Custom
Tabs** feature instead — admin-defined fields (dropdown/checkbox) grouped into tabs on
a person's profile — and have no way to filter sync eligibility by those fields.

## Goal

Let a church filter PCO people by membership category (existing behavior) **and/or**
by one or more custom-tab field values (new) — as two independently toggleable
eligibility sources that get unioned (OR'd) together. This supports cases like: sync
most people via membership category, plus a specific set of people (e.g. attendees of
one gathering) identified only by a custom-tab field, who may not carry an allow-listed
membership value at all.

## PCO API surface used

Confirmed live (each of these returns 401 unauthenticated, not 404, confirming they
exist):

- `Tab` — `/people/v2/tabs` — a custom tab (`name`, `sequence`)
- `FieldDefinition` — `/people/v2/field_definitions` — one custom field: `name`,
  `data_type` (`select`, `checkbox`, `text`, `date`, `file`, ...), `sequence`,
  relationship to `tab`. `select`-type fields have `FieldOption` children.
- `FieldDatum` — a person's value for one field. Included via
  `people/v2/people?include=field_data`; each `FieldDatum` has `attributes.value` and a
  `relationships.field_definition` pointing at the `FieldDefinition` id.

This app already fetches the full PCO people list client-side and filters in-app (see
`membership_allowlist`), so no PCO-side query filtering is needed — the same
fetch-then-filter approach extends to custom fields.

## Data model

New columns on `church_settings` (`server/config/schema.js`), alongside the existing
`planning_center_membership_allowlist`:

- `planning_center_membership_filter_enabled` — `INTEGER DEFAULT 1` (defaults on so
  existing churches keep today's behavior unchanged after migration)
- `planning_center_field_filter_enabled` — `INTEGER DEFAULT 0`
- `planning_center_field_filters` — `TEXT` (JSON array), shape:
  ```json
  [
    { "fieldDefinitionId": "123", "tabName": "Groups", "fieldName": "Connect Status", "values": ["Connected", "New"] }
  ]
  ```

The old `planning_center_filter_mode` concept from the first draft is dropped — there
is no single mode. Each source has its own enable flag and config, and both can be on
at once.

### Eligibility semantics

A person is eligible iff **at least one enabled source** matches (OR across sources):

- Membership source (if `membershipFilterEnabled`): eligible iff
  `membershipAllowlist.includes(person.membership)`. Unchanged from original behavior.
- Custom-field source (if `fieldFilterEnabled`): eligible iff **every** configured rule
  matches (AND across rules within this source) —
  `rule.values.includes(personValueForField)` for each rule. If `fieldFilters` is
  empty, this source contributes no one (doesn't error, just matches nobody — same
  "empty config means nothing from this source" convention as the membership
  allow-list).
- If neither source is enabled, nobody is eligible (safe default — mirrors turning
  `planning_center_sync_enabled` off).
- Missing/`null` field value is normalized to the sentinel `'(none)'` on both the
  tally/summary side and the eligibility-check side, so checking "(none)" in the UI
  actually works. (Note: the existing membership path has this same bug today —
  checking "(none)" silently matches nothing, because `tallyMembership`'s `'(none)'`
  display sentinel is never reconciled with the raw `null` compared in
  `diffEngine.js`. Out of scope for this change — not touched.)

## Fetch & projection changes

- `services/planningCenterSync.js` `fetchAllPcoPeople`: add `field_data` to the
  people-list `include=` param (alongside `households`). Runs unconditionally
  regardless of which sources are enabled, keeping the cached PCO-people snapshot
  independent of filter config so toggling a source doesn't require a fresh fetch.
- `services/planningCenter/projection.js` `projectPerson`: gains a
  `fieldValues: { [fieldDefinitionId]: string }` map. Caller builds a per-page
  `included`-by-id lookup (id -> `FieldDatum`) and passes it in; `projectPerson`
  resolves each id in `person.relationships.field_data.data` against that lookup,
  reading `attributes.value` and `relationships.field_definition.data.id`.
- New `services/planningCenter/fieldDefinitions.js`: fetches `/people/v2/tabs` and
  `/people/v2/field_definitions` (paginated), joins field definitions to their tab
  name, filters to `data_type` of `select` or `checkbox` only (bounded value sets —
  matches the "Dropdown & checkbox only" UX decision), returns
  `[{ id, name, tabName, dataType, sequence }]`. This is metadata, not per-person data
  — fetched fresh on demand, not part of the PCO-people cache.

## Eligibility logic

New `services/planningCenter/eligibility.js`:

```js
function isEligible(person, filterConfig) {
  if (filterConfig.membershipFilterEnabled) {
    const allow = new Set(filterConfig.membershipAllowlist || []);
    if (allow.has(person.membership)) return true;
  }
  if (filterConfig.fieldFilterEnabled) {
    const rules = filterConfig.fieldFilters || [];
    if (rules.length) {
      const matches = rules.every(r => {
        const val = (person.fieldValues && person.fieldValues[r.fieldDefinitionId]) ?? '(none)';
        return r.values.includes(val);
      });
      if (matches) return true;
    }
  }
  return false;
}

module.exports = { isEligible };
```

`services/planningCenter/diffEngine.js` `computePlan`: replace the `allowlist:
string[]` param with `filterConfig: { membershipFilterEnabled, membershipAllowlist,
fieldFilterEnabled, fieldFilters }`. The two existing `allow.has(p.membership)` call
sites (reactivate check, add check) become `isEligible(p, filterConfig)`.

`services/planningCenterSync.js` (around the existing allow-list load at line ~199):
load all four settings columns, build the `filterConfig` object, pass it to
`computePlan` in place of the bare `allowlist` array.

## API endpoints (`routes/integrations.js`)

Internal API, no external consumers — clean rename rather than versioning:

- `GET /planning-center/sync-filter` (was `/membership-filter`) — returns
  `{ enabled, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters }`
- `PUT /planning-center/sync-filter` — accepts the same shape, writes all four
  `church_settings` filter columns
- `GET /planning-center/field-definitions` — `[{ id, name, tabName, dataType }]` from
  PCO (select/checkbox only), powers the field picker
- `GET /planning-center/field-summary?fieldDefinitionId=...` — tallies observed values
  for one field across the cached PCO people snapshot, parallel to existing
  `tallyMembership`; add `tallyField(people, fieldDefinitionId)` to
  `services/planningCenter/summary.js`. Returns `{ total, values: [{ value, count }] }`.

`membership-summary` is unchanged (still needed whenever the membership source is
enabled).

## Frontend

- `services/api.ts`: replace `getPlanningCenterMembershipFilter` /
  `savePlanningCenterMembershipFilter` with `getPlanningCenterSyncFilter` /
  `savePlanningCenterSyncFilter` (new payload shape). Add
  `getPlanningCenterFieldDefinitions()` and
  `getPlanningCenterFieldSummary(fieldDefinitionId)`.
- New `components/planningCenter/FieldFilterEditor.tsx` (parallel to
  `MembershipAllowlistEditor.tsx`): manages a list of field-filter rows. Each row: a
  `<select>` of available fields (from `field-definitions`, excluding fields already
  used in another row) + a checkbox value-list (from `field-summary` for that field,
  lazy-loaded on field selection) + a remove button. "Add field filter" button appends
  an empty row.
- `components/integrations/PlanningCenterIntegrationPanel.tsx`: the existing
  `MembershipAllowlistEditor` section gets its own enable toggle
  (`membershipFilterEnabled`) — same switch style as the existing "Enable Planning
  Center sync" toggle already in this panel. A second, independent section below it
  holds the new `FieldFilterEditor` behind its own `fieldFilterEnabled` toggle. Both
  can be on simultaneously; each editor is only rendered/expanded when its toggle is
  on, but both write into the existing save/dirty-tracking flow (`pcConfigDirty`,
  `savePcSyncConfig`) unchanged. If a church turns both off, surface a small inline
  warning ("No one will be synced — enable at least one filter") since that's a
  reachable, likely-unintended state.
- `pages/OnboardingPage.tsx` (currently calls
  `savePlanningCenterMembershipFilter({ enabled: false, allowlist })` to disable sync
  during onboarding): update to the renamed function/shape, defaulting
  `membershipFilterEnabled: true`, `fieldFilterEnabled: false`, `fieldFilters: []`
  (preserves today's onboarding behavior).

## Testing

- New `services/planningCenter/eligibility.test.js`: membership-only (unchanged
  behavior, regression-covers existing diffEngine assertions), field-only (single rule
  match/no-match, multi-rule AND, empty rules -> ineligible, `'(none)'` sentinel
  matching for missing field value), both enabled (OR — matches membership only,
  matches fields only, matches neither, matches both), both disabled (nobody
  eligible).
- `services/planningCenter/projection.test.js`: extend for `fieldValues` extraction
  from `included` `FieldDatum` entries (present, missing, multiple fields on one
  person).
- `services/planningCenter/diffEngine.test.js`: update fixtures/call sites from
  `allowlist` to `filterConfig`.
- `services/planningCenter/summary.test.js`: add cases for new `tallyField`.
- No new automated e2e/integration test for the settings UI — verified manually against
  the running app (start dev server, connect/mock PCO, exercise each toggle combination),
  per project convention for UI changes.

## Out of scope

- Fixing the pre-existing membership `'(none)'` matching bug (see Eligibility
  semantics note above).
- Supporting free-text or date-type custom fields in the filter (bounded to
  select/checkbox per the UX decision).
- OR logic or nested rule groups *within* the custom-field rule set itself (rules
  within that source are AND-only, per the UX decision — the OR happens only between
  the membership source and the field source as a whole).
