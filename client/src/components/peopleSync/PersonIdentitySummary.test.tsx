import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PersonIdentitySummary, { FamilyContext } from './PersonIdentitySummary';

describe('FamilyContext', () => {
  it('shows abbreviated named family context without dumping every member into a row', () => {
    render(
      <FamilyContext
        family={{
          state: 'known',
          name: 'Smith household',
          members: [
            { firstName: 'Casey', lastName: 'Smith' },
            { firstName: 'Drew', lastName: 'Smith' },
            { firstName: 'Jamie', lastName: 'Smith' },
            { firstName: 'Riley', lastName: 'Smith' },
          ],
          totalOtherMembers: 5,
        }}
      />,
    );

    expect(screen.getByText('Smith household')).toBeVisible();
    expect(screen.getByText('Casey Smith, Drew Smith, Jamie Smith')).toBeVisible();
    expect(screen.getByText('2 more family members')).toBeVisible();
    expect(screen.queryByText(/Riley Smith/)).not.toBeInTheDocument();
  });

  it('uses caller-specific empty and unavailable family wording', () => {
    render(
      <div>
        <FamilyContext family={{ state: 'none' }} noneLabel="No household" />
        <FamilyContext family={{ state: 'none' }} noneLabel="No family" />
        <FamilyContext family={{ state: 'unavailable' }} unavailableLabel="Household unavailable" />
      </div>,
    );

    expect(screen.getByText('No household')).toBeVisible();
    expect(screen.getByText('No family')).toBeVisible();
    expect(screen.getByText('Household unavailable')).toBeVisible();
  });

  it('keeps the established full person summary fallbacks for dialog consumers', () => {
    render(
      <PersonIdentitySummary
        label="LMPG person"
        person={{ firstName: 'Alex', lastName: 'Smith', family: { state: 'unavailable' } }}
      />,
    );

    expect(screen.getByText('Alex Smith')).toBeVisible();
    expect(screen.getByText('Household information unavailable')).toBeVisible();
  });
});
