import { addDateOnly } from './churchTime';

export type ReportDateRangePreset =
  | 'last-4-weeks'
  | 'last-8-weeks'
  | 'last-3-months'
  | 'last-6-months'
  | 'year-to-date';

export function reportDateRange(preset: ReportDateRangePreset, churchToday: string): { start: string; end: string } {
  switch (preset) {
    case 'last-4-weeks': return { start: addDateOnly(churchToday, { days: -28 }), end: churchToday };
    case 'last-8-weeks': return { start: addDateOnly(churchToday, { days: -56 }), end: churchToday };
    case 'last-3-months': return { start: addDateOnly(churchToday, { months: -3 }), end: churchToday };
    case 'last-6-months': return { start: addDateOnly(churchToday, { months: -6 }), end: churchToday };
    case 'year-to-date': return { start: `${churchToday.slice(0, 4)}-01-01`, end: churchToday };
  }
}
