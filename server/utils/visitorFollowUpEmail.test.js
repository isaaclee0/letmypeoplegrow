const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderVisitorFollowUp } = require('./visitorFollowUpEmail');
test('named family actions appear in HTML and text independently of AI, with escaped data', () => {
 const {html,text}=renderVisitorFollowUp({asOf:'2026-09-20',groups:[{category:'priority',familyName:'Guest',caregivers:['Alex'],members:[{name:'Sam <Guest>',category:'priority',firstVisitDate:'2026-09-06',latestVisitDate:'2026-09-06',firstGatheringName:'Sunday',missedOpportunities:2}]}]});
 assert.match(html,/Priority follow-up/); assert.match(html,/Sam &lt;Guest&gt;/);
 assert.match(text,/Sam <Guest>/); assert.match(text,/2 completed weekly opportunities/);
 assert.match(text,/Contact status: unknown/); assert.doesNotMatch(text,/Research shows|return rate/);
});
test('empty briefing produces no empty email section',()=>assert.deepEqual(renderVisitorFollowUp({groups:[]}),{html:'',text:''}));
