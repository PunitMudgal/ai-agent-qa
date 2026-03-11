import fs from 'fs-extra';
import path from 'path';
import { saveCoverageReport } from './reportFormatter';
import {
  COVERAGE_CATEGORIES,
  dedupeCoverageEndpoints,
  extractPathFromEndpointLabel,
  normalizeCoverageCategory,
  normalizeCoverageKey,
  normalizeCoveragePath,
  normalizeHttpMethod,
  percentage,
  roundMetric,
} from './utils';
import { ensureOutputDir } from '../utils/fileUtils';
import type {
  CoverageBasis,
  CoverageBasisSourceType,
  CoverageEndpointSummary,
  CoverageExecutionState,
  CoverageReport,
  CoverageResult,
  CoverageRuntimeState,
  CoverageSourceEndpoint,
  ExecutionReport,
  ParseWarning,
  TestCase,
} from '../types';

const SAFE_MODE_SKIP_REASON = 'Mutation skipped by safe mode';

interface CreateCoverageBasisInput {
  sourceType: CoverageBasisSourceType;
  discoveredTotal: number;
  endpoints: CoverageSourceEndpoint[];
  filters?: {
    tags?: string[];
    paths?: string[];
  };
  warnings?: ParseWarning[];
  scopeMode?: CoverageBasis['scopeMode'];
}

interface BuildCoverageReportInput {
  source: string;
  reportDir: string;
  coverageBasis: CoverageBasis;
  testCases: TestCase[];
  warnings?: ParseWarning[];
  executionReport?: ExecutionReport;
}

interface SaveCoverageResultInput extends BuildCoverageReportInput {}

interface LoadedGeneratedBundle {
  testCases: TestCase[];
  coverageBasis: CoverageBasis;
  warnings: ParseWarning[];
}

interface EndpointAccumulator {
  sourceEndpoint: CoverageSourceEndpoint;
  inScope: boolean;
  generatedTests: number;
  categorySet: Set<string>;
  categoryTestCounts: Map<string, number>;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  mutationGated: boolean;
  runtimeEligible: boolean;
  runtimeState: CoverageRuntimeState;
  designScore: number;
  runtimeScore: number | null;
  overallScore: number;
}

function mergeWarnings(...warningGroups: Array<ParseWarning[] | undefined>): ParseWarning[] {
  const unique = new Map<string, ParseWarning>();

  for (const warnings of warningGroups) {
    for (const warning of warnings ?? []) {
      const key = [
        warning.kind,
        warning.file,
        warning.line ?? '',
        warning.column ?? '',
        warning.message,
      ].join('|');

      if (!unique.has(key)) {
        unique.set(key, warning);
      }
    }
  }

  return Array.from(unique.values());
}

function normalizeCoverageBasis(basis: CoverageBasis): CoverageBasis {
  return {
    sourceType: basis.sourceType,
    scopeMode: basis.scopeMode,
    discoveredTotal: Math.max(basis.discoveredTotal ?? basis.filteredTotal ?? 0, 0),
    filteredTotal: dedupeCoverageEndpoints(basis.endpoints ?? []).length,
    filters: {
      tags: [...new Set((basis.filters?.tags ?? []).map(value => String(value).trim()).filter(Boolean))],
      paths: [...new Set((basis.filters?.paths ?? []).map(value => String(value).trim()).filter(Boolean))],
    },
    endpoints: dedupeCoverageEndpoints(basis.endpoints ?? []),
    warnings: [...(basis.warnings ?? [])],
  };
}

function makeGeneratedOnlyWarning(filePath: string): ParseWarning {
  return {
    kind: 'coverage',
    file: path.resolve(filePath),
    message:
      'Coverage basis missing; using generated test cases only. Full API denominator is unavailable.',
  };
}

function buildGeneratedOnlyCoverageBasis(
  testCases: TestCase[],
  warnings: ParseWarning[],
  filePath: string
): CoverageBasis {
  const endpoints = dedupeCoverageEndpoints(
    testCases.map(testCase => ({
      method: normalizeHttpMethod(testCase.method, testCase.endpoint),
      path: extractPathFromEndpointLabel(testCase.endpoint),
      tags: [],
      sourceKind: 'generated' as const,
    }))
  );

  return createCoverageBasis({
    sourceType: 'legacy',
    scopeMode: 'generated-only',
    discoveredTotal: endpoints.length,
    endpoints,
    warnings: mergeWarnings(warnings, [makeGeneratedOnlyWarning(filePath)]),
  });
}

