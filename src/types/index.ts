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
}
