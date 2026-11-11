const Database = require('../config/database');
const crypto = require('crypto');

const churchIdCandidate = (churchName, randomBytes) => {
  const baseId = churchName.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 3) || 'chr';
  return `${baseId.padEnd(3, 'x')}_${crypto.randomBytes(randomBytes).toString('hex')}`;
};

const generateUnusedChurchId = (churchName, randomBytes) => {
  const churchIds = new Set(Database.listChurches().map(church => church.church_id));
  let candidate;
  do {
    candidate = churchIdCandidate(churchName, randomBytes);
  } while (churchIds.has(candidate));
  return candidate;
};

const generateSecureChurchId = async (churchName) => generateUnusedChurchId(churchName, 6);
const generateSimpleChurchId = async (churchName) => generateUnusedChurchId(churchName, 3);

// Claim a new pending registry row. A name match is never proof of membership,
// and an ID collision must be retried before opening any church database.
const reserveNewChurchId = (churchName) => {
  const registry = Database.getRegistryDb();
  const insert = registry.prepare(`
    INSERT INTO churches (church_id, church_name) VALUES (?, ?)
    ON CONFLICT(church_id) DO NOTHING
  `);
  const randomBytes = process.env.NODE_ENV === 'production' ? 6 : 3;
  let candidate;
  do {
    candidate = churchIdCandidate(churchName, randomBytes);
  } while (!insert.run(candidate, churchName).changes);
  return candidate;
};

const isValidChurchId = (churchId) => {
  if (!churchId || typeof churchId !== 'string') return false;
  if (/^[a-z0-9]{3}_[a-f0-9]{12}$/.test(churchId)) return true;
  if (/^[a-z0-9]{3}_[a-f0-9]{6}$/.test(churchId)) return true;
  if (/^[a-z0-9]{1,20}\d*$/.test(churchId)) return true;
  return false;
};

const sanitizeChurchIdForLogging = (churchId) => {
  if (!churchId) return 'null';
  if (churchId.includes('_')) {
    const parts = churchId.split('_');
    return `${parts[0]}_**${churchId.slice(-4)}`;
  }
  return churchId;
};

module.exports = {
  generateSecureChurchId,
  generateSimpleChurchId,
  reserveNewChurchId,
  isValidChurchId,
  sanitizeChurchIdForLogging
};
