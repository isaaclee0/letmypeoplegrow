export const DEFAULT_PANEL_ORDER = [
  'summary',
  'period-attendance',
  'period-visitors',
  'recent-absences',
  'recent-visitors',
  'attendance-direction',
  'regularity',
  'attendance-changes',
] as const;

export type ReportPanelId = typeof DEFAULT_PANEL_ORDER[number];
export type LongTermPanelId = Extract<ReportPanelId,
  'attendance-direction' | 'regularity' | 'attendance-changes'>;

export interface ReportLayout {
  version: 1;
  order: ReportPanelId[];
  hidden: ReportPanelId[];
}

export const REPORT_LAYOUT_KEY = 'reports_layout';

export const REPORT_PANEL_METADATA: Record<ReportPanelId, { label: string; fullWidth?: boolean }> = {
  summary: { label: 'Summary metrics', fullWidth: true },
  'period-attendance': { label: 'Attendance over selected period' },
  'period-visitors': { label: 'Visitors over selected period' },
  'recent-absences': { label: 'Regulars with recent absences' },
  'recent-visitors': { label: 'Visitor welcome & follow-up' },
  'attendance-direction': { label: 'Attendance direction' },
  regularity: { label: 'Regularity' },
  'attendance-changes': { label: 'Attendance changes', fullWidth: true },
};

export function defaultReportLayout(): ReportLayout {
  return { version: 1, order: [...DEFAULT_PANEL_ORDER], hidden: [] };
}

function isPanelId(value: unknown): value is ReportPanelId {
  return typeof value === 'string' && DEFAULT_PANEL_ORDER.includes(value as ReportPanelId);
}

function uniqueKnownIds(value: unknown): ReportPanelId[] {
  if (!Array.isArray(value)) return [];
  const result: ReportPanelId[] = [];
  value.forEach((item) => {
    if (isPanelId(item) && !result.includes(item)) result.push(item);
  });
  return result;
}

export function normalizeReportLayout(value: unknown): ReportLayout {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return defaultReportLayout();
  }

  const candidate = value as { order?: unknown; hidden?: unknown };
  const order = uniqueKnownIds(candidate.order);
  DEFAULT_PANEL_ORDER.forEach((id) => {
    if (!order.includes(id)) order.push(id);
  });

  return {
    version: 1,
    order,
    hidden: uniqueKnownIds(candidate.hidden),
  };
}

export function reorderVisiblePanels(layout: ReportLayout, visibleOrder: ReportPanelId[]): ReportLayout {
  const normalized = normalizeReportLayout(layout);
  const validVisible = [...new Set(visibleOrder)];
  const storedVisible = normalized.order.filter((id) => !normalized.hidden.includes(id));
  if (
    validVisible.length !== visibleOrder.length
    || validVisible.length !== storedVisible.length
    || validVisible.some((id) => !storedVisible.includes(id))
  ) return normalized;

  let visibleIndex = 0;
  return {
    ...normalized,
    order: normalized.order.map((id) => (
      normalized.hidden.includes(id) ? id : validVisible[visibleIndex++]
    )),
  };
}
