const UNKNOWN_EVENT_NAME = 'Unknown Event';

// Returns the calendar date (YYYY-MM-DD) of an ISO timestamp, evaluated in tz.
function localDateInTz(isoString, tz) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function buildIncludedMaps(included = []) {
  const events = {};
  const people = {};
  const periods = {};
  const times = {};
  for (const item of included) {
    if (item.type === 'Event') {
      events[item.id] = item.attributes.name || UNKNOWN_EVENT_NAME;
    } else if (item.type === 'Person') {
      people[item.id] = {
        firstName: item.attributes.first_name || '',
        lastName: item.attributes.last_name || '',
      };
    } else if (item.type === 'EventPeriod') {
      // starts_at is the actual service occurrence date/time (e.g. the Sunday).
      periods[item.id] = item.attributes.starts_at || null;
    } else if (item.type === 'EventTime') {
      // hour/minute are the service's local clock time — lets us tell an AM service
      // apart from a PM one within the same PCO event.
      times[item.id] = { hour: item.attributes.hour, minute: item.attributes.minute };
    }
  }
  return { events, people, periods, times };
}

// Local clock time "HH:MM" from a PCO EventTime, or null if no hour.
function hhmm(hour, minute) {
  if (!Number.isInteger(hour)) return null;
  const m = Number.isInteger(minute) ? minute : 0;
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// payload = { data, included }; tz = church timezone; range (optional) =
// { startDate, endDate } in YYYY-MM-DD — rows whose service date falls outside it
// are dropped (the fetch widens the created_at window to absorb data-entry lag, so
// the precise filtering happens here against the true service date).
//
// When a single PCO event has 2+ distinct service times in the data (e.g. a 10:00
// and a 16:30 Sunday service), its rows are split per time so each can map to a
// different LMPG gathering. The split rows carry a composite `pcoEventId` of
// `${id}@${HH:MM}`, a time-suffixed `eventName`, and a `serviceTime`. Single-time
// events are unchanged.
function normalizeCheckIns(payload, tz, range) {
  const { events, people, periods, times } = buildIncludedMaps(payload.included);

  // Pass 1: flatten to raw rows, carrying each row's service time, with range filter.
  const raw = [];
  for (const ci of payload.data || []) {
    const pcoEventId = ci.relationships?.event?.data?.id;
    const pcoPersonId = ci.relationships?.person?.data?.id;
    // The attendance date is the EventPeriod's starts_at (the actual service date),
    // NOT created_at — Kingston (and others) often enter check-ins days/weeks later.
    const periodId = ci.relationships?.event_period?.data?.id;
    const startsAt = periodId ? periods[periodId] : null;
    if (!pcoEventId || !pcoPersonId || !startsAt) continue;
    const date = localDateInTz(startsAt, tz);
    if (!date) continue;
    if (range && ((range.startDate && date < range.startDate) || (range.endDate && date > range.endDate))) continue;
    const etId = ci.relationships?.event_times?.data?.[0]?.id;
    const et = etId ? times[etId] : null;
    const serviceTime = et ? hhmm(et.hour, et.minute) : null;
    const person = people[pcoPersonId] || { firstName: '', lastName: '' };
    raw.push({
      pcoEventId, eventName: events[pcoEventId] || UNKNOWN_EVENT_NAME,
      pcoPersonId, firstName: person.firstName, lastName: person.lastName, date, serviceTime,
    });
  }

  // Which events have 2+ distinct service times? Only those get split.
  const timesByEvent = new Map();
  for (const r of raw) {
    if (!r.serviceTime) continue;
    if (!timesByEvent.has(r.pcoEventId)) timesByEvent.set(r.pcoEventId, new Set());
    timesByEvent.get(r.pcoEventId).add(r.serviceTime);
  }

  // Pass 2: assign group key + label, dedupe person-per-slot-per-date.
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const distinct = timesByEvent.get(r.pcoEventId);
    const split = r.serviceTime && distinct && distinct.size >= 2;
    const groupKey = split ? `${r.pcoEventId}@${r.serviceTime}` : r.pcoEventId;
    const key = `${groupKey}|${r.pcoPersonId}|${r.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = {
      pcoEventId: groupKey,
      eventName: split ? `${r.eventName} — ${r.serviceTime}` : r.eventName,
      pcoPersonId: r.pcoPersonId,
      firstName: r.firstName,
      lastName: r.lastName,
      date: r.date,
    };
    if (split) row.serviceTime = r.serviceTime;
    out.push(row);
  }
  return out;
}

// Loose name key for matching a PCO event name to a gathering name: lowercase,
// alphanumerics only, single-spaced. "Sunday AM Kids Ministries!" -> "sunday am kids ministries".
function normalizeNameKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Match a name to a gathering: exact normalized match wins, else first containment
// match (either direction). Returns gatheringTypeId or null.
function matchGatheringByName(name, gatherings) {
  const target = normalizeNameKey(name);
  if (!target) return null;
  let contains = null;
  for (const g of gatherings) {
    const key = normalizeNameKey(g.name);
    if (!key) continue;
    if (key === target) return g.id;
    if (contains == null && (key.includes(target) || target.includes(key))) contains = g.id;
  }
  return contains;
}

// Suggest an existing gathering for a PCO event. gatherings: [{ id, name }].
// First tries a direct name match (ignoring any "— HH:MM" time suffix). For a
// split slot (serviceTime given) with no name match, falls back to time-of-day:
// a morning slot prefers an AM/morning gathering, evening prefers PM/evening —
// preferring one that also shares a word with the event name (e.g. "Sunday").
function suggestGatheringId(eventName, gatherings = [], serviceTime = null) {
  const baseName = String(eventName).replace(/\s*[—-]\s*\d{1,2}:\d{2}\s*$/, '');
  const byName = matchGatheringByName(baseName, gatherings);
  if (byName != null) return byName;

  if (serviceTime) {
    const hour = parseInt(serviceTime.slice(0, 2), 10);
    const wantPm = hour >= 12;
    const eventWords = new Set(normalizeNameKey(baseName).split(' ').filter(Boolean));
    let fallback = null;
    for (const g of gatherings) {
      const words = new Set(normalizeNameKey(g.name).split(' ').filter(Boolean));
      const isAm = words.has('am') || words.has('morning');
      const isPm = words.has('pm') || words.has('evening') || words.has('night');
      if ((wantPm && isPm) || (!wantPm && isAm)) {
        const sharesWord = [...eventWords].some((w) => w.length > 2 && words.has(w));
        if (sharesWord) return g.id;
        if (fallback == null) fallback = g.id;
      }
    }
    return fallback;
  }
  return null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayOf(dateStr) {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyFrequency(medGap) {
  if (medGap >= 6 && medGap <= 8) return 'weekly';
  if (medGap >= 12 && medGap <= 16) return 'biweekly';
  if (medGap >= 26 && medGap <= 35) return 'monthly';
  return null;
}

// Infer a gathering schedule from an event's service dates.
// dates: array of 'YYYY-MM-DD'; serviceTime: 'HH:MM' or null.
// Returns { dayOfWeek, startTime, frequency, irregular }. When the dates don't
// fit a consistent weekday + regular cadence (e.g. annual Good Friday), it
// returns irregular:true with dayOfWeek/frequency null (startTime is kept).
function deriveSchedule(dates, serviceTime = null) {
  const startTime = serviceTime || null;
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 2) {
    return { dayOfWeek: null, startTime, frequency: null, irregular: true };
  }
  const counts = {};
  for (const d of uniq) {
    const w = weekdayOf(d);
    counts[w] = (counts[w] || 0) + 1;
  }
  let topDay = null;
  let topCount = 0;
  for (const [w, c] of Object.entries(counts)) {
    if (c > topCount) { topCount = c; topDay = w; }
  }
  const weekdayConsistent = topCount / uniq.length >= 0.6;
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) {
    gaps.push((new Date(`${uniq[i]}T00:00:00Z`) - new Date(`${uniq[i - 1]}T00:00:00Z`)) / 86400000);
  }
  const frequency = classifyFrequency(median(gaps));
  if (weekdayConsistent && frequency) {
    return { dayOfWeek: topDay, startTime, frequency, irregular: false };
  }
  return { dayOfWeek: null, startTime, frequency: null, irregular: true };
}

// Merges a new import result into the persisted check-in import state.
// prev may be null or a parsed state object. Per-event mappings/imported markers
// are overlaid (new wins), other events are preserved. lastRange is replaced.
function mergeCheckinImportState(prev, { lastRange, mappings, imported }) {
  const base = prev && typeof prev === 'object' ? prev : {};
  return {
    lastRange: lastRange || base.lastRange || null,
    mappings: { ...(base.mappings || {}), ...(mappings || {}) },
    imported: { ...(base.imported || {}), ...(imported || {}) },
  };
}

function summarizeEvents(normalized) {
  const byEvent = new Map();
  for (const row of normalized) {
    let e = byEvent.get(row.pcoEventId);
    if (!e) {
      e = { pcoEventId: row.pcoEventId, eventName: row.eventName, serviceTime: row.serviceTime, checkinCount: 0, dates: new Set() };
      byEvent.set(row.pcoEventId, e);
    }
    e.checkinCount += 1;
    e.dates.add(row.date);
  }
  return Array.from(byEvent.values()).map((e) => {
    const sorted = Array.from(e.dates).sort();
    const summary = {
      pcoEventId: e.pcoEventId,
      eventName: e.eventName,
      checkinCount: e.checkinCount,
      sessionCount: sorted.length,
      firstDate: sorted[0] || null,
      lastDate: sorted[sorted.length - 1] || null,
      suggestedSchedule: deriveSchedule(sorted, e.serviceTime || null),
    };
    if (e.serviceTime) summary.serviceTime = e.serviceTime;
    return summary;
  });
}

// normalized: rows from normalizeCheckIns
// existingByPcoId: Map<pcoPersonId, { id, isActive }>
function resolvePeople(normalized, existingByPcoId) {
  const distinct = new Map(); // pcoPersonId -> {firstName,lastName}
  for (const row of normalized) {
    if (!distinct.has(row.pcoPersonId)) {
      distinct.set(row.pcoPersonId, { firstName: row.firstName, lastName: row.lastName });
    }
  }
  const matched = [];
  const toCreate = [];
  for (const [pcoPersonId, name] of distinct) {
    const existing = existingByPcoId.get(pcoPersonId);
    if (existing) {
      matched.push({ pcoPersonId, individualId: existing.id });
    } else {
      toCreate.push({
        pcoPersonId,
        firstName: (name.firstName || '').trim() || 'Unknown',
        lastName: (name.lastName || '').trim() || 'Attendee',
      });
    }
  }
  return { matched, toCreate };
}

// personToIndividual: Map<pcoPersonId, individualId>
// eventToGathering: Map<pcoEventId, gatheringTypeId>
function buildRecordWrites(normalized, personToIndividual, eventToGathering) {
  const seen = new Set();
  const writes = [];
  for (const row of normalized) {
    const gatheringTypeId = eventToGathering.get(row.pcoEventId);
    const individualId = personToIndividual.get(row.pcoPersonId);
    if (gatheringTypeId == null || individualId == null) continue;
    const key = `${gatheringTypeId}|${row.date}|${individualId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writes.push({ gatheringTypeId, date: row.date, individualId });
  }
  return writes;
}

// Computes the cutoff date (YYYY-MM-DD) that is `weeks` before `today` (YYYY-MM-DD).
function recencyCutoff(today, weeks) {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - weeks * 7);
  return t.toISOString().slice(0, 10);
}

