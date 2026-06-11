const cron = require('node-cron');
const Database = require('../config/database');
const { generateWeeklyReviewData, detectSendDay } = require('./weeklyReview');
const { generateInsight, saveInsightAsConversation } = require('./weeklyReviewInsight');
const { sendWeeklyReviewEmail } = require('../utils/email');
const { sendWeeklyCaregiverDigests } = require('./weeklyCaregiverEmail');
const { shouldNudgeForGuidance } = require('./weeklyReviewGuidance');

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
 * Get the day name after a given day name.
 */
function getDayAfter(dayName) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const idx = days.indexOf(dayName);
  return days[(idx + 1) % 7];
}

/**
 * Check if the main gathering(s) have attendance data for this week.
 * Returns true if at least one session exists for the most common gathering day.
 */
async function hasMainGatheringData(churchId, startDate, endDate) {
  // Find the most common gathering day
  const gatherings = await Database.query(
    `SELECT day_of_week, COUNT(*) as cnt
     FROM gathering_types
     WHERE is_active = 1 AND day_of_week IS NOT NULL AND church_id = ?
     GROUP BY day_of_week
     ORDER BY cnt DESC
     LIMIT 1`,
    [churchId]
  );

  if (gatherings.length === 0) return true; // no day info, can't check — proceed

  const mainDay = gatherings[0].day_of_week;

  // Check if any session exists for a gathering on that day within the week window
  const sessions = await Database.query(
    `SELECT 1 FROM attendance_sessions s
     JOIN gathering_types gt ON gt.id = s.gathering_type_id
     WHERE gt.day_of_week = ? AND s.session_date >= ? AND s.session_date <= ? AND s.church_id = ?
       AND s.excluded_from_stats = 0
     LIMIT 1`,
    [mainDay, startDate, endDate, churchId]
  );

  return sessions.length > 0;
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

      // Allow sending on the primary send day OR the day after (retry)
      const retryDay = getDayAfter(sendDay);
      const isPrimaryDay = localDay === sendDay;
      const isRetryDay = localDay === retryDay;

      if (!isPrimaryDay && !isRetryDay) return;

      // Check for duplicate sends this week
      if (wasSentThisWeek(s.weekly_review_email_last_sent)) return;

      // Generate review data
      const reviewData = await generateWeeklyReviewData(churchId);
      if (!reviewData) {
        console.log(`Weekly review: No attendance data for church ${churchId}, skipping`);
        return;
      }

      // On the primary send day, check if the main gathering has data yet.
      // If not, defer to the retry day (gives people time to enter data).
      if (isPrimaryDay) {
        const now = new Date();
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        const hasData = await hasMainGatheringData(
          churchId,
          weekAgo.toISOString().split('T')[0],
          now.toISOString().split('T')[0]
        );
        if (!hasData) {
          console.log(`Weekly review: Main gathering data not yet entered for church ${churchId}, deferring to ${retryDay}`);
          return;
        }
      }

      // Decide whether to nudge the church to set up AI guidance.
      const NUDGE_TITLE = 'Sharpen your weekly insights';
      const guidanceRow = await Database.query(
        `SELECT weekly_review_guidance FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId]
      );
      const hasGuidance = !!(guidanceRow[0]?.weekly_review_guidance || '').trim();

      // Only run the extra people/pending lookups when a nudge is even possible
      // (guidance not yet set). Established churches short-circuit here.
      let nudgeGuidance = false;
      if (!hasGuidance) {
        const peopleRow = await Database.query(
          `SELECT COUNT(*) as cnt FROM individuals WHERE is_active = 1 AND church_id = ?`,
          [churchId]
        );
        const peopleCount = peopleRow[0]?.cnt || 0;

        const pendingRow = await Database.query(
          `SELECT COUNT(*) as cnt FROM notifications
           WHERE church_id = ? AND notification_type = 'system' AND title = ? AND is_read = 0`,
          [churchId, NUDGE_TITLE]
        );
        const pendingNudge = (pendingRow[0]?.cnt || 0) > 0;

        nudgeGuidance = shouldNudgeForGuidance({
          hasGuidance,
          gatheringCount: reviewData.gatherings.length,
          peopleCount,
          weeksTracked: reviewData.weeklyTotals.length,
          pendingNudge,
        });
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
          await sendWeeklyReviewEmail(recipient.email, recipient.first_name, reviewData, insight, { showGuidanceNudge: nudgeGuidance });
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

      // One-time in-app nudge to admins/coordinators to set up AI guidance.
      if (nudgeGuidance) {
        const admins = await Database.query(
          `SELECT id FROM users
           WHERE role IN ('admin', 'coordinator') AND is_active = 1 AND church_id = ?`,
          [churchId]
        );
        for (const admin of admins) {
          await Database.query(
            `INSERT INTO notifications (user_id, title, message, notification_type, church_id)
             VALUES (?, ?, ?, 'system', ?)`,
            [admin.id, NUDGE_TITLE,
             'Tell us a little about your gatherings so the weekly AI insight understands your context (e.g. which gatherings are youth groups). Set it up under Settings → Weekly Review Email.',
             churchId]
          );
        }
        console.log(`Weekly review: created guidance nudge for ${admins.length} user(s) in church ${churchId}`);
      }

      // Send caregiver digest emails on the same day
      await sendWeeklyCaregiverDigests(churchId);
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
