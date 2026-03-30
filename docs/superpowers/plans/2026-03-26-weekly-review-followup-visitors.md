# Weekly Review Email: Follow-Up, Visitors & Getting Started — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new sections to the weekly review email: a follow-up list for newly disengaged regulars, a visitor breakdown (first-time vs returning), and a getting-started encouragement for new churches.

**Architecture:** Two new data functions in `weeklyReview.js` feed new HTML sections in `email.js`. A third data function produces getting-started stats for churches with < 3 weeks of data. The scheduler and insight modules are untouched.

**Tech Stack:** Node.js, SQLite (better-sqlite3), HTML email (table-based)

**Spec:** `docs/superpowers/specs/2026-03-26-weekly-review-followup-visitors-design.md`

---

### Task 1: Add `getNewlyDisengaged()` data function

**Files:**
- Modify: `server/services/weeklyReview.js`

This function finds regulars who were present at least once in weeks 4-6 (counting back from endDate) but absent for the most recent 3 weeks. It returns up to 5 people with the gatherings they used to attend.

- [ ] **Step 1: Add the `getNewlyDisengaged` function**

Add this function after the existing `getFamilyAttendancePatterns` function (around line 832) and before `detectSendDay`:

```js
/**
 * Get regulars who newly became disengaged: present in weeks 4-6 but absent in weeks 1-3.
 * Returns up to 5 people with the gatherings they used to attend, plus total count.
 */
async function getNewlyDisengaged(churchId, endDate) {
  const threeWeeksAgo = new Date(endDate);
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
  const sixWeeksAgo = new Date(endDate);
  sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42);
  const recentStart = threeWeeksAgo.toISOString().split('T')[0];
  const olderStart = sixWeeksAgo.toISOString().split('T')[0];

  // Find active regulars who were present in weeks 4-6 but NOT present in weeks 1-3
  const disengaged = await Database.query(
    `SELECT i.id, i.first_name, i.last_name
     FROM individuals i
     WHERE i.people_type = 'regular' AND i.is_active = 1 AND i.church_id = ?
       AND EXISTS (
         SELECT 1 FROM attendance_records ar
         JOIN attendance_sessions s ON s.id = ar.session_id
         JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
         WHERE ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = ?
           AND s.session_date >= ? AND s.session_date < ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_records ar
         JOIN attendance_sessions s ON s.id = ar.session_id
         JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
         WHERE ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = ?
           AND s.session_date >= ? AND s.session_date <= ?
       )
     ORDER BY i.last_name, i.first_name`,
    [churchId, churchId, olderStart, recentStart, churchId, recentStart, endDate]
  );

  const total = disengaged.length;
  const capped = disengaged.slice(0, 5);

  // For each person, find which gatherings they attended in weeks 4-6
  const result = [];
  for (const person of capped) {
    const gatheringRows = await Database.query(
      `SELECT DISTINCT gt.name
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE ar.individual_id = ? AND ar.present = 1 AND ar.church_id = ?
         AND s.session_date >= ? AND s.session_date < ?
       ORDER BY gt.name`,
      [person.id, churchId, olderStart, recentStart]
    );
    result.push({
      firstName: person.first_name,
      lastName: person.last_name,
      gatherings: gatheringRows.map(g => g.name)
    });
  }

  return { people: result, total };
}
```

- [ ] **Step 2: Add `getWeeklyVisitorBreakdown` function**

Add this function right after `getNewlyDisengaged`:

```js
/**
 * Get this week's local visitors categorized as first-time or returning.
 */
async function getWeeklyVisitorBreakdown(churchId, startDate, endDate) {
  // Get local visitors who attended this week
  const visitors = await Database.query(
    `SELECT DISTINCT i.id, i.first_name, i.last_name
     FROM individuals i
     JOIN attendance_records ar ON ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = i.church_id
     JOIN attendance_sessions s ON s.id = ar.session_id
     JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
     WHERE i.people_type = 'local_visitor' AND i.is_active = 1 AND i.church_id = ?
       AND s.session_date >= ? AND s.session_date <= ?`,
    [churchId, startDate, endDate]
  );

  if (visitors.length === 0) return null;

  const firstTime = [];
  const returning = [];

  for (const visitor of visitors) {
    // Check if they have any attendance before this week
    const prior = await Database.query(
      `SELECT 1 FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       WHERE ar.individual_id = ? AND ar.present = 1 AND ar.church_id = ?
         AND s.session_date < ?
       LIMIT 1`,
      [visitor.id, churchId, startDate]
    );

    // Get which gathering(s) they attended this week
    const gatheringRows = await Database.query(
      `SELECT DISTINCT gt.name
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE ar.individual_id = ? AND ar.present = 1 AND ar.church_id = ?
         AND s.session_date >= ? AND s.session_date <= ?
       ORDER BY gt.name`,
      [visitor.id, churchId, startDate, endDate]
    );
    const gatheringNames = gatheringRows.map(g => g.name);

    const entry = {
      firstName: visitor.first_name,
      lastName: visitor.last_name,
      gatherings: gatheringNames
    };

    if (prior.length > 0) {
      returning.push(entry);
    } else {
      firstTime.push(entry);
    }
  }

  return { firstTime, returning };
}
```

