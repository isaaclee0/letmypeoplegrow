// Provider-neutral "is this person/family locked by the active people-sync
// authority?" helpers (Task 17 of the provider-neutral people-sync
// project).
//
// Provider-neutral authority is the sole source of client-side lock state.
//
// Mirrors the backend helper at server/services/peopleSync/authority.js
// (isPersonLocked/PEOPLE_SOURCE_LOCKED) -- see that module for the
// server-side enforcement this only mirrors for client-side UI decisions
// (disabling edit controls, etc.); the server remains the actual source of
// truth and re-checks this on every mutating request.

import type { AuthorityProvider, ExternalLinks } from '../components/peopleSync/types';

// Standardised error code returned by the backend
// (services/peopleSync/authority.js's PEOPLE_SOURCE_LOCKED) when a locked
// person/family's edit, archive, restore, merge, or delete is rejected.
export const PEOPLE_SOURCE_LOCKED = 'PEOPLE_SOURCE_LOCKED';

// True when `authority` is an active provider (not 'none') AND `links`
// carries a non-empty external id for that same provider -- i.e. this
// person/family is managed by whichever provider is currently the church's
// people-sync authority. Mirrors authority.js's isPersonLocked exactly:
// `authority !== 'none' && links instanceof Set && links.has(authority)`,
// adapted for the client's plain-object ExternalLinks shape instead of the
// server's Set of provider names.
export function isAuthorityLocked(
  links: ExternalLinks | undefined,
  authority: AuthorityProvider,
  peopleEditingLocked = true,
): boolean {
  return peopleEditingLocked && authority !== 'none' && !!links?.[authority];
}

// Human-readable label for an authority provider, matching
// authority.js's own PROVIDER_LABELS map (falling back to 'None' for the
// unlocked state, which authority.js itself never needs to label since it
// only ever labels an ACTIVE authority).
export function authorityLabel(provider: AuthorityProvider): string {
  return provider === 'planning_center' ? 'Planning Center' : provider === 'elvanto' ? 'Elvanto' : 'None';
}
