const express = require('express');
const https = require('https');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// ===== Helper: get stored AI config for this church =====
async function getAiConfig(churchId) {
  try {
    const rows = await Database.query(`
      SELECT preference_value
      FROM user_preferences
      WHERE preference_key = 'ai_config' AND church_id = ?
      LIMIT 1
    `, [churchId]);

    if (rows.length === 0) return null;

    const val = rows[0].preference_value;
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch (error) {
    console.error('Error getting AI config:', error);
    return null;
  }
}

// ===== Helper: HTTPS request (reuse pattern from integrations) =====
function makeHttpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }

    req.end();
  });
}

// ===== Helper: build church data context for the LLM =====
async function buildChurchContext(churchId) {
  const sections = [];

  // 1. Church info
  try {
    const church = await Database.query(
      'SELECT church_name, timezone FROM church_settings WHERE church_id = ? LIMIT 1',
      [churchId]
    );
    if (church.length > 0) {
      sections.push(`Church: ${church[0].church_name} (timezone: ${church[0].timezone || 'unknown'})`);
    }
  } catch (e) { /* ignore */ }

  // 2. Gathering types
  try {
    const gatherings = await Database.query(`
      SELECT id, name, day_of_week, start_time, frequency, attendance_type, is_active
      FROM gathering_types WHERE church_id = ? ORDER BY name
    `, [churchId]);

    if (gatherings.length > 0) {
      const lines = gatherings.map(g =>
        `  - "${g.name}" (ID:${g.id}) | ${g.day_of_week || 'no day'} ${g.start_time || ''} | ${g.frequency} | type:${g.attendance_type} | ${g.is_active ? 'active' : 'inactive'}`
      );
      sections.push(`Gatherings (${gatherings.length}):\n${lines.join('\n')}`);
    }
  } catch (e) { /* ignore */ }

  // 3. Families & individuals summary
  try {
    const families = await Database.query(`
      SELECT f.id, f.family_name, COUNT(i.id) as member_count
      FROM families f
      LEFT JOIN individuals i ON f.id = i.family_id AND i.is_active = 1
      WHERE f.church_id = ?
      GROUP BY f.id
      ORDER BY f.family_name
    `, [churchId]);

    const individuals = await Database.query(`
      SELECT 
        i.id, i.first_name, i.last_name, i.people_type, i.is_active,
        f.family_name,
        GROUP_CONCAT(DISTINCT gt.name ORDER BY gt.name SEPARATOR ', ') as gatherings
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.church_id = ?
      GROUP BY i.id
      ORDER BY i.last_name, i.first_name
    `, [churchId]);

    const activeCount = individuals.filter(i => i.is_active).length;
    const inactiveCount = individuals.filter(i => !i.is_active).length;
    const regulars = individuals.filter(i => i.people_type === 'regular' && i.is_active);
    const localVisitors = individuals.filter(i => i.people_type === 'local_visitor' && i.is_active);
    const travellerVisitors = individuals.filter(i => i.people_type === 'traveller_visitor' && i.is_active);

    sections.push(`People Summary: ${activeCount} active, ${inactiveCount} inactive | ${regulars.length} regulars, ${localVisitors.length} local visitors, ${travellerVisitors.length} traveller visitors | ${families.length} families`);

    // List all active individuals with their family and gathering assignments
    if (individuals.length > 0) {
      const personLines = individuals
        .filter(i => i.is_active)
        .map(i =>
          `  - ${i.first_name} ${i.last_name} (ID:${i.id}) | type:${i.people_type} | family:"${i.family_name || 'none'}" | gatherings:[${i.gatherings || 'none'}]`
        );
      // Cap to avoid huge contexts
      const cap = 500;
      const shown = personLines.slice(0, cap);
      if (personLines.length > cap) {
        shown.push(`  ... and ${personLines.length - cap} more`);
      }
      sections.push(`Active People (${personLines.length}):\n${shown.join('\n')}`);
    }
  } catch (e) {
    console.error('Error building people context:', e);
  }

  // 4. Recent attendance data (last 3 months)
  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const startDate = threeMonthsAgo.toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];

    const sessions = await Database.query(`
      SELECT 
        s.id as session_id,
        s.session_date,
        gt.name as gathering_name,
        gt.attendance_type,
        COUNT(DISTINCT CASE WHEN ar.present = 1 THEN ar.individual_id END) as present_count,
        COUNT(DISTINCT ar.individual_id) as total_recorded
      FROM attendance_sessions s
      JOIN gathering_types gt ON s.gathering_type_id = gt.id
      LEFT JOIN attendance_records ar ON s.id = ar.session_id
      WHERE s.church_id = ? AND s.session_date >= ? AND s.session_date <= ?
      GROUP BY s.id
      ORDER BY s.session_date DESC
    `, [churchId, startDate, today]);

    if (sessions.length > 0) {
      const sessionLines = sessions.map(s => {
        const date = new Date(s.session_date).toISOString().split('T')[0];
        return `  - ${date} | "${s.gathering_name}" | ${s.present_count} present / ${s.total_recorded} recorded`;
      });
      sections.push(`Attendance Sessions (last 3 months, ${sessions.length} sessions):\n${sessionLines.join('\n')}`);
    }

    // Also get headcount data
    const headcounts = await Database.query(`
      SELECT 
        s.session_date,
        gt.name as gathering_name,
        h.headcount
      FROM headcount_records h
      JOIN attendance_sessions s ON h.session_id = s.id
      JOIN gathering_types gt ON s.gathering_type_id = gt.id
      WHERE s.church_id = ? AND s.session_date >= ? AND s.session_date <= ?
      ORDER BY s.session_date DESC
    `, [churchId, startDate, today]);

    if (headcounts.length > 0) {
      const hLines = headcounts.map(h => {
        const date = new Date(h.session_date).toISOString().split('T')[0];
        return `  - ${date} | "${h.gathering_name}" | headcount: ${h.headcount}`;
      });
      sections.push(`Headcount Records (last 3 months, ${headcounts.length}):\n${hLines.join('\n')}`);
    }

    // Individual attendance details for the last 3 months
    const individualAttendance = await Database.query(`
      SELECT 
        i.first_name, i.last_name, i.people_type,
        gt.name as gathering_name,
        s.session_date,
        ar.present
      FROM attendance_records ar
      JOIN attendance_sessions s ON ar.session_id = s.id
      JOIN gathering_types gt ON s.gathering_type_id = gt.id
      JOIN individuals i ON ar.individual_id = i.id
      WHERE s.church_id = ? AND s.session_date >= ? AND s.session_date <= ?
      ORDER BY i.last_name, i.first_name, s.session_date DESC
    `, [churchId, startDate, today]);

    if (individualAttendance.length > 0) {
      // Summarize per person: name, gathering, dates present, dates absent
      const personMap = {};
      for (const row of individualAttendance) {
        const key = `${row.first_name} ${row.last_name}|${row.gathering_name}`;
        if (!personMap[key]) {
          personMap[key] = { name: `${row.first_name} ${row.last_name}`, gathering: row.gathering_name, type: row.people_type, present: [], absent: [] };
        }
        const date = new Date(row.session_date).toISOString().split('T')[0];
        if (row.present) {
          personMap[key].present.push(date);
        } else {
          personMap[key].absent.push(date);
        }
      }

      const summaryLines = Object.values(personMap).map(p =>
        `  - ${p.name} (${p.type}) in "${p.gathering}": present ${p.present.length}x [${p.present.slice(0, 8).join(', ')}${p.present.length > 8 ? '...' : ''}], absent ${p.absent.length}x [${p.absent.slice(0, 8).join(', ')}${p.absent.length > 8 ? '...' : ''}]`
      );

      const cap = 300;
      const shown = summaryLines.slice(0, cap);
      if (summaryLines.length > cap) {
        shown.push(`  ... and ${summaryLines.length - cap} more`);
      }
      sections.push(`Individual Attendance Summary (last 3 months, ${Object.keys(personMap).length} person-gathering combos):\n${shown.join('\n')}`);
    }
  } catch (e) {
    console.error('Error building attendance context:', e);
  }

  // 5. Today's date for reference
  sections.push(`Today's date: ${new Date().toISOString().split('T')[0]}`);

  return sections.join('\n\n');
}

