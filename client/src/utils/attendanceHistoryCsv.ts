export interface AttendanceHistoryEntry {
  date: string;
  gatheringId: number;
  gatheringName: string;
  present: boolean;
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

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildAttendanceHistoryCsv(rows: AttendanceHistoryEntry[]): string {
  const headers = ['Date', 'Gathering', 'Status'];
  const lines = rows.map(row => [
    row.date,
    csvEscape(row.gatheringName),
    row.present ? 'Present' : 'Absent'
  ].join(','));
  return [headers.join(','), ...lines].join('\n');
}
