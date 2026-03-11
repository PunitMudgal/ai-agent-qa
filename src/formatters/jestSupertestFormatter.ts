/**
 * @module jestSupertestFormatter
 * @description Formats test cases as runnable Jest + Supertest .test.ts files (one per endpoint).
 */

import type { TestCase, InputData, ExpectedOutput } from '../types';
import { resolvePathTemplate } from '../runner/utils';
import { generateJestTestFilename } from '../utils/fileUtils';

export interface JestFormatterOptions {
  baseUrl: string;
  useAppPath?: string;
  /** Base path to prepend to all routes (e.g. /api/v1 when app mounts under that) */
  basePath?: string;
  /** If true, only assert status code (avoids failing on invented error shapes) */
  exploratoryAssertions?: boolean;
}

/** Escape a string for use inside a JavaScript string literal (single-quoted) */
function escapeForJs(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** Build the request path with path params substituted (e.g. /users/:id + { id: 123 } -> /users/123) */
function buildPath(pathTemplate: string, pathParams: Record<string, unknown>): string {
  return resolvePathTemplate(pathTemplate, pathParams);
}

/** Serialize a value for embedding in generated source (JSON for objects, safe string for primitives) */
function toSourceValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function buildRequestLines(tc: TestCase, baseVar: string, options: JestFormatterOptions): string[] {
  const method = (tc.method ?? 'GET').toUpperCase();
  const endpoint = tc.endpoint ?? '';
  let pathTemplate = endpoint.replace(/^(get|post|put|delete|patch|options|head)\s+/i, '').trim() || '/';
  const prefix = (options.basePath ?? '').trim().replace(/\/$/, '');
  if (prefix) {
    pathTemplate = (prefix + (pathTemplate.startsWith('/') ? pathTemplate : '/' + pathTemplate)).replace(/\/+/g, '/');
  }
  const input: InputData = tc.inputData ?? {
    headers: {},
    pathParams: {},
    queryParams: {},
    body: {},
  };
  const pathParams = (input.pathParams ?? {}) as Record<string, unknown>;
  const path = buildPath(pathTemplate, pathParams);
  const queryParams = input.queryParams ?? {};
  const headers = input.headers ?? {};
  const body = input.body ?? {};

  const lines: string[] = [];
  lines.push(`    const res = await request(${baseVar})`);
  lines.push(`      .${method.toLowerCase()}(${JSON.stringify(path)})`);

  if (Object.keys(headers).length > 0) {
    lines.push(`      .set(${toSourceValue(headers)})`);
  }
  if (Object.keys(queryParams).length > 0) {
    lines.push(`      .query(${toSourceValue(queryParams)})`);
  }
  if (['POST', 'PUT', 'PATCH'].includes(method) && Object.keys(body).length > 0) {
    lines.push(`      .send(${toSourceValue(body)})`);
  }
  lines.push('      .set(\'Accept\', \'application/json\');');

  return lines;
}

function buildAssertions(tc: TestCase, exploratory: boolean): string[] {
  const expected: ExpectedOutput = tc.expectedOutput ?? {
    statusCode: 200,
    bodyContains: {},
    bodyExcludes: [],
    headers: {},
  };
  const statusCode = expected.statusCode ?? 200;
  const bodyContains = expected.bodyContains ?? {};
  const bodyExcludes = expected.bodyExcludes ?? [];

  const lines: string[] = [];
  lines.push(`    expect(res.status).toBe(${statusCode});`);
  if (!exploratory && Object.keys(bodyContains).length > 0) {
    lines.push(`    expect(res.body).toMatchObject(${toSourceValue(bodyContains)});`);
  }
  if (!exploratory) {
    for (const excl of bodyExcludes) {
      if (typeof excl === 'string') {
        lines.push(`    expect(JSON.stringify(res.body)).not.toContain(${JSON.stringify(excl)});`);
      }
    }
  }
  return lines;
}

function generateOneTest(tc: TestCase, baseVar: string, options: JestFormatterOptions): string {
  const scenario = (tc.scenario ?? 'should respond').replace(/\s+/g, ' ').trim();
  const safeScenario = escapeForJs(scenario).slice(0, 120);
  const requestLines = buildRequestLines(tc, baseVar, options);
  const assertionLines = buildAssertions(tc, options.exploratoryAssertions ?? true);

  const parts: string[] = [];
  parts.push(`  it('${safeScenario}', async () => {`);
  parts.push(...requestLines);
  parts.push('');
  parts.push(...assertionLines.map(l => '    ' + l.trim()));
  parts.push('  });');
  return parts.join('\n');
}

function generateFileContent(
  endpointKey: string,
  cases: TestCase[],
  options: JestFormatterOptions
): string {
  const baseVar = options.useAppPath ? 'app' : 'baseUrl';
  const header = options.useAppPath
    ? `const request = require('supertest');\nconst app = require('${options.useAppPath.replace(/\\/g, '\\\\')}');\n`
    : `const request = require('supertest');\nconst baseUrl = process.env.API_BASE_URL || ${JSON.stringify(options.baseUrl)};\n`;

  const tests = cases.map(tc => generateOneTest(tc, baseVar, options)).join('\n\n');

  return `/**
 * Generated by QA Test Generator. Run: npx jest path/to/this/file.
 * Endpoint: ${endpointKey}
 * Generated at: ${new Date().toISOString()}
 */
${header}
describe(${JSON.stringify(endpointKey)}, () => {
${tests}
});
`;
}

export interface JestTestFile {
  filename: string;
  content: string;
}

/**
 * Group test cases by endpoint (method + path) and return one test file per endpoint.
 */
export function formatTestCasesAsJestByEndpoint(
  testCases: TestCase[],
  options: JestFormatterOptions
): JestTestFile[] {
  const byEndpoint = new Map<string, TestCase[]>();
  for (const tc of testCases) {
    const key = (tc.method ?? 'GET') + ' ' + ((tc.endpoint ?? '').replace(/^(get|post|put|delete|patch|options|head)\s+/i, '').trim() || '/');
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key)!.push(tc);
  }

  const result: JestTestFile[] = [];
  for (const [endpointKey, cases] of byEndpoint) {
    const endpointLabel = (cases[0]?.method ?? 'GET') + ' ' + (cases[0]?.endpoint ?? '').replace(/^(get|post|put|delete|patch|options|head)\s+/i, '').trim() || '/';
    const filename = generateJestTestFilename(endpointLabel);
    const content = generateFileContent(endpointLabel, cases, options);
    result.push({ filename, content });
  }
  return result;
}
