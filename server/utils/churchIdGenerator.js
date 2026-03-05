const Database = require('../config/database');
const crypto = require('crypto');

const generateSecureChurchId = async (churchName) => {
  const baseId = churchName.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 3) || 'chr';
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const secureId = `${baseId}_${randomSuffix}`;

  const existing = Database.listChurches().find(c => c.church_id === secureId);
  if (existing) {
    return generateSecureChurchId(churchName);
  }
  return secureId;
};

const generateSimpleChurchId = async (churchName) => {
  const baseId = churchName.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 3) || 'chr';
  const randomSuffix = crypto.randomBytes(3).toString('hex');
  const developmentId = `${baseId}_${randomSuffix}`;

  const existing = Database.listChurches().find(c => c.church_id === developmentId);
  if (existing) {
    return generateSimpleChurchId(churchName);
  }
  return developmentId;
};

const getOrCreateChurchId = async (churchName) => {
  try {
    const churches = Database.listChurches();
    const existing = churches.find(c => c.church_name === churchName);
    if (existing) {
      return existing.church_id;
    }

    let newChurchId;
    if (process.env.NODE_ENV === 'production') {
      newChurchId = await generateSecureChurchId(churchName);
    } else {
      newChurchId = await generateSimpleChurchId(churchName);
    }

    Database.ensureChurch(newChurchId, churchName);

    await Database.setChurchContext(newChurchId, async () => {
      try {
        await Database.query(
          `INSERT INTO church_settings (church_id, church_name, country_code, timezone, onboarding_completed)
           VALUES (?, ?, 'AU', 'Australia/Sydney', 0)`,
          [newChurchId, churchName]
        );
        console.log(`✅ Created church_settings for "${churchName}" with ID: ${newChurchId}`);
      } catch (insertError) {
        console.warn(`⚠️ Could not create church_settings for ${newChurchId}:`, insertError.message);
      }
    });

    return newChurchId;
  } catch (error) {
    console.error('Error getting or creating church ID:', error);
    throw error;
  }
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
  getOrCreateChurchId,
  isValidChurchId,
  sanitizeChurchIdForLogging
};
