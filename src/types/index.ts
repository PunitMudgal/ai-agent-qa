/**
 * Shared types for parsers, generators, formatters, server, and CLI.
 */

// ─── Swagger / API (swaggerParser) ─────────────────────────────────────────

export interface SchemaProperty {
  name: string;
  type: string;
  required: boolean;
  format?: string | null;
  enum?: readonly unknown[] | null;
  minLength?: number | null;
  maxLength?: number | null;
  minimum?: number | null;
  maximum?: number | null;
  pattern?: string | null;
  description: string;
  default?: unknown;
  nullable?: boolean;
  example?: unknown;
  /** For array type */
  items?: string;
  minItems?: number;
  maxItems?: number;
}

export interface Parameter {
  name: string;
  in: string;
  required: boolean;
  type: string;
  format?: string | null;
  enum?: readonly unknown[] | null;
  description: string;
  example?: unknown;
}

export interface RequestBody {
  required: boolean;
  schema: Record<string, unknown>;
  properties: SchemaProperty[];
}

export interface ResponseItem {
  statusCode: string;
  description: string;
  schema: Record<string, unknown> | null;
  properties: SchemaProperty[];
}

export interface Endpoint {
  method: string;
  path: string;
  operationId: string | null;
  summary: string;
  description: string;
  tags: string[];
  parameters: Parameter[];
  requestBody: RequestBody | null;
  responses: ResponseItem[];
  security: unknown[] | null;
  deprecated?: boolean;
  /** Route filename (e.g. auth.routes.js) - used for path/tag filtering in routes-only mode */
  sourceFileName?: string;
  sourceKind?: CoverageSourceKind;
}

// ─── Test cases (formatters, generator, AI prompt) ─────────────────────────

