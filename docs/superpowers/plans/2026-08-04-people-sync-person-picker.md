# People Sync Person Picker Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace family-oriented picker tiles with compact, directly selectable person rows whose search matches only each person's own name.

**Architecture:** Keep the existing dialog ownership, selection callbacks, candidate eligibility checks, and ordering. Change each dialog's local search projection and result markup in place; the two components remain separate because their selection safeguards and correction behavior differ.

**Tech Stack:** React 19, TypeScript, Headless UI, Tailwind CSS, Vitest, Testing Library

## Global Constraints

- Search only a person's own first name, last name, or full name after case-insensitive Unicode normalization.
- Family names and other family members must not contribute to search matching.
- Show the person's family name only as smaller muted supporting text.
- Eligible rows select immediately when clicked or tapped; do not render visible “Select” or “Use this person” copy.
- Preserve exclusions, disabled candidates, claimed-person safeguards, correction exchange behavior, and existing callbacks.
- Do not change server contracts or review decision payloads.

---

### Task 1: Simplify the normal match picker

**Files:**
- Modify: `client/src/components/peopleSync/PeoplePickerDialog.test.tsx`
- Modify: `client/src/components/peopleSync/PeoplePickerDialog.tsx`

**Interfaces:**
- Consumes: `PeopleSyncPersonDisplay`, `personDisplayName(person)`, `personFamilyDisplay(person)`, and the existing `onSelectPerson(individualId: number)` callback.
- Produces: unchanged `PeoplePickerDialogProps` and unchanged selection behavior; the button keeps the accessible name `Select ${personDisplayName(person)}` while its visible content is only person and family information.

- [ ] **Step 1: Replace family-oriented search and expandable-detail tests with failing person-row tests**

Add a focused test that searches `Jamie` (a name present only among family members) and expects no candidate buttons, then searches `Alex` and expects only Alex Jones. Assert that the family name remains visible and the family-member preview is absent:

```tsx
it('searches only each person name and shows compact family context', async () => {
  const user = userEvent.setup();
  render(<PickerHarness />);

  await user.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
  const dialog = screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' });
  const search = within(dialog).getByRole('searchbox', { name: 'Search LMPG people' });

  await user.type(search, 'Jamie');
  expect(within(dialog).getByText('No matching people found.')).toBeVisible();

  await user.clear(search);
  await user.type(search, 'Alex');
  const alex = within(dialog).getByRole('button', { name: 'Select Alex Jones' });
  expect(alex).toHaveTextContent('Alex Jones');
  expect(alex).toHaveTextContent('Jones family');
  expect(within(dialog).queryByRole('button', { name: 'Select Morgan Reed' })).not.toBeInTheDocument();
  expect(within(dialog).queryByText('Casey Jones')).not.toBeInTheDocument();
  expect(within(dialog).queryByText('2 more family members')).not.toBeInTheDocument();
});
```

Keep the existing direct-selection test as the click/tap behavior assertion. Update the search placeholder expectation only if the test suite refers to the old copy.

- [ ] **Step 2: Run the focused test and verify the new behavior fails**

Run:

```bash
cd client && npm test -- src/components/peopleSync/PeoplePickerDialog.test.tsx
```

Expected: FAIL because `Jamie` still matches family-member data and the result still contains expandable family details.

- [ ] **Step 3: Implement person-only search and one compact selection row**

Reduce `searchableText` to the person's own name:

```tsx
function searchableText(person: PeopleSyncPersonDisplay): string {
  return `${person.firstName} ${person.lastName}`.normalize('NFKD').toLocaleLowerCase();
}
```

Change the placeholder to `Search by person name`. Replace `PersonIdentitySummary` plus the separate visible selection action with a single full-width button:

```tsx
const family = personFamilyDisplay(person);
const familyLabel = family.state === 'known'
  ? family.name || 'Unnamed family'
  : family.state === 'none' ? 'No family' : 'Family unavailable';

<button
  type="button"
  disabled={disabled}
  aria-label={`Select ${personDisplayName(person)}`}
  onClick={() => choosePerson(individualId)}
  className="block w-full rounded-lg border border-gray-200 px-3 py-3 text-left hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-55 dark:border-gray-700 dark:hover:bg-gray-700"
>
  <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{personDisplayName(person)}</span>
  <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{familyLabel}</span>
</button>
```

Keep each disabled-reason paragraph immediately after the button in its existing wrapper. Remove the unused default `PersonIdentitySummary` import while retaining `personDisplayName` and `personFamilyDisplay`.

- [ ] **Step 4: Run the component test and verify it passes**

Run:

```bash
cd client && npm test -- src/components/peopleSync/PeoplePickerDialog.test.tsx
```

Expected: all `PeoplePickerDialog` tests PASS with no warnings.

- [ ] **Step 5: Commit the normal picker change**

```bash
git add client/src/components/peopleSync/PeoplePickerDialog.tsx client/src/components/peopleSync/PeoplePickerDialog.test.tsx
git commit -m "fix(sync): simplify person match picker"
```

### Task 2: Simplify the established-link correction picker