// Which (gatheringTypeId, individualId) roll memberships to create.
// A person is added iff: their individual id is in activeIndividualIds, the
// event maps to a gathering, and they have >=1 check-in to it on/after the
// recency cutoff. Deduped.
// - normalized: rows from normalizeCheckIns
// - activeIndividualIds: Set<individualId> of is_active=1 individuals
// - personToIndividual: Map<pcoPersonId, individualId>
// - eventToGathering: Map<pcoEventId, gatheringTypeId>
// - recencyWeeks: integer window
// - today: 'YYYY-MM-DD'
function buildGatheringListAdds(normalized, activeIndividualIds, personToIndividual, eventToGathering, recencyWeeks, today) {
  const cutoff = recencyCutoff(today, recencyWeeks);
  const seen = new Set();
  const adds = [];
  for (const row of normalized) {
    if (row.date < cutoff) continue;
    const individualId = personToIndividual.get(row.pcoPersonId);
    if (individualId == null || !activeIndividualIds.has(individualId)) continue;
    const gatheringTypeId = eventToGathering.get(row.pcoEventId);
    if (gatheringTypeId == null) continue;
    const key = `${gatheringTypeId}|${individualId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adds.push({ gatheringTypeId, individualId });
  }
  return adds;
}

module.exports = {
  localDateInTz, normalizeCheckIns, summarizeEvents, resolvePeople, buildRecordWrites, buildGatheringListAdds,
  suggestGatheringId, deriveSchedule, mergeCheckinImportState,
};
