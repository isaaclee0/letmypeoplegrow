export interface AttendanceHistoryEntry {
  date: string;
  gatheringId: number;
  gatheringName: string;
  present: boolean;
  personId?: number;
  personName?: string;
}

export function filterHistoryByGathering(
  history: AttendanceHistoryEntry[],
  gatheringId: number | null
): AttendanceHistoryEntry[] {
  if (gatheringId === null) {
    return history;
  }
  return history.filter(row => row.gatheringId === gatheringId);
}

export function filterHistoryByPerson(
  history: AttendanceHistoryEntry[],
  personId: number | null
): AttendanceHistoryEntry[] {
  if (personId === null) {
    return history;
  }
  return history.filter(row => row.personId === personId);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildAttendanceHistoryCsv(rows: AttendanceHistoryEntry[]): string {
  const isMultiPerson = rows.some(row => row.personName !== undefined);
  const headers = isMultiPerson
    ? ['Date', 'Person', 'Gathering', 'Status']
    : ['Date', 'Gathering', 'Status'];
  const lines = rows.map(row => {
    const cells = isMultiPerson
      ? [row.date, csvEscape(row.personName || ''), csvEscape(row.gatheringName), row.present ? 'Present' : 'Absent']
      : [row.date, csvEscape(row.gatheringName), row.present ? 'Present' : 'Absent'];
    return cells.join(',');
  });
  return [headers.join(','), ...lines].join('\n');
}
