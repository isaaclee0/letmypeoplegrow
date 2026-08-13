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
  let user: { timezone?: string | null } | null | undefined;
  try {
    user = useAuth().user;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'useAuth must be used within an AuthProvider') throw error;
    user = null;
  }
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
