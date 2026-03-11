import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type {
  ExecutionTestResult,
  RunnerConfig,
  TestCase,
} from '../types';
import { prepareRunnerHooksPath } from './hookLoader';
import { endpointPathFromTestCase, isMutatingMethod } from './utils';

const execFileAsync = promisify(execFile);

interface AppImportRunInput {
  testCases: TestCase[];
  config: RunnerConfig;
}

export async function runAgainstAppImport(
  input: AppImportRunInput
): Promise<ExecutionTestResult[]> {
  const { testCases, config } = input;

  if (!config.appModulePath) {
    throw new Error('App import mode requires an app module path');
  }

  const appModulePath = path.resolve(config.appModulePath);
  if (!(await fs.pathExists(appModulePath))) {
    throw new Error(`App module not found: ${appModulePath}`);
  }

  const skippedResults = testCases
    .filter(tc => !config.allowMutations && isMutatingMethod(tc.method))
    .map<ExecutionTestResult>(tc => ({
      testCaseId: tc.id ?? 'unknown',
      endpoint: endpointPathFromTestCase(tc),
      method: String(tc.method ?? 'GET').toUpperCase(),
      scenario: tc.scenario ?? 'Generated test case',
      status: 'skipped',
      durationMs: 0,
      skippedReason: 'Mutation skipped by safe mode',
    }));

  const executableCases = testCases.filter(
    tc => config.allowMutations || !isMutatingMethod(tc.method)
  );
  if (executableCases.length === 0) {
    return skippedResults;
  }

  const projectRoot = await findProjectRoot(appModulePath);
  const jestBin = resolveDependency(projectRoot, 'jest/bin/jest.js');
  const supertestPath = resolveDependency(projectRoot, 'supertest');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-qa-runner-'));
  const sidecarPath = path.join(tempDir, 'results.ndjson');
  const jestJsonPath = path.join(tempDir, 'jest-results.json');
  const suitePath = path.join(tempDir, 'generated.test.cjs');
  const hooksPrep = await prepareRunnerHooksPath(config.hooksPath);

  try {
    const suiteContent = buildJestSuite({
      testCases: executableCases,
      appModulePath,
      supertestPath,
      sidecarPath,
      strictAssertions: config.strictAssertions,
      hooksPath: hooksPrep.loadPath,
    });
    await fs.writeFile(suitePath, suiteContent, 'utf-8');

    let jestStdErr = '';
    try {
      await execFileAsync(
        process.execPath,
        [
          jestBin,
          '--runInBand',
          '--json',
          '--outputFile',
          jestJsonPath,
          suitePath,
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            CI: '1',
          },
          maxBuffer: 10 * 1024 * 1024,
        }
      );
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string };
      jestStdErr = error.stderr ?? error.stdout ?? '';
    }

    const executedResults = await readSidecarResults(sidecarPath);
    if (executedResults.length === 0) {
      return [
        ...skippedResults,
        {
          testCaseId: 'RUNNER',
          endpoint: 'Runner setup',
          method: 'N/A',
          scenario: 'Jest/Supertest runner bootstrap',
          status: 'failed',
          durationMs: 0,
          failureType: 'setup',
          message:
            jestStdErr ||
            'Jest execution failed before any test results were produced',
        },
      ];
    }

    return [...skippedResults, ...executedResults];
  } finally {
    await hooksPrep.cleanup();
    await fs.remove(tempDir).catch(() => {});
  }
}

