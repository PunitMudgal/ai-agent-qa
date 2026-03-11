import type {
  ExecutionFailureType,
  ExecutionTestResult,
  InputData,
  RunnerConfig,
  RunnerHooks,
  RunnerHookSharedContext,
  TestCase,
} from '../types';
import {
  ExecutionAssertionError,
  HookSkipError,
  applyHookOverride,
  assertExecutionResult,
  buildRequestSnapshot,
  endpointPathFromTestCase,
  isMutatingMethod,
  resolvePathTemplate,
  responseSnapshotFromFetchResponse,
} from './utils';

interface BaseUrlRunInput {
  testCases: TestCase[];
  config: RunnerConfig;
  hooks: RunnerHooks;
}

export async function runAgainstBaseUrl(
  input: BaseUrlRunInput
): Promise<ExecutionTestResult[]> {
  const { testCases, config, hooks } = input;
  const shared: RunnerHookSharedContext = {};

  if (hooks.beforeRun) {
    await hooks.beforeRun({
      mode: 'base-url',
      baseUrl: config.baseUrl,
      shared,
    });
  }

  const results: ExecutionTestResult[] = [];

  for (const testCase of testCases) {
    const method = String(testCase.method ?? 'GET').toUpperCase();
    const startedAt = Date.now();
    const baseInput = (testCase.inputData ?? {}) as InputData;

    if (!config.allowMutations && isMutatingMethod(method)) {
      results.push({
        testCaseId: testCase.id ?? 'unknown',
        endpoint: endpointPathFromTestCase(testCase),
        method,
        scenario: testCase.scenario ?? 'Generated test case',
        status: 'skipped',
        durationMs: 0,
        skippedReason: 'Mutation skipped by safe mode',
      });
      continue;
    }

    let requestInput = baseInput;
    let notes: string[] = [];
    let requestSnapshot = buildRequestSnapshot(
      method,
      endpointPathFromTestCase(testCase),
      requestInput
    );

    try {
      if (hooks.beforeTest) {
        const override = await hooks.beforeTest({
          mode: 'base-url',
          baseUrl: config.baseUrl,
          testCase,
          requestInput,
          shared,
        });
        if (override?.skip) {
          throw new HookSkipError(override.reason || 'Skipped by beforeTest hook');
        }
        requestInput = applyHookOverride(requestInput, override);
        notes = [...notes, ...(override?.notes ?? [])];
      }

      const pathValue = resolvePathTemplate(
        endpointPathFromTestCase(testCase),
        (requestInput.pathParams ?? {}) as Record<string, unknown>
      );
      const url = new URL(pathValue, config.baseUrl);
      for (const [key, value] of Object.entries(requestInput.queryParams ?? {})) {
        if (value == null) continue;
        url.searchParams.set(key, String(value));
      }

      const headers = {
        Accept: 'application/json',
        ...(requestInput.headers ?? {}),
      };
      requestSnapshot = buildRequestSnapshot(method, url.toString(), {
        ...requestInput,
        headers,
      });

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

      let responseBody: unknown = null;
      let responseStatus = 0;
      let responseHeaders = new Headers();

      try {
        const response = await fetch(url, {
          method,
          headers,
          body:
            ['GET', 'HEAD', 'OPTIONS'].includes(method) ||
            Object.keys(requestInput.body ?? {}).length === 0
              ? undefined
              : JSON.stringify(requestInput.body ?? {}),
          signal: controller.signal,
        });

        responseStatus = response.status;
        responseHeaders = response.headers;

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          responseBody = await response.json().catch(() => null);
        } else {
          responseBody = await response.text().catch(() => '');
        }
      } finally {
        clearTimeout(timeoutHandle);
      }

      const responseSnapshot = responseSnapshotFromFetchResponse(
        responseStatus,
        responseHeaders,
        responseBody
      );
      assertExecutionResult(testCase, responseSnapshot, config.strictAssertions);

      if (hooks.afterTest) {
        await hooks.afterTest({
          mode: 'base-url',
          baseUrl: config.baseUrl,
          testCase,
          requestInput,
          response: responseSnapshot,
          shared,
        });
      }

      results.push({
        testCaseId: testCase.id ?? 'unknown',
        endpoint: endpointPathFromTestCase(testCase),
        method,
        scenario: testCase.scenario ?? 'Generated test case',
        status: 'passed',
        durationMs: Date.now() - startedAt,
        request: requestSnapshot,
        response: responseSnapshot,
        notes,
      });
    } catch (err) {
      const { status, failureType, message } = classifyBaseUrlError(err);

      const result: ExecutionTestResult = {
        testCaseId: testCase.id ?? 'unknown',
        endpoint: endpointPathFromTestCase(testCase),
        method,
        scenario: testCase.scenario ?? 'Generated test case',
        status,
        durationMs: Date.now() - startedAt,
        request: requestSnapshot,
        message,
        notes,
      };

      if (status === 'skipped') {
        result.skippedReason = message;
      } else {
        result.failureType = failureType;
      }

      results.push(result);
    }
  }

  if (hooks.afterRun) {
    await hooks.afterRun({
      mode: 'base-url',
      baseUrl: config.baseUrl,
      shared,
    });
  }

  return results;
}

function classifyBaseUrlError(err: unknown): {
  status: 'failed' | 'skipped';
  failureType?: ExecutionFailureType;
  message: string;
} {
  if (err instanceof HookSkipError) {
    return {
      status: 'skipped',
      message: err.reason,
    };
  }

  if (err instanceof ExecutionAssertionError) {
    return {
      status: 'failed',
      failureType: 'assertion',
      message: err.message,
    };
  }

  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      status: 'failed',
      failureType: 'timeout',
      message: 'Request timed out',
    };
  }

  if (err instanceof Error && /abort/i.test(err.name)) {
    return {
      status: 'failed',
      failureType: 'timeout',
      message: err.message,
    };
  }

  if (err instanceof TypeError) {
    return {
      status: 'failed',
      failureType: 'network',
      message: err.message,
    };
  }

  if (err instanceof Error) {
    return {
      status: 'failed',
      failureType: 'hook',
      message: err.message,
    };
  }

  return {
    status: 'failed',
    failureType: 'runner',
    message: String(err),
  };
}