// ===== Helper: call OpenAI =====
async function callOpenAI(apiKey, systemPrompt, userMessage, model) {
  const response = await makeHttpsRequest('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 2000
    })
  });

  if (response.status !== 200) {
    const errMsg = response.data?.error?.message || JSON.stringify(response.data);
    throw new Error(`OpenAI API error (${response.status}): ${errMsg}`);
  }

  return response.data.choices?.[0]?.message?.content || 'No response from AI.';
}

// ===== Helper: call Anthropic =====
async function callAnthropic(apiKey, systemPrompt, userMessage, model) {
  const response = await makeHttpsRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (response.status !== 200) {
    const errMsg = response.data?.error?.message || JSON.stringify(response.data);
    throw new Error(`Anthropic API error (${response.status}): ${errMsg}`);
  }

  return response.data.content?.[0]?.text || 'No response from AI.';
}

// ===== ROUTES =====

// Get AI config status (is it configured?)
router.get('/status', async (req, res) => {
  try {
    const config = await getAiConfig(req.user.church_id);
    res.json({
      configured: !!(config && config.api_key),
      provider: config?.provider || null
    });
  } catch (error) {
    console.error('AI status error:', error);
    res.status(500).json({ error: 'Failed to get AI status.' });
  }
});

// Save AI config (admin only)
router.post('/configure', requireRole(['admin']), async (req, res) => {
  try {
    const { apiKey, provider, model } = req.body;

    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'API key is required.' });
    }

    if (!provider || !['openai', 'anthropic'].includes(provider)) {
      return res.status(400).json({ error: 'Provider must be "openai" or "anthropic".' });
    }

    // Quick validation: try a tiny request
    try {
      if (provider === 'openai') {
        await callOpenAI(apiKey.trim(), 'Say OK', 'Test', model || 'gpt-4o-mini');
      } else {
        await callAnthropic(apiKey.trim(), 'Say OK', 'Test', model || 'claude-sonnet-4-20250514');
      }
    } catch (validationError) {
      return res.status(400).json({
        error: 'API key validation failed. Please check your key.',
        details: validationError.message
      });
    }

    const configData = {
      api_key: apiKey.trim(),
      provider,
      model: model || null,
      connected_at: new Date().toISOString()
    };

    // Remove any existing AI config for this church (could be from a different admin)
    await Database.query(`
      DELETE FROM user_preferences
      WHERE preference_key = 'ai_config' AND church_id = ?
    `, [req.user.church_id]);

    // Insert new config
    await Database.query(`
      INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
      VALUES (?, 'ai_config', ?, ?)
    `, [req.user.id, JSON.stringify(configData), req.user.church_id]);

    res.json({ success: true, message: 'AI configured successfully.', provider });
  } catch (error) {
    console.error('AI configure error:', error);
    res.status(500).json({ error: 'Failed to configure AI.' });
  }
});

