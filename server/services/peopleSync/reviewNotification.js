// Provider-neutral review-required notifications (Task 15 of the
// provider-neutral people-sync project). Generalizes the established
// dedup-via-stored-marker pattern from server/services/planningCenter/
// reviewNotification.js (PCO-only, kept unmodified — that module's
// reviewNotificationDecision()/buildPcoReviewMessage() are the design
// precedent this file generalizes, not something this file calls) to work
// for any registered provider, and stores its dedup fingerprint on the
// audit trail itself (people_sync_runs.review_notification_fingerprint via
// runRepository) rather than a provider-specific church_settings column —
// per this task's own instruction, this must NOT reuse
// planning_center_last_notified_review or any other provider-specific
// settings column.
//
// Call exactly once per completed orchestrator run that classifies as
// review_required (see orchestrator.js's runUnattended) — never from a
// pure preview (buildReview/previewAuthoritySwitch) and never from an
// interactive applyReviewed (a human already reviewed that plan directly,
// so a follow-up notification would just be noise).
const crypto = require('node:crypto');
const Database = require('../../config/database');
const runRepository = require('./runRepository');

const PROVIDER_LABELS = { planning_center: 'Planning Center', elvanto: 'Elvanto' };
const NOTIFIABLE_ROLES = ['admin', 'coordinator'];

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

// Only ever a small, fixed set of non-negative integer counts (see
// orchestrator.js's `heldCounts` — ambiguousPeople/familyConflicts/
// renameFamily/unmatchedLocalRegulars). Coerced defensively so a stray
// non-numeric value can never produce two different-looking fingerprints
// for what a human would consider the same counts object.
function stableCounts(counts) {
  const safe = {};
  for (const key of Object.keys(counts || {}).sort()) {
    const value = Number(counts[key]);
    safe[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return safe;
}

function hasAnyPending(counts) {
  return Object.values(counts).some((value) => value > 0);
}

// Hashes the STABLE provider + pending-count object only — never a person
// name, run id, or timestamp — so the fingerprint is a pure function of
// "what does this notification say", matching the de-dup rule: identical
// pending counts for the same provider never re-notify; any change does.
function fingerprintFor(provider, counts) {
  const payload = JSON.stringify({ provider, counts });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Sanitized by construction: only the provider label and small integer
// counts ever feed into this string, plus a fixed link to Settings. No
// person names, external IDs, or raw provider payloads are ever in scope
// here to leak.
function buildReviewMessage(provider, counts) {
  const label = providerLabel(provider);
  const parts = [];
  if (counts.ambiguousPeople) parts.push(pluralize(counts.ambiguousPeople, 'ambiguous match', 'ambiguous matches'));
  if (counts.familyConflicts) parts.push(pluralize(counts.familyConflicts, 'family conflict', 'family conflicts'));
  if (counts.unmatchedLocalRegulars) {
    parts.push(pluralize(counts.unmatchedLocalRegulars, 'unmatched local regular', 'unmatched local regulars'));
  }
  if (counts.renameFamily) parts.push(pluralize(counts.renameFamily, 'family rename', 'family renames'));

  const detail = parts.length > 0 ? `${parts.join(', ')} waiting for review` : 'items waiting for review';
  return `${label} sync has ${detail} in Settings → Integrations.`;
}

/**
 * notifyReviewRequired({ churchId, provider, runId, counts })
 *
 * De-duplicated by provider and unchanged pending counts: a fresh SHA-256
 * fingerprint of `{ provider, counts }` is compared against the most
 * recent fingerprint recorded for this church+provider across ALL runs
 * (runRepository.findLatestReviewNotificationFingerprint) — not scoped to
 * one batch, matching "de-duplicated by provider" verbatim. When the
 * fingerprint is unchanged, no new notification rows are created (though
 * this run is still tagged with the same fingerprint for audit
 * continuity). When it differs (including "no prior notification at
 * all"), one notification is created per active admin/coordinator and the
 * new fingerprint is recorded on this run.
 */
async function notifyReviewRequired({ churchId, provider, runId, counts }) {
  if (!churchId) throw new Error('notifyReviewRequired requires a churchId');
  if (!provider) throw new Error('notifyReviewRequired requires a provider');

  const safeCounts = stableCounts(counts);
  if (!hasAnyPending(safeCounts)) return { notified: false, adminCount: 0 };

  const fingerprint = fingerprintFor(provider, safeCounts);
  const previousFingerprint = await runRepository.findLatestReviewNotificationFingerprint(churchId, provider);

  if (fingerprint === previousFingerprint) {
    if (runId) {
      // Best-effort continuity tag only — dedup correctness above does not
      // depend on this write succeeding (the comparison already used the
      // most recent existing fingerprint regardless of which run it lives
      // on), so a failure here must never surface as a notify failure.
      await runRepository.setReviewNotificationFingerprint(runId, churchId, provider, fingerprint).catch(() => {});
    }
    return { notified: false, adminCount: 0 };
  }

  const admins = await Database.queryForChurch(
    churchId,
    `SELECT id FROM users WHERE role IN (${NOTIFIABLE_ROLES.map(() => '?').join(',')}) AND is_active = 1 AND church_id = ?`,
    [...NOTIFIABLE_ROLES, churchId]
  );
  const message = buildReviewMessage(provider, safeCounts);
  const title = `${providerLabel(provider)} sync needs your review`;
  for (const admin of admins) {
    await Database.queryForChurch(
      churchId,
      `INSERT INTO notifications (user_id, title, message, notification_type, church_id)
       VALUES (?, ?, ?, 'system', ?)`,
      [admin.id, title, message, churchId]
    );
  }

  if (runId) {
    await runRepository.setReviewNotificationFingerprint(runId, churchId, provider, fingerprint);
  }

  return { notified: true, adminCount: admins.length };
}

module.exports = { notifyReviewRequired, buildReviewMessage };