- [ ] **Step 3: Integrate both functions into `generateWeeklyReviewData`**

In `generateWeeklyReviewData`, after the existing enriched data block (around line 193, after `crossGatheringShifts`), add:

```js
  // Follow-up and visitor data (only for standard gatherings)
  let followUpData = { people: [], total: 0 };
  let weeklyVisitors = null;
  if (hasStandardGatherings) {
    followUpData = await getNewlyDisengaged(churchId, endDate);
    weeklyVisitors = await getWeeklyVisitorBreakdown(churchId, startDate, endDate);
  }

  // Getting started data for new churches
  const isNewChurch = weeklyTotals.length < 3;
  let gettingStarted = null;
  if (isNewChurch) {
    const gatheringCount = gatherings.length;
    const peopleCountResult = await Database.query(
      `SELECT COUNT(*) as cnt FROM individuals WHERE is_active = 1 AND church_id = ?`,
      [churchId]
    );
    gettingStarted = {
      gatheringCount,
      peopleCount: peopleCountResult[0]?.cnt || 0,
      weeksTracked: weeklyTotals.length
    };
  }
```

Then add to the return object (after `familyPatterns`):

```js
    followUpPeople: followUpData.people,
    followUpTotal: followUpData.total,
    weeklyVisitors,
    gettingStarted
```

- [ ] **Step 4: Verify no syntax errors by rebuilding the server container**

```bash
docker-compose -f docker-compose.dev.yml build server && docker-compose -f docker-compose.dev.yml up -d server
```

Check logs for startup errors:

```bash
docker-compose -f docker-compose.dev.yml logs --tail=20 server
```

Expected: Server starts without errors.

- [ ] **Step 5: Commit**

```bash
git add server/services/weeklyReview.js
git commit -m "feat(weekly-review): add follow-up, visitor breakdown, and getting-started data functions"
```

---

### Task 2: Add follow-up section HTML to email

**Files:**
- Modify: `server/utils/email.js`

Add the "🔔 People to Follow Up With" section to `sendWeeklyReviewEmail`. This goes after the totals box and before the insight.

- [ ] **Step 1: Add follow-up HTML builder**

In `sendWeeklyReviewEmail`, after the `insightHtml` variable (around line 371), add:

```js
  // Follow-up section
  const appUrl = process.env.CLIENT_URL || 'https://app.letmypeoplegrow.com.au';
  let followUpHtml = '';
  if (!reviewData.gettingStarted && reviewData.followUpPeople && reviewData.followUpPeople.length > 0) {
    const peopleRows = reviewData.followUpPeople.map(p => {
      const gatheringText = p.gatherings.length > 0 ? p.gatherings.join(', ') : 'gatherings';
      return `<tr><td style="padding: 6px 0; color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; border-bottom: 1px solid #f3f4f6;">${p.firstName} ${p.lastName} <span style="color: #9ca3af;">&mdash; used to attend ${gatheringText}</span></td></tr>`;
    }).join('');
    const moreText = reviewData.followUpTotal > reviewData.followUpPeople.length
      ? `<tr><td style="padding: 6px 0; color: #9ca3af; font-size: 13px; font-style: italic;">and ${reviewData.followUpTotal - reviewData.followUpPeople.length} more</td></tr>`
      : '';
    followUpHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
        <tr>
          <td style="background-color: #ffffff; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; border-left: 4px solid #9B51E0;">
            <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 12px; font-size: 15px;">&#128276; People to Follow Up With</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              ${peopleRows}
              ${moreText}
            </table>
            <div style="margin-top: 12px;"><a href="${appUrl}/app/reports" style="color: #7c3aed; font-weight: 600; font-size: 13px; text-decoration: underline;">View all in Reports &rarr;</a></div>
          </td>
        </tr>
      </table>`;
  }
```

- [ ] **Step 2: Insert follow-up section into the HTML template**

Replace the line `${insightHtml}` (around line 416) with:

```
                  ${followUpHtml}

                  ${insightHtml}