// Disconnect AI (admin only)
router.post('/disconnect', requireRole(['admin']), async (req, res) => {
  try {
    await Database.query(`
      DELETE FROM user_preferences
      WHERE preference_key = 'ai_config' AND church_id = ?
    `, [req.user.church_id]);

    res.json({ success: true, message: 'AI disconnected.' });
  } catch (error) {
    console.error('AI disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect AI.' });
  }
});

// ===== Server-side topic guard =====
// Quick keyword check to reject blatantly off-topic questions before spending API tokens.
// The LLM system prompt provides the second layer of defence for borderline cases.
const ALLOWED_TOPIC_KEYWORDS = [
  // People & relationships
  'attend', 'absence', 'absent', 'miss', 'missing', 'present', 'people', 'person',
  'member', 'family', 'families', 'individual', 'visitor', 'guest', 'new',
  'regular', 'traveller', 'local', 'who', 'name',
  // Gatherings & services
  'gathering', 'service', 'church', 'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'meeting', 'group', 'session',
  // Time & trends
  'week', 'month', 'year', 'date', 'today', 'yesterday', 'last', 'recent',
  'trend', 'pattern', 'growth', 'decline', 'average', 'total', 'count',
  'how many', 'how often', 'frequency', 'consistent', 'streak',
  // Pastoral / insights
  'follow up', 'follow-up', 'concern', 'pastoral', 'care', 'check in',
  'inactive', 'active', 'dropped', 'stopped', 'return', 'coming back',
  'insight', 'summary', 'overview', 'report', 'highlight', 'notable',
  // Prediction / context
  'predict', 'prediction', 'forecast', 'expect', 'upcoming', 'next sunday',
  'next week', 'next month', 'weather', 'holiday', 'holidays', 'christmas',
  'easter', 'why low', 'why drop', 'why fewer', 'explain', 'reason',
  'seasonal', 'season', 'winter', 'summer', 'rain', 'storm', 'snow',
  // Data
  'headcount', 'number', 'percentage', 'rate', 'list', 'show', 'tell',
  'compare', 'difference', 'between', 'most', 'least', 'best', 'worst',
];

