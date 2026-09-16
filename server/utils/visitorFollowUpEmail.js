'use strict';
const { CATEGORIES, describeMember } = require('../services/visitorFollowUp');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderVisitorFollowUp(briefing) {
  if (!briefing?.groups?.length) return { html: '', text: '' };
  const title = `Visitor welcome & follow-up — week ending ${briefing.asOf}`;
  const sections = CATEGORIES.map(category => {
    const groups = briefing.groups.filter(g => g.category === category.key);
    if (!groups.length) return null;
    const rows = groups.map(g => [g.familyName ? `${g.familyName} family` : '',
      ...g.members.map(describeMember),
      `Assigned caregiver: ${g.caregivers.join(', ') || 'none recorded'}. Contact status: unknown.`,
    ].filter(Boolean).join(' '));
    return { category, rows };
  }).filter(Boolean);
  return {
    html: `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;font-family:Arial,sans-serif;color:#374151"><h3 style="color:#7c3aed">${escape(title)}</h3>${sections.map(({category,rows}) => `<h4>${escape(category.label)}</h4><p>${escape(category.action)}</p>${rows.map(row => `<p>${escape(row)}</p>`).join('')}`).join('')}<p>Missed opportunities require held gatherings with roster evidence. Missing attendance is not treated as absence.</p></td></tr></table>`,
    text: `\n${title}\n${sections.map(({category,rows}) => `${category.label}: ${category.action}\n${rows.map(row => `  - ${row}`).join('\n')}`).join('\n')}\n`,
  };
}
module.exports = { renderVisitorFollowUp };