export interface InputData {
  headers?: Record<string, string>;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface ExpectedOutput {
  statusCode?: number;
  bodyContains?: Record<string, unknown>;
  bodyExcludes?: string[];
  headers?: Record<string, string>;
}

export interface TestCase {
  id?: string;
  endpoint?: string;
  method?: string;
  scenario?: string;
  category?: string;
  priority?: string;
  inputData?: InputData;
  expectedOutput?: ExpectedOutput;
  preconditions?: string;
  notes?: string;
  status?: string;
}

export interface ParseWarning {
  kind: 'route' | 'controller' | 'coverage';
  file: string;
  message: string;
  line?: number;
  column?: number;
}

// ─── Routes (routeParser) ──────────────────────────────────────────────────

export interface RouteInfo {
  method: string;
  path: string;
  rawPath: string;
  basePath: string;
  middlewares: string[];
  controllerFunction: string;
  controllerRef: string;
  validationMiddleware: string[];
  sourceFile: string;
  fileName: string;
}

export interface RouteParseResult {
  routes: RouteInfo[];
  warnings: ParseWarning[];
}

// ─── Controllers (controllerParser) ────────────────────────────────────────

export interface ThrownError {
  type: string;
  message: string;
}

export interface ControllerHint {
  functionName: string;
  sourceFile: string;
  fileName: string;
  statusCodes: number[];
  thrownErrors: ThrownError[];
  modelReferences: string[];
  authChecks: string[];
  validationChecks: string[];
  jsdoc: string;
  conditionalBranches: number;
}

export interface ControllerParseResult {
  hints: ControllerHint[];
  warnings: ParseWarning[];
}

// ─── Generation options ────────────────────────────────────────────────────

export interface GenerationOptions {
  format: 'json' | 'markdown' | 'both';
  outputDir: string;
  businessContext: string;
  filterTags: string[];
  filterPaths: string[];
  minTestsPerEndpoint: number;
  includeCategories?: string[];
  /** Generate Jest + Supertest test files */
  outputJest?: boolean;
  /** Directory for .test.ts files (default: outputDir + '/jest') */
  jestOutputDir?: string;
  /** Base URL for API under test (default: http://localhost:3000) */
  jestBaseUrl?: string;
  /** Base path to prepend to all routes (e.g. /api/v1 when app mounts under that) */
  jestBasePath?: string;
  /** If false, use strict body assertions; if true (default), only assert status code */
  jestExploratoryAssertions?: boolean;
}

export type RunnerMode = 'base-url' | 'app-import';
export type ExecutionFailureType =
  | 'assertion'
  | 'network'
  | 'timeout'
  | 'setup'
  | 'runner'
  | 'hook';
export type ExecutionStatus = 'passed' | 'failed' | 'skipped';

export interface RunnerConfig {
  mode: RunnerMode;
  baseUrl?: string;
  appModulePath?: string;
  allowMutations: boolean;
  hooksPath?: string;
  reportDir: string;
  timeoutMs: number;
  strictAssertions: boolean;
}

export interface RunnerHookOverride {
  skip?: boolean;
  reason?: string;
  headers?: Record<string, string>;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  body?: Record<string, unknown>;
  notes?: string[];
}

export interface RunnerHookSharedContext {
  [key: string]: unknown;
}

export interface RunnerHookContext {
  mode: RunnerMode;
  testCase?: TestCase;
  requestInput?: InputData;
  response?: ExecutionResponseSnapshot;
  shared: RunnerHookSharedContext;
  appModulePath?: string;
  baseUrl?: string;
}

export interface RunnerHooks {
  beforeRun?: (ctx: RunnerHookContext) => Promise<void> | void;
  beforeTest?: (
    ctx: RunnerHookContext
  ) => Promise<RunnerHookOverride | void> | RunnerHookOverride | void;
  afterTest?: (ctx: RunnerHookContext) => Promise<void> | void;
  afterRun?: (ctx: RunnerHookContext) => Promise<void> | void;
}

export interface ExecutionRequestSnapshot {
  method: string;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, unknown>;
  pathParams?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface ExecutionResponseSnapshot {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ExecutionTestResult {
  testCaseId: string;
  endpoint: string;
  method: string;
  scenario: string;
  status: ExecutionStatus;
  durationMs: number;
  failureType?: ExecutionFailureType;
  message?: string;
  skippedReason?: string;
  request?: ExecutionRequestSnapshot;
  response?: ExecutionResponseSnapshot;
  notes?: string[];
}

export interface ExecutionEndpointSummary {
  endpoint: string;
  method: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface ExecutionReportMetadata {
  mode: RunnerMode;
  source: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  reportDir: string;
  allowMutations: boolean;
  strictAssertions: boolean;
  baseUrl?: string;
  appModulePath?: string;
  hooksPath?: string;
}

export interface ExecutionReportSummary {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  skippedMutations: number;
  warnings: number;
}

export interface ExecutionReport {
  metadata: ExecutionReportMetadata;
  summary: ExecutionReportSummary;
  endpointSummaries: ExecutionEndpointSummary[];
  results: ExecutionTestResult[];
  warnings: ParseWarning[];
}

export interface ExecutionResult {
  report: ExecutionReport;
  savedFiles: string[];
  exitCode: number;
}

export type CoverageSourceKind = 'swagger' | 'routes' | 'generated';
export type CoverageBasisSourceType = 'swagger' | 'routes' | 'mixed' | 'legacy';
export type CoverageScopeMode = 'filtered' | 'generated-only';
export type CoverageExecutionState = 'pending' | 'available' | 'partial';
export type CoverageRuntimeState =
  | 'pending'
  | 'not-run'
  | 'passing'
  | 'failing'
  | 'skipped'
  | 'mutation-gated';

export interface CoverageSourceEndpoint {
  method: string;
  path: string;
  tags: string[];
  sourceKind: CoverageSourceKind;
  sourceFileName?: string;
}

export interface CoverageBasis {
  sourceType: CoverageBasisSourceType;
  scopeMode: CoverageScopeMode;
  discoveredTotal: number;
  filteredTotal: number;
  filters: {
    tags: string[];
    paths: string[];
  };
  endpoints: CoverageSourceEndpoint[];
  warnings: ParseWarning[];
}

export interface CoverageCategorySummary {
  category: string;
  endpointsCovered: number;
  totalEndpoints: number;
  testCount: number;
  coveragePct: number;
}

export interface CoverageEndpointSummary {
  method: string;
  path: string;
  generatedTests: number;
  categoriesCovered: string[];
  missingCategories: string[];
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  mutationGated: boolean;
  runtimeState: CoverageRuntimeState;
  designScore: number;
  runtimeScore: number | null;
  overallScore: number;
}

export interface CoverageReportMetadata {
  source: string;
  sourceType: CoverageBasisSourceType;
  scopeMode: CoverageScopeMode;
  generatedAt: string;
  reportDir: string;
  executionState: CoverageExecutionState;
}

export interface CoverageReportSummary {
  discoveredTotal: number;
  inScopeTotal: number;
  coveredEndpoints: number;
  uncoveredEndpoints: number;
  endpointCoveragePct: number;
  totalTests: number;
  avgTestsPerCoveredEndpoint: number;
  executedTests: number;
  passRate: number | null;
  mutationGatedEndpoints: number;
  designScore: number;
  runtimeScore: number | null;
  overallScore: number;
  warnings: number;
}

export interface CoverageReport {
  metadata: CoverageReportMetadata;
  summary: CoverageReportSummary;
  categorySummaries: CoverageCategorySummary[];
  endpointSummaries: CoverageEndpointSummary[];
  uncoveredEndpoints: CoverageSourceEndpoint[];
  warnings: ParseWarning[];
}

export interface CoverageResult {
  report: CoverageReport;
  savedFiles: string[];
}

/** Options for generateFromMixed (includes optional swagger/routes/controllers paths) */
export interface GenerationMixedOptions extends GenerationOptions {
  swagger?: string;
  routes?: string;
  controllers?: string;
}

// ─── Formatted output (jsonFormatter) ───────────────────────────────────────

export interface FormattedJsonMetadata {
  generatedAt: string;
  totalCount: number;
  countByCategory: Record<string, number>;
  countByEndpoint: Record<string, number>;
  countByPriority: Record<string, number>;
  generator: string;
}

export interface FormattedJsonOutput {
  metadata: FormattedJsonMetadata;
  testCases: TestCase[];
  coverageBasis?: CoverageBasis;
  warnings?: ParseWarning[];
}

// ─── Server (POST /generate body) ──────────────────────────────────────────

export interface GenerateRequestBody {
  type?: string;
  swaggerContent?: string;
  routesPath?: string;
  controllersPath?: string;
  businessContext?: string;
  format?: string;
  filterTags?: string[] | string;
  filterPaths?: string[] | string;
  minTests?: number;
  outputJest?: boolean;
  jestDir?: string;
  jestBaseUrl?: string;
  jestBasePath?: string;
  jestExploratoryAssertions?: boolean;
  runAfterGenerate?: boolean;
  runnerMode?: RunnerMode;
  runBaseUrl?: string;
  appModulePath?: string;
  runnerHooksPath?: string;
  allowMutations?: boolean;
  reportDir?: string;
  timeoutMs?: number;
  strictAssertions?: boolean;
  testCases?: TestCase[];
  inputPath?: string;
  coverageBasis?: CoverageBasis;
  warnings?: ParseWarning[];
}

export interface RunRequestBody {
  testCases?: TestCase[];
  inputPath?: string;
  outputDir?: string;
  runnerMode?: RunnerMode;
  runBaseUrl?: string;
  appModulePath?: string;
  runnerHooksPath?: string;
  allowMutations?: boolean;
  reportDir?: string;
  timeoutMs?: number;
  strictAssertions?: boolean;
  sourceLabel?: string;
  coverageBasis?: CoverageBasis;
  warnings?: ParseWarning[];
}
