import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanningCenterSyncReview, { mapLegacyPcoPlan } from './PlanningCenterSyncReview';
import { integrationsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getPlanningCenterBatchPlan: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
  },
}));

const legacyPlan = {
  link: [], restore: [],
  ambiguous: [{
    individualId: 12, firstName: 'Ada', lastName: 'Lovelace', candidates: ['9007199254740993'],
    candidateDetails: [{ pcoId: '9007199254740993', firstName: 'Ada', lastName: 'Byron', membership: 'Member' }],
  }],
  visitorMatches: [], add: [], update: [],
  archive: [{ individualId: 14, pcoId: 'archive-opaque-id' }],
  reactivate: [], familyNameUpdates: [],
};

describe('mapLegacyPcoPlan', () => {
  it('keeps legacy archives destructive and assigns opaque candidate keys', () => {
    const plan = mapLegacyPcoPlan(legacyPlan);

    expect(plan.archive).toEqual([expect.objectContaining({ individualId: 14, externalPersonId: 'archive-opaque-id' })]);
    expect(plan.skipped).toEqual([]);
    expect(plan.ambiguousPeople[0].candidateIndividualIds).toEqual([1]);
  });

  it('shows initial candidate names and keeps legacy automatic archives gated', async () => {
    const getPlan = integrationsAPI.getPlanningCenterBatchPlan as ReturnType<typeof vi.fn>;
    getPlan.mockResolvedValue({ data: { plan: legacyPlan } });

    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Ada Byron — Member')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I understand that this sync will archive people/));
    expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled();
  });
});
