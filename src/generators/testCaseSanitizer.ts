import { normalizeTestCase } from '../runner/utils';
import type {
  ControllerHint,
  Endpoint,
  ExpectedOutput,
  InputData,
  Parameter,
  RequestBody,
  SchemaProperty,
  TestCase,
} from '../types';

const ALLOWED_CATEGORIES = new Set(['positive', 'negative', 'edge', 'validation', 'boundary']);
const ALLOWED_PRIORITIES = new Set(['high', 'medium', 'low']);
const RESERVED_REQUEST_KEYS = new Set([
  'id',
  'endpoint',
  'method',
  'scenario',
  'category',
  'priority',
  'inputData',
  'expectedOutput',
  'preconditions',
  'notes',
  'status',
  'headers',
  'pathParams',
  'queryParams',
  'body',
]);

export function enrichEndpointWithControllerHint(
  endpoint: Endpoint,
  controllerHint: ControllerHint | null
): Endpoint {
  if (!controllerHint) {
    return {
      ...endpoint,
      parameters: mergeEndpointParameters(endpoint.parameters ?? [], extractPathParamNames(endpoint.path), []),
    };
  }

  const pathNames = uniqueStrings([
    ...extractPathParamNames(endpoint.path),
    ...(endpoint.parameters ?? [])
      .filter(param => param.in === 'path')
      .map(param => param.name),
    ...controllerHint.pathParamNames,
  ]);
  const queryNames = uniqueStrings([
    ...(endpoint.parameters ?? [])
      .filter(param => param.in === 'query')
      .map(param => param.name),
    ...controllerHint.queryParamNames,
  ]);
  const bodyNames = uniqueStrings([
    ...(endpoint.requestBody?.properties ?? []).map(prop => prop.name),
    ...controllerHint.bodyFieldNames,
  ]);

  return {
    ...endpoint,
    parameters: mergeEndpointParameters(endpoint.parameters ?? [], pathNames, queryNames),
    requestBody: mergeRequestBody(endpoint.requestBody, bodyNames),
  };
}

export function sanitizeGeneratedTestCases(
  rawTestCases: unknown[],
  endpoint: Endpoint,
  controllerHint: ControllerHint | null
): TestCase[] {
  const enrichedEndpoint = enrichEndpointWithControllerHint(endpoint, controllerHint);
  const method = String(enrichedEndpoint.method || 'GET').toUpperCase();
  const endpointLabel = `${method} ${enrichedEndpoint.path}`;
  const context = buildEndpointContext(enrichedEndpoint, controllerHint);
  const normalizedCases: TestCase[] = [];

  rawTestCases.forEach((rawCase, index) => {
    const record = asRecord(rawCase);
    const inputData = asRecord(record.inputData);
    const nestedExpectedFallback =
      asRecord(inputData.queryParams).expectedOutput ?? asRecord(inputData.body).expectedOutput;

    const sanitizedCase: TestCase = normalizeTestCase(
      {
        endpoint: endpointLabel,
        method,
        scenario: cleanText(record.scenario) || 'Generated test case',
        category: normalizeCategory(record.category),
        priority: normalizePriority(record.priority),
        preconditions: cleanText(record.preconditions),
        notes: cleanText(record.notes),
        status: normalizeStatus(record.status),
        inputData: sanitizeInputData(inputData, context),
        expectedOutput: sanitizeExpectedOutput(record.expectedOutput ?? nestedExpectedFallback),
      },
      index
    );

    if (shouldDropCase(record, sanitizedCase, context)) {
      return;
    }

    normalizedCases.push(sanitizedCase);
  });

  return dedupeTestCases(normalizedCases);
}

interface EndpointContext {
  method: string;
  queryParamNames: string[];
  bodyFieldNames: string[];
  pathParamNames: string[];
  authRequired: boolean;
  hasExplicitConstraints: boolean;
}

function buildEndpointContext(
  endpoint: Endpoint,
  controllerHint: ControllerHint | null
): EndpointContext {
  return {
    method: String(endpoint.method || 'GET').toUpperCase(),
    queryParamNames: uniqueStrings(
      (endpoint.parameters ?? [])
        .filter(param => param.in === 'query')
        .map(param => param.name)
    ),
    bodyFieldNames: uniqueStrings((endpoint.requestBody?.properties ?? []).map(prop => prop.name)),
    pathParamNames: uniqueStrings([
      ...extractPathParamNames(endpoint.path),
      ...(endpoint.parameters ?? [])
        .filter(param => param.in === 'path')
        .map(param => param.name),
    ]),
    authRequired: Boolean((endpoint.security ?? []).length) || Boolean(controllerHint?.authChecks.length),
    hasExplicitConstraints: endpointHasExplicitConstraints(endpoint),
  };
}

