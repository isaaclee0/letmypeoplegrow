import { normalizeReportLayout, REPORT_LAYOUT_KEY, type ReportLayout } from '../components/reports/reportLayout';
import { usersAPI } from './api';

export interface ReportLayoutScope {
  userId: number;
  churchId: string;
}

function cacheKey({ userId, churchId }: ReportLayoutScope): string {
  return `reports-layout:v1:${encodeURIComponent(churchId)}:${userId}`;
}

export function readCachedReportLayout(scope: ReportLayoutScope): ReportLayout | null {
  try {
    const value = localStorage.getItem(cacheKey(scope));
    return value ? normalizeReportLayout(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

export function cacheReportLayout(scope: ReportLayoutScope, layout: ReportLayout): void {
  try {
    localStorage.setItem(cacheKey(scope), JSON.stringify(normalizeReportLayout(layout)));
  } catch {
    // A full or disabled browser store must not prevent using reports.
  }
}

export async function fetchReportLayout(): Promise<ReportLayout> {
  const response = await usersAPI.getPreferences();
  return normalizeReportLayout(response.data.preferences?.[REPORT_LAYOUT_KEY]);
}

export async function saveReportLayout(layout: ReportLayout): Promise<void> {
  await usersAPI.savePreference(REPORT_LAYOUT_KEY, normalizeReportLayout(layout));
}
