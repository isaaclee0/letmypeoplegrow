import React, { useEffect, useId, useRef, useState } from 'react';
import { gatheringsAPI } from '../../services/api';
import { formatDateOnly, normalizeTimeZone } from '../../utils/churchTime';

type AttendanceType = 'standard' | 'headcount';
type Frequency = 'weekly' | 'biweekly' | 'monthly';
type Recurrence = Frequency | 'daily';
type CreateGathering = Parameters<typeof gatheringsAPI.create>[0];
type CustomSchedule = NonNullable<CreateGathering['customSchedule']>;
type Schedule = Pick<CreateGathering, 'dayOfWeek' | 'startTime' | 'endTime' | 'frequency' | 'customSchedule'>;

interface CreatedGathering {
  id: number;
  name: string;
  attendanceType: AttendanceType;
  individualMode?: boolean;
}

interface GatheringWizardProps {
  onCreated: (gathering: CreatedGathering) => void | Promise<void>;
  onCancel?: () => void;
  timeZone?: string;
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const stepTitles = ['Name and schedule', 'How will you take attendance?', 'Families and leader check-in'];
const inputClass = 'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-primary-500 focus:outline-2 focus:outline-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const primaryButtonClass = 'rounded-md bg-primary-600 px-4 py-2 font-medium text-white hover:bg-primary-700 disabled:opacity-50';
const secondaryButtonClass = 'rounded-md border border-gray-300 px-4 py-2 font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700';

function createErrorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string; errors?: { msg: string }[] } } })?.response?.data;
  return data?.error || data?.errors?.map(({ msg }) => msg).join(', ') || 'Could not create the gathering. Try again.';
}