function mergeEndpointParameters(
  existing: Parameter[],
  pathParamNames: string[],
  queryParamNames: string[]
): Parameter[] {
  const merged = [...existing];
  const seen = new Set(existing.map(param => `${param.in}:${param.name}`));

  pathParamNames.forEach(name => {
    const key = `path:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({
      name,
      in: 'path',
      required: true,
      type: 'string',
      description: 'Observed in controller implementation',
    });
  });

  queryParamNames.forEach(name => {
    const key = `query:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({
      name,
      in: 'query',
      required: false,
      type: 'string',
      description: 'Observed in controller implementation',
    });
  });

  return merged;
}

function mergeRequestBody(existing: RequestBody | null, bodyFieldNames: string[]): RequestBody | null {
  if (!bodyFieldNames.length && !existing) return null;

  const existingProps = existing?.properties ?? [];
  const mergedProps: SchemaProperty[] = [...existingProps];
  const seen = new Set(existingProps.map(prop => prop.name));

  bodyFieldNames.forEach(name => {
    if (seen.has(name)) return;
    seen.add(name);
    mergedProps.push({
      name,
      type: 'string',
      required: false,
      description: 'Observed in controller implementation',
    });
  });

  return {
    required: existing?.required ?? false,
    schema: existing?.schema ?? {},
    properties: mergedProps,
  };
}

function sanitizeInputData(inputData: Record<string, unknown>, context: EndpointContext): InputData {
  return {
    headers: sanitizeHeaders(inputData.headers),
    pathParams: sanitizeRequestSection(inputData.pathParams, context.pathParamNames),
    queryParams: sanitizeRequestSection(inputData.queryParams, context.queryParamNames),
    body: sanitizeRequestSection(inputData.body, context.bodyFieldNames),
  };
}

function sanitizeHeaders(rawValue: unknown): Record<string, string> {
  const input = asRecord(rawValue);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    output[key] = String(value);
  }
  return output;
}

function sanitizeRequestSection(rawValue: unknown, knownFieldNames: string[]): Record<string, unknown> {
  const input = asRecord(rawValue);
  const sanitizedEntries = Object.entries(input)
    .filter(([key]) => !RESERVED_REQUEST_KEYS.has(key))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, sanitizeNestedValue(value)] as const);

  const sanitizedObject = Object.fromEntries(sanitizedEntries);
  if (!knownFieldNames.length) {
    return sanitizedObject;
  }

  const directMatches = Object.fromEntries(
    Object.entries(sanitizedObject).filter(([key]) => knownFieldNames.includes(key))
  );
  if (Object.keys(directMatches).length > 0) {
    return directMatches;
  }

  const mapped = mapGenericRequestKeys(sanitizedObject, knownFieldNames);
  return mapped ?? {};
}

function mapGenericRequestKeys(
  source: Record<string, unknown>,
  knownFieldNames: string[]
): Record<string, unknown> | null {
  const genericEntries = Object.entries(source).filter(([key]) => isGenericPlaceholderKey(key));
  if (!genericEntries.length || genericEntries.length > knownFieldNames.length) {
    return null;
  }

  const orderedEntries = genericEntries.sort((a, b) => placeholderKeyRank(a[0]) - placeholderKeyRank(b[0]));
  const mapped: Record<string, unknown> = {};

  orderedEntries.forEach(([key, value], index) => {
    const targetKey = knownFieldNames[Math.min(index, knownFieldNames.length - 1)];
    if (mapped[targetKey] === undefined) {
      mapped[targetKey] = value;
    } else {
      mapped[key] = value;
    }
  });

  return Object.keys(mapped).length > 0 ? mapped : null;
}

function sanitizeExpectedOutput(rawValue: unknown): ExpectedOutput {
  const input = asRecord(rawValue);
  const statusCode = normalizeStatusCode(input.statusCode);
  const bodyContains = asRecord(input.bodyContains);
  const bodyExcludes = Array.isArray(input.bodyExcludes)
    ? input.bodyExcludes.filter(item => typeof item === 'string')
    : [];
  const headers = sanitizeHeaders(input.headers);

  return {
    statusCode,
    bodyContains,
    bodyExcludes,
    headers,
  };
}

function shouldDropCase(
  rawCase: Record<string, unknown>,
  sanitizedCase: TestCase,
  context: EndpointContext
): boolean {
  const caseText = [
    cleanText(rawCase.scenario),
    cleanText(rawCase.preconditions),
    cleanText(rawCase.notes),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!context.authRequired && isAuthScenario(caseText, sanitizedCase.expectedOutput?.statusCode)) {
    return true;
  }

  if (!context.hasExplicitConstraints && looksLikeConstraintScenario(caseText)) {
    return true;
  }

  if (
    context.queryParamNames.length > 0 &&
    Object.keys(asRecord(asRecord(rawCase.inputData).queryParams)).length > 0 &&
    Object.keys(sanitizedCase.inputData?.queryParams ?? {}).length === 0
  ) {
    return true;
  }

  if (
    context.bodyFieldNames.length > 0 &&
    Object.keys(asRecord(asRecord(rawCase.inputData).body)).length > 0 &&
    Object.keys(sanitizedCase.inputData?.body ?? {}).length === 0
  ) {
    return true;
  }

  return false;
}

