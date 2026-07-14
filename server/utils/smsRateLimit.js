const Database = require('../config/database');

const DEFAULT_MIN_INTERVAL_SECONDS = 60;
const DEFAULT_DAILY_LIMIT = 10;
const RETENTION_DAYS = 2;

function getMinIntervalSeconds() {
  return parseInt(process.env.OTC_RESEND_COOLDOWN_SECONDS, 10) || DEFAULT_MIN_INTERVAL_SECONDS;
}

function getDailyLimit() {
  return parseInt(process.env.OTC_SMS_DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT;
}

// Spend-abuse guardrails for SMS OTC sends: a per-contact resend cooldown and
// a per-contact daily cap, backed by sms_send_log. Deliberately not backed by
// otc_codes, since that table's expired/used rows get wiped on the contact's
// next request and can't serve as a reliable send history.
async function checkSmsSendAllowed(churchId, contactIdentifier) {
  const cooldownRows = await Database.queryForChurch(
    churchId,
    `SELECT COUNT(*) AS count FROM sms_send_log
     WHERE contact_identifier = ? AND sent_at > datetime('now', ?)`,
    [contactIdentifier, `-${getMinIntervalSeconds()} seconds`]
  );
  if (cooldownRows[0].count > 0) {
    return { allowed: false, reason: 'cooldown' };
  }

  const dailyRows = await Database.queryForChurch(
    churchId,
    `SELECT COUNT(*) AS count FROM sms_send_log
     WHERE contact_identifier = ? AND sent_at > datetime('now', '-1 day')`,
    [contactIdentifier]
  );
  if (dailyRows[0].count >= getDailyLimit()) {
    return { allowed: false, reason: 'daily_limit' };
  }

  return { allowed: true };
}

async function recordSmsSend(churchId, contactIdentifier) {
  await Database.queryForChurch(
    churchId,
    `INSERT INTO sms_send_log (church_id, contact_identifier) VALUES (?, ?)`,
    [churchId, contactIdentifier]
  );
  await Database.queryForChurch(
    churchId,
    `DELETE FROM sms_send_log WHERE sent_at < datetime('now', ?)`,
    [`-${RETENTION_DAYS} days`]
  );
}

module.exports = { checkSmsSendAllowed, recordSmsSend };