function isOnTopic(question) {
  const lower = question.toLowerCase();
  return ALLOWED_TOPIC_KEYWORDS.some(kw => lower.includes(kw));
}

const OFF_TOPIC_MESSAGE = "I can only help with questions about your church's attendance data, membership, and gatherings. Try asking something like:\n\n- \"Who has missed the last 3 weeks?\"\n- \"What are the attendance trends this month?\"\n- \"Which families have been most consistent?\"";

// ===== Prediction / contextual question detection =====
const PREDICTION_KEYWORDS = [
  'predict', 'prediction', 'forecast', 'expect', 'expected',
  'next sunday', 'next week', 'next month', 'upcoming',
  'weather', 'rain', 'storm', 'snow', 'temperature', 'cold', 'hot',
  'holiday', 'holidays', 'christmas', 'easter', 'public holiday',
  'why low', 'why drop', 'why fewer', 'why less', 'why decrease',
  'why high', 'why increase', 'why more', 'explain', 'reason',
  'seasonal', 'season', 'winter', 'summer', 'autumn', 'fall', 'spring',
  'long weekend', 'school holidays',
];

function isPredictionQuestion(question) {
  const lower = question.toLowerCase();
  return PREDICTION_KEYWORDS.some(kw => lower.includes(kw));
}

// ===== Helper: fetch public holidays via Nager.Date =====
async function fetchHolidays(countryCode, years) {
  const allHolidays = [];
  for (const year of years) {
    try {
      const response = await makeHttpsRequest(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
        { method: 'GET', headers: { 'User-Agent': 'LetMyPeopleGrow/1.0' } }
      );
      if (response.status === 200 && Array.isArray(response.data)) {
        allHolidays.push(...response.data.map(h => ({
          date: h.date,
          name: h.localName || h.name,
          type: h.types ? h.types.join(', ') : 'Public'
        })));
      }
    } catch (e) {
      console.warn(`Failed to fetch holidays for ${year}/${countryCode}:`, e.message);
    }
  }
  return allHolidays;
}

