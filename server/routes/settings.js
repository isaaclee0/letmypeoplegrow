const express = require('express');
const https = require('https');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get church settings
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const settings = await Database.query(`
      SELECT
        cs.id,
        cs.church_name,
        cs.country_code,
        cs.timezone,
        cs.email_from_name,
        cs.email_from_address,
        cs.onboarding_completed,
        cs.location_name,
        cs.location_lat,
        cs.location_lng,
        cs.child_flair_color,
        cs.default_badge_text,
        cs.default_child_badge_icon,
        cs.default_adult_badge_text,
        cs.default_adult_badge_color,
        cs.default_adult_badge_icon,
        cs.created_at,
        cs.updated_at
      FROM church_settings cs
      WHERE cs.church_id = ?
      LIMIT 1
    `, [req.user.church_id]);

    if (settings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ settings: settings[0] });
  } catch (error) {
    console.error('Get church settings error:', error);
    res.status(500).json({ error: 'Failed to retrieve church settings.' });
  }
});

// Get badge defaults (accessible to all authenticated users)
router.get('/badge-defaults', async (req, res) => {
  try {
    const settings = await Database.query(`
      SELECT
        default_badge_text,
        child_flair_color,
        default_child_badge_icon,
        default_adult_badge_text,
        default_adult_badge_color,
        default_adult_badge_icon
      FROM church_settings
      WHERE church_id = ?
      LIMIT 1
    `, [req.user.church_id]);

    if (settings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ settings: settings[0] });
  } catch (error) {
    console.error('Get badge defaults error:', error);
    res.status(500).json({ error: 'Failed to retrieve badge defaults.' });
  }
});

// Update data access setting
// DISABLED: External data access feature is currently disabled
/*
router.put('/data-access', requireRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean value' });
    }

    // Since there's no data_access_enabled column, we'll return a success response
    // indicating that data access is always enabled for now
    res.json({ 
      message: `Data access is always enabled in this version`,
      dataAccessEnabled: true
    });
  } catch (error) {
    console.error('Update data access setting error:', error);
    res.status(500).json({ error: 'Failed to update data access setting.' });
  }
});

// Get data access setting only
router.get('/data-access', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    // Since there's no data_access_enabled column, we'll return true
    // indicating that data access is always enabled for now
    res.json({ dataAccessEnabled: true });
  } catch (error) {
    console.error('Get data access setting error:', error);
    res.status(500).json({ error: 'Failed to retrieve data access setting.' });
  }
});
*/

// Return 404 for data access endpoints since feature is disabled
router.put('/data-access', (req, res) => {
  res.status(404).json({ 
    error: 'External data access feature is currently disabled',
    message: 'This feature has been temporarily disabled'
  });
});

router.get('/data-access', (req, res) => {
  res.status(404).json({ 
    error: 'External data access feature is currently disabled',
    message: 'This feature has been temporarily disabled'
  });
});

// Get Elvanto configuration (admin only)
router.get('/elvanto-config', requireRole(['admin']), async (req, res) => {
  try {
    const settings = await Database.query(`
      SELECT 
        elvanto_client_id,
        elvanto_redirect_uri,
        CASE 
          WHEN elvanto_client_secret IS NOT NULL AND elvanto_client_secret != '' THEN 1 
          ELSE 0 
        END as has_client_secret
      FROM church_settings
      WHERE church_id = ?
      LIMIT 1
    `, [req.user.church_id]);

    if (settings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ 
      clientId: settings[0].elvanto_client_id || null,
      redirectUri: settings[0].elvanto_redirect_uri || null,
      hasClientSecret: settings[0].has_client_secret === 1
    });
  } catch (error) {
    console.error('Get Elvanto config error:', error);
    res.status(500).json({ error: 'Failed to retrieve Elvanto configuration.' });
  }
});

