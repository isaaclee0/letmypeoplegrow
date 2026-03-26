const cron = require('node-cron');
const Database = require('../config/database');
const { generateWeeklyReviewData, detectSendDay } = require('./weeklyReview');
const { generateInsight, saveInsightAsConversation } = require('./weeklyReviewInsight');
const { sendWeeklyReviewEmail } = require('../utils/email');

let cronJob = null;

/**
 * Get the current local hour for a given timezone.
 */
function getLocalHour(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone
    });
    return parseInt(formatter.format(now), 10);
  } catch {
    return new Date().getUTCHours();
  }
}

/**
 * Get the current local day name for a given timezone.
 */
function getLocalDayName(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: timezone
    });
    return formatter.format(now);
  } catch {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[new Date().getDay()];
  }
}

/**
 * Get the current local date string (YYYY-MM-DD) for a given timezone.
 */
function getLocalDateString(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }); // en-CA gives YYYY-MM-DD
    return formatter.format(now);
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Check if the last_sent date is within the current week (last 6 days).
 */
function wasSentThisWeek(lastSent) {
  if (!lastSent) return false;
  const sent = new Date(lastSent);
  const now = new Date();
  const diffMs = now - sent;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays < 6; // prevent duplicate within same week
}

/**
 * Process a single church for weekly review email.
 */
async function processChurch(church) {
  const churchId = church.church_id;

  try {
    await Database.setChurchContext(churchId, async () => {
      // Get church settings
      const settings = await Database.query(
        `SELECT weekly_review_email_enabled, weekly_review_email_day,
                weekly_review_email_include_insight, weekly_review_email_last_sent,
                timezone
         FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId]
      );

      if (settings.length === 0) return;
      const s = settings[0];

      // Check if enabled
      if (!s.weekly_review_email_enabled) return;

      const timezone = s.timezone || 'UTC';
      const localHour = getLocalHour(timezone);

      // Only send between 7-8 AM local time
      if (localHour !== 7) return;

      const localDay = getLocalDayName(timezone);

      // Determine send day
      let sendDay = s.weekly_review_email_day;
      if (!sendDay) {
        sendDay = await detectSendDay(churchId);
      }

      if (localDay !== sendDay) return;

      // Check for duplicate sends this week
      if (wasSentThisWeek(s.weekly_review_email_last_sent)) return;

      // Generate review data
      const reviewData = await generateWeeklyReviewData(churchId);
      if (!reviewData) {
        console.log(`Weekly review: No attendance data for church ${churchId}, skipping`);
        return;
      }

      // Generate insight
      let insight = null;
      if (s.weekly_review_email_include_insight) {
        insight = await generateInsight(reviewData);
      }

      // Send to each recipient and save insight as conversation
      let sentCount = 0;
      const weekLabel = `${reviewData.weekStartDate} to ${reviewData.weekEndDate}`;
      for (const recipient of reviewData.recipients) {
        try {
          await sendWeeklyReviewEmail(recipient.email, recipient.first_name, reviewData, insight);
          sentCount++;
          // Save insight as AI conversation so user can follow up
          if (insight) {
            await saveInsightAsConversation(churchId, recipient.id, insight, weekLabel);
          }
        } catch (err) {
          console.error(`Weekly review: Failed to send to ${recipient.email}:`, err.message);
        }
      }

      // Update last sent date
      const localDate = getLocalDateString(timezone);
      await Database.query(
        `UPDATE church_settings SET weekly_review_email_last_sent = ? WHERE church_id = ?`,
        [localDate, churchId]
      );

      if (sentCount > 0) {
        console.log(`Weekly review: Sent ${sentCount} email(s) for church ${churchId} (${reviewData.churchName})`);
      }
    });
  } catch (err) {
    console.error(`Weekly review: Error processing church ${churchId}:`, err.message);
  }
}

/**
 * Start the weekly review scheduler.
 * Runs every hour and checks each church's timezone for 7 AM send window.
 */
function start() {
  if (cronJob) {
    cronJob.stop();
  }

  cronJob = cron.schedule('0 * * * *', async () => {
    try {
      const churches = Database.listChurches();
      for (const church of churches) {
        await processChurch(church);
      }
    } catch (err) {
      console.error('Weekly review scheduler error:', err.message);
    }
  });

  console.log('Weekly review scheduler started (hourly check)');
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('Weekly review scheduler stopped');
  }
}

module.exports = { start, stop, processChurch };
