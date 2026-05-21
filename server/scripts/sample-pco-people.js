#!/usr/bin/env node
/*
 * Local web wrapper to sample & profile a Planning Center People dataset and
 * figure out which records should NOT be imported into LMPG (archived,
 * deceased, visitors, stub contacts with no household / no contact info /
 * never checked in, etc).
 *
 * It runs a tiny web server on your machine. You open it in a browser, click
 * "Connect", and log in to Planning Center AS WHICHEVER ACCOUNT you want to
 * sample (e.g. another church's account). The script never sees a password and
 * never stores the token — the token lives in memory for the duration of one
 * request and is discarded.
 *
 * Setup (one-time): in the PCO OAuth app (developer.planning.center) add this
 * redirect URI to the app's allowed list:
 *     http://localhost:8088/callback
 *   (change the port with --port=NNNN and register that URI instead)
 *
 * Run:
 *   cd server
 *   node scripts/sample-pco-people.js
 *   # then open http://localhost:8088 in your browser
 *
 * Reads only — makes no changes to PCO or to any local database.
 */

const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const path = require('path');

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const PORT_ARG = process.argv.find((a) => a.startsWith('--port='));
const PORT = PORT_ARG ? parseInt(PORT_ARG.split('=')[1], 10) : 8088;

const CLIENT_ID = process.env.PLANNING_CENTER_CLIENT_ID;
const CLIENT_SECRET = process.env.PLANNING_CENTER_CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'people check_ins';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: PLANNING_CENTER_CLIENT_ID / PLANNING_CENTER_CLIENT_SECRET not found in server/.env');
  process.exit(1);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function get(url, accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function exchangeCodeForToken(code) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }).toString();
    const req = https.request(
      {
        hostname: 'api.planningcenteronline.com',
        port: 443,
        path: '/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchAllPeople(accessToken, maxPeople) {
  let all = [];
  let next = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households,addresses';
  while (next && all.length < maxPeople) {
    const r = await get(next, accessToken);
    if (r.status !== 200) {
      throw new Error(`People fetch failed (status ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    all = all.concat(r.data.data || []);
    next = r.data.links?.next || null;
    process.stderr.write(`\rPeople: fetched ${all.length}...`);
  }
  process.stderr.write('\n');
  return all.slice(0, maxPeople);
}

async function fetchCheckinPersonIds(accessToken, maxPages, cutoffIso) {
  const seen = new Set();
  // Newest first so we can stop once we cross the lookback cutoff.
  let next = 'https://api.planningcenteronline.com/check-ins/v2/check_ins?per_page=100&include=person&order=-created_at';
  let pages = 0;
  let scanned = 0;
  let failed = null;
  let stoppedAtCutoff = false;
  outer:
  while (next && pages < maxPages) {
    const r = await get(next, accessToken);
    if (r.status !== 200) { failed = r.status; break; }
    for (const c of r.data.data || []) {
      const created = c.attributes?.created_at;
      if (cutoffIso && created && created < cutoffIso) { stoppedAtCutoff = true; break outer; }
      scanned++;
      const pid = c.relationships?.person?.data?.id;
      if (pid) seen.add(pid);
    }
    next = r.data.links?.next || null;
    pages++;
    process.stderr.write(`\rCheck-ins: page ${pages}, scanned ${scanned}, distinct people ${seen.size}...`);
  }
  process.stderr.write('\n');
  return { seen, pages, scanned, failed, stoppedAtCutoff, cutoffIso };
}

// ─── Report builder (returns plain text) ─────────────────────────────────────

function tally(map, key) {
  const k = key === null || key === undefined || key === '' ? '(empty)' : String(key);
  map.set(k, (map.get(k) || 0) + 1);
}

function buildReport(people, checkin) {
  const L = [];
  const total = people.length;
  const pct = (n) => ((n / (total || 1)) * 100).toFixed(1).padStart(5);

  const printTally = (title, map, denom) => {
    L.push('', title);
    const d = denom || total || 1;
    for (const [k, n] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
      L.push(`  ${String(n).padStart(5)}  ${((n / d) * 100).toFixed(1).padStart(5)}%  ${k}`);
    }
  };
  const row = (label, n) => L.push(`  ${String(n).padStart(5)}  ${pct(n)}%  ${label}`);

  L.push(`Total people pulled: ${total}`);
  L.push('='.repeat(60));

  const byStatus = new Map();
  const byMembership = new Map();
  const byChild = new Map();
  let noHousehold = 0, noEmail = 0, noPhone = 0, noEmailOrPhone = 0, noBirthdate = 0;
  let hasInactivatedAt = 0, totallyEmptyStub = 0;
  const membershipWhenInactive = new Map();

  for (const p of people) {
    const a = p.attributes || {};
    tally(byStatus, a.status);
    tally(byMembership, a.membership);
    tally(byChild, a.child ? 'child' : 'adult');

    const hasHousehold = !!p.relationships?.households?.data?.length;
    const hasEmail = !!(a.emails?.length);
    const hasPhone = !!(a.phone_numbers?.length);
    const hasBirthdate = !!a.birthdate;

    if (!hasHousehold) noHousehold++;
    if (!hasEmail) noEmail++;
    if (!hasPhone) noPhone++;
    if (!hasEmail && !hasPhone) noEmailOrPhone++;
    if (!hasBirthdate) noBirthdate++;
    if (a.inactivated_at) hasInactivatedAt++;
    if (!hasHousehold && !hasEmail && !hasPhone && !hasBirthdate) totallyEmptyStub++;
    if (a.status === 'inactive') tally(membershipWhenInactive, a.membership);
  }

  printTally('STATUS (active vs inactive/archived):', byStatus);
  printTally('MEMBERSHIP (free-text: Member/Visitor/Deceased/etc):', byMembership);
  printTally('CHILD vs ADULT:', byChild);

  L.push('', `MISSING-DATA SIGNALS (count / % of ${total}):`);
  row('no household', noHousehold);
  row('no email', noEmail);
  row('no phone', noPhone);
  row('no email AND no phone', noEmailOrPhone);
  row('no birthdate', noBirthdate);
  row('has inactivated_at timestamp', hasInactivatedAt);
  row('TOTALLY EMPTY stub (no household/email/phone/birthdate)', totallyEmptyStub);

  if (membershipWhenInactive.size) {
    printTally('MEMBERSHIP values among INACTIVE people:', membershipWhenInactive, hasInactivatedAt || total);
  }

  if (checkin) {
    L.push('', '='.repeat(60), 'CHECK-IN HISTORY (the "actually attends" signal):');
    if (checkin.failed) {
      L.push(`  (check-ins fetch failed with status ${checkin.failed} — token may lack Check-Ins access)`);
    } else {
      const window = checkin.cutoffIso ? `since ${checkin.cutoffIso.slice(0, 10)}` : 'all-time';
      L.push(`  window: ${window}  |  check-ins scanned: ${checkin.scanned}  |  pages: ${checkin.pages}` +
        (checkin.stoppedAtCutoff ? '  (reached cutoff)' : checkin.pages >= 1000 ? '  (HIT PAGE CAP — window may be truncated)' : ''));
      L.push(`  distinct people with >=1 check-in in window: ${checkin.seen.size}`);

      let neverCheckedIn = 0, activeNever = 0;
      for (const p of people) {
        if (!checkin.seen.has(p.id)) {
          neverCheckedIn++;
          if (p.attributes?.status === 'active') activeNever++;
        }
      }
      row('people in directory who did NOT check in (in window)', neverCheckedIn);
      row('ACTIVE people who did NOT check in (in window)', activeNever);

      // The decisive cross-tab: attendance rate per membership category.
      L.push('', 'ATTENDANCE BY MEMBERSHIP (checked-in / total — high = real attenders):');
      const byMem = new Map(); // membership -> { total, attended }
      for (const p of people) {
        const m = p.attributes?.membership || '(empty)';
        const e = byMem.get(m) || { total: 0, attended: 0 };
        e.total++;
        if (checkin.seen.has(p.id)) e.attended++;
        byMem.set(m, e);
      }
      const rows = [...byMem.entries()].sort((a, b) => b[1].total - a[1].total);
      for (const [m, e] of rows) {
        const rate = ((e.attended / e.total) * 100).toFixed(0).padStart(3);
        L.push(`  ${rate}%   ${String(e.attended).padStart(4)}/${String(e.total).padStart(4)}  ${m}`);
      }
    }
  }

  L.push('', '='.repeat(60), 'SAMPLE suspicious records (raw attributes):');
  const samples = people.filter((p) => {
    const a = p.attributes || {};
    const noContact = !(a.emails?.length) && !(a.phone_numbers?.length);
    return a.status === 'inactive' || noContact || !p.relationships?.households?.data?.length;
  }).slice(0, 10);
  for (const p of samples) {
    const a = p.attributes || {};
    L.push(JSON.stringify({
      id: p.id,
      name: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
      status: a.status,
      membership: a.membership,
      child: a.child,
      inactivated_at: a.inactivated_at,
      hasHousehold: !!p.relationships?.households?.data?.length,
      emails: a.emails?.length || 0,
      phones: a.phone_numbers?.length || 0,
      birthdate: a.birthdate || null,
    }));
  }

  return L.join('\n');
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>PCO Sampler</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1a1a1a}
  h1{font-size:20px} label{display:block;margin:10px 0}
  .btn{display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;border:0;font-size:15px;cursor:pointer}
  pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto;font-size:12px;line-height:1.5}
  .muted{color:#666;font-size:13px}
</style></head><body>${body}</body></html>`;
}

function landingPage() {
  return page(`
    <h1>Planning Center — People Sampler</h1>
    <p class="muted">Read-only. Log in as the account you want to sample. The token is never stored.</p>
    <form action="/authorize" method="get">
      <label><input type="checkbox" name="checkins" value="1" checked> Also profile check-in history (slower)</label>
      <label>Check-in lookback in WEEKS (takes precedence; matches app's 6-week visitor window): <input type="number" name="weeks" min="0" value="6" style="width:120px"></label>
      <label>...or months (used only if weeks is 0/blank; 0 = all-time): <input type="number" name="months" min="0" placeholder="0" style="width:120px"></label>
      <label>Max people to pull (blank = all): <input type="number" name="max" min="1" placeholder="all" style="width:120px"></label>
      <button class="btn" type="submit">Connect Planning Center &amp; Sample</button>
    </form>
    <p class="muted" style="margin-top:24px">Redirect URI in use: <code>${esc(REDIRECT_URI)}</code> — must be registered in the PCO OAuth app.</p>
  `);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT_URI);

  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(landingPage());
  }

  if (u.pathname === '/authorize') {
    const opts = {
      checkins: u.searchParams.get('checkins') === '1',
      max: parseInt(u.searchParams.get('max'), 10) || 0,
      weeks: parseInt(u.searchParams.get('weeks'), 10) || 0,
      months: parseInt(u.searchParams.get('months'), 10) || 0,
    };
    const state = Buffer.from(JSON.stringify(opts)).toString('base64');
    const authUrl = 'https://api.planningcenteronline.com/oauth/authorize?' +
      `client_id=${encodeURIComponent(CLIENT_ID)}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      'response_type=code&' +
      `scope=${encodeURIComponent(SCOPE)}&` +
      `state=${encodeURIComponent(state)}`;
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  if (u.pathname === '/callback') {
    const err = u.searchParams.get('error');
    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end(page(`<h1>Authorization failed</h1><p>${esc(err)}</p><a href="/">Try again</a>`));
    }
    const code = u.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end(page('<h1>Missing code</h1><a href="/">Try again</a>'));
    }

    let opts = { checkins: false, max: 0, weeks: 6, months: 0 };
    try { opts = JSON.parse(Buffer.from(u.searchParams.get('state') || '', 'base64').toString()); } catch (_) {}
    const maxPeople = opts.max && opts.max > 0 ? opts.max : Infinity;

    try {
      const tok = await exchangeCodeForToken(code);
      if (tok.status !== 200 || !tok.data?.access_token) {
        throw new Error(`Token exchange failed (status ${tok.status}): ${JSON.stringify(tok.data).slice(0, 300)}`);
      }
      const accessToken = tok.data.access_token; // in-memory only

      console.log('\nAuthorized. Pulling people...');
      const people = await fetchAllPeople(accessToken, maxPeople);

      let checkin = null;
      if (opts.checkins) {
        const weeks = opts.weeks || 0;
        const months = opts.months || 0;
        const cutoffMs = weeks > 0 ? weeks * 7 * 24 * 60 * 60 * 1000
          : months > 0 ? months * 30 * 24 * 60 * 60 * 1000
          : null;
        const cutoffIso = cutoffMs ? new Date(Date.now() - cutoffMs).toISOString() : null;
        console.log(`Pulling check-ins (${cutoffIso ? `since ${cutoffIso.slice(0, 10)}` : 'all-time'})...`);
        checkin = await fetchCheckinPersonIds(accessToken, 1000, cutoffIso);
      }

      const report = buildReport(people, checkin);
      console.log('\n' + report + '\n\nDone. (You can stop the server with Ctrl+C.)');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page(`
        <h1>Sample complete — ${people.length} people</h1>
        <p class="muted">Same output is also printed in your terminal. <a href="/">Run another</a></p>
        <pre>${esc(report)}</pre>
      `));
    } catch (e) {
      console.error('\nFAILED:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(page(`<h1>Failed</h1><pre>${esc(e.message)}</pre><a href="/">Try again</a>`));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Free it or pass --port=NNNN (and register that redirect URI in PCO).`);
  } else {
    console.error('Server error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`PCO sampler running at ${url}`);
  console.log(`Redirect URI (register this in the PCO OAuth app): ${REDIRECT_URI}\n`);
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${opener} "${url}"`, () => {});
});
