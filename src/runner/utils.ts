import path from 'path';
import { extractPathFromEndpointLabel } from '../coverage/utils';
import type {
  ExecutionEndpointSummary,
  ExecutionReport,
  ExecutionRequestSnapshot,
  ExecutionResponseSnapshot,
  ExecutionTestResult,
  InputData,
  ParseWarning,
  RunnerConfig,
  RunnerHookOverride,
  TestCase,
} from '../types';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ExecutionAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionAssertionError';
  }
}

export class HookSkipError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'HookSkipError';
    this.reason = reason;
  }
}

export function normalizeRunnerConfig(
  input: Partial<RunnerConfig>,
  outputDir: string
): RunnerConfig {
  const resolvedOutput = path.resolve(outputDir);
  return {
    mode: input.mode ?? 'base-url',
    baseUrl: input.baseUrl?.trim() || 'http://localhost:3000',
    appModulePath: input.appModulePath?.trim() || undefined,
    allowMutations: input.allowMutations ?? false,
    hooksPath: input.hooksPath?.trim() || undefined,
    reportDir: path.resolve(input.reportDir?.trim() || path.join(resolvedOutput, 'reports')),
    timeoutMs: input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 10000,
    strictAssertions: input.strictAssertions ?? false,
  };
}

export function isMutatingMethod(method: string | undefined): boolean {
  return MUTATING_METHODS.has(String(method ?? 'GET').toUpperCase());
}

export function normalizeTestCase(tc: TestCase, index: number): TestCase {
  const method = String(tc.method ?? 'GET').toUpperCase();
  const endpoint =
    tc.endpoint?.trim() ||
    `${method} /`;

  return {
    ...tc,
    id: tc.id?.trim() || `TC-${String(index + 1).padStart(3, '0')}`,
    method,
    endpoint,
    scenario: tc.scenario?.trim() || 'Generated test case',
    status: tc.status ?? 'Pending',
    inputData: {
      headers: { ...(tc.inputData?.headers ?? {}) },
      pathParams: { ...(tc.inputData?.pathParams ?? {}) },
      queryParams: { ...(tc.inputData?.queryParams ?? {}) },
      body: { ...(tc.inputData?.body ?? {}) },
    },
    expectedOutput: {
      statusCode: tc.expectedOutput?.statusCode ?? 200,
      bodyContains: { ...(tc.expectedOutput?.bodyContains ?? {}) },
      bodyExcludes: [...(tc.expectedOutput?.bodyExcludes ?? [])],
      headers: { ...(tc.expectedOutput?.headers ?? {}) },
    },
    notes: tc.notes ?? '',
    preconditions: tc.preconditions ?? '',
  };
}

export function normalizeTestCases(testCases: TestCase[]): TestCase[] {
  return testCases.map(normalizeTestCase);
}

export function applyHookOverride(
  input: InputData,
  override?: RunnerHookOverride | void
): InputData {
  if (!override) return input;

  return {
    headers: {
      ...(input.headers ?? {}),
      ...(override.headers ?? {}),
    },
    pathParams: {
      ...(input.pathParams ?? {}),
      ...(override.pathParams ?? {}),
    },
    queryParams: {
      ...(input.queryParams ?? {}),
      ...(override.queryParams ?? {}),
    },
    body: {
      ...(input.body ?? {}),
      ...(override.body ?? {}),
    },
  };
}

export function endpointPathFromTestCase(tc: TestCase): string {
  return extractPathFromEndpointLabel(tc.endpoint);
}

export function resolvePathTemplate(
  pathTemplate: string,
  pathParams: Record<string, unknown>
): string {
  let pathValue = pathTemplate;
  for (const [key, rawValue] of Object.entries(pathParams ?? {})) {
    const safeValue = encodeURIComponent(String(rawValue ?? ''));
    pathValue = pathValue.replace(
      new RegExp(`:${escapeRegExp(key)}\\b`, 'g'),
      safeValue
    );
    pathValue = pathValue.replace(
      new RegExp(`\\{${escapeRegExp(key)}\\}`, 'g'),
      safeValue
    );
  }
  return pathValue;
}

