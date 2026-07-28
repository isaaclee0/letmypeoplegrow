const DAY_MS = 24 * 60 * 60 * 1000;

function frequencyToDays(frequency) {
  if (frequency === 'biweekly') return 14;
  if (frequency === 'monthly') return 30;
  return 7;
}

function calculateConsecutiveAbsenceStreaks({
  sessions = [], attendanceRows = [], individualIds = [], maxPeriods = 12,
}) {
  const streaks = new Map(individualIds.map((id) => [Number(id), 0]));
  if (!sessions.length || !individualIds.length || maxPeriods <= 0) return streaks;

  const periodDays = Math.min(...sessions.map((session) => frequencyToDays(session.frequency)));
  const ordered = [...sessions].sort((a, b) =>
    b.session_date.localeCompare(a.session_date) || Number(b.id) - Number(a.id)
  );
  const periods = [];
  let anchor = null;

  for (const session of ordered) {
    const time = Date.parse(`${session.session_date}T00:00:00Z`);
    if (anchor === null || (anchor - time) / DAY_MS >= periodDays) {
      if (periods.length >= maxPeriods) break;
      anchor = time;
      periods.push([]);
    }
    periods[periods.length - 1].push(Number(session.id));
  }

  const present = new Set(attendanceRows
    .filter((row) => Number(row.present) === 1)
    .map((row) => `${Number(row.individual_id)}:${Number(row.session_id)}`));

  for (const rawId of individualIds) {
    const id = Number(rawId);
    let streak = 0;
    for (const sessionIds of periods) {
      if (sessionIds.some((sessionId) => present.has(`${id}:${sessionId}`))) break;
      streak += 1;
    }
    streaks.set(id, streak);
  }

  return streaks;
}

module.exports = { frequencyToDays, calculateConsecutiveAbsenceStreaks };
