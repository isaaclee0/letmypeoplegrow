# PCO Medical Indicator Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the medical-indicator settings collapsible, use the standard settings switch, and match the People-page badge appearance picker.

**Architecture:** Keep the change inside the existing `PlanningCenterMedicalNotesSettings` component because persistence and API contracts are unchanged. Add local expansion state and replace the select/native-colour-only controls with the established tile grid plus colour swatch/hex input pattern.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Heroicons, Vitest, Testing Library

## Global Constraints

- The panel starts collapsed on every mount.
- Enabling expands the panel but does not save automatically.
- The panel remains manually collapsible while enabled.
- Existing badge adoption keeps its destructive confirmation.
- No server, database, sync, or medical-text behaviour changes.

---

### Task 1: Medical indicator settings panel

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx`
- Test: `client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx`

**Interfaces:**
- Consumes: `BADGE_ICON_OPTIONS`, `BadgeIcon`, `MedicalNoteIndicator`, the existing settings API DTO, and existing badge appearances.
- Produces: the same settings update payload, including `adoptExistingAppearance`, with no API signature changes.

- [ ] **Step 1: Write failing component tests**

Add tests that render loaded settings and assert these user-visible contracts:

```tsx
expect(screen.queryByLabelText('Minimum access level')).not.toBeInTheDocument();
const enabled = await screen.findByRole('switch', { name: 'Enable medical-note indicators' });
fireEvent.click(enabled);
expect(screen.getByLabelText('Minimum access level')).toBeInTheDocument();
fireEvent.click(screen.getByRole('button', { name: 'Collapse medical-note indicator settings' }));
expect(screen.queryByLabelText('Minimum access level')).not.toBeInTheDocument();
```

Add a second test that expands the panel, selects a normal icon tile, edits the hexadecimal colour input, opens **Adopt existing**, selects an existing appearance, saves, and observes the existing confirmation modal.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd client && npm test -- --run src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx
```

Expected: FAIL because the checkbox has no switch role, the panel is always expanded, and the tile/hex controls do not exist.

- [ ] **Step 3: Implement expansion and standard switch**

In `PlanningCenterMedicalNotesSettings.tsx`:

```tsx
const [isExpanded, setIsExpanded] = useState(false);

const setEnabled = (enabled: boolean) => {
  setSettings((current) => ({ ...current, enabled }));
  if (enabled) setIsExpanded(true);
};
```

Render the switch with `role="switch"`, `aria-checked`, and the same green track/thumb classes as the background-check setting. Give the chevron button an expansion-state-specific accessible name and render the form body only when `isExpanded` is true.

- [ ] **Step 4: Implement the matching appearance picker**

Replace the icon select with the People-page tile grid:

```tsx
<button type="button" onClick={() => setShowExistingAppearances(true)}>Adopt existing</button>
{BADGE_ICON_OPTIONS.map((option) => (
  <button type="button" aria-label={`Use ${option.label} icon`} onClick={() => {
    setAdopt(false);
    setShowExistingAppearances(false);
    setSettings((current) => ({ ...current, badgeIcon: option.value }));
  }}>
    <BadgeIcon type={option.value} />
    <span>{option.label}</span>
  </button>
))}
```

Use the People-page colour control pattern: a native colour input beside a seven-character hexadecimal text input. Both controls update `badgeColor`; normal appearance edits clear adoption mode. Existing appearance choices remain radio controls and retain the active/archived person count.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
cd client && npm test -- --run src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 6: Run proportional regression verification**

Run:

```bash
cd client && npm test -- --run src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx src/components/icons/MedicalNoteIndicator.test.tsx src/components/people/PersonCard.medicalNotes.test.tsx
cd client && npm run build
git diff --check
```

Expected: focused tests and production build pass; `git diff --check` prints no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx
git commit -m "refactor(pco): compact medical indicator settings"
```

### Task 2: Match the destructive confirmation buttons

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx`
- Test: `client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx`

**Interfaces:**
- Consumes: the component's existing `saving` state and `save(true)` adoption flow.
- Produces: unchanged modal behaviour with the standard secondary/destructive action presentation.

- [ ] **Step 1: Write the failing modal action test**

Open the adoption confirmation and assert that Cancel and Confirm are equal-width standard actions. Keep the update request pending after Confirm is clicked and assert both actions are disabled while the destructive label reads `Saving…`.

```tsx
expect(cancel).toHaveClass('flex-1', 'border-gray-300', 'bg-white');
expect(confirm).toHaveClass('flex-1', 'bg-red-600', 'hover:bg-red-700');
fireEvent.click(confirm);
expect(cancel).toBeDisabled();
expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd client && npm test -- --run src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx
```

Expected: FAIL because the current Cancel action is unstyled and neither modal action is disabled while saving.

- [ ] **Step 3: Apply the established confirmation action styles**

Render an equal-width action row using the standard secondary button classes for Cancel and destructive red classes for Confirm. Bind both `disabled` properties to `saving` and render `Saving…` while the adoption request is pending.

- [ ] **Step 4: Run proportional verification**

Run:

```bash
cd client && npm test -- --run src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx
cd client && npm run build
git diff --check
```

Expected: all focused tests and the production build pass; `git diff --check` prints no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx
git commit -m "fix(pco): align adoption confirmation actions"
```