function dedupeTestCases(testCases: TestCase[]): TestCase[] {
  const seen = new Set<string>();
  const result: TestCase[] = [];

  testCases.forEach(testCase => {
    const key = JSON.stringify({
      endpoint: testCase.endpoint,
      method: testCase.method,
      scenario: testCase.scenario,
      inputData: testCase.inputData,
      expectedOutput: testCase.expectedOutput,
    });
    if (seen.has(key)) return;
    seen.add(key);
    result.push(testCase);
  });

  return result.map((testCase, index) => ({
    ...testCase,
    id: `TC-${String(index + 1).padStart(3, '0')}`,
  }));
}

function extractPathParamNames(pathTemplate: string): string[] {
  const names = new Set<string>();
  const colonMatches = pathTemplate.matchAll(/:([A-Za-z0-9_]+)/g);
  const braceMatches = pathTemplate.matchAll(/\{([A-Za-z0-9_]+)\}/g);

  for (const match of colonMatches) {
    names.add(match[1]);
  }
  for (const match of braceMatches) {
    names.add(match[1]);
  }

  return Array.from(names);
}

function endpointHasExplicitConstraints(endpoint: Endpoint): boolean {
  const constrainedParameter = (endpoint.parameters ?? []).some(
    param => param.enum || param.format
  );
  if (constrainedParameter) return true;

  return (endpoint.requestBody?.properties ?? []).some(
    prop =>
      prop.enum ||
      prop.format ||
      prop.minLength != null ||
      prop.maxLength != null ||
      prop.minimum != null ||
      prop.maximum != null ||
      prop.pattern != null ||
      prop.minItems != null ||
      prop.maxItems != null
  );
}

function isAuthScenario(caseText: string, statusCode: number | undefined): boolean {
  if (statusCode === 401 || statusCode === 403) return true;
  return /\bunauthorized\b|\bforbidden\b|without authentication|missing authentication|invalid authentication|no authentication/.test(caseText);
}

function looksLikeConstraintScenario(caseText: string): boolean {
  return /max(?:imum)? length|minimum length|at limit|beyond limit|too many characters|too few characters|length exceeds|exceed maximum length/.test(caseText);
}

function containsPlaceholderValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\.repeat\(/.test(value) || /\n\s*\}/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => containsPlaceholderValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(item => containsPlaceholderValue(item));
  }
  return false;
}

function sanitizeNestedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const repeated = materializeRepeatPlaceholder(value);
    return repeated.replace(/\n[\s}]+$/g, '').trim();
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeNestedValue(item));
  }
  if (value && typeof value === 'object') {
    const record = asRecord(value);
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !RESERVED_REQUEST_KEYS.has(key))
        .map(([key, nested]) => [key, sanitizeNestedValue(nested)])
    );
  }
  return value;
}

function materializeRepeatPlaceholder(value: string): string {
  const match = value.match(/^\s*([A-Za-z0-9])(?:\\?")?\.repeat\((\d{1,5})\)/);
  if (!match) return value;

  const [, token, rawCount] = match;
  const count = Number(rawCount);
  if (!Number.isFinite(count) || count < 0 || count > 5000) {
    return value;
  }
  return token.repeat(count);
}

function normalizeStatusCode(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return 200;
}

function normalizeCategory(value: unknown): string {
  const normalized = cleanText(value).toLowerCase();
  return ALLOWED_CATEGORIES.has(normalized) ? normalized : 'positive';
}

function normalizePriority(value: unknown): string {
  const normalized = cleanText(value).toLowerCase();
  return ALLOWED_PRIORITIES.has(normalized) ? normalized : 'medium';
}

function normalizeStatus(value: unknown): string {
  const normalized = cleanText(value);
  return normalized || 'Pending';
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach(value => {
    const cleaned = cleanText(value);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    result.push(cleaned);
  });
  return result;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isGenericPlaceholderKey(key: string): boolean {
  return /^(?:invalid)?param\d*$/i.test(key) ||
    /^query\d*$/i.test(key) ||
    /^field\d*$/i.test(key) ||
    /^value\d*$/i.test(key) ||
    /^arg\d*$/i.test(key);
}

function placeholderKeyRank(key: string): number {
  const numericSuffix = key.match(/(\d+)$/);
  if (!numericSuffix) return 0;
  return parseInt(numericSuffix[1], 10);
}