export function createGeneratedOnlyCoverageBasis(
  testCases: TestCase[],
  warnings: ParseWarning[] = [],
  sourceLabel = 'inline'
): CoverageBasis {
  return buildGeneratedOnlyCoverageBasis(testCases, warnings, sourceLabel);
}

function ensureAccumulator(
  accumulators: Map<string, EndpointAccumulator>,
  endpoint: CoverageSourceEndpoint,
  inScope: boolean
): EndpointAccumulator {
  const key = normalizeCoverageKey(endpoint.method, endpoint.path);
  const existing = accumulators.get(key);
  if (existing) {
    if (inScope) {
      existing.inScope = true;
    }
    return existing;
  }

  const created: EndpointAccumulator = {
    sourceEndpoint: {
      ...endpoint,
      method: normalizeHttpMethod(endpoint.method),
      path: normalizeCoveragePath(endpoint.path),
    },
    inScope,
    generatedTests: 0,
    categorySet: new Set<string>(),
    categoryTestCounts: new Map<string, number>(),
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    mutationGated: false,
    runtimeEligible: false,
    runtimeState: 'pending',
    designScore: 0,
    runtimeScore: null,
    overallScore: 0,
  };
  accumulators.set(key, created);
  return created;
}

function executionStateForReport(
  coverageBasis: CoverageBasis,
  executionReport?: ExecutionReport
): CoverageExecutionState {
  if (!executionReport) return 'pending';
  return coverageBasis.scopeMode === 'generated-only' ? 'partial' : 'available';
}

export function createCoverageBasis(input: CreateCoverageBasisInput): CoverageBasis {
  const endpoints = dedupeCoverageEndpoints(input.endpoints);
  return {
    sourceType: input.sourceType,
    scopeMode: input.scopeMode ?? 'filtered',
    discoveredTotal: Math.max(input.discoveredTotal ?? endpoints.length, 0),
    filteredTotal: endpoints.length,
    filters: {
      tags: [...new Set((input.filters?.tags ?? []).map(value => String(value).trim()).filter(Boolean))],
      paths: [...new Set((input.filters?.paths ?? []).map(value => String(value).trim()).filter(Boolean))],
    },
    endpoints,
    warnings: [...(input.warnings ?? [])],
  };
}

