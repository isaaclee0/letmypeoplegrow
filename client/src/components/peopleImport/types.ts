import type {
  PeopleSyncPlan,
  PeopleSyncReview,
  PeopleSyncSelections,
  ProviderSource,
} from '../peopleSync/types';

export type ImportSelection =
  | { kind: 'all' }
  | {
      kind: 'planning_center_list' | 'elvanto_category' | 'elvanto_group';
      externalId: string;
    };

export interface PeopleImportSourcesResponse {
  success: true;
  sources: ProviderSource[];
  allOption: { kind: 'all'; name: 'Everyone' };
}

export interface PeopleImportReview extends PeopleSyncReview {
  operationKind: 'people_import';
  selection: ImportSelection;
  plan: PeopleSyncPlan & { operationKind: 'people_import' };
}

export interface PeopleImportApplyRequest {
  selection: ImportSelection;
  reviewToken: string;
  selections: PeopleSyncSelections;
}

const FORBIDDEN_IMPORT_BUCKETS = [
  'updateManagedFields',
  'promoteToRegular',
  'demoteToLocalVisitor',
  'archive',
  'reactivate',
  'moveFamily',
  'renameFamily',
  'addToGathering',
  'removeFromGathering',
  'unmatchedLocalRegulars',
] as const satisfies ReadonlyArray<keyof PeopleSyncPlan>;

export function hasForbiddenImportMutations(review: PeopleSyncReview): boolean {
  return FORBIDDEN_IMPORT_BUCKETS.some((bucket) => {
    const value = review.plan[bucket];
    return !Array.isArray(value) || value.length > 0;
  });
}
