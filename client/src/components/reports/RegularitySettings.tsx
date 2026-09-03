import React, { useEffect, useState } from 'react';
import type {
  ContextualEngagementSettingsDto,
  EngagementTierKey,
} from '../../services/api';
import { settingsAPI } from '../../services/api';

interface RegularitySettingsProps {
  settings: ContextualEngagementSettingsDto;
  onSaved: (settings: ContextualEngagementSettingsDto) => void | Promise<void>;
}

interface RegularitySettingsInput {
  coreMinimum: number;
  casualMinimum: number;
  tiers: ContextualEngagementSettingsDto['tiers'];
}

const TIER_KEYS: EngagementTierKey[] = ['core', 'casual', 'irregular'];

function formFrom(settings: ContextualEngagementSettingsDto): RegularitySettingsInput {
  return {
    coreMinimum: settings.coreMinimum,
    casualMinimum: settings.casualMinimum,
    tiers: structuredClone(settings.tiers),
  };
}

const RegularitySettings: React.FC<RegularitySettingsProps> = ({ settings, onSaved }) => {
  const [form, setForm] = useState<RegularitySettingsInput>(() => formFrom(settings));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm(formFrom(settings));
    setError('');
    setSaved(false);
  }, [settings]);

  const updateTier = (tier: EngagementTierKey, field: 'label' | 'colour', value: string) => {
    setForm((current) => ({
      ...current,
      tiers: {
        ...current.tiers,
        [tier]: { ...current.tiers[tier], [field]: value },
      },
    }));
  };

  const save = async () => {
    setSaved(false);
    if (!Number.isInteger(form.casualMinimum) || !Number.isInteger(form.coreMinimum)
        || form.casualMinimum < 0 || form.coreMinimum > 100
        || form.casualMinimum >= form.coreMinimum) {
      setError('Casual minimum must be less than Core minimum, using whole percentages from 0 to 100.');
      return;
    }
    if (TIER_KEYS.some((tier) => !form.tiers[tier].label.trim())) {
      setError('Each tier needs a label.');
      return;
    }
    if (TIER_KEYS.some((tier) => !/^#[0-9a-f]{6}$/i.test(form.tiers[tier].colour))) {
      setError('Each tier needs a valid six-digit hex colour.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const update = settingsAPI.updateEngagementSettings as unknown as (
        input: RegularitySettingsInput,
      ) => Promise<{ data: { settings: ContextualEngagementSettingsDto } }>;
      const response = await update(form);
      await onSaved(response.data.settings);
      setSaved(true);
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || 'Could not save regularity settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-6" aria-labelledby="regularity-settings-heading">
      <div>
        <h2 id="regularity-settings-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Regularity settings</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Set the percentage of opportunity weeks needed for each attendance tier.</p>
      </div>

      <fieldset>
        <legend className="font-semibold text-gray-900 dark:text-gray-100">Tier thresholds</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <label htmlFor="regularity-core-minimum" className="block text-sm font-medium text-gray-900 dark:text-gray-100">Core threshold</label>
            <div className="relative mt-2">
              <input id="regularity-core-minimum" aria-label="Core minimum" type="number" min="0" max="100" value={form.coreMinimum} onChange={(event) => setForm((current) => ({ ...current, coreMinimum: Number(event.target.value) }))} className="block w-full rounded border border-gray-300 py-2 pl-3 pr-9 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-gray-500 dark:text-gray-400">%</span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Percentage of opportunity weeks needed to enter this tier.</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <label htmlFor="regularity-casual-minimum" className="block text-sm font-medium text-gray-900 dark:text-gray-100">Casual threshold</label>
            <div className="relative mt-2">
              <input id="regularity-casual-minimum" aria-label="Casual minimum" type="number" min="0" max="100" value={form.casualMinimum} onChange={(event) => setForm((current) => ({ ...current, casualMinimum: Number(event.target.value) }))} className="block w-full rounded border border-gray-300 py-2 pl-3 pr-9 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-gray-500 dark:text-gray-400">%</span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Percentage of opportunity weeks needed to enter this tier.</p>
          </div>
        </div>
        <div className="mt-4 rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">What these tiers mean</p>
          <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
            <div><span className="font-medium text-gray-900 dark:text-gray-100">{form.tiers.core.label}</span><p className="text-gray-600 dark:text-gray-300">{form.coreMinimum}% or more of opportunity weeks</p></div>
            <div><span className="font-medium text-gray-900 dark:text-gray-100">{form.tiers.casual.label}</span><p className="text-gray-600 dark:text-gray-300">{form.casualMinimum}%–{form.coreMinimum - 1}% of opportunity weeks</p></div>
            <div><span className="font-medium text-gray-900 dark:text-gray-100">{form.tiers.irregular.label}</span><p className="text-gray-600 dark:text-gray-300">Below {form.casualMinimum}% of opportunity weeks</p></div>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend className="font-semibold text-gray-900 dark:text-gray-100">Tier names and colours</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {TIER_KEYS.map((tier) => {
            const name = tier[0].toUpperCase() + tier.slice(1);
            return (
              <div key={tier} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <label className="text-sm text-gray-900 dark:text-gray-100">{name} label
                  <input aria-label={`${name} label`} value={form.tiers[tier].label} onChange={(event) => updateTier(tier, 'label', event.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                </label>
                <label className="mt-3 block text-sm text-gray-900 dark:text-gray-100">{name} colour
                  <input aria-label={`${name} colour`} type="color" value={form.tiers[tier].colour} onChange={(event) => updateTier(tier, 'colour', event.target.value)} className="mt-1 h-10 w-full" />
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {saved && <p role="status" className="text-sm text-green-700 dark:text-green-300">Settings saved. Long-term trends have been refreshed.</p>}
      <button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60">
        {saving ? 'Saving…' : 'Save regularity settings'}
      </button>
    </section>
  );
};

export default RegularitySettings;