// Update Elvanto configuration (admin only)
router.put('/elvanto-config', requireRole(['admin']), async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri } = req.body;

    // Validate required fields
    if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
      return res.status(400).json({ error: 'Client ID is required' });
    }

    if (!redirectUri || typeof redirectUri !== 'string' || redirectUri.trim() === '') {
      return res.status(400).json({ error: 'Redirect URI is required' });
    }

    // Validate redirect URI format
    try {
      new URL(redirectUri);
    } catch (e) {
      return res.status(400).json({ error: 'Redirect URI must be a valid URL' });
    }

    // Check if settings exist
    const existingSettings = await Database.query(
      'SELECT id FROM church_settings WHERE church_id = ? LIMIT 1',
      [req.user.church_id]
    );

    if (existingSettings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    // Update Elvanto configuration
    // Only update client_secret if provided (allows updating other fields without changing secret)
    if (clientSecret !== undefined && clientSecret !== null) {
      await Database.query(`
        UPDATE church_settings
        SET elvanto_client_id = ?,
            elvanto_client_secret = ?,
            elvanto_redirect_uri = ?,
            updated_at = datetime('now')
        WHERE church_id = ?
      `, [clientId.trim(), clientSecret.trim(), redirectUri.trim(), req.user.church_id]);
    } else {
      await Database.query(`
        UPDATE church_settings
        SET elvanto_client_id = ?,
            elvanto_redirect_uri = ?,
            updated_at = datetime('now')
        WHERE church_id = ?
      `, [clientId.trim(), redirectUri.trim(), req.user.church_id]);
    }

    res.json({ 
      message: 'Elvanto configuration updated successfully',
      clientId: clientId.trim(),
      redirectUri: redirectUri.trim(),
      hasClientSecret: clientSecret !== undefined && clientSecret !== null && clientSecret.trim() !== ''
    });
  } catch (error) {
    console.error('Update Elvanto config error:', error);
    res.status(500).json({ error: 'Failed to update Elvanto configuration.' });
  }
});

// ===== Location endpoints =====

// Helper: make HTTPS GET request
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'User-Agent': 'LetMyPeopleGrow/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

