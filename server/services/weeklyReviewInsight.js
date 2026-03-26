const https = require('https');

const PLATFORM_API_KEY = process.env.PLATFORM_ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = 'You are an attendance analyst for a church. Given this week\'s data, provide ONE brief, actionable insight (2-3 sentences). Pick the single most noteworthy pattern from: engagement changes among regulars, local visitor retention, cross-gathering trends, or family attendance shifts. Be warm and pastoral in tone. Do not use markdown formatting. Use the real names provided — they will appear in an email to church leaders. Local visitors are people the church hopes will return and integrate. Traveller visitors are passing through and not expected to return — do not flag their non-return as a problem.';

/**
 * Check minimum data thresholds for enriched insight.
 */
function meetsMinimumThresholds(reviewData) {
  if ((reviewData.weeklyTotals || []).length < 3) return false;

  // All-headcount churches have no individual-level data for enriched insights
  const hasStandard = (reviewData.gatherings || []).some(g => g.attendanceType === 'standard');
  if (!hasStandard) return false;

  let dataPoints = 0;
  dataPoints += (reviewData.engagementChanges || []).length;
  if (reviewData.visitorRetention?.current?.newCount > 0) dataPoints++;
  dataPoints += (reviewData.crossGatheringTrends || []).filter(t => t.direction !== 'stable').length;
  dataPoints += (reviewData.crossGatheringShifts || []).length;
  dataPoints += (reviewData.familyPatterns || []).length;

  return dataPoints >= 3;
}

