import React, { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import HouseholdChoiceEditor, { householdChoiceEditsMatch, withoutCoveredHouseholdWarnings } from './HouseholdChoiceEditor';
import type { HouseholdChoiceEdits, HouseholdChoiceGroup, HouseholdChoicesPlan, PeopleSyncPlan } from './types';

const group = (overrides: Partial<HouseholdChoiceGroup> = {}): HouseholdChoiceGroup => ({
  id: 'shared-households',
  people: [
    { externalPersonId: 'one', individualId: 1, firstName: 'Alex', lastName: 'Smith', currentFamilyId: 10, sourceFingerprint: null, currentFamilyName: 'Smith family' },
    { externalPersonId: 'two', individualId: 2, firstName: 'Blair', lastName: 'Smith', currentFamilyId: 10, sourceFingerprint: null, currentFamilyName: 'Smith family' },
  ],
  sourceHouseholds: [
    { externalFamilyId: 'h1', name: 'PCO Smith household', members: [
      { externalPersonId: 'one', firstName: 'Alex', lastName: 'Smith', inSource: true },
      { externalPersonId: 'parent', firstName: 'Pat', lastName: 'Smith', inSource: false },
    ] },
    { externalFamilyId: 'h2', name: 'PCO Smith household', members: [
      { externalPersonId: 'two', firstName: 'Blair', lastName: 'Smith', inSource: true },
      { externalPersonId: 'child', firstName: 'Casey', lastName: 'Smith', inSource: true },
    ] },
  ],
  selectedDestination: { kind: 'keep' }, displayName: 'Smith family', suggestedName: 'Smith household', sourceChanged: false, saved: false, invalidReason: null,
  ...overrides,
});
const plan = (card = group()): HouseholdChoicesPlan => ({
  version: 2, groups: [card], edits: {}, basePreferences: [], decisions: [],
  localFamilies: [
    { id: 10, familyName: 'Smith family', memberNames: ['Alex Smith', 'Blair Smith'] },
    { id: 20, familyName: 'Unrelated local family', memberNames: ['Jamie Jones'] },
  ],
});
function Editor({ card = group(), onChange = vi.fn() }: { card?: HouseholdChoiceGroup; onChange?: (edits: HouseholdChoiceEdits) => void }) {
  const [edits, setEdits] = useState<HouseholdChoiceEdits>({});
  return <HouseholdChoiceEditor plan={plan(card)} baseGroups={[card]} edits={edits}
    onChange={(next) => { setEdits(next); onChange(next); }} onPreview={vi.fn()} needsPreview={Object.keys(edits).length > 0} />;
}

describe('HouseholdChoiceEditor', () => {
  it('defaults one selector to keep the LMPG household and explicitly remembers it without choosing PCO', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    const card = screen.getByRole('group', { name: 'Household choice for Alex & Blair Smith' });
    expect(within(card).getAllByRole('combobox')).toHaveLength(1);
    expect(within(card).getByRole('combobox')).toHaveValue('keep');
    expect(within(card).getByRole('option', { name: /Unrelated local family.*Jamie Jones/ })).toBeInTheDocument();
    expect(within(card).queryByRole('option', { name: /PCO Smith household/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Pat Smith.*outside source/).closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('household-display-name')).toHaveTextContent('Smith family');
    await user.click(screen.getByRole('button', { name: 'Remember this household' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'keep' } } });
    expect(screen.getByRole('button', { name: 'Preview household choices' })).toBeEnabled();
  });

  it('chooses any existing LMPG family for the whole card and renames it only through the pencil', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await user.selectOptions(screen.getByRole('combobox'), 'existing:20');
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'existing', familyId: 20 } } });
    expect(screen.getByTestId('household-display-name')).toHaveTextContent('Unrelated local family');
    await user.click(screen.getByRole('button', { name: /Edit family name/ }));
    const name = screen.getByLabelText(/LMPG family display name/);
    expect(name).toHaveValue('Unrelated local family');
    await user.clear(name); await user.type(name, 'Alex and Blair');
    await user.click(screen.getByRole('button', { name: 'Done editing name' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'existing', familyId: 20 }, displayName: 'Alex and Blair' } });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('creates a new named family and blocks preview until its required name is present', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await user.selectOptions(screen.getByRole('combobox'), 'create');
    const name = screen.getByRole('textbox', { name: 'New family name' });
    expect(name).toHaveValue('Smith household');
    await user.clear(name);
    expect(screen.getByRole('button', { name: 'Preview household choices' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name for the new family.');
    await user.type(name, 'New Smith family');
    expect(screen.getByRole('button', { name: 'Preview household choices' })).toBeEnabled();
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'create' }, displayName: 'New Smith family' } });
  });

  it('keeps a mixed arrangement without offering a shared name override', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    const card = group();
    card.people[1] = { ...card.people[1], currentFamilyId: null, currentFamilyName: null };
    card.displayName = '';
    render(<Editor card={card} onChange={onChange} />);
    expect(screen.queryByRole('button', { name: /Edit family name/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remember this arrangement' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'keep' } } });
  });

  it('keeps saved choices editable, forgettable, and resettable without a write', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Editor card={group({ saved: true, selectedDestination: { kind: 'existing', familyId: 10 } })} onChange={onChange} />);
    expect(screen.getByRole('combobox')).toHaveValue('existing:10');
    await user.click(screen.getByRole('button', { name: 'Forget saved choice' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'forget' } } });
    expect(screen.getByText(/will be forgotten when you apply/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset card' }));
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(screen.getByRole('combobox')).toHaveValue('existing:10');
  });

  it('cancels a pencil edit without replacing the current local name with a PCO name', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Edit family name/ }));
    await user.clear(screen.getByRole('textbox')); await user.type(screen.getByRole('textbox'), 'Temporary name');
    await user.click(screen.getByRole('button', { name: 'Cancel name edit' }));
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(screen.getByTestId('household-display-name')).toHaveTextContent('Smith family');
    expect(screen.queryByRole('button', { name: 'Use PCO name' })).not.toBeInTheDocument();
  });

  it('shows invalid saved choices and requires forgetting instead of silently replacing them', () => {
    render(<Editor card={group({ saved: true, selectedDestination: { kind: 'existing', familyId: 99 }, invalidReason: 'The local family was deleted. Forget this choice first.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The local family was deleted. Forget this choice first.');
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forget saved choice' })).toBeEnabled();
  });

  it('lets a changed Planning Center household be reconfirmed without forgetting first', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Editor card={group({ saved: true, sourceChanged: true, invalidReason: 'Planning Center household membership changed. Review the updated household.' })} onChange={onChange} />);
    expect(screen.getByRole('combobox')).toBeEnabled();
    expect(screen.getByRole('button', { name: /Edit family name/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Remember this household' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'shared-households': { destination: { kind: 'keep' } } });
    expect(screen.getByText(/remembers your choices until Planning Center household membership changes/)).toBeInTheDocument();
  });

  it('compares destination kind, family, and explicit name edits and retains unrelated warnings', () => {
    expect(householdChoiceEditsMatch({ x: { destination: { kind: 'keep' } } }, { x: { destination: { kind: 'create' }, displayName: 'Family' } })).toBe(false);
    expect(householdChoiceEditsMatch({ x: { destination: { kind: 'existing', familyId: 10 } } }, { x: { destination: { kind: 'existing', familyId: 20 } } })).toBe(false);
    expect(householdChoiceEditsMatch({ x: { destination: { kind: 'keep' }, displayName: '' } }, { x: { destination: { kind: 'keep' } } })).toBe(false);
    const source = { householdChoices: plan(), familyConflicts: [
      { id: 'other', memberExternalIds: ['elsewhere'], reason: 'multiple_provider_households' },
      { id: 'blocked', memberExternalIds: ['one'], reason: 'unknown_household_membership' },
    ] } as PeopleSyncPlan;
    expect(withoutCoveredHouseholdWarnings(source).familyConflicts.map((entry) => entry.id)).toEqual(['other', 'blocked']);
  });
});
