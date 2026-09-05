import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultReportLayout,
  normalizeReportLayout,
  reorderVisiblePanels,
  type ReportLayout,
  type ReportPanelId,
} from './reportLayout';
import {
  cacheReportLayout,
  fetchReportLayout,
  readCachedReportLayout,
  saveReportLayout,
  type ReportLayoutScope,
} from '../../services/reportLayoutPreferences';

const SAVE_ERROR = 'Could not save your layout. Try again.';

function scopeKey(scope: ReportLayoutScope | null): string {
  return scope ? `${scope.churchId}:${scope.userId}` : '';
}

export function useReportLayout(scope: ReportLayoutScope | null) {
  const key = scopeKey(scope);
  const cached = useMemo(() => (scope ? readCachedReportLayout(scope) : null), [key]);
  const [committed, setCommitted] = useState<ReportLayout>(() => cached ?? defaultReportLayout());
  const [draft, setDraft] = useState<ReportLayout>(() => cached ?? defaultReportLayout());
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(Boolean(scope));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const initial = scope ? readCachedReportLayout(scope) ?? defaultReportLayout() : defaultReportLayout();
    setCommitted(initial);
    setDraft(initial);
    setEditing(false);
    setError(null);
    setLoading(Boolean(scope));
    if (!scope) return;

    fetchReportLayout().then((layout) => {
      if (generation.current !== current) return;
      const normalized = normalizeReportLayout(layout);
      cacheReportLayout(scope, normalized);
      setCommitted(normalized);
      setDraft(normalized);
      setLoading(false);
    }).catch(() => {
      if (generation.current !== current) return;
      setError('Could not load your saved layout. Try again.');
      setLoading(false);
    });
  }, [key, retryGeneration]);

  const setVisible = useCallback((id: ReportPanelId, visible: boolean) => {
    setDraft((layout) => ({
      ...layout,
      hidden: visible ? layout.hidden.filter((hidden) => hidden !== id) : [...layout.hidden, id],
    }));
  }, []);

  const reorder = useCallback((visibleOrder: ReportPanelId[]) => {
    setDraft((layout) => reorderVisiblePanels(layout, visibleOrder));
  }, []);

  const move = useCallback((id: ReportPanelId, offset: -1 | 1) => {
    setDraft((layout) => {
      const index = layout.order.indexOf(id);
      const destination = index + offset;
      if (index < 0 || destination < 0 || destination >= layout.order.length) return layout;
      const order = [...layout.order];
      [order[index], order[destination]] = [order[destination], order[index]];
      return { ...layout, order };
    });
  }, []);

  const save = useCallback(async () => {
    if (!scope || saving) return;
    const saved = normalizeReportLayout(draft);
    setSaving(true);
    setError(null);
    try {
      await saveReportLayout(saved);
      cacheReportLayout(scope, saved);
      setCommitted(saved);
      setDraft(saved);
      setEditing(false);
    } catch {
      setError(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  }, [draft, saving, scope]);

  return {
    layout: editing ? draft : committed,
    editing,
    loading,
    saving,
    error,
    canEdit: Boolean(scope) && !loading && !error?.startsWith('Could not load'),
    beginEditing: () => { setDraft(committed); setError(null); setEditing(true); },
    cancel: () => { setDraft(committed); setError(null); setEditing(false); },
    reset: () => setDraft(defaultReportLayout()),
    setVisible,
    reorder,
    move,
    save,
    retry: () => setRetryGeneration((value) => value + 1),
  };
}