// ===== Helper: fetch weather data via Open-Meteo =====
async function fetchWeatherHistory(lat, lng, startDate, endDate) {
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,snowfall_sum,windspeed_10m_max,weathercode&timezone=auto`;
    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': 'LetMyPeopleGrow/1.0' }
    });
    if (response.status === 200 && response.data?.daily) {
      const d = response.data.daily;
      const days = [];
      for (let i = 0; i < (d.time || []).length; i++) {
        days.push({
          date: d.time[i],
          tempMax: d.temperature_2m_max?.[i],
          tempMin: d.temperature_2m_min?.[i],
          precipitation: d.precipitation_sum?.[i],
          rain: d.rain_sum?.[i],
          snowfall: d.snowfall_sum?.[i],
          windMax: d.windspeed_10m_max?.[i],
          weatherCode: d.weathercode?.[i]
        });
      }
      return days;
    }
  } catch (e) {
    console.warn('Failed to fetch weather history:', e.message);
  }
  return [];
}

async function fetchWeatherForecast(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max,weathercode&timezone=auto&forecast_days=14`;
    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': 'LetMyPeopleGrow/1.0' }
    });
    if (response.status === 200 && response.data?.daily) {
      const d = response.data.daily;
      const days = [];
      for (let i = 0; i < (d.time || []).length; i++) {
        days.push({
          date: d.time[i],
          tempMax: d.temperature_2m_max?.[i],
          tempMin: d.temperature_2m_min?.[i],
          precipitation: d.precipitation_sum?.[i],
          precipProb: d.precipitation_probability_max?.[i],
          windMax: d.windspeed_10m_max?.[i],
          weatherCode: d.weathercode?.[i]
        });
      }
      return days;
    }
  } catch (e) {
    console.warn('Failed to fetch weather forecast:', e.message);
  }
  return [];
}

// WMO weather code to description
function weatherCodeToDescription(code) {
  const map = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers',
    82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
  };
  return map[code] || `Code ${code}`;
}

// Build enriched context sections for prediction questions
async function buildEnrichedContext(churchId) {
  const sections = [];

  // Get church location and country
  const church = await Database.query(
    'SELECT country_code, location_name, location_lat, location_lng FROM church_settings WHERE church_id = ? LIMIT 1',
    [churchId]
  );

  if (church.length === 0) return { enrichedContext: '', hasLocation: false };

  const { country_code, location_name, location_lat, location_lng } = church[0];

  if (!location_lat || !location_lng) {
    return { enrichedContext: '', hasLocation: false };
  }

  // Date ranges
  const now = new Date();
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const currentYear = now.getFullYear();
  const lastYear = currentYear - 1;

  // Fetch holidays and weather in parallel
  const [holidays, weatherHistory, weatherForecast] = await Promise.all([
    fetchHolidays(country_code || 'US', [lastYear, currentYear]),
    fetchWeatherHistory(
      location_lat, location_lng,
      threeMonthsAgo.toISOString().split('T')[0],
      now.toISOString().split('T')[0]
    ),
    fetchWeatherForecast(location_lat, location_lng)
  ]);

  // Location info
  sections.push(`Church Location: ${location_name} (lat: ${location_lat}, lng: ${location_lng})`);

  // Holidays — filter to relevant window (last 3 months + next 2 months)
  if (holidays.length > 0) {
    const twoMonthsFromNow = new Date();
    twoMonthsFromNow.setMonth(twoMonthsFromNow.getMonth() + 2);
    const relevantHolidays = holidays.filter(h => {
      const d = new Date(h.date);
      return d >= threeMonthsAgo && d <= twoMonthsFromNow;
    });
    if (relevantHolidays.length > 0) {
      const lines = relevantHolidays.map(h => `  - ${h.date}: ${h.name} (${h.type})`);
      sections.push(`Public Holidays (relevant window):\n${lines.join('\n')}`);
    }
  }

  // Historical weather aligned with attendance dates
  if (weatherHistory.length > 0) {
    // Get attendance session dates to match weather
    const sessionDates = await Database.query(`
      SELECT DISTINCT DATE_FORMAT(session_date, '%Y-%m-%d') as d
      FROM attendance_sessions
      WHERE church_id = ? AND session_date >= ?
      ORDER BY session_date
    `, [churchId, threeMonthsAgo.toISOString().split('T')[0]]);

    const sessionDateSet = new Set(sessionDates.map(r => r.d));

    const matchedWeather = weatherHistory.filter(w => sessionDateSet.has(w.date));
    if (matchedWeather.length > 0) {
      const lines = matchedWeather.map(w =>
        `  - ${w.date}: ${weatherCodeToDescription(w.weatherCode)} | ${w.tempMin}°–${w.tempMax}°C | rain:${w.rain || 0}mm | wind:${w.windMax || 0}km/h`
      );
      sections.push(`Weather on Attendance Days (last 3 months):\n${lines.join('\n')}`);
    }
  }

  // Weather forecast
  if (weatherForecast.length > 0) {
    const lines = weatherForecast.map(w =>
      `  - ${w.date}: ${weatherCodeToDescription(w.weatherCode)} | ${w.tempMin}°–${w.tempMax}°C | rain:${w.precipitation || 0}mm (${w.precipProb || 0}% chance) | wind:${w.windMax || 0}km/h`
    );
    sections.push(`Weather Forecast (next 14 days):\n${lines.join('\n')}`);
  }

  return { enrichedContext: sections.join('\n\n'), hasLocation: true };
}

