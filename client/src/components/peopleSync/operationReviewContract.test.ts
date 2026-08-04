import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  tagLegacyPeopleReview,
  type AuthoritySwitchReview,
  type PeopleReviewToken,
  type PeopleSyncOperationReview,
  type PeopleSyncReview,
} from './types';

function legacyReview(): PeopleSyncReview {
  return {
    reviewToken: 'legacy-token',
    plan: {},
  } as PeopleSyncReview;
}

describe('operation-tagged people review contract', () => {
  it.each(['people_sync', 'authority_switch'] as const)(
    'tags an unmarked legacy %s response once at its workflow boundary',
    (operationKind) => {
      const tagged = tagLegacyPeopleReview(legacyReview(), operationKind);

      expect(tagged).toMatchObject({
        operationKind,
        reviewToken: 'legacy-token',
        plan: { operationKind },
      });
    },
  );

  it.each([
    ['people_sync', 'authority_switch', 'top-level'],
    ['people_sync', 'authority_switch', 'plan'],
    ['authority_switch', 'people_sync', 'top-level'],
    ['authority_switch', 'people_sync', 'plan'],
  ] as const)(
    'rejects %s normalization when an existing %s marker conflicts at the %s level',
    (expected, conflicting, markerLocation) => {
      const review = legacyReview();
      if (markerLocation === 'top-level') {
        (review as PeopleSyncReview & { operationKind: string }).operationKind = conflicting;
      } else {
        (review.plan as PeopleSyncReview['plan'] & { operationKind: string }).operationKind = conflicting;
      }

      expect(() => tagLegacyPeopleReview(review, expected)).toThrow('belongs to a different operation');
    },
  );

  it('keys review tokens and callback paths to their operation at compile time', () => {
    const syncReview = tagLegacyPeopleReview(legacyReview(), 'people_sync');
    const authorityReview = tagLegacyPeopleReview(legacyReview(), 'authority_switch');

    expectTypeOf(syncReview).toEqualTypeOf<PeopleSyncOperationReview>();
    expectTypeOf(authorityReview).toEqualTypeOf<AuthoritySwitchReview>();
    expectTypeOf(syncReview.reviewToken).toEqualTypeOf<PeopleReviewToken<'people_sync'>>();
    expectTypeOf(authorityReview.reviewToken).toEqualTypeOf<PeopleReviewToken<'authority_switch'>>();
    expectTypeOf(syncReview.reviewToken).not.toEqualTypeOf<PeopleReviewToken<'authority_switch'>>();
  });
});
