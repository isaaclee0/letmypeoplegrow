// PCO source-of-truth mode lock helpers.
//
// Single source of truth on the client for "is this person Planning Center–owned
// and therefore read-only for name/age + no merge/delete/restore?"
//
// Mirrors the backend helper at server/services/planningCenter/mode.js.
//
// Task 17 (provider-neutral people-sync project): this now DELEGATES to the
// provider-neutral isAuthorityLocked() in authorityLock.ts, which is the new
// single source of truth going forward -- kept here, with its original
// signature and behaviour unchanged, purely so existing PCO-only call sites
// (e.g. client/src/pages/PeoplePage.tsx) keep compiling and behaving
// identically until they migrate to isAuthorityLocked/ExternalLinks
// directly (Task 21).

import { isAuthorityLocked } from './authorityLock';

export interface PcoLockablePerson {
  planningCenterId?: string | null;
}

export function isPcoLocked(
  person: PcoLockablePerson | undefined | null,
  planningCenterSyncIndicator: boolean,
): boolean {
  return isAuthorityLocked(
    { planning_center: person?.planningCenterId ?? undefined },
    planningCenterSyncIndicator ? 'planning_center' : 'none',
  );
}

// Count how many of `people` are PCO-locked under the given mode flag.
export function countPcoLocked<T extends PcoLockablePerson>(
  people: T[],
  planningCenterSyncIndicator: boolean,
): number {
  if (!planningCenterSyncIndicator) return 0;
  let n = 0;
  for (const p of people) if (isPcoLocked(p, true)) n++;
  return n;
}

// Standardised error code returned by the backend when an action is blocked.
export const PCO_MODE_LOCKED = 'PCO_MODE_LOCKED';
