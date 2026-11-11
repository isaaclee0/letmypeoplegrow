const { randomUUID } = require('crypto');
const Database = require('../config/database');

function referralError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Reserve before contacting the provider so concurrent requests cannot send twice.
function reserve(email, user) {
  const registry = Database.getRegistryDb();
  return registry.transaction(() => {
    if (Database.lookupChurchByEmail(email)) {
      throw referralError(409, 'This email is already registered. Ask them to sign in instead.');
    }
    const recent = registry.prepare(`SELECT id FROM organisation_referrals
      WHERE email = ? AND last_attempt_at > datetime('now', '-1 minute') LIMIT 1`).get(email);
    if (recent) throw referralError(429, 'Please wait a minute before sending another invitation to this address.');

    const previous = registry.prepare('SELECT redeemed_at FROM organisation_referrals WHERE church_id = ? AND email = ?')
      .get(user.church_id, email);
    if (previous?.redeemed_at) throw referralError(409, 'This referral has already been used.');

    const attemptId = randomUUID();
    registry.prepare(`INSERT INTO organisation_referrals (church_id, invited_by, referrer_name, email, attempt_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(church_id, email) DO UPDATE SET
        invited_by = excluded.invited_by, referrer_name = excluded.referrer_name,
        attempt_id = excluded.attempt_id, last_attempt_at = datetime('now'), delivery_failed = 0`)
      .run(user.church_id, user.id, [user.first_name, user.last_name].filter(Boolean).join(' ') || 'An admin', email, attemptId);
    return registry.prepare('SELECT id, attempt_id FROM organisation_referrals WHERE church_id = ? AND email = ?')
      .get(user.church_id, email);
  }).immediate();
}

function recordDelivery(referral, churchId, succeeded) {
  Database.getRegistryDb().prepare(succeeded
    ? `UPDATE organisation_referrals SET sent_at = datetime('now'), expires_at = datetime('now', '+30 days'), delivery_failed = 0
       WHERE id = ? AND church_id = ? AND attempt_id = ? AND redeemed_at IS NULL`
    : `UPDATE organisation_referrals SET delivery_failed = 1
       WHERE id = ? AND church_id = ? AND attempt_id = ? AND redeemed_at IS NULL`)
    .run(referral.id, churchId, referral.attempt_id);
}

const listColumns = `r.id, r.email, r.referrer_name, r.sent_at, r.expires_at, r.last_attempt_at,
  r.delivery_failed, r.registered_church_id,
  CASE WHEN r.redeemed_at IS NOT NULL THEN 'registered'
    WHEN r.sent_at IS NOT NULL AND r.expires_at > datetime('now') THEN 'pre_approved'
    WHEN r.delivery_failed = 1 THEN 'failed'
    WHEN r.sent_at IS NOT NULL THEN 'expired'
    ELSE 'sending' END AS status`;

function listForChurch(churchId) {
  return Database.getRegistryDb().prepare(`SELECT ${listColumns} FROM organisation_referrals r
    WHERE r.church_id = ? ORDER BY r.last_attempt_at DESC, r.id DESC LIMIT 100`).all(churchId);
}

// Used only by the separate, internal admin server.
function listForPlatform() {
  return Database.getRegistryDb().prepare(`SELECT ${listColumns}, r.church_id,
    c.church_name AS referring_church_name, target.church_name AS registered_church_name
    FROM organisation_referrals r LEFT JOIN churches c ON c.church_id = r.church_id
    LEFT JOIN churches target ON target.church_id = r.registered_church_id
    ORDER BY r.last_attempt_at DESC, r.id DESC LIMIT 200`).all();
}

// Called within registration's registry transaction, before publishing success.
function redeem(email, newChurchId) {
  const registry = Database.getRegistryDb();
  const candidates = registry.prepare(`SELECT r.* FROM organisation_referrals r
    JOIN churches c ON c.church_id = r.church_id AND c.is_approved = 1
    WHERE r.email = ? AND r.sent_at IS NOT NULL AND r.expires_at > datetime('now')
      AND r.redeemed_at IS NULL ORDER BY r.sent_at, r.id`).all(email);
  for (const referral of candidates) {
    const admin = Database.getChurchDb(referral.church_id).prepare(`SELECT id FROM users
      WHERE id = ? AND church_id = ? AND role = 'admin' AND is_active = 1`)
      .get(referral.invited_by, referral.church_id);
    if (!admin) continue;
    // Consume every invitation for this email, so none can approve a second signup.
    registry.prepare(`UPDATE organisation_referrals SET redeemed_at = datetime('now'), registered_church_id = ?
      WHERE email = ? AND redeemed_at IS NULL`).run(newChurchId, email);
    Database.approveChurch(newChurchId, true);
    return true;
  }
  return false;
}

module.exports = { reserve, recordDelivery, listForChurch, listForPlatform, redeem };
