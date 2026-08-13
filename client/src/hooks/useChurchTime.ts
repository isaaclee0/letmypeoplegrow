import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  formatDateOnly,
  formatInstant,
  getChurchClockMinutes,
  getChurchDate,
  InstantInput,
  normalizeTimeZone,
} from '../utils/churchTime';

export function useChurchTime() {
  const { user } = useAuth();
  const timeZone = normalizeTimeZone(user?.timezone);

  return useMemo(() => ({
    timeZone,
    today: (instant: Date = new Date()) => getChurchDate(timeZone, instant),
    formatInstant: (value: InstantInput, options?: Intl.DateTimeFormatOptions, locale?: string) =>
      formatInstant(value, timeZone, options, locale),
    formatDateOnly,
    clockMinutes: (instant: Date = new Date()) => getChurchClockMinutes(timeZone, instant),
  }), [timeZone]);
}