export function buildCoverageReport(input: BuildCoverageReportInput): CoverageReport {
  const normalizedBasis = normalizeCoverageBasis(input.coverageBasis);
  const warnings = mergeWarnings(normalizedBasis.warnings, input.warnings);
  const accumulators = new Map<string, EndpointAccumulator>();

  for (const endpoint of normalizedBasis.endpoints) {
    ensureAccumulator(accumulators, endpoint, true);
  }

  for (const testCase of input.testCases) {
    const method = normalizeHttpMethod(testCase.method, testCase.endpoint);
    const pathValue = extractPathFromEndpointLabel(testCase.endpoint);
    const key = normalizeCoverageKey(method, pathValue);
    const accumulator =
      accumulators.get(key) ??
      ensureAccumulator(
        accumulators,
        {
          method,
          path: pathValue,
          tags: [],
          sourceKind: 'generated',
        },
        false
      );

    accumulator.generatedTests += 1;
    const normalizedCategory = normalizeCoverageCategory(testCase.category);
    if (normalizedCategory) {
      accumulator.categorySet.add(normalizedCategory);
      accumulator.categoryTestCounts.set(
        normalizedCategory,
        (accumulator.categoryTestCounts.get(normalizedCategory) ?? 0) + 1
      );
    }
  }

  if (input.executionReport) {
    for (const result of input.executionReport.results ?? []) {
      const method = normalizeHttpMethod(result.method);
      const key = normalizeCoverageKey(method, result.endpoint);
      const accumulator =
        accumulators.get(key) ??
        ensureAccumulator(
          accumulators,
          {
            method,
            path: result.endpoint,
            tags: [],
            sourceKind: 'generated',
          },
          false
        );

      if (result.status === 'passed') {
        accumulator.passed += 1;
        accumulator.executed += 1;
      } else if (result.status === 'failed') {
        accumulator.failed += 1;
        accumulator.executed += 1;
      } else {
        accumulator.skipped += 1;
      }
    }
  }

  const allSummaries: CoverageEndpointSummary[] = [];
  const scopedSummaries: CoverageEndpointSummary[] = [];

  for (const accumulator of accumulators.values()) {
    const categoriesCovered = COVERAGE_CATEGORIES.filter(category =>
      accumulator.categorySet.has(category)
    );
    const missingCategories = COVERAGE_CATEGORIES.filter(
      category => !accumulator.categorySet.has(category)
    );

    accumulator.designScore =
      accumulator.generatedTests === 0
        ? 0
        : roundMetric(50 + 50 * (categoriesCovered.length / COVERAGE_CATEGORIES.length));

    if (!input.executionReport) {
      accumulator.runtimeState = 'pending';
      accumulator.runtimeScore = null;
    } else {
      const totalResults =
        accumulator.executed + accumulator.skipped;
      const mutationOnly =
        totalResults > 0 &&
        accumulator.executed === 0 &&
        accumulator.skipped > 0 &&
        (input.executionReport.results ?? [])
          .filter(
            result =>
              normalizeCoverageKey(
                normalizeHttpMethod(result.method),
                result.endpoint
              ) ===
              normalizeCoverageKey(
                accumulator.sourceEndpoint.method,
                accumulator.sourceEndpoint.path
              )
          )
          .every(
            result =>
              result.status === 'skipped' &&
              result.skippedReason === SAFE_MODE_SKIP_REASON
          );

      accumulator.mutationGated = mutationOnly;
      accumulator.runtimeEligible = totalResults > 0 && !mutationOnly;

      if (mutationOnly) {
        accumulator.runtimeState = 'mutation-gated';
        accumulator.runtimeScore = null;
      } else if (accumulator.failed > 0) {
        accumulator.runtimeState = 'failing';
      } else if (accumulator.executed > 0) {
        accumulator.runtimeState = 'passing';
      } else if (accumulator.skipped > 0) {
        accumulator.runtimeState = 'skipped';
      } else {
        accumulator.runtimeState = 'not-run';
      }

      if (accumulator.runtimeEligible) {
        const endpointPassRate =
          accumulator.executed > 0
            ? percentage(accumulator.passed, accumulator.executed)
            : 0;
        const endpointExecutionCoverage = accumulator.executed > 0 ? 100 : 0;
        accumulator.runtimeScore = roundMetric(
          endpointExecutionCoverage * 0.4 + endpointPassRate * 0.6
        );
      }
    }

    accumulator.overallScore =
      accumulator.runtimeScore == null
        ? accumulator.designScore
        : roundMetric(accumulator.designScore * 0.7 + accumulator.runtimeScore * 0.3);

    const summary: CoverageEndpointSummary = {
      method: accumulator.sourceEndpoint.method,
      path: accumulator.sourceEndpoint.path,
      generatedTests: accumulator.generatedTests,
      categoriesCovered,
      missingCategories,
      executed: accumulator.executed,
      passed: accumulator.passed,
      failed: accumulator.failed,
      skipped: accumulator.skipped,
      mutationGated: accumulator.mutationGated,
      runtimeState: accumulator.runtimeState,
      designScore: accumulator.designScore,
      runtimeScore: accumulator.runtimeScore,
      overallScore: accumulator.overallScore,
    };

    allSummaries.push(summary);
    if (accumulator.inScope) {
      scopedSummaries.push(summary);
    }
  }

  scopedSummaries.sort((a, b) => {
    if (a.path === b.path) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });
  allSummaries.sort((a, b) => {
    if (a.path === b.path) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });

  const inScopeTotal = normalizedBasis.filteredTotal;
  const coveredEndpoints = scopedSummaries.filter(summary => summary.generatedTests > 0).length;
  const uncoveredEndpoints = normalizedBasis.endpoints.filter(endpoint => {
    const key = normalizeCoverageKey(endpoint.method, endpoint.path);
    const summary = scopedSummaries.find(
      item => normalizeCoverageKey(item.method, item.path) === key
    );
    return !summary || summary.generatedTests === 0;
  });
  const totalTests = scopedSummaries.reduce(
    (sum, summary) => sum + summary.generatedTests,
    0
  );
  const executedTests = scopedSummaries.reduce(
    (sum, summary) => sum + summary.executed,
    0
  );
  const passedTests = scopedSummaries.reduce(
    (sum, summary) => sum + summary.passed,
    0
  );
  const runtimeEligibleEndpoints = scopedSummaries.filter(summary => {
    const accumulator = accumulators.get(
      normalizeCoverageKey(summary.method, summary.path)
    );
    return accumulator?.runtimeEligible ?? false;
  }).length;
  const executedEndpoints = scopedSummaries.filter(summary => summary.executed > 0).length;
  const mutationGatedEndpoints = scopedSummaries.filter(
    summary => summary.mutationGated
  ).length;
  const designScore = inScopeTotal
    ? roundMetric(
        scopedSummaries.reduce((sum, summary) => sum + summary.designScore, 0) /
          inScopeTotal
      )
    : 0;
  const passRate = executedTests > 0 ? percentage(passedTests, executedTests) : null;
  const runtimeScore =
    !input.executionReport || runtimeEligibleEndpoints === 0 || passRate == null
      ? null
      : roundMetric(
          percentage(executedEndpoints, runtimeEligibleEndpoints) * 0.4 +
            passRate * 0.6
        );
  const overallScore =
    runtimeScore == null
      ? designScore
      : roundMetric(designScore * 0.7 + runtimeScore * 0.3);

  return {
    metadata: {
      source: input.source,
      sourceType: normalizedBasis.sourceType,
      scopeMode: normalizedBasis.scopeMode,
      generatedAt: new Date().toISOString(),
      reportDir: path.resolve(input.reportDir),
      executionState: executionStateForReport(normalizedBasis, input.executionReport),
    },
    summary: {
      discoveredTotal: normalizedBasis.discoveredTotal,
      inScopeTotal,
      coveredEndpoints,
      uncoveredEndpoints: uncoveredEndpoints.length,
      endpointCoveragePct: percentage(coveredEndpoints, inScopeTotal),
      totalTests,
      avgTestsPerCoveredEndpoint:
        coveredEndpoints === 0 ? 0 : Number((totalTests / coveredEndpoints).toFixed(1)),
      executedTests,
      passRate,
      mutationGatedEndpoints,
      designScore,
      runtimeScore,
      overallScore,
      warnings: warnings.length,
    },
    categorySummaries: COVERAGE_CATEGORIES.map(category => {
      const endpointsCovered = scopedSummaries.filter(summary =>
        summary.categoriesCovered.includes(category)
      ).length;
      const testCount = scopedSummaries.reduce((sum, summary) => {
        const accumulator = accumulators.get(
          normalizeCoverageKey(summary.method, summary.path)
        );
        return sum + (accumulator?.categoryTestCounts.get(category) ?? 0);
      }, 0);

      return {
        category,
        endpointsCovered,
        totalEndpoints: inScopeTotal,
        testCount,
        coveragePct: percentage(endpointsCovered, inScopeTotal),
      };
    }),
    endpointSummaries: allSummaries,
    uncoveredEndpoints,
    warnings,
  };
}