function buildContext(reviewData) {
  // Gathering summary (local visitors only)
  const gatheringSummary = (reviewData.gatherings || []).map(g => {
    let line = `${g.name}: ${g.count} attendees on ${g.date}`;
    if (g.deltaPercent !== null) {
      const dir = g.deltaPercent > 0 ? 'up' : g.deltaPercent < 0 ? 'down' : 'flat';
      line += ` (${dir} ${Math.abs(g.deltaPercent)}% vs 3-week avg of ${g.avgPrevious})`;
    }
    if (g.localVisitorCount > 0) line += `, ${g.localVisitorCount} local visitors`;
    return line;
  }).join('\n');

  // Engagement changes
  let engagementSection = '';
  if (reviewData.engagementChanges && reviewData.engagementChanges.length > 0) {
    const lines = reviewData.engagementChanges.map(c => {
      if (c.isFamily) {
        if (c.type === 'disengaging') {
          return `- ${c.familyName} family (${c.memberCount} members): attended ${c.totalAttended}/${c.totalWeeks} weeks, missed last ${c.consecutiveMisses} weeks`;
        } else {
          return `- ${c.familyName} family (${c.memberCount} members): newly consistent — ${c.consecutivePresent} straight weeks`;
        }
      } else {
        const name = `${c.firstName} ${c.lastName}`;
        const familyNote = c.familyName ? ` (${c.familyName} family)` : '';
        if (c.type === 'disengaging') {
          return `- ${name}${familyNote}: attended ${c.totalAttended}/${c.totalWeeks} weeks, missed last ${c.consecutiveMisses} weeks`;
        } else {
          return `- ${name}${familyNote}: newly consistent — ${c.consecutivePresent} straight weeks after sporadic attendance`;
        }
      }
    });
    engagementSection = `\nRegulars with changed patterns (last 8 weeks):\n${lines.join('\n')}`;
  }

  // Visitor retention
  let visitorSection = '';
  if (reviewData.visitorRetention?.current) {
    const cur = reviewData.visitorRetention.current;
    const lines = [];
    lines.push(`- ${cur.newCount} new local visitors, ${cur.returnedCount} returned for 2nd+ visit (${cur.returnRate !== null ? cur.returnRate + '% return rate' : 'no data'})`);
    if (reviewData.visitorRetention.prior.returnRate !== null) {
      lines.push(`- Prior 4-week return rate was ${reviewData.visitorRetention.prior.returnRate}%`);
    }
    for (const v of cur.integrationCandidates) {
      lines.push(`- ${v.first_name} ${v.last_name}: visited ${v.total_visits} times in last month (strong integration candidate)`);
    }
    if (lines.length > 0) {
      visitorSection = `\nLocal visitor retention (last 4 weeks):\n${lines.join('\n')}`;
    }
  }

  // Cross-gathering trends
  let trendSection = '';
  if (reviewData.crossGatheringTrends && reviewData.crossGatheringTrends.length > 0) {
    const lines = reviewData.crossGatheringTrends.map(t => {
      return `- ${t.name}: ${t.direction} (avg ${t.firstAvg} → ${t.secondAvg} over ${t.sessionCount} sessions)`;
    });
    // Individual cross-gathering shifts
    if (reviewData.crossGatheringShifts && reviewData.crossGatheringShifts.length > 0) {
      for (const s of reviewData.crossGatheringShifts) {
        lines.push(`- ${s.firstName} ${s.lastName}: stopped attending ${s.droppedGatherings.join(', ')} but still attends ${s.activeGatherings.join(', ')}`);
      }
    }
    trendSection = `\nCross-gathering patterns:\n${lines.join('\n')}`;
  }

  // Family patterns
  let familySection = '';
  if (reviewData.familyPatterns && reviewData.familyPatterns.length > 0) {
    const lines = reviewData.familyPatterns.map(f => {
      if (f.pattern === 'whole-family-absent') {
        return `- ${f.familyName} family (${f.memberCount} members): whole family absent ${f.fullAbsentWeeks} of last ${f.totalWeeks} weeks (was mostly present before)`;
      } else if (f.pattern === 'partial-attendance') {
        return `- ${f.familyName} family (${f.memberCount} members): only some members attending ${f.partialWeeks} of ${f.totalWeeks} weeks`;
      } else {
        return `- ${f.familyName} family (${f.memberCount} members): newly consistent — full family present last ${f.fullPresentWeeks} weeks`;
      }
    });
    familySection = `\nFamily attendance patterns:\n${lines.join('\n')}`;
  }

  // Weekly totals
  const trendSummary = reviewData.weeklyTotals
    .map(w => `Week of ${w.weekStart}: ${w.total}`)
    .join(', ');

  return `Week: ${reviewData.weekStartDate} to ${reviewData.weekEndDate}

This week's gatherings:
${gatheringSummary}

Total attendance: ${reviewData.totalAttendance}
Total local visitors: ${reviewData.totalLocalVisitors}
${engagementSection}${visitorSection}${trendSection}${familySection}

Weekly totals (last 8 weeks):
${trendSummary}`;
}

/**
 * Generate one AI insight for the weekly review email.
 * Uses the platform-level Anthropic API key (LMPG-owned), not the church's own config.
 *
 * @param {object} reviewData - The weekly review data from generateWeeklyReviewData
 * @param {object} [options]
 * @param {boolean} [options.forceAlgorithmic] - Skip AI and use algorithmic insight (e.g. to avoid spending credits on test emails)
 * @returns {string} The insight text (HTML-safe)
 */
async function generateInsight(reviewData, options = {}) {
  if (options.forceAlgorithmic) {
    return generateAlgorithmicInsight(reviewData);
  }

  if (!PLATFORM_API_KEY) {
    return generateAlgorithmicInsight(reviewData);
  }

  // Check minimum data thresholds
  if (!meetsMinimumThresholds(reviewData)) {
    return generateAlgorithmicInsight(reviewData);
  }

  try {
    const context = buildContext(reviewData);
    const response = await callClaude(context);
    if (!response) return generateAlgorithmicInsight(reviewData);

    // Link to AI insights page for follow-up
    const appUrl = process.env.CLIENT_URL || 'https://app.letmypeoplegrow.com.au';
    const findOutMoreUrl = `${appUrl}/app/ai-insights`;

    return response + `\n\n<a href="${findOutMoreUrl}" style="color: #1e40af; font-weight: 600; text-decoration: underline;">Find out more &rarr;</a>`;
  } catch (err) {
    console.error('Weekly review AI insight failed, falling back to algorithmic:', err.message);
    return generateAlgorithmicInsight(reviewData);
  }
}

