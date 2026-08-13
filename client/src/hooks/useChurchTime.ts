import { useContext, useMemo } from 'react';
import { AuthContext } from '../contexts/authContextValue';
import {
  formatDateOnly,
  formatInstant,
  getChurchClockMinutes,
  getChurchDate,
  InstantInput,
  normalizeTimeZone,
} from '../utils/churchTime';

export function useChurchTime() {
  const user = useContext(AuthContext)?.user;
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
