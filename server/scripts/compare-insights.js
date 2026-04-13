#!/usr/bin/env node
/**
 * Compare weekly review insights from Claude vs Grok.
 *
 * Usage (run inside the server container):
 *   docker-compose -f docker-compose.dev.yml exec server node scripts/compare-insights.js
 */

require('dotenv').config();

const Database = require('../config/database');
const { generateWeeklyReviewData } = require('../services/weeklyReview');

// Import the internals we need
const https = require('https');

const PLATFORM_API_KEY = process.env.PLATFORM_ANTHROPIC_API_KEY;
const PLATFORM_XAI_API_KEY = process.env.PLATFORM_XAI_API_KEY;

const SYSTEM_PROMPT = 'You are an attendance analyst for a church. Given this week\'s data, provide ONE brief, actionable insight (2-3 sentences). Pick the single most noteworthy pattern from: engagement changes among regulars, local visitor retention, cross-gathering trends, or family attendance shifts. Be warm and pastoral in tone. Do not use markdown formatting. Use the real names provided — they will appear in an email to church leaders. Local visitors are people the church hopes will return and integrate. Traveller visitors are passing through and not expected to return — do not flag their non-return as a problem.';

// Reuse buildContext from the insight module
const insightModule = require('../services/weeklyReviewInsight');
// buildContext isn't exported, so we'll duplicate it inline — or we can just
// require the file and extract it. Let's use a simpler approach: generate the
// context the same way the module does.

function buildContext(reviewData) {
  const gatheringSummary = (reviewData.gatherings || []).map(g => {
    let line = `${g.name}: ${g.count} attendees on ${g.date}`;
    if (g.deltaPercent !== null) {
      const dir = g.deltaPercent > 0 ? 'up' : g.deltaPercent < 0 ? 'down' : 'flat';
      line += ` (${dir} ${Math.abs(g.deltaPercent)}% vs 3-week avg of ${g.avgPrevious})`;
    }
    if (g.localVisitorCount > 0) line += `, ${g.localVisitorCount} local visitors`;
    return line;
  }).join('\n');

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

  let trendSection = '';
  if (reviewData.crossGatheringTrends && reviewData.crossGatheringTrends.length > 0) {
    const lines = reviewData.crossGatheringTrends.map(t => {
      return `- ${t.name}: ${t.direction} (avg ${t.firstAvg} → ${t.secondAvg} over ${t.sessionCount} sessions)`;
    });
    if (reviewData.crossGatheringShifts && reviewData.crossGatheringShifts.length > 0) {
      for (const s of reviewData.crossGatheringShifts) {
        lines.push(`- ${s.firstName} ${s.lastName}: stopped attending ${s.droppedGatherings.join(', ')} but still attends ${s.activeGatherings.join(', ')}`);
      }
    }
    trendSection = `\nCross-gathering patterns:\n${lines.join('\n')}`;
  }

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
          if (parsed.content?.[0]?.text) {
            resolve(parsed.content[0].text.trim());
          } else {
            reject(new Error('Unexpected Claude response: ' + data.substring(0, 500)));
          }
        } catch (e) {
          reject(new Error('Failed to parse Claude response: ' + e.message));
        }
      });
    });

    req.setTimeout(15000, () => req.destroy(new Error('Claude API timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callGrok(context) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'grok-4-fast',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: context }
      ],
      max_tokens: 150,
      temperature: 0.3
    });

    const options = {
      hostname: 'api.x.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PLATFORM_XAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices?.[0]?.message?.content) {
            resolve(parsed.choices[0].message.content.trim());
          } else {
            reject(new Error('Unexpected Grok response: ' + data.substring(0, 500)));
          }
        } catch (e) {
          reject(new Error('Failed to parse Grok response: ' + e.message));
        }
      });
    });

    req.setTimeout(15000, () => req.destroy(new Error('Grok API timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // Initialize database layer
  Database.initialize();

  // Look up church_id for isaac@redeemercc.org.au from registry
  const row = Database.lookupChurchByEmail('isaac@redeemercc.org.au');

  if (!row) {
    console.error('Could not find isaac@redeemercc.org.au in registry');
    process.exit(1);
  }

  const churchId = row.church_id;
  console.log(`Church ID: ${churchId}\n`);

  // Generate review data within church context
  const reviewData = await Database.setChurchContext(churchId, async () => {
    return await generateWeeklyReviewData(churchId);
  });

  if (!reviewData) {
    console.error('No attendance data found for the past week.');
    process.exit(1);
  }

  const context = buildContext(reviewData);
  console.log('=== CONTEXT SENT TO MODELS ===');
  console.log(context);
  console.log('\n');

  // Call both in parallel
  const results = await Promise.allSettled([
    PLATFORM_API_KEY ? callClaude(context) : Promise.reject(new Error('No PLATFORM_ANTHROPIC_API_KEY set')),
    PLATFORM_XAI_API_KEY ? callGrok(context) : Promise.reject(new Error('No PLATFORM_XAI_API_KEY set'))
  ]);

  console.log('=== CLAUDE (Haiku 4.5) ===');
  if (results[0].status === 'fulfilled') {
    console.log(results[0].value);
  } else {
    console.log('FAILED:', results[0].reason.message);
  }

  console.log('\n=== GROK (grok-4-fast) ===');
  if (results[1].status === 'fulfilled') {
    console.log(results[1].value);
  } else {
    console.log('FAILED:', results[1].reason.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