async function findProjectRoot(startPath: string): Promise<string> {
  let current = path.dirname(startPath);
  while (true) {
    const pkg = path.join(current, 'package.json');
    if (await fs.pathExists(pkg)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function resolveDependency(projectRoot: string, request: string): string {
  try {
    return require.resolve(request, { paths: [projectRoot] });
  } catch {
    throw new Error(
      `Missing runtime dependency "${request}" in project root ${projectRoot}. ` +
        'Install the required packages before using app-import execution mode.'
    );
  }
}

async function readSidecarResults(sidecarPath: string): Promise<ExecutionTestResult[]> {
  if (!(await fs.pathExists(sidecarPath))) {
    return [];
  }

  const content = await fs.readFile(sidecarPath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as ExecutionTestResult);
}

function buildJestSuite(input: {
  testCases: TestCase[];
  appModulePath: string;
  supertestPath: string;
  sidecarPath: string;
  strictAssertions: boolean;
  hooksPath?: string;
}): string {
  const serializedCases = JSON.stringify(input.testCases, null, 2);
  const hookPathExpr = input.hooksPath ? JSON.stringify(input.hooksPath) : 'null';

  return `const fs = require('fs');
const { pathToFileURL } = require('url');
const request = require(${JSON.stringify(input.supertestPath)});

const strictAssertions = ${input.strictAssertions ? 'true' : 'false'};
const sidecarPath = ${JSON.stringify(input.sidecarPath)};
const hooksPath = ${hookPathExpr};
const appModulePath = ${JSON.stringify(input.appModulePath)};
const testCases = ${serializedCases};
const shared = {};

let hooks = {};
let app = null;

function appendResult(result) {
  fs.appendFileSync(sidecarPath, JSON.stringify(result) + '\\n');
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
}

function endpointPath(endpoint) {
  return String(endpoint || '').replace(/^(get|post|put|delete|patch|options|head)\\s+/i, '').trim() || '/';
}

function resolvePath(pathTemplate, pathParams) {
  let value = pathTemplate;
  Object.entries(pathParams || {}).forEach(([key, rawValue]) => {
    const safeValue = encodeURIComponent(String(rawValue == null ? '' : rawValue));
    value = value.replace(new RegExp(':' + escapeRegExp(key) + '\\\\b', 'g'), safeValue);
    value = value.replace(new RegExp('\\\\{' + escapeRegExp(key) + '\\\\}', 'g'), safeValue);
  });
  return value;
}

function mergeInput(baseInput, override) {
  return {
    headers: { ...(baseInput.headers || {}), ...((override && override.headers) || {}) },
    pathParams: { ...(baseInput.pathParams || {}), ...((override && override.pathParams) || {}) },
    queryParams: { ...(baseInput.queryParams || {}), ...((override && override.queryParams) || {}) },
    body: { ...(baseInput.body || {}), ...((override && override.body) || {}) },
  };
}

function responseBodyValue(res) {
  if (res.body && Object.keys(res.body).length > 0) return res.body;
  return res.text;
}

function matchesSubset(actual, expected) {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, index) => matchesSubset(actual[index], item));
  }
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => matchesSubset(actual[key], value));
}

function createAssertionError(message) {
  const err = new Error(message);
  err.__qaFailureType = 'assertion';
  return err;
}

function createSkipError(reason) {
  const err = new Error(reason);
  err.__qaSkip = true;
  return err;
}

function createHookError(message) {
  const err = new Error(message);
  err.__qaFailureType = 'hook';
  return err;
}

function classifyFailureType(err) {
  if (err && err.__qaFailureType) return err.__qaFailureType;
  return 'runner';
}

async function loadOptionalModule(filePath) {
  if (!filePath) return {};
  const loaded = await import(pathToFileURL(filePath).href);
  return loaded.default || loaded;
}

beforeAll(async () => {
  hooks = await loadOptionalModule(hooksPath);
  const appModule = await loadOptionalModule(appModulePath);
  app = appModule.default || appModule.app || appModule.server || appModule;
  if (hooks.beforeRun) {
    await hooks.beforeRun({
      mode: 'app-import',
      appModulePath,
      shared,
    });
  }
});

afterAll(async () => {
  if (hooks.afterRun) {
    await hooks.afterRun({
      mode: 'app-import',
      appModulePath,
      shared,
    });
  }
});

describe('ai-agent-qa executable app-import suite', () => {
  testCases.forEach((testCase) => {
    const title = String(testCase.id || 'TC') + ' ' + String(testCase.scenario || 'Generated test case');
    it(title, async () => {
      const startedAt = Date.now();
      const method = String(testCase.method || 'GET').toUpperCase();
      const baseInput = deepClone(testCase.inputData || { headers: {}, pathParams: {}, queryParams: {}, body: {} });
      let requestInput = baseInput;
      let notes = [];
      let requestSnapshot = {
        method,
        url: endpointPath(testCase.endpoint),
        headers: requestInput.headers || {},
        pathParams: requestInput.pathParams || {},
        queryParams: requestInput.queryParams || {},
        body: requestInput.body || {},
      };
      let responseSnapshot = undefined;

      try {
        if (hooks.beforeTest) {
          const override = await hooks.beforeTest({
            mode: 'app-import',
            appModulePath,
            testCase,
            requestInput,
            shared,
          });
          if (override && override.skip) {
            throw createSkipError(override.reason || 'Skipped by beforeTest hook');
          }
          requestInput = mergeInput(requestInput, override || {});
          notes = [].concat((override && override.notes) || []);
        }

        const pathValue = resolvePath(endpointPath(testCase.endpoint), requestInput.pathParams || {});
        let req = request(app)[method.toLowerCase()](pathValue).set('Accept', 'application/json');
        if (requestInput.headers && Object.keys(requestInput.headers).length > 0) {
          req = req.set(requestInput.headers);
        }
        if (requestInput.queryParams && Object.keys(requestInput.queryParams).length > 0) {
          req = req.query(requestInput.queryParams);
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && requestInput.body && Object.keys(requestInput.body).length > 0) {
          req = req.send(requestInput.body);
        }

        requestSnapshot = {
          method,
          url: pathValue,
          headers: { Accept: 'application/json', ...(requestInput.headers || {}) },
          pathParams: requestInput.pathParams || {},
          queryParams: requestInput.queryParams || {},
          body: requestInput.body || {},
        };

        const res = await req;
        responseSnapshot = {
          statusCode: res.status,
          headers: res.headers || {},
          body: responseBodyValue(res),
        };

        const expected = testCase.expectedOutput || {};
        if (expected.statusCode != null && res.status !== expected.statusCode) {
          throw createAssertionError('Expected status ' + expected.statusCode + ', got ' + res.status);
        }
        if (strictAssertions && expected.bodyContains && Object.keys(expected.bodyContains).length > 0) {
          if (!matchesSubset(responseSnapshot.body, expected.bodyContains)) {
            throw createAssertionError('Response body did not match expected subset');
          }
        }
        if (strictAssertions && expected.bodyExcludes && expected.bodyExcludes.length > 0) {
          const bodyText = JSON.stringify(responseSnapshot.body);
          for (const token of expected.bodyExcludes) {
            if (bodyText.includes(token)) {
              throw createAssertionError('Response body unexpectedly contained excluded token "' + token + '"');
            }
          }
        }
        if (strictAssertions && expected.headers && Object.keys(expected.headers).length > 0) {
          for (const [key, value] of Object.entries(expected.headers)) {
            if ((responseSnapshot.headers || {})[String(key).toLowerCase()] !== value) {
              throw createAssertionError('Expected header ' + key + '=' + value);
            }
          }
        }

        if (hooks.afterTest) {
          await hooks.afterTest({
            mode: 'app-import',
            appModulePath,
            testCase,
            requestInput,
            response: responseSnapshot,
            shared,
          });
        }

        appendResult({
          testCaseId: testCase.id || 'unknown',
          endpoint: endpointPath(testCase.endpoint),
          method,
          scenario: testCase.scenario || 'Generated test case',
          status: 'passed',
          durationMs: Date.now() - startedAt,
          request: requestSnapshot,
          response: responseSnapshot,
          notes,
        });
      } catch (err) {
        const skipped = !!(err && err.__qaSkip);
        const record = {
          testCaseId: testCase.id || 'unknown',
          endpoint: endpointPath(testCase.endpoint),
          method,
          scenario: testCase.scenario || 'Generated test case',
          status: skipped ? 'skipped' : 'failed',
          durationMs: Date.now() - startedAt,
          request: requestSnapshot,
          response: responseSnapshot,
          notes,
          message: err instanceof Error ? err.message : String(err),
        };
        if (skipped) {
          record.skippedReason = record.message;
        } else {
          record.failureType = classifyFailureType(err);
        }
        appendResult(record);
        if (!skipped) {
          throw err;
        }
      }
    }, ${Math.max(input.testCases.length, 1) * 1000 + 5000});
  });
});
`;
}
