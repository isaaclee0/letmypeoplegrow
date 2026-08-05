import { useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import type { PeopleSyncSettings } from './types';

export default function PeopleEditingLockControl({
  settings,
  onRefresh,
  compact = false,
}: {
  settings: PeopleSyncSettings;
  onRefresh: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setUpdating(true);
    setError(null);
    try {
      await peopleSyncAPI.updateSettings({ peopleEditingLocked: !settings.peopleEditingLocked });
      await onRefresh();
    } catch {
      setError('Could not update the People-page editing setting.');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className={compact ? 'flex items-center gap-2' : 'flex items-start justify-between gap-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700'}>
      <div>
        {compact ? <span className="text-sm text-gray-600 dark:text-gray-300">Lock People editing</span> : <>
        <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Lock People page editing</h5>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {settings.peopleEditingLocked
            ? 'Synced people can only be changed in your provider.'
            : 'Changes made here may be overwritten by the next provider sync.'}
        </p>
        </>}
        {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-label="Lock People page editing"
        aria-checked={settings.peopleEditingLocked}
        disabled={updating}
        onClick={() => void toggle()}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${settings.peopleEditingLocked ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${settings.peopleEditingLocked ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </section>
  );
}