```

This places the follow-up section after the totals box and before the AI insight.

- [ ] **Step 3: Add follow-up to the plain text version**

After the totals line in the text version (around line 460), add:

```js
  // Follow-up plain text
  let followUpText = '';
  if (!reviewData.gettingStarted && reviewData.followUpPeople && reviewData.followUpPeople.length > 0) {
    const lines = reviewData.followUpPeople.map(p => `- ${p.firstName} ${p.lastName} — used to attend ${p.gatherings.join(', ')}`);
    if (reviewData.followUpTotal > reviewData.followUpPeople.length) {
      lines.push(`  ...and ${reviewData.followUpTotal - reviewData.followUpPeople.length} more`);
    }
    followUpText = `\nPeople to Follow Up With:\n${lines.join('\n')}\nView all: ${appUrl}/app/reports\n`;
  }
```

And insert `${followUpText}` before the insight in the text template.

- [ ] **Step 4: Verify by rebuilding**

```bash
docker-compose -f docker-compose.dev.yml build server && docker-compose -f docker-compose.dev.yml up -d server
```

Check logs:

```bash
docker-compose -f docker-compose.dev.yml logs --tail=20 server
```

- [ ] **Step 5: Commit**

```bash
git add server/utils/email.js
git commit -m "feat(weekly-review): add follow-up section to email template"
```

---

### Task 3: Add visitor section HTML to email

**Files:**
- Modify: `server/utils/email.js`

Add the "👋 This Week's Visitors" section between follow-up and AI insight.

- [ ] **Step 1: Add visitor HTML builder**

After the `followUpHtml` block, add:

```js
  // Visitor breakdown section
  let visitorBreakdownHtml = '';
  if (reviewData.weeklyVisitors && (reviewData.weeklyVisitors.firstTime.length > 0 || reviewData.weeklyVisitors.returning.length > 0)) {
    const buildVisitorRows = (visitors) => visitors.map(v => {
      const gatheringText = v.gatherings.length > 0 ? v.gatherings.join(', ') : '';
      return `<tr><td style="padding: 4px 0 4px 12px; color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px;">${v.firstName} ${v.lastName}${gatheringText ? ` <span style="color: #9ca3af;">&mdash; ${gatheringText}</span>` : ''}</td></tr>`;
    }).join('');

    let subSections = '';
    if (reviewData.weeklyVisitors.firstTime.length > 0) {
      subSections += `
        <div style="font-weight: 600; color: #374151; font-size: 13px; margin-top: 8px; margin-bottom: 4px;">First-time</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${buildVisitorRows(reviewData.weeklyVisitors.firstTime)}</table>`;
    }
    if (reviewData.weeklyVisitors.returning.length > 0) {
      subSections += `
        <div style="font-weight: 600; color: #374151; font-size: 13px; margin-top: 12px; margin-bottom: 4px;">Returning</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${buildVisitorRows(reviewData.weeklyVisitors.returning)}</table>`;
    }

    visitorBreakdownHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 16px;">
        <tr>
          <td style="background-color: #ffffff; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; border-left: 4px solid #9B51E0;">
            <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 8px; font-size: 15px;">&#128075; This Week's Visitors</div>
            ${subSections}
            <div style="margin-top: 14px; font-style: italic; color: #9ca3af; font-size: 13px; line-height: 1.5;">Research shows that visitors are more likely to return when someone other than the pastor reaches out before Wednesday.</div>
          </td>
        </tr>
      </table>`;
  }
```

- [ ] **Step 2: Insert visitor section into the HTML template**

Update the content area so the order is: followUpHtml, visitorBreakdownHtml, insightHtml:

```
                  ${followUpHtml}

                  ${visitorBreakdownHtml}

                  ${insightHtml}
```

- [ ] **Step 3: Add visitor breakdown to plain text version**

```js
  // Visitor breakdown plain text
  let visitorBreakdownText = '';
  if (reviewData.weeklyVisitors && (reviewData.weeklyVisitors.firstTime.length > 0 || reviewData.weeklyVisitors.returning.length > 0)) {
    const lines = ['This Week\'s Visitors:'];
    if (reviewData.weeklyVisitors.firstTime.length > 0) {
      lines.push('First-time:');
      reviewData.weeklyVisitors.firstTime.forEach(v => lines.push(`  - ${v.firstName} ${v.lastName}${v.gatherings.length > 0 ? ` — ${v.gatherings.join(', ')}` : ''}`));
    }
    if (reviewData.weeklyVisitors.returning.length > 0) {
      lines.push('Returning:');
      reviewData.weeklyVisitors.returning.forEach(v => lines.push(`  - ${v.firstName} ${v.lastName}${v.gatherings.length > 0 ? ` — ${v.gatherings.join(', ')}` : ''}`));
    }
    lines.push('Tip: Visitors are more likely to return when someone other than the pastor reaches out before Wednesday.');
    visitorBreakdownText = '\n' + lines.join('\n') + '\n';
  }
```

Insert `${visitorBreakdownText}` after `${followUpText}` and before the insight in the text template.

- [ ] **Step 4: Verify by rebuilding**

```bash
docker-compose -f docker-compose.dev.yml build server && docker-compose -f docker-compose.dev.yml up -d server
```

- [ ] **Step 5: Commit**

```bash
git add server/utils/email.js
git commit -m "feat(weekly-review): add visitor breakdown section to email template"
```

---

### Task 4: Add getting-started section HTML to email

**Files:**
- Modify: `server/utils/email.js`

Add the "🌱 Your Church is Growing" section for new churches (< 3 weeks of data). When shown, it replaces the follow-up, visitor, and insight sections.

- [ ] **Step 1: Add getting-started HTML builder**

After the `visitorBreakdownHtml` block, add:

```js
  // Getting started section (new churches only)
  let gettingStartedHtml = '';
  if (reviewData.gettingStarted) {
    const gs = reviewData.gettingStarted;
    const gatheringWord = gs.gatheringCount === 1 ? 'gathering' : 'gatherings';
    const personWord = gs.peopleCount === 1 ? 'person' : 'people';
    const weekWord = gs.weeksTracked === 1 ? 'week' : 'weeks';
    gettingStartedHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
        <tr>
          <td style="background-color: #ffffff; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; border-left: 4px solid #9B51E0;">
            <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 12px; font-size: 15px;">&#127793; Your Church is Growing</div>
            <div style="color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.6;">
              You've set up ${gs.gatheringCount} ${gatheringWord} and added ${gs.peopleCount} ${personWord} &mdash; great start! You've been tracking attendance for ${gs.weeksTracked} ${weekWord} so far.
            </div>
            <div style="color: #6b7280; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.6; margin-top: 10px;">
              Keep it up! As you record more weeks of attendance, this email will start including follow-up suggestions, visitor insights, and AI-powered trends to help your church grow.
            </div>
          </td>
        </tr>
      </table>`;
  }