function callClaude(context) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: context }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PLATFORM_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) {
            resolve(parsed.content[0].text.trim());
          } else {
            console.error('Weekly review: unexpected Claude response:', data.substring(0, 500));
            resolve(null);
          }
        } catch (e) {
          console.error('Weekly review: failed to parse Claude response:', e.message);
          resolve(null);
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error('Claude API request timed out'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fallback: generate a simple algorithmic insight based on trends.
 */
function generateAlgorithmicInsight(reviewData) {
  const totals = reviewData.weeklyTotals || [];
  if (totals.length < 2) {
    return 'Keep tracking attendance each week to unlock trend insights and growth patterns.';
  }

  const thisWeek = totals[totals.length - 1]?.total || 0;
  const lastWeek = totals[totals.length - 2]?.total || 0;

  if (thisWeek > lastWeek) {
    const pct = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;
    return `Great news! Your total attendance grew by ${pct}% compared to last week. Keep up the momentum and continue reaching out to your community.`;
  } else if (thisWeek < lastWeek) {
    const pct = lastWeek > 0 ? Math.round(((lastWeek - thisWeek) / lastWeek) * 100) : 0;
    return `Attendance was down ${pct}% from last week. This is normal and can fluctuate seasonally. Consider a personal check-in with members who were missed.`;
  } else {
    return 'Attendance held steady this week. Consistency is a sign of a healthy community. Consider ways to welcome new visitors and make them feel at home.';
  }
}

/**
 * Save the weekly review insight as an AI chat conversation so users
 * can see it and ask follow-up questions in the AI Insights page.
 *
 * @param {string} churchId
 * @param {number} userId - The recipient user's ID
 * @param {string} insight - The insight text (may contain HTML link)
 * @param {string} weekLabel - e.g. "2026-03-17 to 2026-03-23"
 */
async function saveInsightAsConversation(churchId, userId, insight, weekLabel) {
  try {
    const Database = require('../config/database');

    // Strip HTML tags and the "Find out more" link from insight
    const plainInsight = insight
      .replace(/<a[^>]*>.*?<\/a>/g, '')  // remove entire anchor elements
      .replace(/<[^>]*>/g, '')            // remove any remaining HTML tags
      .trim();
    if (!plainInsight) return;

    const title = `Weekly Review — ${weekLabel}`;
    const userMessage = `Here is the weekly attendance review insight for ${weekLabel}. Can you tell me more about this and who I should follow up with?\n\n"${plainInsight}"`;

    // Create conversation
    const conv = await Database.query(
      `INSERT INTO ai_chat_conversations (user_id, church_id, title) VALUES (?, ?, ?)`,
      [userId, churchId, title]
    );
    const conversationId = conv.insertId || conv.lastInsertRowid;
    if (!conversationId) return;

    // Insert user message
    await Database.query(
      `INSERT INTO ai_chat_messages (conversation_id, role, content) VALUES (?, 'user', ?)`,
      [conversationId, userMessage]
    );

    // Insert assistant response (the insight itself, elaborated)
    const assistantMessage = plainInsight + '\n\nWould you like me to dig deeper into any of these patterns, or help you draft a message to reach out to specific people?';
    await Database.query(
      `INSERT INTO ai_chat_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`,
      [conversationId, assistantMessage]
    );
  } catch (err) {
    // Non-critical — don't fail the email send
    console.error('Failed to save weekly review as conversation:', err.message);
  }
}

module.exports = { generateInsight, saveInsightAsConversation };
