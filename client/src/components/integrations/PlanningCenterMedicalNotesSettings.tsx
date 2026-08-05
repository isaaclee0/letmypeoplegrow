import React, { useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { gatheringsAPI, settingsAPI, type MedicalBadgeAppearance, type MedicalNotesMinimumRole, type PlanningCenterMedicalNotesSettingsDto } from '../../services/api';
import BadgeIcon, { BADGE_ICON_OPTIONS, type BadgeIconType } from '../icons/BadgeIcon';
import MedicalNoteIndicator from '../icons/MedicalNoteIndicator';
import Modal from '../Modal';

type Gathering = { id: number; name: string; attendanceType?: string; attendance_type?: string; isActive?: boolean; is_active?: boolean };

const emptySettings: PlanningCenterMedicalNotesSettingsDto = {
  enabled: false, minimumRole: 'admin', gatheringTypeIds: [], badgeIcon: null,
  badgeColor: null, lastRefreshedAt: null, lastRefreshResult: null,
};

const PlanningCenterMedicalNotesSettings: React.FC = () => {
  const [settings, setSettings] = useState(emptySettings);
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [appearances, setAppearances] = useState<MedicalBadgeAppearance[]>([]);
  const [adopt, setAdopt] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showExistingAppearances, setShowExistingAppearances] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      settingsAPI.getIntegrationSettings(),
      gatheringsAPI.getAll(),
      settingsAPI.getMedicalBadgeAppearances(),
    ]).then(([settingsResponse, gatheringResponse, appearanceResponse]) => {
      if (!active) return;
      setSettings(settingsResponse.data.planningCenterMedicalNotes || emptySettings);
      const data: any = gatheringResponse.data;
      setGatherings(data.gatheringTypes || data.gatherings || (Array.isArray(data) ? data : []));
      setAppearances(appearanceResponse.data.appearances || []);
    }).catch(() => active && setMessage('Unable to load medical-note indicator settings.'));
    return () => { active = false; };
  }, []);

  const usableGatherings = gatherings.filter((g) =>
    (g.attendanceType || g.attendance_type || 'standard') === 'standard'
    && (g.isActive ?? g.is_active ?? true) !== false);
  const selectedAppearance = appearances.find((a) => a.icon === settings.badgeIcon && a.color === settings.badgeColor);

  const setEnabled = (enabled: boolean) => {
    setSettings((current) => ({ ...current, enabled }));
    if (enabled) setIsExpanded(true);
  };

  const setNewAppearance = (updates: Partial<Pick<PlanningCenterMedicalNotesSettingsDto, 'badgeIcon' | 'badgeColor'>>) => {
    setAdopt(false);
    setShowExistingAppearances(false);
    setSettings((current) => ({ ...current, ...updates }));
  };

  const save = async (confirmed = false) => {
    if (settings.enabled && (!settings.gatheringTypeIds.length || !settings.badgeIcon || !settings.badgeColor)) {
      setMessage('Choose at least one gathering, an icon, and a colour.'); return;
    }
    if (adopt && !confirmed) { setConfirming(true); return; }
    setSaving(true); setMessage(null);
    try {
      const response = await settingsAPI.updateIntegrationSettings({ planningCenterMedicalNotes: {
        enabled: settings.enabled,
        minimumRole: settings.minimumRole,
        gatheringTypeIds: settings.gatheringTypeIds,
        badgeIcon: settings.badgeIcon,
        badgeColor: settings.badgeColor,
        adoptExistingAppearance: adopt && confirmed,
      } });
      setMessage(response.data.adoptedCount
        ? `${response.data.adoptedCount} manually assigned badges were replaced by the medical-note indicator.`
        : 'Medical-note indicator settings saved.');
      setAdopt(false); setConfirming(false);
    } catch (error: any) {
      setMessage(error.response?.data?.error || 'Unable to save medical-note indicator settings.');
    } finally { setSaving(false); }
  };

  return (
    <section className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Medical-note indicators</h5>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Let My People Grow stores only whether a linked person has a medical note. Open Planning Center to view details.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setEnabled(!settings.enabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${settings.enabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Enable medical-note indicators"
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${settings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} medical-note indicator settings`}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-green-500 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            {isExpanded ? <ChevronUpIcon className="h-5 w-5" /> : <ChevronDownIcon className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {isExpanded && <div className="mt-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Minimum access level
          <select className="mt-1 block w-full rounded-md border-gray-300 p-2 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 sm:text-sm" value={settings.minimumRole}
            onChange={(event) => setSettings({ ...settings, minimumRole: event.target.value as MedicalNotesMinimumRole })}>
            <option value="admin">Admins</option><option value="coordinator">Coordinators</option><option value="attendance_taker">Attendance takers</option>
          </select>
        </label>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Indicator icon</legend>
          <div className="mt-2 grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => { setAdopt(false); setShowExistingAppearances((current) => !current); }}
              aria-pressed={showExistingAppearances}
              className={`flex flex-col items-center justify-center rounded-md border-2 p-3 transition-all ${showExistingAppearances
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'}`}
            >
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Adopt existing</span>
            </button>
            {BADGE_ICON_OPTIONS.map((option) => <button
              key={option.value}
              type="button"
              aria-label={`Use ${option.label} icon`}
              aria-pressed={!adopt && settings.badgeIcon === option.value}
              onClick={() => setNewAppearance({ badgeIcon: option.value as BadgeIconType })}
              className={`flex flex-col items-center justify-center rounded-md border-2 p-3 transition-all ${!adopt && settings.badgeIcon === option.value
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'}`}
              title={option.label}
            >
              <BadgeIcon type={option.value as BadgeIconType} className="h-5 w-5 text-gray-700 dark:text-gray-300" />
              <span className="mt-1 text-xs text-gray-600 dark:text-gray-400">{option.label}</span>
            </button>)}
          </div>

          {showExistingAppearances && <div className="mt-3 rounded-md border border-gray-200 p-3 dark:border-gray-600">
            {appearances.length > 0 ? <div className="space-y-2">{appearances.map((appearance) => <label key={`${appearance.icon}-${appearance.color}`} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="radio" name="medical-appearance" aria-label={`Use existing ${appearance.icon} badge`} checked={adopt && selectedAppearance === appearance}
                onChange={() => { setAdopt(true); setShowExistingAppearances(true); setSettings({ ...settings, badgeIcon: appearance.icon, badgeColor: appearance.color }); }} />
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full" style={{ backgroundColor: appearance.color }}>
                <BadgeIcon type={appearance.icon} className="h-4 w-4" />
              </span>
              {appearance.count} {appearance.count === 1 ? 'person' : 'people'} (active and archived)
            </label>)}</div> : <p className="text-sm text-gray-500 dark:text-gray-400">No icon-only badges are currently in use.</p>}
          </div>}
        </fieldset>

        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Indicator colour</label>
          <div className="mt-2 flex items-center space-x-3">
            <input
              aria-label="Indicator colour picker"
              type="color"
              value={settings.badgeColor && /^#[0-9a-fA-F]{6}$/.test(settings.badgeColor) ? settings.badgeColor : '#facc15'}
              onChange={(event) => setNewAppearance({ badgeColor: event.target.value.toLowerCase() })}
              className="h-10 w-20 cursor-pointer rounded border border-gray-300 dark:border-gray-600"
            />
            <input
              aria-label="Indicator colour hex"
              type="text"
              value={settings.badgeColor || ''}
              onChange={(event) => setNewAppearance({ badgeColor: event.target.value })}
              className="block w-32 rounded-md border-gray-300 font-mono uppercase shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 sm:text-sm"
              placeholder="#FACC15"
              maxLength={7}
            />
          </div>
        </div>

        <fieldset className="mt-4"><legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Relevant gatherings</legend>
          <div className="mt-2 flex flex-wrap gap-3">{usableGatherings.map((g) => <label key={g.id} className="text-sm text-gray-700 dark:text-gray-300">
            <input aria-label={g.name} type="checkbox" checked={settings.gatheringTypeIds.includes(g.id)} onChange={(event) => setSettings({ ...settings,
              gatheringTypeIds: event.target.checked ? [...settings.gatheringTypeIds, g.id] : settings.gatheringTypeIds.filter((id) => id !== g.id) })} /> {g.name}
          </label>)}</div>
        </fieldset>

        {settings.badgeIcon && settings.badgeColor && <div className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><MedicalNoteIndicator icon={settings.badgeIcon} color={settings.badgeColor} /> Medical note recorded</div>}
        {message && <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-300">{message}</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Save medical-note settings</button>
          <button type="button" disabled={saving || !settings.enabled} onClick={async () => { setSaving(true); try { await settingsAPI.refreshMedicalNoteStatuses(); setMessage('Medical-note indicators refreshed.'); } catch { setMessage('Unable to refresh right now. Existing indicators have been retained.'); } finally { setSaving(false); } }} className="rounded border px-3 py-2 text-sm">Refresh now</button>
        </div>
      </div>}

      <Modal isOpen={confirming} onClose={() => setConfirming(false)}><div className="max-w-md rounded bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 className="font-semibold">Replace existing badges?</h3>
        <p className="mt-2 text-sm">Selecting this existing style will remove this manually assigned badge from {selectedAppearance?.count || 0} active and archived people. This cannot be automatically restored.</p>
        <div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfirming(false)}>Cancel</button><button className="rounded bg-red-600 px-3 py-2 text-white" onClick={() => void save(true)}>Confirm and save</button></div>
      </div></Modal>
    </section>
  );
};

export default PlanningCenterMedicalNotesSettings;
