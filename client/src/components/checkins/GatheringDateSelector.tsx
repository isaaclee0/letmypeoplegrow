import React, { useEffect } from 'react';
import { GatheringType } from '../../services/api';
import { addDateOnly, differenceInDateOnlyDays, formatDateOnly } from '../../utils/churchTime';

const DAY_MAP: Record<string, number> = {
  'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
  'Thursday': 4, 'Friday': 5, 'Saturday': 6,
};

/**
 * Compute the next upcoming gathering date (today or in the future).
 */
export function getNextGatheringDate(gathering: GatheringType, churchToday: string): { date: string; daysAway: number } {
  const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const before = (left: string, right: string) => differenceInDateOnlyDays(left, right) < 0;
  const todayStr = churchToday;

  if (gathering.customSchedule) {
    const cs = gathering.customSchedule;
    if (cs.type === 'one_off') {
      const diff = differenceInDateOnlyDays(cs.startDate, todayStr);
      return { date: cs.startDate, daysAway: Math.max(diff, 0) };
    }
    if (cs.type === 'recurring' && cs.pattern) {
      const endDate = cs.endDate || addDateOnly(todayStr, { days: 56 });
      const dates: string[] = [];
      const startDate = cs.startDate;

      if (cs.pattern.frequency === 'daily') {
        if (cs.pattern.customDates?.length) {
          dates.push(...cs.pattern.customDates);
        } else {
          let cur = startDate;
          while (before(cur, endDate)) {
            dates.push(cur);
            cur = addDateOnly(cur, { days: cs.pattern.interval || 1 });
          }
        }
      } else if (cs.pattern.frequency === 'weekly' || cs.pattern.frequency === 'biweekly') {
        const targetDays = (cs.pattern.daysOfWeek || []).map(d => DAY_MAP[d]).filter(d => d !== undefined);
        let cur = addDateOnly(startDate, { days: -weekday(startDate) });
        let weekCount = 0;
        while (before(cur, endDate)) {
          const skip = cs.pattern.frequency === 'biweekly' && weekCount % 2 !== 0;
          if (!skip) {
            for (const td of targetDays) {
              const eventDate = addDateOnly(cur, { days: td });
              if (!before(eventDate, startDate) && before(eventDate, endDate)) {
                dates.push(eventDate);
              }
            }
          }
          cur = addDateOnly(cur, { days: 7 });
          weekCount++;
        }
      } else if (cs.pattern.frequency === 'monthly' && cs.pattern.dayOfMonth) {
        let cur = startDate;
        while (before(cur, endDate)) {
          const eventDate = addDateOnly(`${cur.slice(0, 8)}01`, { days: cs.pattern.dayOfMonth - 1 });
          if (!before(eventDate, startDate) && before(eventDate, endDate)) {
            dates.push(eventDate);
          }
          cur = addDateOnly(cur, { months: 1 });
        }
      }

      const sorted = dates.sort();
      const next = sorted.find(d => d >= todayStr) || sorted[sorted.length - 1];
      if (next) {
        const diff = differenceInDateOnlyDays(next, todayStr);
        return { date: next, daysAway: Math.max(diff, 0) };
      }
    }
  }

  const targetDay = DAY_MAP[gathering.dayOfWeek || ''];
  if (targetDay === undefined) {
    return { date: todayStr, daysAway: 0 };
  }

  const todayDow = weekday(todayStr);
  let daysUntil = targetDay - todayDow;
  if (daysUntil < 0) daysUntil += 7;

  const dateStr = addDateOnly(todayStr, { days: daysUntil });
  return { date: dateStr, daysAway: daysUntil };
}

interface GatheringDateSelectorProps {
  kioskGatherings: GatheringType[];
  onSelect: (gathering: GatheringType, date: string, daysAway: number) => void;
  selectedGathering: GatheringType | null;
  selectedDate: string;
  daysAway: number;
  churchToday: string;
}

const GatheringDateSelector: React.FC<GatheringDateSelectorProps> = ({
  kioskGatherings,
  onSelect,
  selectedGathering,
  selectedDate,
  daysAway,
  churchToday,
}) => {
  // Auto-select when only one gathering and none selected yet
  useEffect(() => {
    if (kioskGatherings.length === 1 && !selectedGathering) {
      const g = kioskGatherings[0];
      const { date, daysAway: da } = getNextGatheringDate(g, churchToday);
      onSelect(g, date, da);
    }
  }, [kioskGatherings, selectedGathering, onSelect, churchToday]);

  const handleGatheringSelect = (g: GatheringType) => {
    const { date, daysAway: da } = getNextGatheringDate(g, churchToday);
    onSelect(g, date, da);
  };

  if (kioskGatherings.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="checkin-gathering" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Gathering</label>
          <select
            id="checkin-gathering"
            value={selectedGathering?.id ?? ''}
            onChange={(event) => {
              const gathering = kioskGatherings.find(g => g.id === Number(event.target.value));
              if (gathering) handleGatheringSelect(gathering);
            }}
            className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-transparent dark:bg-gray-900/50 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500"
          >
            <option value="" disabled>Select a gathering</option>
            {kioskGatherings.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div>
          <div className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Check-in date</div>
          <div className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
            {selectedGathering ? formatDateOnly(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Select a gathering first'}
          </div>
        </div>
      </div>

      {selectedGathering && daysAway > 0 && (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          This gathering is {daysAway} day{daysAway !== 1 ? 's' : ''} away. Attendance will be recorded for the date shown above.
        </p>
      )}
    </div>
  );
};

export default GatheringDateSelector;