// Search cities via Open-Meteo geocoding (free, no API key)
router.get('/location-search', requireRole(['admin']), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ results: [] });
    }

    const data = await httpsGet(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=8&language=en&format=json`
    );

    const results = (data.results || []).map(r => ({
      name: r.name,
      admin1: r.admin1 || null,
      country: r.country || null,
      countryCode: r.country_code || null,
      lat: r.latitude,
      lng: r.longitude,
      displayName: [r.name, r.admin1, r.country].filter(Boolean).join(', ')
    }));

    res.json({ results });
  } catch (error) {
    console.error('Location search error:', error);
    res.status(500).json({ error: 'Failed to search locations.' });
  }
});

// Update church location (admin only)
router.put('/location', requireRole(['admin']), async (req, res) => {
  try {
    const { name, lat, lng } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Location name is required.' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Valid latitude and longitude are required.' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Latitude/longitude out of range.' });
    }

    const existing = await Database.query(
      'SELECT id FROM church_settings WHERE church_id = ? LIMIT 1',
      [req.user.church_id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Church settings not found.' });
    }

    await Database.query(`
      UPDATE church_settings
      SET location_name = ?, location_lat = ?, location_lng = ?, updated_at = datetime('now')
      WHERE church_id = ?
    `, [name.trim(), lat, lng, req.user.church_id]);

    res.json({
      message: 'Location updated successfully.',
      location: { name: name.trim(), lat, lng }
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location.' });
  }
});

// Update child flair color
router.put('/child-flair-color', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { color } = req.body;

    // Validate hex color format
    if (!color || !/^#[0-9A-F]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'Invalid color format. Must be a hex color (e.g., #fef3c7)' });
    }

    await Database.query(`
      UPDATE church_settings
      SET child_flair_color = ?
      WHERE church_id = ?
    `, [color, req.user.church_id]);

    res.json({
      message: 'Child flair color updated successfully.',
      color
    });
  } catch (error) {
    console.error('Update child flair color error:', error);
    res.status(500).json({ error: 'Failed to update child flair color.' });
  }
});

// Update default badge settings (text, color, icon for both child and adult)
router.put('/default-badge', requireRole(['admin']), async (req, res) => {
  try {
    const {
      child_text,
      child_color,
      child_icon,
      adult_text,
      adult_color,
      adult_icon
    } = req.body;

    // Validate inputs
    if (child_text !== undefined && (typeof child_text !== 'string' || child_text.length > 50)) {
      return res.status(400).json({ error: 'Child badge text must be a string (max 50 characters)' });
    }
    if (child_color !== undefined && !/^#[0-9A-F]{6}$/i.test(child_color)) {
      return res.status(400).json({ error: 'Invalid child color format. Must be a hex color (e.g., #fef3c7)' });
    }
    if (child_icon !== undefined && (typeof child_icon !== 'string' || child_icon.length > 50)) {
      return res.status(400).json({ error: 'Child badge icon must be a string (max 50 characters)' });
    }
    if (adult_text !== undefined && adult_text !== null && adult_text !== '' && (typeof adult_text !== 'string' || adult_text.length > 50)) {
      return res.status(400).json({ error: 'Adult badge text must be a string (max 50 characters)' });
    }
    if (adult_color !== undefined && adult_color !== null && adult_color !== '' && !/^#[0-9A-F]{6}$/i.test(adult_color)) {
      return res.status(400).json({ error: 'Invalid adult color format. Must be a hex color (e.g., #fef3c7)' });
    }
    if (adult_icon !== undefined && adult_icon !== null && adult_icon !== '' && (typeof adult_icon !== 'string' || adult_icon.length > 50)) {
      return res.status(400).json({ error: 'Adult badge icon must be a string (max 50 characters)' });
    }

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];

    if (child_text !== undefined) {
      updates.push('default_badge_text = ?');
      values.push(child_text);
    }
    if (child_color !== undefined) {
      updates.push('child_flair_color = ?');
      values.push(child_color);
    }
    if (child_icon !== undefined) {
      updates.push('default_child_badge_icon = ?');
      values.push(child_icon);
    }
    if (adult_text !== undefined) {
      updates.push('default_adult_badge_text = ?');
      values.push(adult_text);
    }
    if (adult_color !== undefined) {
      updates.push('default_adult_badge_color = ?');
      values.push(adult_color);
    }
    if (adult_icon !== undefined) {
      updates.push('default_adult_badge_icon = ?');
      values.push(adult_icon);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user.church_id);

    await Database.query(`
      UPDATE church_settings
      SET ${updates.join(', ')}
      WHERE church_id = ?
    `, values);

    res.json({
      message: 'Default badge settings updated successfully.'
    });
  } catch (error) {
    console.error('Update default badge error:', error);
    res.status(500).json({ error: 'Failed to update default badge settings.' });
  }
});

// ===== Weekly Review Email endpoints =====

// Get weekly review settings
router.get('/weekly-review', requireRole(['admin']), async (req, res) => {
  try {
    const settings = await Database.query(`
      SELECT weekly_review_email_enabled, weekly_review_email_day,
             weekly_review_email_include_insight, weekly_review_email_last_sent,
             caregiver_absence_threshold
      FROM church_settings WHERE church_id = ? LIMIT 1
    `, [req.user.church_id]);

    if (settings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    // Detect send day if not manually set
    const { detectSendDay } = require('../services/weeklyReview');
    const detectedDay = await detectSendDay(req.user.church_id);

    res.json({
      enabled: !!settings[0].weekly_review_email_enabled,
      day: settings[0].weekly_review_email_day,
      detectedDay,
      includeInsight: !!settings[0].weekly_review_email_include_insight,
      lastSent: settings[0].weekly_review_email_last_sent,
      caregiverAbsenceThreshold: settings[0].caregiver_absence_threshold ?? 3,
    });
  } catch (error) {
    console.error('Get weekly review settings error:', error);
    res.status(500).json({ error: 'Failed to retrieve weekly review settings.' });
  }
});

// Update weekly review settings
router.put('/weekly-review', requireRole(['admin']), async (req, res) => {
  try {
    const { enabled, day, includeInsight, caregiverAbsenceThreshold } = req.body;

    const updates = [];
    const values = [];

    if (typeof enabled === 'boolean') {
      updates.push('weekly_review_email_enabled = ?');
      values.push(enabled ? 1 : 0);
    }
    if (day !== undefined) {
      const validDays = [null, 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      if (!validDays.includes(day)) {
        return res.status(400).json({ error: 'Invalid day value' });
      }
      updates.push('weekly_review_email_day = ?');
      values.push(day);
    }
    if (caregiverAbsenceThreshold !== undefined) {
      const threshold = parseInt(caregiverAbsenceThreshold, 10);
      if (!isNaN(threshold) && threshold >= 1 && threshold <= 20) {
        updates.push('caregiver_absence_threshold = ?');
        values.push(threshold);
      }
    }
    if (typeof includeInsight === 'boolean') {
      updates.push('weekly_review_email_include_insight = ?');
      values.push(includeInsight ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user.church_id);
    await Database.query(
      `UPDATE church_settings SET ${updates.join(', ')} WHERE church_id = ?`,
      values
    );

    res.json({ message: 'Weekly review settings updated successfully' });
  } catch (error) {
    console.error('Update weekly review settings error:', error);
    res.status(500).json({ error: 'Failed to update weekly review settings.' });
  }
});

// Send test weekly review email
router.post('/weekly-review/test', requireRole(['admin']), async (req, res) => {
  try {
    const { generateWeeklyReviewData } = require('../services/weeklyReview');
    const { generateInsight, saveInsightAsConversation } = require('../services/weeklyReviewInsight');
    const { sendWeeklyReviewEmail } = require('../utils/email');

    // Get requesting user's info
    const users = await Database.query(
      `SELECT id, first_name, email FROM users WHERE id = ? AND church_id = ? LIMIT 1`,
      [req.user.id, req.user.church_id]
    );

    if (users.length === 0 || !users[0].email) {
      return res.status(400).json({ error: 'Your account does not have an email address configured.' });
    }

    const reviewData = await generateWeeklyReviewData(req.user.church_id);
    if (!reviewData) {
      return res.status(400).json({ error: 'No attendance data found for the past week. Record some attendance first.' });
    }

    // Check if insight is enabled
    const settings = await Database.query(
      `SELECT weekly_review_email_include_insight FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const includeInsight = settings.length > 0 && settings[0].weekly_review_email_include_insight;

    let insight = null;
    if (includeInsight) {
      const isDev = process.env.NODE_ENV === 'development';
      insight = await generateInsight(reviewData, { forceAlgorithmic: !isDev });
    }

    await sendWeeklyReviewEmail(users[0].email, users[0].first_name, reviewData, insight);

    // Save insight as AI conversation for follow-up
    if (insight) {
      const weekLabel = `${reviewData.weekStartDate} to ${reviewData.weekEndDate}`;
      await saveInsightAsConversation(req.user.church_id, users[0].id, insight, weekLabel);
    }

    res.json({ message: `Test email sent to ${users[0].email}` });
  } catch (error) {
    console.error('Send test weekly review email error:', error);
    res.status(500).json({ error: 'Failed to send test email.' });
  }
});

// Send test caregiver digest emails
router.post('/caregiver-digest/test', requireRole(['admin']), async (req, res) => {
  try {
    const { generateCaregiverDigests, sendWeeklyCaregiverDigests } = require('../services/weeklyCaregiverEmail');

    // Call generateCaregiverDigests directly so any SQL/config errors surface
    const digests = await generateCaregiverDigests(req.user.church_id);

    if (digests.length === 0) {
      return res.json({ message: 'No caregiver digest emails to send — no caregivers have assigned families with recent absences.' });
    }

    const sent = await sendWeeklyCaregiverDigests(req.user.church_id);
    res.json({ message: `${sent} caregiver digest email${sent !== 1 ? 's' : ''} sent (${digests.length} caregiver${digests.length !== 1 ? 's' : ''} had qualifying absences).` });
  } catch (error) {
    console.error('Send test caregiver digest error:', error);
    res.status(500).json({ error: `Failed to generate caregiver digests: ${error.message}` });
  }
});

module.exports = router;