import React, { useEffect, useMemo, useState } from 'react';
import type {
  EngagementGatheringRole,
  EngagementSettingsDto,
  EngagementSettingsInput,
  EngagementTierKey,
} from '../../services/api';
import { settingsAPI } from '../../services/api';

interface EngagementSettingsProps {
  settings: EngagementSettingsDto;
  canEdit: boolean;
  onSaved: (settings: EngagementSettingsDto) => void | Promise<void>;
}

const TIER_KEYS: EngagementTierKey[] = ['core', 'casual', 'irregular'];
const ROLE_LABELS: Record<string, string> = {
  primary: 'Primary', community: 'Other participation', other: 'Excluded', unclassified: 'Unclassified',
};

function rulesSummary(settings: EngagementSettingsDto): string {
  return `${settings.tiers.core.label}: ${settings.coreMinimum}% or more`;
}

function editableRoles(settings: EngagementSettingsDto) {
  return settings.gatheringRoles.map(({ gatheringTypeId, role }) => ({ gatheringTypeId, role }));
}

const EngagementSettings: React.FC<EngagementSettingsProps> = ({ settings, canEdit, onSaved }) => {
  const [form, setForm] = useState<EngagementSettingsInput>({
    coreMinimum: settings.coreMinimum,
    casualMinimum: settings.casualMinimum,
    tiers: structuredClone(settings.tiers),
    gatheringRoles: editableRoles(settings),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const gatheringById = useMemo(
    () => new Map(settings.gatheringRoles.map((gathering) => [gathering.gatheringTypeId, gathering])),
    [settings.gatheringRoles],
  );

  useEffect(() => {
    setForm({
      coreMinimum: settings.coreMinimum,
      casualMinimum: settings.casualMinimum,
      tiers: structuredClone(settings.tiers),
      gatheringRoles: editableRoles(settings),
    });
  }, [settings]);

  if (!canEdit) {
    return (
      <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-700" aria-labelledby="active-engagement-rules">
        <h3 id="active-engagement-rules" className="font-semibold text-gray-900 dark:text-gray-100">Active engagement rules</h3>
        <ul className="mt-2 space-y-1 text-sm text-gray-700 dark:text-gray-300">
          <li>{rulesSummary(settings)}</li>
          <li>{settings.tiers.casual.label}: {settings.casualMinimum}% to {settings.coreMinimum - 1}%</li>
          <li>{settings.tiers.irregular.label}: below {settings.casualMinimum}%</li>
        </ul>
        <ul className="mt-3 space-y-1 text-sm">
          {settings.gatheringRoles.map(({ gatheringTypeId, name, attendanceType, isActive, role }) => (
            <li key={gatheringTypeId}>
              {name}: {ROLE_LABELS[role || 'unclassified']}
              {!isActive && ' (Inactive)'}
              {attendanceType === 'headcount' && ' (Headcount)'}
            </li>
          ))}
        </ul>
        {settings.gatheringRoles.some(({ attendanceType }) => attendanceType === 'headcount') && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Headcount gatherings do not create person-level tiers; their role affects aggregate trends only.</p>
        )}
      </section>
    );
  }

  const updateTier = (tier: EngagementTierKey, field: 'label' | 'colour', value: string) => {
    setForm((current) => ({ ...current, tiers: { ...current.tiers, [tier]: { ...current.tiers[tier], [field]: value } } }));
  };
  const updateRole = (gatheringTypeId: number, role: EngagementGatheringRole) => {
    setForm((current) => ({
      ...current,
      gatheringRoles: current.gatheringRoles.map((assignment) => assignment.gatheringTypeId === gatheringTypeId ? { ...assignment, role } : assignment),
    }));
  };
  const save = async () => {
    setSaved(false);
    if (!Number.isInteger(form.casualMinimum) || !Number.isInteger(form.coreMinimum)
      || form.casualMinimum < 0 || form.coreMinimum > 100 || form.casualMinimum >= form.coreMinimum) {
      setError('Casual minimum must be less than Core minimum, using whole percentages from 0 to 100.');
      return;
    }
    if (TIER_KEYS.some((tier) => !form.tiers[tier].label.trim())) {
      setError('Each tier needs a label.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await settingsAPI.updateEngagementSettings(form);
      await onSaved(response.data.settings);
      setSaved(true);
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || 'Could not save engagement settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-6" aria-labelledby="configure-engagement-heading">
      <div>
        <h2 id="configure-engagement-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Configure engagement</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Changes to thresholds and roles are saved together and reports refresh under the new rules.</p>
      </div>
      <fieldset>
        <legend className="font-semibold text-gray-900 dark:text-gray-100">Tier rules</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="text-sm text-gray-900 dark:text-gray-100">Core minimum
            <input aria-label="Core minimum" type="number" min="0" max="100" value={form.coreMinimum} onChange={(event) => setForm({ ...form, coreMinimum: Number(event.target.value) })} className="mt-1 block w-full rounded border border-gray-300 p-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
          </label>
          <label className="text-sm text-gray-900 dark:text-gray-100">Casual minimum
            <input aria-label="Casual minimum" type="number" min="0" max="100" value={form.casualMinimum} onChange={(event) => setForm({ ...form, casualMinimum: Number(event.target.value) })} className="mt-1 block w-full rounded border border-gray-300 p-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
          </label>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {TIER_KEYS.map((tier) => (
            <div key={tier} className="rounded border border-gray-200 p-3 dark:border-gray-700">
              <label className="text-sm text-gray-900 dark:text-gray-100">{tier[0].toUpperCase() + tier.slice(1)} label
                <input aria-label={`${tier[0].toUpperCase() + tier.slice(1)} label`} value={form.tiers[tier].label} onChange={(event) => updateTier(tier, 'label', event.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
              </label>
              <label className="mt-3 block text-sm text-gray-900 dark:text-gray-100">{tier[0].toUpperCase() + tier.slice(1)} colour
                <input aria-label={`${tier[0].toUpperCase() + tier.slice(1)} colour`} type="color" value={form.tiers[tier].colour} onChange={(event) => updateTier(tier, 'colour', event.target.value)} className="mt-1 h-10 w-full" />
              </label>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-900 dark:text-gray-300">
          <p>The exact opportunity percentage is used; monthly counts are examples only.</p>
          <ul className="mt-2 list-disc pl-5">
            <li>Weekly: 31 of 52 is 60%</li>
            <li>Fortnightly: 16 of 26 is 62%</li>
            <li>Monthly: 8 of 13 is 62%</li>
          </ul>
        </div>
      </fieldset>
      <fieldset>
        <legend className="font-semibold text-gray-900 dark:text-gray-100">Gathering roles</legend>
        <div className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-300">
          <p>Primary combines alternative services into one opportunity per person each week.</p>
          <p>Other participation treats each eligible session as a separate opportunity.</p>
          <p>Excluded gatherings remain in attendance trends but not person tiers.</p>
        </div>
        <div className="mt-4 space-y-3">
          {form.gatheringRoles.map((assignment) => {
            const gathering = gatheringById.get(assignment.gatheringTypeId);
            const name = gathering?.name || `Gathering ${assignment.gatheringTypeId}`;
            return (
              <div key={assignment.gatheringTypeId} className="rounded border border-gray-200 p-3 text-gray-900 dark:border-gray-700 dark:text-gray-100 sm:flex sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <span className="font-medium">{name}</span>{' '}
                  {gathering && !gathering.isActive && <span className="rounded bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700 dark:text-gray-200">Inactive</span>}
                  {gathering?.attendanceType === 'headcount' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Headcount gatherings cannot create person-level tiers; their role affects aggregate trends only.</p>}
                </div>
                <select aria-label={`Role for ${name}`} value={assignment.role || ''} onChange={(event) => updateRole(assignment.gatheringTypeId, (event.target.value || null) as EngagementGatheringRole)} className="mt-2 rounded border border-gray-300 p-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 sm:mt-0">
                  <option value="">Unclassified</option><option value="primary">Primary</option><option value="community">Other participation</option><option value="other">Excluded</option>
                </select>
              </div>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3 text-sm text-gray-700 dark:text-gray-300">
        <span>{settings.assignmentPreview.primaryAssigned} Primary assigned</span>
        <span>{settings.assignmentPreview.communityAssigned} Other participation assigned</span>
        <span>{settings.assignmentPreview.primaryNotAssigned} Primary not assigned</span>
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {saved && <p role="status" className="text-sm text-green-700 dark:text-green-300">Settings saved. Long-term health has been refreshed.</p>}
      <button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {saving ? 'Saving…' : 'Save engagement settings'}
      </button>
    </section>
  );
};

export default EngagementSettings;