export default function GatheringWizard({ onCreated, onCancel, timeZone }: GatheringWizardProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const submissionInProgress = useRef(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<Frequency | 'custom'>('weekly');
  const [dayOfWeek, setDayOfWeek] = useState('Sunday');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('');
  const [scheduleType, setScheduleType] = useState<'one_off' | 'dates' | 'recurring'>('one_off');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateList, setDateList] = useState('');
  const [recurrence, setRecurrence] = useState<Recurrence>('weekly');
  const [interval, setInterval] = useState('1');
  const [daysOfWeek, setDaysOfWeek] = useState<string[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [attendanceType, setAttendanceType] = useState<AttendanceType>();
  const [groupFamilies, setGroupFamilies] = useState(true);
  const [leaderCheckinEnabled, setLeaderCheckinEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createdGathering, setCreatedGathering] = useState<CreatedGathering>();
  const [continued, setContinued] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const isCustom = frequency === 'custom';
  const usesWeekdays = recurrence === 'weekly' || recurrence === 'biweekly';
  const createsGathering = step === 2 || (step === 1 && attendanceType === 'headcount');

  function getSchedule(): { schedule: Schedule } | { error: string } {
    if (!name.trim() || name.trim().length > 255) {
      return { error: 'Enter a gathering name of 255 characters or fewer.' };
    }

    if (frequency !== 'custom') {
      if (!startTime) return { error: 'Enter a start time.' };
      return { schedule: { dayOfWeek, startTime, endTime: endTime || undefined, frequency } };
    }

    let customSchedule: CustomSchedule;
    if (scheduleType === 'dates') {
      const customDates = [...new Set(dateList.split('\n').map(date => date.trim()).filter(Boolean))].sort();
      if (!customDates.length || customDates.some(date => !formatDateOnly(date))) {
        return { error: 'Enter a valid date on each line in YYYY-MM-DD format.' };
      }
      customSchedule = {
        type: 'recurring',
        startDate: customDates[0],
        pattern: { frequency: 'daily', interval: 1, customDates },
      };
    } else {
      if (!formatDateOnly(startDate)) return { error: 'Enter a valid date.' };
      if (scheduleType === 'one_off') {
        customSchedule = { type: 'one_off', startDate };
      } else {
        if (!formatDateOnly(endDate) || endDate <= startDate) {
          return { error: 'Enter an end date after the first date.' };
        }
        const repeatInterval = Number(interval);
        if (!Number.isSafeInteger(repeatInterval) || repeatInterval < 1) {
          return { error: 'Enter a whole number of 1 or more for the repeat interval.' };
        }
        if (usesWeekdays && !daysOfWeek.length) return { error: 'Select at least one day of the week.' };
        const monthDay = Number(dayOfMonth);
        if (recurrence === 'monthly' && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)) {
          return { error: 'Enter a day of the month from 1 to 31.' };
        }
        customSchedule = {
          type: 'recurring',
          startDate,
          endDate,
          pattern: {
            frequency: recurrence,
            interval: repeatInterval,
            ...(usesWeekdays ? { daysOfWeek } : {}),
            ...(recurrence === 'monthly' ? { dayOfMonth: monthDay } : {}),
          },
        };
      }
    }
    return { schedule: { customSchedule } };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionInProgress.current || continued) return;
    setError('');

    const schedule = getSchedule();
    if ('error' in schedule) {
      setError(schedule.error);
      setStep(0);
      return;
    }
    if (step === 0) {
      setStep(1);
      return;
    }
    if (!attendanceType) {
      setError('Choose how you will take attendance.');
      return;
    }
    if (!createsGathering) {
      setStep(2);
      return;
    }

    submissionInProgress.current = true;
    setSaving(true);
    let gathering = createdGathering;
    try {
      if (!gathering) {
        const standard = attendanceType === 'standard';
        const individualMode = !groupFamilies;
        const { data } = await gatheringsAPI.create({
          ...schedule.schedule,
          name: name.trim(),
          attendanceType,
          kioskEnabled: false,
          ...(standard ? { individualMode, leaderCheckinEnabled } : {}),
        });
        gathering = {
          id: data.id,
          name: name.trim(),
          attendanceType,
          ...(standard ? { individualMode } : {}),
        };
        setCreatedGathering(gathering);
      }
      await onCreated(gathering);
      setContinued(true);
    } catch (failure) {
      submissionInProgress.current = false;
      setError(gathering
        ? 'The gathering was saved. Select Continue to resume setup.'
        : createErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  function goBack() {
    setError('');
    setStep(step - 1);
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-labelledby={`${id}-heading`} className="space-y-5">
      <div>
        <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
          Step {step + 1} of {attendanceType === 'headcount' ? 2 : 3}
        </p>
        <h2 id={`${id}-heading`} ref={heading} tabIndex={-1} className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
          {stepTitles[step]}
        </h2>
      </div>

      {step === 0 && (
        <div className="space-y-4 text-sm font-medium">
          <label className="block">
            Gathering name
            <input className={inputClass} value={name} onChange={event => setName(event.target.value)} maxLength={255} required />
          </label>
          <label className="block">
            Frequency
            <select className={inputClass} value={frequency} onChange={event => setFrequency(event.target.value as typeof frequency)}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {isCustom ? (
            <>
              <label className="block">
                Custom schedule type
                <select className={inputClass} value={scheduleType} onChange={event => setScheduleType(event.target.value as typeof scheduleType)}>
                  <option value="one_off">One-off date</option>
                  <option value="dates">Specific dates</option>
                  <option value="recurring">Recurring pattern</option>
                </select>
              </label>
              {scheduleType === 'dates' ? (
                <div>
                  <label htmlFor={`${id}-dates`}>Dates (YYYY-MM-DD)</label>
                  <textarea id={`${id}-dates`} className={inputClass} value={dateList} onChange={event => setDateList(event.target.value)} rows={4} aria-describedby={`${id}-date-help`} required />
                  <p id={`${id}-date-help`} className="mt-1 font-normal text-gray-600 dark:text-gray-400">Enter one date per line.</p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    {scheduleType === 'one_off' ? 'Date' : 'First date'}
                    <input type="date" className={inputClass} value={startDate} onChange={event => setStartDate(event.target.value)} required />
                  </label>
                  {scheduleType === 'recurring' && (
                    <label className="block">
                      End date
                      <input type="date" className={inputClass} value={endDate} onChange={event => setEndDate(event.target.value)} required />
                    </label>
                  )}
                </div>
              )}
              {scheduleType === 'recurring' && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      Repeat
                      <select className={inputClass} value={recurrence} onChange={event => setRecurrence(event.target.value as Recurrence)}>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="biweekly">Fortnightly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </label>
                    <label className="block">
                      Repeat interval
                      <input type="number" min={1} className={inputClass} value={interval} onChange={event => setInterval(event.target.value)} required />
                    </label>
                  </div>
                  {usesWeekdays && (
                    <fieldset>
                      <legend>Repeat on</legend>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                        {weekdays.map(day => (
                          <label key={day} className="flex items-center gap-2">
                            <input type="checkbox" checked={daysOfWeek.includes(day)} onChange={event => {
                              setDaysOfWeek(event.target.checked ? [...daysOfWeek, day] : daysOfWeek.filter(value => value !== day));
                            }} />
                            {day}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  {recurrence === 'monthly' && (
                    <label className="block">
                      Day of month
                      <input type="number" min={1} max={31} className={inputClass} value={dayOfMonth} onChange={event => setDayOfMonth(event.target.value)} required />
                    </label>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                Day of week
                <select className={inputClass} value={dayOfWeek} onChange={event => setDayOfWeek(event.target.value)}>
                  {weekdays.map(day => <option key={day}>{day}</option>)}
                </select>
              </label>
              <label className="block">
                Start time
                <input type="time" className={inputClass} value={startTime} onChange={event => setStartTime(event.target.value)} required />
              </label>
              <label className="block">
                End time (optional)
                <input type="time" className={inputClass} value={endTime} onChange={event => setEndTime(event.target.value)} />
              </label>
            </div>
          )}
          <p className="font-normal text-gray-600 dark:text-gray-400">Church time zone is {normalizeTimeZone(timeZone)}.</p>
        </div>
      )}

      {step === 1 && (
        <fieldset disabled={saving || !!createdGathering} className="space-y-3">
          <legend className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            In Let My People Grow, you can mark each person present by name, or record a simple headcount.
          </legend>
          {([
            ['standard', 'Track people by name', 'See who attended and follow attendance over time.'],
            ['headcount', 'Simple headcount', 'Record how many people attended without adding names.'],
          ] as const).map(([value, label, description]) => (
            <div key={value} className="flex items-start gap-3 rounded-md border border-gray-300 p-3 has-checked:border-primary-500 dark:border-gray-600">
              <input id={`${id}-${value}`} name={`${id}-attendance`} type="radio" className="mt-1" checked={attendanceType === value} onChange={() => setAttendanceType(value)} aria-labelledby={`${id}-${value}-label`} aria-describedby={`${id}-${value}-help`} />
              <label htmlFor={`${id}-${value}`} className="flex-1 cursor-pointer">
                <span id={`${id}-${value}-label`} className="block font-medium">{label}</span>
                <span id={`${id}-${value}-help`} className="block text-sm text-gray-600 dark:text-gray-400">{description}</span>
              </label>
            </div>
          ))}
        </fieldset>
      )}

      {step === 2 && (
        <fieldset disabled={saving || !!createdGathering} aria-labelledby={`${id}-heading`} className="space-y-4">
          <div className="flex items-start gap-3">
            <input id={`${id}-families`} type="checkbox" className="mt-1" checked={groupFamilies} onChange={event => setGroupFamilies(event.target.checked)} aria-describedby={`${id}-families-help`} />
            <div>
              <label htmlFor={`${id}-families`} className="font-medium">Group people into families</label>
              <p id={`${id}-families-help`} className="text-sm text-gray-600 dark:text-gray-400">Keep family members together on your attendance list.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <input id={`${id}-leaders`} type="checkbox" className="mt-1" checked={leaderCheckinEnabled} onChange={event => setLeaderCheckinEnabled(event.target.checked)} aria-describedby={`${id}-leaders-help`} />
            <div>
              <label htmlFor={`${id}-leaders`} className="font-medium">Enable leader check-in</label>
              <p id={`${id}-leaders-help`} className="text-sm text-gray-600 dark:text-gray-400">
                Record when people check in and out, and which leader checked them in or out.
                Useful for children's groups and other gatherings where arrival and departure details matter.
              </p>
            </div>
          </div>
        </fieldset>
      )}

      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}

      <div className="flex flex-wrap justify-end gap-3">
        {step > 0 ? (
          <button type="button" className={secondaryButtonClass} onClick={goBack} disabled={saving || !!createdGathering}>Back</button>
        ) : onCancel && (
          <button type="button" className={secondaryButtonClass} onClick={onCancel}>Cancel</button>
        )}
        <button type="submit" className={primaryButtonClass} disabled={saving || continued}>
          {saving ? (createdGathering ? 'Continuing…' : 'Creating…') : createdGathering ? 'Continue' : createsGathering ? 'Create gathering' : 'Next'}
        </button>
      </div>
    </form>
  );
}
