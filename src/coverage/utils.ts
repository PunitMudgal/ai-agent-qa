import type { CoverageSourceEndpoint } from '../types';

export const COVERAGE_CATEGORIES = [
  'positive',
  'negative',
  'edge',
  'validation',
  'boundary',
] as const;

export function normalizeHttpMethod(
  method?: string,
  endpointLabel?: string
): string {
  if (method?.trim()) {
    return method.trim().toUpperCase();
  }

  const label = String(endpointLabel ?? '').trim();
  const match = label.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
  return (match?.[1] ?? 'GET').toUpperCase();
}

export function extractPathFromEndpointLabel(endpointLabel?: string): string {
  const value = String(endpointLabel ?? '').trim();
  if (!value) return '/';

  return value.replace(/^(get|post|put|delete|patch|options|head)\s+/i, '').trim() || '/';
}

export function normalizeCoverageKey(method: string, pathValue: string): string {
  return `${normalizeHttpMethod(method)} ${normalizeCoveragePath(pathValue)}`;
}

export function normalizeCoveragePath(pathValue?: string): string {
  const value = String(pathValue ?? '').trim();
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

export function normalizeCoverageCategory(category?: string): string | null {
  const value = String(category ?? '')
    .toLowerCase()
    .trim();

  if (!value) return null;

  return COVERAGE_CATEGORIES.includes(value as (typeof COVERAGE_CATEGORIES)[number])
    ? value
    : null;
}

export function endpointSummaryLabel(endpoint: {
  method: string;
  path: string;
}): string {
  return `${normalizeHttpMethod(endpoint.method)} ${normalizeCoveragePath(endpoint.path)}`;
}

export function dedupeCoverageEndpoints(
  endpoints: CoverageSourceEndpoint[]
): CoverageSourceEndpoint[] {
  const unique = new Map<string, CoverageSourceEndpoint>();

  for (const endpoint of endpoints) {
    const normalizedEndpoint: CoverageSourceEndpoint = {
      ...endpoint,
      method: normalizeHttpMethod(endpoint.method),
      path: normalizeCoveragePath(endpoint.path),
      tags: [...new Set((endpoint.tags ?? []).map(tag => String(tag).trim()).filter(Boolean))],
    };
    const key = normalizeCoverageKey(normalizedEndpoint.method, normalizedEndpoint.path);
    if (!unique.has(key)) {
      unique.set(key, normalizedEndpoint);
    }
  }

  return Array.from(unique.values()).sort((a, b) => {
    if (a.path === b.path) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });
}

export function roundMetric(value: number): number {
  return Math.round(Number.isFinite(value) ? value : 0);
}

export function percentage(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return roundMetric((numerator / denominator) * 100);
}
