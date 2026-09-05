import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_ORDER,
  defaultReportLayout,
  normalizeReportLayout,
  reorderVisiblePanels,
  type ReportPanelId,
} from './reportLayout';

describe('report layout', () => {
  it('keeps a hidden panel in its stored slot when visible panels move', () => {
    const layout = { ...defaultReportLayout(), hidden: ['period-visitors'] as ReportPanelId[] };
    const visible = layout.order.filter((id) => !layout.hidden.includes(id));
    [visible[0], visible[1]] = [visible[1], visible[0]];

    const next = reorderVisiblePanels(layout, visible);

    expect(next.order.slice(0, 3)).toEqual(['period-attendance', 'summary', 'period-visitors']);
    expect(layout.order).toEqual(DEFAULT_PANEL_ORDER);
  });

  it('normalizes a stale stored layout without losing known panels', () => {
    expect(normalizeReportLayout({
      version: 1,
      order: ['recent-visitors', 'future-panel', 'recent-visitors'],
      hidden: ['future-panel', 'recent-visitors', 'recent-visitors'],
    })).toEqual({
      version: 1,
      order: [
        'recent-visitors', 'summary', 'period-attendance', 'period-visitors',
        'recent-absences', 'attendance-direction', 'regularity', 'attendance-changes',
      ],
      hidden: ['recent-visitors'],
    });
  });

  it('falls back to the default layout for an unsupported stored version', () => {
    expect(normalizeReportLayout({ version: 2, order: [], hidden: [] })).toEqual(defaultReportLayout());
  });
});
