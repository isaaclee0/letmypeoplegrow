import React, { useEffect } from 'react';
import { format, addDays, startOfWeek, addWeeks, startOfDay, isBefore, differenceInCalendarDays } from 'date-fns';
import { GatheringType } from '../../services/api';

const DAY_MAP: Record<string, number> = {
  'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
  'Thursday': 4, 'Friday': 5, 'Saturday': 6,
};

/**
 * Compute the next upcoming gathering date (today or in the future).
 */
export function getNextGatheringDate(gathering: GatheringType): { date: string; daysAway: number } {
  const today = startOfDay(new Date());
  const todayStr = format(today, 'yyyy-MM-dd');

  if (gathering.customSchedule) {
    const cs = gathering.customSchedule;
    if (cs.type === 'one_off') {
      const diff = differenceInCalendarDays(new Date(cs.startDate), today);
      return { date: cs.startDate, daysAway: Math.max(diff, 0) };
    }
    if (cs.type === 'recurring' && cs.pattern) {
      const endDate = cs.endDate ? new Date(cs.endDate) : addWeeks(today, 8);
      const dates: string[] = [];
      const startDate = new Date(cs.startDate);

      if (cs.pattern.frequency === 'daily') {
        if (cs.pattern.customDates?.length) {
          dates.push(...cs.pattern.customDates);
        } else {
          let cur = startDate;
          while (isBefore(cur, endDate)) {
            dates.push(format(cur, 'yyyy-MM-dd'));
            cur = addDays(cur, cs.pattern.interval || 1);
          }
        }
      } else if (cs.pattern.frequency === 'weekly' || cs.pattern.frequency === 'biweekly') {
        const targetDays = (cs.pattern.daysOfWeek || []).map(d => DAY_MAP[d]).filter(d => d !== undefined);
        let cur = startDate;
        let weekCount = 0;
        while (isBefore(cur, endDate)) {
          const skip = cs.pattern.frequency === 'biweekly' && weekCount % 2 !== 0;
          if (!skip) {
            const ws = startOfWeek(cur, { weekStartsOn: 0 });
            for (const td of targetDays) {
              const eventDate = addDays(ws, td);
              if (!isBefore(eventDate, startDate) && isBefore(eventDate, endDate)) {
                dates.push(format(eventDate, 'yyyy-MM-dd'));
              }
            }
          }
          cur = addWeeks(cur, 1);
          weekCount++;
        }
      } else if (cs.pattern.frequency === 'monthly' && cs.pattern.dayOfMonth) {
        let cur = startDate;
        while (isBefore(cur, endDate)) {
          const eventDate = new Date(cur.getFullYear(), cur.getMonth(), cs.pattern.dayOfMonth);
          if (!isBefore(eventDate, startDate) && isBefore(eventDate, endDate)) {
            dates.push(format(eventDate, 'yyyy-MM-dd'));
          }
          cur = addWeeks(cur, 4);
        }
      }

      const sorted = dates.sort();
      const next = sorted.find(d => d >= todayStr) || sorted[sorted.length - 1];
      if (next) {
        const diff = differenceInCalendarDays(new Date(next), today);
        return { date: next, daysAway: Math.max(diff, 0) };
      }
    }
  }

  const targetDay = DAY_MAP[gathering.dayOfWeek || ''];
  if (targetDay === undefined) {
    return { date: todayStr, daysAway: 0 };
  }

  const todayDow = today.getDay();
  let daysUntil = targetDay - todayDow;
  if (daysUntil < 0) daysUntil += 7;

  const nextDate = addDays(today, daysUntil);
  const dateStr = format(nextDate, 'yyyy-MM-dd');
  return { date: dateStr, daysAway: daysUntil };
}

interface GatheringDateSelectorProps {
  kioskGatherings: GatheringType[];
  onSelect: (gathering: GatheringType, date: string, daysAway: number) => void;
  selectedGathering: GatheringType | null;
  selectedDate: string;
  daysAway: number;
}

const GatheringDateSelector: React.FC<GatheringDateSelectorProps> = ({
  kioskGatherings,
  onSelect,
  selectedGathering,
  selectedDate,
  daysAway,
}) => {
  // Auto-select when only one gathering and none selected yet
  useEffect(() => {
    if (kioskGatherings.length === 1 && !selectedGathering) {
      const g = kioskGatherings[0];
      const { date, daysAway: da } = getNextGatheringDate(g);
      onSelect(g, date, da);
    }
  }, [kioskGatherings, selectedGathering, onSelect]);

  const handleGatheringSelect = (g: GatheringType) => {
    const { date, daysAway: da } = getNextGatheringDate(g);
    onSelect(g, date, da);
  };

  if (kioskGatherings.length === 0) {
    return null;
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Gathering</label>
      {kioskGatherings.length === 1 ? (
        <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
          <div className="font-medium text-gray-900">{kioskGatherings[0].name}</div>
          {kioskGatherings[0].dayOfWeek && (
            <div className="text-sm text-gray-500">{kioskGatherings[0].dayOfWeek}</div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {kioskGatherings.map(g => (
            <label
              key={g.id}
              className={`flex items-center p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                selectedGathering?.id === g.id
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="gathering"
                checked={selectedGathering?.id === g.id}
                onChange={() => handleGatheringSelect(g)}
                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
              />
              <div className="ml-3">
                <div className="font-medium text-gray-900">{g.name}</div>
                {g.dayOfWeek && g.startTime && (
                  <div className="text-sm text-gray-500">{g.dayOfWeek} at {g.startTime}</div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {selectedGathering && daysAway > 0 && (
        <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
          Next gathering is on{' '}
          <span className="font-medium">
            {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
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