export async function createAndSaveCoverageResult(
  input: SaveCoverageResultInput
): Promise<CoverageResult> {
  const reportDir = path.resolve(input.reportDir);
  await ensureOutputDir(reportDir);
  const report = buildCoverageReport(input);
  const savedFiles = await saveCoverageReport(report, reportDir, input.source);
  return { report, savedFiles };
}

export async function loadGeneratedBundleFromFile(
  inputPath: string
): Promise<LoadedGeneratedBundle> {
  const resolvedPath = path.resolve(inputPath);
  const content = await fs.readFile(resolvedPath, 'utf-8');
  const parsed = JSON.parse(content) as
    | {
        testCases?: unknown;
        coverageBasis?: CoverageBasis;
        warnings?: ParseWarning[];
      }
    | unknown[];

  const testCases = Array.isArray(parsed)
    ? parsed
    : parsed.testCases;

  if (!Array.isArray(testCases)) {
    throw new Error(
      'Input JSON must be either an array of test cases or an object with a "testCases" array'
    );
  }

  const warnings = Array.isArray(parsed)
    ? []
    : Array.isArray(parsed.warnings)
      ? parsed.warnings
      : [];
  const coverageBasis =
    !Array.isArray(parsed) && parsed.coverageBasis
      ? normalizeCoverageBasis(parsed.coverageBasis)
      : buildGeneratedOnlyCoverageBasis(
          testCases as TestCase[],
          warnings,
          resolvedPath
        );

  return {
    testCases: testCases as TestCase[],
    coverageBasis,
    warnings: mergeWarnings(warnings, coverageBasis.warnings),
  };
}

export async function loadExecutionReportFromFile(
  inputPath: string
): Promise<ExecutionReport> {
  const resolvedPath = path.resolve(inputPath);
  const content = await fs.readFile(resolvedPath, 'utf-8');
  return JSON.parse(content) as ExecutionReport;
}
