// Pure helpers for the reports attendance export (CSV / TSV / XLSX).
// buildExportTable produces { headers, rows }; the to* functions serialize it.
const ExcelJS = require('exceljs');

function formatDateHeader(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

function frequencyToDays(freq) {
  switch (freq) {
    case 'biweekly': return 14;
    case 'monthly': return 30;
    case 'weekly':
    default: return 7;
  }
}

// Assigns each distinct session date an ascending period index (0 = earliest),
// grouping dates that fall within `periodDays` of the period's first date.
// This lets gatherings meeting on different days of the same week (e.g. Sunday
// AM + Wednesday) collapse into a single period for the Present/Absent
// summary counts, mirroring the per-period absence logic used on the Reports
// page itself. `periodDays` is the shortest frequency among the exported
// gatherings.
function buildPeriodIndexByDate(sessions) {
  const uniqueDates = Array.from(new Set(sessions.map(s => s.session_date))).sort();
  const periodDays = sessions.length > 0
    ? Math.min(...sessions.map(s => frequencyToDays(s.gathering_frequency)))
    : 7;
  const periodIndexByDate = new Map();
  let anchorTime = null;
  let currentPeriod = -1;
  uniqueDates.forEach(dateStr => {
    const t = new Date(dateStr).getTime();
    if (anchorTime === null || (t - anchorTime) / (1000 * 60 * 60 * 24) >= periodDays) {
      currentPeriod += 1;
      anchorTime = t;
    }
    periodIndexByDate.set(dateStr, currentPeriod);
  });
  return periodIndexByDate;
}

// sessions: [{ session_date, gathering_type_id, gathering_name, gathering_frequency }]
//   ordered by date then name
// people: rows from the export people query
// attendanceMap: Map keyed by `${individualId}_${sessionDate}_${gatheringTypeId}` -> boolean
function buildExportTable({ sessions, people, attendanceMap, includeGatheringInHeaders }) {
  const dateHeaders = sessions.map(session => includeGatheringInHeaders
    ? `${formatDateHeader(session.session_date)} – ${session.gathering_name}`
    : formatDateHeader(session.session_date));

  const headers = [
    'First Name', 'Last Name', 'Family Name', 'People Type', 'Adult/Child',
    'Present Count', 'Absent Count',
    ...dateHeaders,
  ];

  // When multiple gatherings are exported, a naive per-column tally would
  // count a person as "absent" for every gathering they missed on a date even
  // if they attended a different selected gathering the same week. Present/
  // Absent Count are computed per reporting period instead, so attending any
  // one selected gathering counts as present for that whole period. Single-
  // gathering exports keep the original simple per-session tally (where an
  // unrecorded session counts as absent), since periods and sessions coincide
  // there anyway.
  const periodIndexByDate = includeGatheringInHeaders ? buildPeriodIndexByDate(sessions) : null;

  const rows = people.map(person => {
    const attendance = sessions.map(session =>
      attendanceMap.get(`${person.id}_${session.session_date}_${session.gathering_type_id}`) === true
    );

    let presentCount;
    let absentCount;
    if (periodIndexByDate) {
      const periodPresence = new Map();
      sessions.forEach(session => {
        const key = `${person.id}_${session.session_date}_${session.gathering_type_id}`;
        if (!attendanceMap.has(key)) return; // not tracked for this gathering/session — doesn't count either way
        const periodIndex = periodIndexByDate.get(session.session_date);
        const present = attendanceMap.get(key) === true;
        periodPresence.set(periodIndex, present || periodPresence.get(periodIndex) === true);
      });
      presentCount = Array.from(periodPresence.values()).filter(Boolean).length;
      absentCount = periodPresence.size - presentCount;
    } else {
      presentCount = attendance.filter(Boolean).length;
      absentCount = attendance.length - presentCount;
    }

    return [
      person.first_name || '',
      person.last_name || '',
      person.family_name || '',
      person.people_type || '',
      person.is_child ? 'Child' : 'Adult',
      presentCount,
      absentCount,
      ...attendance.map(present => (present ? 'TRUE' : 'FALSE')),
    ];
  });

  return { headers, rows };
}

function csvEscape(value) {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function tsvSanitize(value) {
  return String(value).replace(/[\t\n\r]+/g, ' ');
}

function toCsv(table) {
  return [table.headers, ...table.rows]
    .map(row => row.map(csvEscape).join(','))
    .join('\n');
}

function toTsv(table) {
  return [table.headers, ...table.rows]
    .map(row => row.map(tsvSanitize).join('\t'))
    .join('\n');
}

async function toXlsx(table) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Attendance');
  worksheet.addRow(table.headers);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  table.rows.forEach(row => worksheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildExportTable, toCsv, toTsv, toXlsx };
