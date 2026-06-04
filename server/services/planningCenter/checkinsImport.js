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
  for (const item of included) {
    if (item.type === 'Event') {
      events[item.id] = item.attributes.name || UNKNOWN_EVENT_NAME;
    } else if (item.type === 'Person') {
      people[item.id] = {
        firstName: item.attributes.first_name || '',
        lastName: item.attributes.last_name || '',
      };
    }
  }
  return { events, people };
}

// payload = { data, included }; returns flat, de-duped rows.
function normalizeCheckIns(payload, tz) {
  const { events, people } = buildIncludedMaps(payload.included);
  const seen = new Set();
  const out = [];
  for (const ci of payload.data || []) {
    const pcoEventId = ci.relationships?.event?.data?.id;
    const pcoPersonId = ci.relationships?.person?.data?.id;
    const checkedInAt = ci.attributes?.checked_in_at;
    if (!pcoEventId || !pcoPersonId || !checkedInAt) continue;
    const date = localDateInTz(checkedInAt, tz);
    if (!date) continue;
    const key = `${pcoEventId}|${pcoPersonId}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const person = people[pcoPersonId] || { firstName: '', lastName: '' };
    out.push({
      pcoEventId,
      eventName: events[pcoEventId] || UNKNOWN_EVENT_NAME,
      pcoPersonId,
      firstName: person.firstName,
      lastName: person.lastName,
      date,
    });
  }
  return out;
}

function summarizeEvents(normalized) {
  const byEvent = new Map();
  for (const row of normalized) {
    let e = byEvent.get(row.pcoEventId);
    if (!e) {
      e = { pcoEventId: row.pcoEventId, eventName: row.eventName, checkinCount: 0, dates: new Set() };
      byEvent.set(row.pcoEventId, e);
    }
    e.checkinCount += 1;
    e.dates.add(row.date);
  }
  return Array.from(byEvent.values()).map((e) => {
    const sorted = Array.from(e.dates).sort();
    return {
      pcoEventId: e.pcoEventId,
      eventName: e.eventName,
      checkinCount: e.checkinCount,
      sessionCount: sorted.length,
      firstDate: sorted[0] || null,
      lastDate: sorted[sorted.length - 1] || null,
    };
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
};