**Files:**
- Modify: `client/src/components/peopleSync/EstablishedLinkDialog.test.tsx`
- Modify: `client/src/components/peopleSync/EstablishedLinkDialog.tsx`

**Interfaces:**
- Consumes: `PeopleSyncPersonDisplay`, `personDisplayName(person)`, `personFamilyDisplay(person)`, existing eligibility maps, and `onRelink(individualId: number)`.
- Produces: unchanged `EstablishedLinkDialogProps`, link-exchange safeguards, and callback payloads; replacement rows share the compact visual interaction from Task 1 without introducing a shared component.

- [ ] **Step 1: Write failing correction-picker tests for person-only filtering and direct rows**

Replace the family-member search test with a query for `Family` that expects no matches, then query `Eligible` and click the accessible result row. Assert its primary and secondary text and the absence of family-member details:

```tsx
it('searches replacement names only and relinks from a compact person row', async () => {
  const user = userEvent.setup();
  const onRelink = vi.fn();
  render(<EstablishedLinkDialog {...defaultProps} onRelink={onRelink} />);
  const dialog = screen.getByRole('dialog', { name: 'Correct linked person for Alex Smith' });

  await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
  const search = within(dialog).getByRole('searchbox', { name: 'Search LMPG people' });
  await user.type(search, 'Family');
  expect(within(dialog).getByText('No matching people found.')).toBeVisible();

  await user.clear(search);
  await user.type(search, 'Eligible');
  const eligible = within(dialog).getByRole('button', { name: 'Select Eligible Person' });
  expect(eligible).toHaveTextContent('Eligible Person');
  expect(eligible).toHaveTextContent('Green family');
  expect(within(dialog).queryByText('Family Member')).not.toBeInTheDocument();
  expect(within(dialog).queryByText('2 more family members')).not.toBeInTheDocument();

  await user.click(eligible);
  expect(onRelink).toHaveBeenCalledOnce();
  expect(onRelink).toHaveBeenCalledWith(22);
});
```

Retain the tests for unavailable, claimed, original-link, and provisionally reassignable candidates.

- [ ] **Step 2: Run the correction-picker test and verify the new behavior fails**

Run:

```bash
cd client && npm test -- src/components/peopleSync/EstablishedLinkDialog.test.tsx
```

Expected: FAIL because `Family` still matches family-member data and expandable details still render.

- [ ] **Step 3: Implement compact replacement rows without changing correction rules**

Apply the same person-only `searchableText`, `Search by person name` placeholder, family-label derivation, and full-width row markup from Task 1. Keep these existing calculations unchanged:

```tsx
const correctableExternalId = correctableClaimByIndividualId.get(individualId);
const provisionallyReassignable = individualId === originalIndividualId ||
  (correctableExternalId !== undefined && correctableExternalId !== externalId);
const unavailable = !availableIndividualIds.has(individualId) && !provisionallyReassignable;
const disabled = (claimedElsewhere && !provisionallyReassignable) || unavailable;
```

Wire the row's click directly to `onRelink(individualId)`. Keep the existing disabled and provisional-exchange explanation paragraphs after the row. Continue using `PersonIdentitySummary` for the separate “Currently linked LMPG person” section, so its default import remains required in this component.

- [ ] **Step 4: Run the correction-picker test and verify it passes**

Run:

```bash
cd client && npm test -- src/components/peopleSync/EstablishedLinkDialog.test.tsx
```

Expected: all `EstablishedLinkDialog` tests PASS with no warnings.

- [ ] **Step 5: Commit the correction picker change**

```bash
git add client/src/components/peopleSync/EstablishedLinkDialog.tsx client/src/components/peopleSync/EstablishedLinkDialog.test.tsx
git commit -m "fix(sync): simplify link correction picker"
```

### Task 3: Verify shared review workflows

**Files:**
- Verify: `client/src/components/peopleSync/PeoplePickerDialog.test.tsx`
- Verify: `client/src/components/peopleSync/EstablishedLinkDialog.test.tsx`
- Verify: `client/src/components/peopleSync/IdentityReviewTable.test.tsx`
- Verify: `client/src/components/peopleSync/SyncReview.test.tsx`
- Verify: `client/src/components/planningCenter/PlanningCenterSyncReview.test.tsx`

**Interfaces:**
- Consumes: the unchanged accessible result names and unchanged `onSelectPerson`/`onRelink` payloads.
- Produces: evidence that the streamlined rows preserve normal decisions, correction previews, and Planning Center review application.

- [ ] **Step 1: Run the affected review tests together**

```bash
cd client && npm test -- \
  src/components/peopleSync/PeoplePickerDialog.test.tsx \
  src/components/peopleSync/EstablishedLinkDialog.test.tsx \
  src/components/peopleSync/IdentityReviewTable.test.tsx \
  src/components/peopleSync/SyncReview.test.tsx \
  src/components/planningCenter/PlanningCenterSyncReview.test.tsx
```

Expected: all listed test files PASS.

- [ ] **Step 2: Run a production client build**

```bash
cd client && npm run build
```

Expected: service-worker generation and Vite production build both exit successfully.

- [ ] **Step 3: Inspect the final diff for accidental scope expansion**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the planned picker source/tests and ignored workflow documents differ from the pre-task state.
