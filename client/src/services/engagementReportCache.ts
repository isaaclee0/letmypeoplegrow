import type { EngagementOverviewDto } from './api';

const CACHE_PREFIX = 'engagement-overview';
const SCHEMA_VERSION = 1;

function prefixForChurch(churchId: string): string {
  return `${CACHE_PREFIX}:v${SCHEMA_VERSION}:${encodeURIComponent(churchId)}:`;
}

function isOverview(value: unknown): value is EngagementOverviewDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<EngagementOverviewDto>;
  return candidate.schemaVersion === SCHEMA_VERSION
    && typeof candidate.churchId === 'string'
    && !!candidate.window
    && typeof candidate.window.completedWeekEnd === 'string'
    && typeof candidate.window.currentStart === 'string'
    && typeof candidate.window.currentEnd === 'string'
    && !!candidate.settings
    && !!candidate.setup
    && !!candidate.primaryDistribution
    && !!candidate.movement
    && !!candidate.matrix
    && !!candidate.trend
    && Array.isArray(candidate.trend.buckets)
    && !!candidate.visitorJourney
    && !!candidate.coverage;
}

function churchKeys(churchId: string): string[] {
  const prefix = prefixForChurch(churchId);
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => !!key && key.startsWith(prefix));
}

export function readEngagementOverviewCache(churchId: string): EngagementOverviewDto | null {
  const keys = churchKeys(churchId).sort().reverse();
  for (const key of keys) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null');
      if (!isOverview(parsed) || parsed.churchId !== churchId) {
        localStorage.removeItem(key);
        continue;
      }
      const expectedKey = `${prefixForChurch(churchId)}${parsed.window.completedWeekEnd}`;
      if (key !== expectedKey) {
        localStorage.removeItem(key);
        continue;
      }
      return parsed;
    } catch {
      localStorage.removeItem(key);
    }
  }
  return null;
}

export function writeEngagementOverviewCache(overview: EngagementOverviewDto): void {
  if (!isOverview(overview)) return;
  const key = `${prefixForChurch(overview.churchId)}${overview.window.completedWeekEnd}`;
  localStorage.setItem(key, JSON.stringify(overview));
}

export function clearEngagementOverviewCache(churchId: string): void {
  churchKeys(churchId).forEach((key) => localStorage.removeItem(key));
}
