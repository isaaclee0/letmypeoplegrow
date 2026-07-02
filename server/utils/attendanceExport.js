// Pure helpers for the reports attendance export (CSV / TSV / XLSX).
// buildExportTable produces { headers, rows }; the to* functions serialize it.
const ExcelJS = require('exceljs');

function formatDateHeader(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

// sessions: [{ session_date, gathering_type_id, gathering_name }] ordered by date then name
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

  const rows = people.map(person => {
    const attendance = sessions.map(session =>
      attendanceMap.get(`${person.id}_${session.session_date}_${session.gathering_type_id}`) === true
    );
    const presentCount = attendance.filter(Boolean).length;
    return [
      person.first_name || '',
      person.last_name || '',
      person.family_name || '',
      person.people_type || '',
      person.is_child ? 'Child' : 'Adult',
      presentCount,
      attendance.length - presentCount,
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
