// Pure decision logic for whether a scheduled PCO sync run should notify admins
// that something needs review. Kept separate from planningCenterSync.js (which
// does the DB/network work) so this logic — the part most likely to have a
// subtle comparison bug — can be unit tested without mocking DB or HTTPS
// calls, matching how the rest of services/planningCenter/ is tested.

// totals/prev shape: { ambiguous, visitorMatches, familyNameUpdatesPending }
// prev is null if there is no prior notification on record.
// Returns { notify, clear }:
//   - notify: create a new notification now
//   - clear: reset the stored "last notified" snapshot to null (everything is
//     resolved, so a future reappearance notifies fresh instead of being
//     compared against a stale, no-longer-relevant snapshot)
function reviewNotificationDecision(prev, totals) {
  const allZero = !totals.ambiguous && !totals.visitorMatches && !totals.familyNameUpdatesPending;
  if (allZero) {
    return { notify: false, clear: !!prev };
  }
  const unchanged = !!prev &&
    prev.ambiguous === totals.ambiguous &&
    prev.visitorMatches === totals.visitorMatches &&
    prev.familyNameUpdatesPending === totals.familyNameUpdatesPending;
  return { notify: !unchanged, clear: false };
}

// Builds the notification body from whichever counts are nonzero. Returns ''
// for all-zero totals (callers should not be notifying in that case anyway).
function buildPcoReviewMessage(totals) {
  const parts = [];
  if (totals.ambiguous) {
    parts.push(`${totals.ambiguous} ambiguous match${totals.ambiguous === 1 ? '' : 'es'}`);
  }
  if (totals.visitorMatches) {
    parts.push(`${totals.visitorMatches} possible visitor match${totals.visitorMatches === 1 ? '' : 'es'}`);
  }
  if (totals.familyNameUpdatesPending) {
    parts.push(`${totals.familyNameUpdatesPending} family name update${totals.familyNameUpdatesPending === 1 ? '' : 's'}`);
  }

  if (!parts.length) return '';
  return `${parts.join(', ')} need review in Review & Sync.`;
}

module.exports = { reviewNotificationDecision, buildPcoReviewMessage };
