import React, { useEffect, useState } from 'react';
import { REPORT_PANEL_METADATA, type ReportLayout, type ReportPanelId } from './reportLayout';
import AccessibleDialog from './AccessibleDialog';

interface Props {
  layout: ReportLayout;
  editing: boolean;
  saving: boolean;
  error: string | null;
  unavailable: Partial<Record<ReportPanelId, string>>;
  onSetVisible(id: ReportPanelId, visible: boolean): void;
  onSave(): void;
  onCancel(): void;
}

const ReportLayoutEditor: React.FC<Props> = ({ layout, editing, saving, error, unavailable, onSetVisible, onSave, onCancel }) => {
  const [showHiddenSections, setShowHiddenSections] = useState(false);
  const hidden = layout.order.filter((id) => layout.hidden.includes(id));
  useEffect(() => { if (hidden.length === 0) setShowHiddenSections(false); }, [hidden.length]);
  if (!editing) return null;

  return (
    <section className="rounded-lg border border-primary-200 bg-primary-50 p-4 dark:border-gray-700 dark:bg-gray-800" aria-label="Customise layout">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Customise layout</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Drag a panel by its handle to move it. Use the × button on a panel to hide it.</p>
        </div>
        {hidden.length > 0 && <button type="button" onClick={() => setShowHiddenSections(true)} disabled={saving} className="rounded border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200">Reveal hidden sections ({hidden.length})</button>}
      </div>
      {error && <p role="alert" className="mt-3 text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className="rounded px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white/70 disabled:opacity-50 dark:text-gray-200">Cancel</button>
        <button type="button" onClick={onSave} disabled={saving} className="rounded bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save layout'}</button>
      </div>
      {showHiddenSections && <AccessibleDialog label="Reveal hidden sections" onClose={() => setShowHiddenSections(false)} className="z-50">
        <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Reveal hidden sections</h2><p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Restore any panel to add it back to your layout.</p></div><button type="button" onClick={() => setShowHiddenSections(false)} aria-label="Close hidden sections" className="rounded-full p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">×</button></div>
          <ul className="mt-4 space-y-2">
            {hidden.map((id) => <li key={id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"><span className="text-sm font-medium text-gray-800 dark:text-gray-100">{REPORT_PANEL_METADATA[id].label}{unavailable[id] && <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">({unavailable[id]})</span>}</span><button type="button" onClick={() => onSetVisible(id, true)} disabled={saving} className="rounded bg-primary-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">Restore</button></li>)}
          </ul>
        </div>
      </AccessibleDialog>}
    </section>
  );
};

export default ReportLayoutEditor;
