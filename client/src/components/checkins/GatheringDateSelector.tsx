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
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Gathering</label>
      {kioskGatherings.length === 1 ? (
        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600">
          <div className="font-medium text-gray-900 dark:text-gray-100">{kioskGatherings[0].name}</div>
          {kioskGatherings[0].dayOfWeek && (
            <div className="text-sm text-gray-500 dark:text-gray-400">{kioskGatherings[0].dayOfWeek}</div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {kioskGatherings.map(g => (
            <label
              key={g.id}
              className={`flex items-center p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                selectedGathering?.id === g.id
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
              }`}
            >
              <input
                type="radio"
                name="gathering"
                checked={selectedGathering?.id === g.id}
                onChange={() => handleGatheringSelect(g)}
                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500"
              />
              <div className="ml-3">
                <div className="font-medium text-gray-900 dark:text-gray-100">{g.name}</div>
                {g.dayOfWeek && g.startTime && (
                  <div className="text-sm text-gray-500 dark:text-gray-400">{g.dayOfWeek} at {g.startTime}</div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {selectedGathering && daysAway > 0 && (
        <div className="mt-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-3 text-sm text-amber-700 dark:text-amber-300">
          Next gathering is on{' '}
          <span className="font-medium">
            {formatDateOnly(selectedDate, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </span>{' '}
          ({daysAway} day{daysAway !== 1 ? 's' : ''} away). Attendance will be recorded for that date.
        </div>
      )}
    </div>
  );
};

export default GatheringDateSelector;
