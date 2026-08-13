export type InstantInput = string | number | Date;

export interface DateOnlyAmount {
  days?: number;
  months?: number;
  years?: number;
}

const SQLITE_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeTimeZone(value?: string | null): string {
  if (!value) return 'UTC';

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    return 'UTC';
  }
}

export function parseInstant(value: InstantInput): Date | null {
  const instant = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'string' && SQLITE_UTC_TIMESTAMP.test(value)
      ? new Date(`${value.replace(' ', 'T')}Z`)
      : new Date(value);

  return Number.isNaN(instant.getTime()) ? null : instant;
}

export function formatInstant(
  value: InstantInput,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const instant = parseInstant(value);
  if (!instant) return '';

  return new Intl.DateTimeFormat(locale, {
    timeZone: normalizeTimeZone(timeZone),
    ...options,
  }).format(instant);
}

function getZonedParts(timeZone: string, instant: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  return Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  ) as Record<string, string>;
}

export function getChurchDate(timeZone: string, instant: Date = new Date()): string {
  const parts = getZonedParts(timeZone, instant);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getChurchClockMinutes(timeZone: string, instant: Date = new Date()): number {
  const parts = getZonedParts(timeZone, instant);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function dateOnlyToUtcNoon(value: string): Date | null {
  const match = DATE_ONLY.exec(value);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    ? date
    : null;
}

export function formatDateOnly(
  value: string,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const date = dateOnlyToUtcNoon(value);
  if (!date) return '';

  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(date);
}

export function addDateOnly(value: string, amount: DateOnlyAmount): string {
  const date = dateOnlyToUtcNoon(value);
  if (!date) return value;

  if (amount.years) date.setUTCFullYear(date.getUTCFullYear() + amount.years);
  if (amount.months) date.setUTCMonth(date.getUTCMonth() + amount.months);
  if (amount.days) date.setUTCDate(date.getUTCDate() + amount.days);

  return date.toISOString().slice(0, 10);
}

export function differenceInDateOnlyDays(left: string, right: string): number {
  const leftDate = dateOnlyToUtcNoon(left);
  const rightDate = dateOnlyToUtcNoon(right);
  if (!leftDate || !rightDate) return Number.NaN;

  return Math.round((leftDate.getTime() - rightDate.getTime()) / 86_400_000);
}