export function buildRequestSnapshot(
  method: string,
  url: string,
  input: InputData
): ExecutionRequestSnapshot {
  return {
    method,
    url,
    headers: input.headers ?? {},
    pathParams: input.pathParams ?? {},
    queryParams: input.queryParams ?? {},
    body: input.body ?? {},
  };
}

export function responseSnapshotFromFetchResponse(
  statusCode: number,
  headers: Headers,
  body: unknown
): ExecutionResponseSnapshot {
  const headerMap: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerMap[key] = value;
  });
  return {
    statusCode,
    headers: headerMap,
    body,
  };
}

export function responseSnapshotFromPlainObject(
  statusCode: number | undefined,
  headers: Record<string, string>,
  body: unknown
): ExecutionResponseSnapshot {
  return {
    statusCode,
    headers,
    body,
  };
}

export function assertExecutionResult(
  testCase: TestCase,
  response: ExecutionResponseSnapshot,
  strictAssertions: boolean
): void {
  const expected = testCase.expectedOutput ?? {};

  if (
    expected.statusCode != null &&
    response.statusCode !== expected.statusCode
  ) {
    throw new ExecutionAssertionError(
      `Expected status ${expected.statusCode}, got ${response.statusCode ?? 'unknown'}`
    );
  }

  if (!strictAssertions) return;

  if (expected.bodyContains && Object.keys(expected.bodyContains).length > 0) {
    if (!matchesSubset(response.body, expected.bodyContains)) {
      throw new ExecutionAssertionError('Response body did not match expected subset');
    }
  }

  if (expected.bodyExcludes && expected.bodyExcludes.length > 0) {
    const bodyText = safeJsonStringify(response.body);
    for (const token of expected.bodyExcludes) {
      if (bodyText.includes(token)) {
        throw new ExecutionAssertionError(
          `Response body unexpectedly contained excluded token "${token}"`
        );
      }
    }
  }

  if (expected.headers && Object.keys(expected.headers).length > 0) {
    for (const [key, value] of Object.entries(expected.headers)) {
      if ((response.headers ?? {})[key.toLowerCase()] !== value) {
        throw new ExecutionAssertionError(
          `Expected header ${key}=${value}`
        );
      }
    }
  }
}

export function buildEndpointSummaries(
  results: ExecutionTestResult[]
): ExecutionEndpointSummary[] {
  const grouped = new Map<string, ExecutionEndpointSummary>();

  for (const result of results) {
    const key = `${result.method} ${result.endpoint}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        endpoint: result.endpoint,
        method: result.method,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
      });
    }
    const summary = grouped.get(key)!;
    summary.total += 1;
    summary.durationMs += result.durationMs;
    if (result.status === 'passed') summary.passed += 1;
    if (result.status === 'failed') summary.failed += 1;
    if (result.status === 'skipped') summary.skipped += 1;
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.endpoint === b.endpoint) return a.method.localeCompare(b.method);
    return a.endpoint.localeCompare(b.endpoint);
  });
}

export function createExecutionReport(
  config: RunnerConfig,
  source: string,
  startedAt: Date,
  endedAt: Date,
  results: ExecutionTestResult[],
  warnings: ParseWarning[]
): ExecutionReport {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const skippedMutations = results.filter(
    r => r.status === 'skipped' && r.skippedReason === 'Mutation skipped by safe mode'
  ).length;

  return {
    metadata: {
      mode: config.mode,
      source,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      reportDir: config.reportDir,
      allowMutations: config.allowMutations,
      strictAssertions: config.strictAssertions,
      baseUrl: config.mode === 'base-url' ? config.baseUrl : undefined,
      appModulePath: config.mode === 'app-import' ? config.appModulePath : undefined,
      hooksPath: config.hooksPath,
    },
    summary: {
      total: results.length,
      executed: passed + failed,
      passed,
      failed,
      skipped,
      skippedMutations,
      warnings: warnings.length,
    },
    endpointSummaries: buildEndpointSummaries(results),
    results,
    warnings,
  };
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, index) => matchesSubset(actual[index], item));
  }

  if (actual === null || typeof actual !== 'object') return false;

  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    matchesSubset((actual as Record<string, unknown>)[key], value)
  );
}