```

- [ ] **Step 2: Update the HTML template to conditionally show getting-started OR the other sections**

Replace the section placement block with:

```
                  ${reviewData.gettingStarted ? gettingStartedHtml : `${followUpHtml}${visitorBreakdownHtml}${insightHtml}`}
```

- [ ] **Step 3: Add getting-started to plain text version**

```js
  // Getting started plain text
  let gettingStartedText = '';
  if (reviewData.gettingStarted) {
    const gs = reviewData.gettingStarted;
    gettingStartedText = `\nYour Church is Growing!\nYou've set up ${gs.gatheringCount} gathering(s) and added ${gs.peopleCount} people — great start! You've been tracking attendance for ${gs.weeksTracked} week(s) so far.\n\nKeep it up! As you record more weeks, this email will include follow-up suggestions, visitor insights, and AI-powered trends.\n`;
  }
```

Refactor the existing plain text template string. The current template has `${insight ? ...}` inline at line 462. Extract the insight text into a variable and replace the inline section with the conditional:

```js
  const insightText = insight ? `\nWeekly Insight:\n${insight.replace(/<[^>]*>/g, '')}\n` : '';

  // In the textContent template, replace the existing insight line with:
  // ${reviewData.gettingStarted ? gettingStartedText : `${followUpText}${visitorBreakdownText}${insightText}`}
```

The full text template should become:

```js
  const textContent = `
${churchName} Weekly Review
${reviewData.weekStartDate} to ${reviewData.weekEndDate}

Hi ${firstName},

Here's how your gatherings went this week:

${gatheringCardsText}

Total attendance: ${reviewData.totalAttendance}${reviewData.totalVisitors > 0 ? ` | ${reviewData.totalVisitors} visitors` : ''}
${reviewData.gettingStarted ? gettingStartedText : `${followUpText}${visitorBreakdownText}${insightText}`}
Blessings,
${churchName}

---
This email was sent from the Let My People Grow church management system.
To stop receiving these emails, ask your admin to update your notification preferences.
  `;
```

- [ ] **Step 4: Verify by rebuilding and sending a test email**

```bash
docker-compose -f docker-compose.dev.yml build server && docker-compose -f docker-compose.dev.yml up -d server
```

Send a test email from Settings to verify all sections render correctly. Check:
1. The follow-up section shows if there are newly disengaged people
2. The visitor section shows with first-time/returning categories
3. A new church (< 3 weeks data) sees the getting-started section instead
4. All sections omit gracefully when there's no data

- [ ] **Step 5: Commit**

```bash
git add server/utils/email.js
git commit -m "feat(weekly-review): add getting-started section for new churches"
```
