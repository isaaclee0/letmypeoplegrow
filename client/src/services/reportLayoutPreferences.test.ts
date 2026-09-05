import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usersAPI } from './api';
import { REPORT_LAYOUT_KEY, defaultReportLayout, type ReportLayout } from '../components/reports/reportLayout';
import {
  cacheReportLayout,
  fetchReportLayout,
  readCachedReportLayout,
  saveReportLayout,
} from './reportLayoutPreferences';

vi.mock('./api', () => ({
  usersAPI: { getPreferences: vi.fn(), savePreference: vi.fn() },
}));

describe('report layout preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('reads the layout from the authenticated user preferences response', async () => {
    vi.mocked(usersAPI.getPreferences).mockResolvedValue({ data: { preferences: {
      [REPORT_LAYOUT_KEY]: { version: 1, order: ['recent-visitors'], hidden: ['recent-visitors'] },
    } } } as never);

    await expect(fetchReportLayout()).resolves.toEqual({
      version: 1,
      order: [
        'recent-visitors', 'summary', 'period-attendance', 'period-visitors',
        'recent-absences', 'attendance-direction', 'regularity', 'attendance-changes',
      ],
      hidden: ['recent-visitors'],
    });
  });

  it('saves the normalized layout under the dedicated preference key', async () => {
    vi.mocked(usersAPI.savePreference).mockResolvedValue({} as never);

    await saveReportLayout({ ...defaultReportLayout(), hidden: ['regularity'] });

    expect(usersAPI.savePreference).toHaveBeenCalledWith(REPORT_LAYOUT_KEY, {
      version: 1, order: expect.any(Array), hidden: ['regularity'],
    });
  });

  it('keeps cached layouts separate for people in different churches', () => {
    const layout: ReportLayout = { ...defaultReportLayout(), hidden: ['summary'] };
    cacheReportLayout({ userId: 7, churchId: 'church-a' }, layout);

    expect(readCachedReportLayout({ userId: 7, churchId: 'church-a' })).toEqual(layout);
    expect(readCachedReportLayout({ userId: 7, churchId: 'church-b' })).toBeNull();
  });
});
