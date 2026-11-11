import type { GatheringType } from '../services/api';
import { addDateOnly, differenceInDateOnlyDays, formatDateOnly } from './churchTime';

type CustomSchedule = NonNullable<GatheringType['customSchedule']>;
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function monthNumber(date: string) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

export function getCustomGatheringDates(
  schedule: CustomSchedule,
  from?: string,
  through?: string,
): string[] {
  const { startDate, endDate, pattern } = schedule;
  const start = from && from > startDate ? from : startDate;
  const end = endDate && (!through || endDate < through) ? endDate : through;
  const inRange = (date: string) => date >= start && (!end || date <= end) && !!formatDateOnly(date);

  if (schedule.type === 'one_off') return inRange(startDate) ? [startDate] : [];
  if (!pattern) return [];
  if (pattern.customDates?.length) {
    return [...new Set(pattern.customDates)]
      .filter(date => (!from || date >= from) && (!through || date <= through) && !!formatDateOnly(date))
      .sort();
  }
  if (!end || !formatDateOnly(start) || !formatDateOnly(startDate) || !formatDateOnly(end) || end < start) return [];

  const interval = Number.isSafeInteger(pattern.interval) && pattern.interval > 0 ? pattern.interval : 1;
  const dates: string[] = [];
  if (pattern.frequency === 'monthly') {
    const day = pattern.dayOfMonth;
    if (!day || day < 1 || day > 31) return dates;

    const startMonth = monthNumber(startDate);
    const lastMonth = monthNumber(end);
    const firstMonth = startMonth + Math.ceil((monthNumber(start) - startMonth) / interval) * interval;
    for (let month = firstMonth; month <= lastMonth; month += interval) {
      const date = `${String(Math.floor(month / 12)).padStart(4, '0')}-${String(month % 12 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (inRange(date)) dates.push(date);
    }
    return dates;
  }

  if (pattern.frequency === 'daily') {
    const firstDay = Math.ceil(differenceInDateOnlyDays(start, startDate) / interval) * interval;
    const lastDay = differenceInDateOnlyDays(end, startDate);
    for (let offset = firstDay; offset <= lastDay; offset += interval) {
      dates.push(addDateOnly(startDate, { days: offset }));
    }
    return dates;
  }

  const daysOfWeek = weekdays.flatMap((day, index) => pattern.daysOfWeek?.includes(day) ? [index] : []);
  if (!daysOfWeek.length) return dates;

  const startWeekday = new Date(`${startDate}T12:00:00Z`).getUTCDay();
  const firstWeek = addDateOnly(startDate, { days: -startWeekday });
  const period = interval * (pattern.frequency === 'biweekly' ? 14 : 7);
  const firstOffset = Math.floor(differenceInDateOnlyDays(start, firstWeek) / period) * period;
  const lastOffset = differenceInDateOnlyDays(end, firstWeek);
  for (let offset = firstOffset; offset <= lastOffset; offset += period) {
    for (const weekday of daysOfWeek) {
      if (offset + weekday > lastOffset) continue;
      const date = addDateOnly(firstWeek, { days: offset + weekday });
      if (date >= start) dates.push(date);
    }
  }
  return dates;
}
