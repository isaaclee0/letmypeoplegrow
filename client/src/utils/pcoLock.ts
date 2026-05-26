// PCO source-of-truth mode lock helpers.
//
// Single source of truth on the client for "is this person Planning Center–owned
// and therefore read-only for name/age + no merge/delete/restore?"
//
// Mirrors the backend helper at server/services/planningCenter/mode.js.

export interface PcoLockablePerson {
  planningCenterId?: string | null;
}

export function isPcoLocked(
  person: PcoLockablePerson | undefined | null,
  planningCenterSyncEnabled: boolean,
): boolean {
  if (!planningCenterSyncEnabled) return false;
  if (!person) return false;
  return !!person.planningCenterId;
}

// Count how many of `people` are PCO-locked under the given mode flag.
export function countPcoLocked<T extends PcoLockablePerson>(
  people: T[],
  planningCenterSyncEnabled: boolean,
): number {
  if (!planningCenterSyncEnabled) return 0;
  let n = 0;
  for (const p of people) if (p && p.planningCenterId) n++;
  return n;
}

// Standardised error code returned by the backend when an action is blocked.
export const PCO_MODE_LOCKED = 'PCO_MODE_LOCKED';
