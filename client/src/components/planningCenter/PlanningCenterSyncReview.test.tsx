import { describe, expect, it } from 'vitest';
import { mapLegacyPcoPlan } from './PlanningCenterSyncReview';

describe('mapLegacyPcoPlan', () => {
  it('keeps legacy archives destructive and assigns opaque candidate keys', () => {
    const plan = mapLegacyPcoPlan({
      link: [], restore: [],
      ambiguous: [{
        individualId: 12, firstName: 'Ada', lastName: 'Lovelace', candidates: ['9007199254740993'],
        candidateDetails: [{ pcoId: '9007199254740993', firstName: 'Ada', lastName: 'Byron', membership: 'Member' }],
      }],
      visitorMatches: [], add: [], update: [],
      archive: [{ individualId: 14, pcoId: 'archive-opaque-id' }],
      reactivate: [], familyNameUpdates: [],
    });

    expect(plan.archive).toEqual([expect.objectContaining({ individualId: 14, externalPersonId: 'archive-opaque-id' })]);
    expect(plan.skipped).toEqual([]);
    expect(plan.ambiguousPeople[0].candidateIndividualIds).toEqual([1]);
  });
});
