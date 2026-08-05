import React, { useEffect, useState } from 'react';
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
        <div>
          <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Medical-note indicators</h5>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Let My People Grow stores only whether a linked person has a medical note. Open Planning Center to view details.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input aria-label="Enable medical-note indicators" type="checkbox" checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /> Enabled
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Minimum access level
          <select className="mt-1 block w-full rounded border p-2" value={settings.minimumRole}
            onChange={(event) => setSettings({ ...settings, minimumRole: event.target.value as MedicalNotesMinimumRole })}>
            <option value="admin">Admins</option><option value="coordinator">Coordinators</option><option value="attendance_taker">Attendance takers</option>
          </select>
        </label>
        <label className="text-sm">New indicator icon
          <select className="mt-1 block w-full rounded border p-2" value={settings.badgeIcon || ''}
            onChange={(event) => { setAdopt(false); setSettings({ ...settings, badgeIcon: event.target.value as BadgeIconType }); }}>
            <option value="">Choose an icon</option>{BADGE_ICON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Indicator colour
          <input className="mt-1 block h-10 w-full" type="color" value={settings.badgeColor || '#facc15'}
            onChange={(event) => { setAdopt(false); setSettings({ ...settings, badgeColor: event.target.value.toLowerCase() }); }} />
        </label>
      </div>

      <fieldset className="mt-4"><legend className="text-sm font-medium">Relevant gatherings</legend>
        <div className="mt-2 flex flex-wrap gap-3">{usableGatherings.map((g) => <label key={g.id} className="text-sm">
          <input aria-label={g.name} type="checkbox" checked={settings.gatheringTypeIds.includes(g.id)} onChange={(event) => setSettings({ ...settings,
            gatheringTypeIds: event.target.checked ? [...settings.gatheringTypeIds, g.id] : settings.gatheringTypeIds.filter((id) => id !== g.id) })} /> {g.name}
        </label>)}</div>
      </fieldset>

      {appearances.length > 0 && <fieldset className="mt-4"><legend className="text-sm font-medium">Or adopt an existing icon-only badge</legend>
        <div className="mt-2 space-y-2">{appearances.map((appearance) => <label key={`${appearance.icon}-${appearance.color}`} className="flex items-center gap-2 text-sm">
          <input type="radio" name="medical-appearance" aria-label={`Use existing ${appearance.icon} badge`} checked={adopt && selectedAppearance === appearance}
            onChange={() => { setAdopt(true); setSettings({ ...settings, badgeIcon: appearance.icon, badgeColor: appearance.color }); }} />
          <BadgeIcon type={appearance.icon} className="h-4 w-4" /> {appearance.count} {appearance.count === 1 ? 'person' : 'people'} (active and archived)
        </label>)}</div>
      </fieldset>}

      {settings.badgeIcon && settings.badgeColor && <div className="mt-4 flex items-center gap-2 text-sm"><MedicalNoteIndicator icon={settings.badgeIcon} color={settings.badgeColor} /> Medical note recorded</div>}
      {message && <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-300">{message}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Save medical-note settings</button>
        <button type="button" disabled={saving || !settings.enabled} onClick={async () => { setSaving(true); try { await settingsAPI.refreshMedicalNoteStatuses(); setMessage('Medical-note indicators refreshed.'); } catch { setMessage('Unable to refresh right now. Existing indicators have been retained.'); } finally { setSaving(false); } }} className="rounded border px-3 py-2 text-sm">Refresh now</button>
      </div>

      <Modal isOpen={confirming} onClose={() => setConfirming(false)}><div className="max-w-md rounded bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 className="font-semibold">Replace existing badges?</h3>
        <p className="mt-2 text-sm">Selecting this existing style will remove this manually assigned badge from {selectedAppearance?.count || 0} active and archived people. This cannot be automatically restored.</p>
        <div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfirming(false)}>Cancel</button><button className="rounded bg-red-600 px-3 py-2 text-white" onClick={() => void save(true)}>Confirm and save</button></div>
      </div></Modal>
    </section>
  );
};

export default PlanningCenterMedicalNotesSettings;