// Ask a question
router.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question is required.' });
    }

    // Length guard — no essays
    if (question.trim().length > 1000) {
      return res.status(400).json({ error: 'Question is too long. Please keep it under 1000 characters.' });
    }

    // Server-side topic filter
    if (!isOnTopic(question.trim())) {
      return res.json({ answer: OFF_TOPIC_MESSAGE, provider: 'system', filtered: true });
    }

    const config = await getAiConfig(req.user.church_id);
    if (!config || !config.api_key) {
      return res.status(400).json({
        error: 'AI is not configured. An admin needs to add an AI API key in Settings → Integrations.'
      });
    }

    // Build church data context
    const churchContext = await buildChurchContext(req.user.church_id);

    // Check if this is a prediction/contextual question that needs enriched data
    let enrichedSection = '';
    const isPrediction = isPredictionQuestion(question.trim());

    if (isPrediction) {
      const { enrichedContext, hasLocation } = await buildEnrichedContext(req.user.church_id);

      if (!hasLocation) {
        return res.json({
          answer: "To answer prediction or weather/holiday-related questions, your church's location needs to be configured first.\n\nAn admin can set this in **Settings → General → Church Location**. Once a location is set, I'll be able to factor in weather forecasts, public holidays, and seasonal patterns into my analysis.",
          provider: 'system',
          filtered: false
        });
      }

      if (enrichedContext) {
        enrichedSection = `\n\nADDITIONAL CONTEXT (holidays, weather, forecasts):\n${enrichedContext}`;
      }
    }

    const predictionInstructions = isPrediction ? `
- When predicting attendance, consider: historical trends, day of week, weather forecasts, public holidays, school holidays, and seasonal patterns.
- Clearly state which factors you considered and how they might impact attendance.
- Give a predicted attendance range (e.g. "I'd expect 45-55 people") rather than a single number.
- If weather or holidays are likely to have a significant impact, call it out specifically.` : '';

    const systemPrompt = `You are a specialised assistant for a church attendance application called "Let My People Grow". Your ONLY purpose is to help church leaders understand their attendance data, membership, and pastoral follow-up needs.

STRICT RULES — you MUST follow these:
1. ONLY answer questions related to church attendance, membership, gatherings, families, visitors, and pastoral care.
2. If the user asks about ANYTHING else (coding, recipes, general knowledge, homework, writing, etc.), you MUST refuse politely and remind them this tool is only for attendance insights. Do NOT answer off-topic questions under any circumstances, even if the user insists.
3. Do NOT generate code, scripts, essays, stories, or any content unrelated to this church's data.
4. Base your answers ONLY on the real data provided below. If the data doesn't contain enough information, say so.
5. FOCUS ON REGULAR ATTENDERS by default. Unless the question specifically asks about visitors or guests, your answers should prioritize and emphasize regular church members. Only include visitor data when explicitly requested or when it's directly relevant to the question asked.

CHURCH DATA:
${churchContext}${enrichedSection}

RESPONSE GUIDELINES:
- Be concise and practical. Church leaders are busy.
- When discussing attendance patterns, mention specific names and dates.
- Use plain language, not technical database jargon.
- If asked about trends, calculate and present them clearly.
- Format responses with markdown for readability (bold, lists, etc.).
- Use human-friendly date formats (e.g. "Sunday 5 Jan 2025").
- If someone hasn't attended recently, mention their last known attendance date.
- Be pastorally sensitive — these are real people, not just numbers.${predictionInstructions}`;

    let answer;
    if (config.provider === 'openai') {
      answer = await callOpenAI(config.api_key, systemPrompt, question.trim(), config.model);
    } else if (config.provider === 'anthropic') {
      answer = await callAnthropic(config.api_key, systemPrompt, question.trim(), config.model);
    } else {
      return res.status(400).json({ error: `Unknown provider: ${config.provider}` });
    }

    res.json({ answer, provider: config.provider });
  } catch (error) {
    console.error('AI ask error:', error);
    res.status(500).json({
      error: 'Failed to get AI response.',
      details: error.message
    });
  }
});

// ===== Chat History Endpoints =====

// Get all conversations for the user
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;

    const conversations = await Database.query(`
      SELECT
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        COUNT(m.id) as message_count
      FROM ai_chat_conversations c
      LEFT JOIN ai_chat_messages m ON c.id = m.conversation_id
      WHERE c.user_id = ? AND c.church_id = ?
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `, [userId, churchId]);

    res.json({ conversations });
  } catch (error) {
    logger.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// Create new conversation
router.post('/conversations', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { title } = req.body;

    const result = await Database.query(`
      INSERT INTO ai_chat_conversations (user_id, church_id, title)
      VALUES (?, ?, ?)
    `, [userId, churchId, title || 'New Chat']);

    res.json({
      conversation: {
        id: Number(result.insertId),
        title: title || 'New Chat',
        created_at: new Date(),
        updated_at: new Date()
      }
    });
  } catch (error) {
    logger.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get messages for a conversation
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { id } = req.params;

    // Verify ownership
    const conversation = await Database.query(`
      SELECT id FROM ai_chat_conversations
      WHERE id = ? AND user_id = ? AND church_id = ?
    `, [id, userId, churchId]);

    if (conversation.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await Database.query(`
      SELECT id, role, content, created_at as timestamp
      FROM ai_chat_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `, [id]);

    res.json({ messages });
  } catch (error) {
    logger.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Save message to conversation
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { id } = req.params;
    const { role, content } = req.body;

    // Verify ownership
    const conversation = await Database.query(`
      SELECT id FROM ai_chat_conversations
      WHERE id = ? AND user_id = ? AND church_id = ?
    `, [id, userId, churchId]);

    if (conversation.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Insert message
    const result = await Database.query(`
      INSERT INTO ai_chat_messages (conversation_id, role, content)
      VALUES (?, ?, ?)
    `, [id, role, content]);

    // Update conversation updated_at
    await Database.query(`
      UPDATE ai_chat_conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    res.json({
      message: {
        id: Number(result.insertId),
        role,
        content,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('Save message error:', error);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// Update conversation title
router.put('/conversations/:id/title', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { id } = req.params;
    const { title } = req.body;

    // Verify ownership and update
    const result = await Database.query(`
      UPDATE ai_chat_conversations
      SET title = ?
      WHERE id = ? AND user_id = ? AND church_id = ?
    `, [title, id, userId, churchId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Update conversation title error:', error);
    res.status(500).json({ error: 'Failed to update title' });
  }
});

// Delete conversation
router.delete('/conversations/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { id } = req.params;

    // Delete (messages will cascade)
    const result = await Database.query(`
      DELETE FROM ai_chat_conversations
      WHERE id = ? AND user_id = ? AND church_id = ?
    `, [id, userId, churchId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

module.exports = router;
