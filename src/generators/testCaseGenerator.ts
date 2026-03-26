/**
 * @module testCaseGenerator
 * @description Main orchestration module that combines parsers, prompt builder, and AI client.
 */

import path from 'path';
import { createCoverageBasis } from '../coverage';
import { parseSwaggerFile, parseSwaggerString } from '../parsers/swaggerParser';
import { parseRouteDirectory } from '../parsers/routeParser';
import { parseControllerDirectory } from '../parsers/controllerParser';
import { buildPrompt } from '../ai/promptBuilder';
import { generateTestCases, initAIProvider } from '../ai/groqClient';
import { formatTestCases as formatJson, saveToFile as saveJson } from '../formatters/jsonFormatter';
import { formatTestCases as formatMd, saveToFile as saveMd } from '../formatters/markdownFormatter';
import { formatTestCasesAsJestByEndpoint } from '../formatters/jestSupertestFormatter';
import { enrichEndpointWithControllerHint, sanitizeGeneratedTestCases } from './testCaseSanitizer';
import { ensureOutputDir, generateBatchFilename, validateAndWriteJestFile } from '../utils/fileUtils';
import * as logger from '../utils/logger';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const API_CALL_DELAY_MS = 500;
import type {
  CoverageBasis,
  CoverageSourceEndpoint,
  Endpoint,
  TestCase,
  ControllerHint,
  GenerationOptions,
  GenerationMixedOptions,
  ParseWarning,
} from '../types';

const GROQ_DAILY_LIMIT_MSG =
  'Groq daily limit reached. Falling back to Gemini if GEMINI_API_KEY is set; otherwise generation will stop.\n' +
  '  Options: 1) Add GEMINI_API_KEY to .env as fallback  2) Use --filter-paths or --filter-tags  3) Reduce --min-tests  4) Wait for limit reset';

function handleGenerationError(err: unknown, label: string): void {
  const code = (err as { code?: string }).code;
  if (code === 'GROQ_DAILY_LIMIT') {
    logger.warn(GROQ_DAILY_LIMIT_MSG);
    throw err;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(`Failed to generate for ${label}: ${message}`);
}

const DEFAULT_OPTIONS: GenerationOptions = {
  format: 'json',
  outputDir: './output',
  businessContext: '',
  filterTags: [],
  filterPaths: [],
  minTestsPerEndpoint: 10,
  includeCategories: ['positive', 'negative', 'edge', 'validation', 'boundary'],
};

function filterEndpoints(
  endpoints: Endpoint[],
  options: GenerationOptions
): Endpoint[] {
  let filtered = [...endpoints];

  if (options.filterTags && options.filterTags.length > 0) {
    const tags = options.filterTags.map(t => t.toLowerCase().trim());
    filtered = filtered.filter(
      ep => ep.tags && ep.tags.some(t => tags.some(filterTag => tagMatchesFilter(t, filterTag)))
    );
    logger.debug(`Filtered by tags: ${filtered.length} endpoints remaining`);
  }

  if (options.filterPaths && options.filterPaths.length > 0) {
    const paths = options.filterPaths.map(p => p.toLowerCase().trim());
    filtered = filtered.filter(ep => {
      if (paths.some(p => ep.path.toLowerCase().startsWith(p))) return true;
      // Route-derived endpoints: path is relative (e.g. /sign-in). Match by filter path segment
      // to source filename (e.g. /api/v1/auth -> auth.routes.js)
      const sourceFile = (ep as Endpoint & { sourceFileName?: string }).sourceFileName || '';
      return paths.some(p => {
        const segment = p.split('/').filter(Boolean).pop();
        return segment && sourceFile.toLowerCase().includes(segment.toLowerCase());
      });
    });
    logger.debug(`Filtered by paths: ${filtered.length} endpoints remaining`);
  }

  return filtered;
}

function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function singularize(tag: string): string {
  return tag.endsWith('s') ? tag.slice(0, -1) : tag;
}

function tagMatchesFilter(endpointTag: string, filterTag: string): boolean {
  const endpointNorm = normalizeTag(endpointTag);
  const filterNorm = normalizeTag(filterTag);

  if (!endpointNorm || !filterNorm) return false;
  if (endpointNorm === filterNorm) return true;
  if (singularize(endpointNorm) === singularize(filterNorm)) return true;
  if (endpointNorm.includes(filterNorm)) return true;
  if (filterNorm.includes(endpointNorm)) return true;
  return false;
}

function assignIdsToNormalizedCases(testCases: TestCase[], startId = 1): TestCase[] {
  return testCases.map((tc, i) => ({
    ...tc,
    id: `TC-${String(startId + i).padStart(3, '0')}`,
    status: tc.status ?? 'Pending',
  }));
}

async function saveOutput(
  testCases: TestCase[],
  options: GenerationOptions,
  extras: {
    coverageBasis?: CoverageBasis;
    warnings?: ParseWarning[];
  } = {}
): Promise<string[]> {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OPTIONS.outputDir);
  await ensureOutputDir(outputDir);
  const savedFiles: string[] = [];

  const format = options.format ?? 'json';

  if (format === 'json' || format === 'both') {
    const filename = generateBatchFilename('json');
    const filePath = path.join(outputDir, filename);
    const formatted = formatJson(testCases, extras);
    await saveJson(formatted, filePath);
    savedFiles.push(filePath);
    logger.success(`JSON saved: ${filePath}`);
  }

  if (format === 'markdown' || format === 'both') {
    const filename = generateBatchFilename('markdown');
    const filePath = path.join(outputDir, filename);
    const formatted = formatMd(testCases);
    await saveMd(formatted, filePath);
    savedFiles.push(filePath);
    logger.success(`Markdown saved: ${filePath}`);
  }

  if (options.outputJest && testCases.length > 0) {
    const jestOutputDir = path.resolve(
      options.jestOutputDir || path.join(outputDir, 'jest')
    );
    await ensureOutputDir(jestOutputDir);
    const baseUrl = options.jestBaseUrl ?? 'http://localhost:3000';
    const jestOpts = {
      baseUrl,
      basePath: options.jestBasePath,
      exploratoryAssertions: options.jestExploratoryAssertions ?? true,
    };
    const files = formatTestCasesAsJestByEndpoint(testCases, jestOpts);
    for (const { filename, content } of files) {
      const filePath = path.join(jestOutputDir, filename);
      const ok = await validateAndWriteJestFile(filePath, content);
      if (ok) {
        savedFiles.push(filePath);
        logger.success(`Jest test saved: ${filePath}`);
      } else {
        logger.warn(`Skipped invalid Jest file: ${filePath}`);
      }
    }
  }

  return savedFiles;
}

export interface GenerateResult {
  testCases: TestCase[];
  savedFiles: string[];
  warnings: ParseWarning[];
  coverageBasis: CoverageBasis;
}

function logParseWarnings(warnings: ParseWarning[]): void {
  warnings.forEach(warning => {
    const location = warning.line ? `:${warning.line}` : '';
    logger.warn(
      `[${warning.kind}] ${path.basename(warning.file)}${location} ${warning.message}`
    );
  });
}

export async function generateFromSwagger(
  swaggerPath: string,
  options: Partial<GenerationOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  logger.info(`Parsing Swagger file: ${swaggerPath}`);
  let endpoints: Endpoint[] = (await parseSwaggerFile(swaggerPath)).map(endpoint => ({
    ...endpoint,
    sourceKind: endpoint.sourceKind ?? 'swagger',
  }));
  logger.success(`Found ${endpoints.length} endpoints`);
  const discoveredTotal = endpoints.length;

  endpoints = filterEndpoints(endpoints, opts);
  const coverageBasis = createCoverageBasis({
    sourceType: 'swagger',
    discoveredTotal,
    endpoints: toCoverageSourceEndpoints(endpoints),
    filters: {
      tags: opts.filterTags,
      paths: opts.filterPaths,
    },
  });
  if (endpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [], warnings: [], coverageBasis };
  }

  logger.info(`Generating test cases for ${endpoints.length} endpoints...`);

  const allTestCases: TestCase[] = [];
  let idCounter = 1;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const label = `${ep.method} ${ep.path}`;
    logger.updateSpinner(
      `[${i + 1}/${endpoints.length}] Generating tests for ${label}...`
    );

    try {
      const { systemPrompt, userPrompt } = buildPrompt(
        ep,
        opts.businessContext,
        null,
        opts.minTestsPerEndpoint ?? DEFAULT_OPTIONS.minTestsPerEndpoint
      );
      const rawTestCases = await generateTestCases(userPrompt, {
        systemPrompt,
      });

      const normalizedCases = sanitizeGeneratedTestCases(rawTestCases, ep, null);
      const withIds = assignIdsToNormalizedCases(normalizedCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
      logger.debug(`Generated ${withIds.length} test cases for ${label}`);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < endpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  logger.info(`Total test cases generated: ${allTestCases.length}`);

  const savedFiles = await saveOutput(allTestCases, opts, {
    coverageBasis,
    warnings: [],
  });
  return { testCases: allTestCases, savedFiles, warnings: [], coverageBasis };
}

export async function generateFromSwaggerString(
  swaggerContent: string,
  options: Partial<GenerationOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  logger.info('Parsing Swagger content...');
  let endpoints: Endpoint[] = (await parseSwaggerString(swaggerContent)).map(endpoint => ({
    ...endpoint,
    sourceKind: endpoint.sourceKind ?? 'swagger',
  }));
  logger.success(`Found ${endpoints.length} endpoints`);
  const discoveredTotal = endpoints.length;

  endpoints = filterEndpoints(endpoints, opts);
  const coverageBasis = createCoverageBasis({
    sourceType: 'swagger',
    discoveredTotal,
    endpoints: toCoverageSourceEndpoints(endpoints),
    filters: {
      tags: opts.filterTags,
      paths: opts.filterPaths,
    },
  });
  if (endpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [], warnings: [], coverageBasis };
  }

  const allTestCases: TestCase[] = [];
  let idCounter = 1;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const label = `${ep.method} ${ep.path}`;

    try {
      const { systemPrompt, userPrompt } = buildPrompt(
        ep,
        opts.businessContext,
        null,
        opts.minTestsPerEndpoint ?? DEFAULT_OPTIONS.minTestsPerEndpoint
      );
      const rawTestCases = await generateTestCases(userPrompt, { systemPrompt });

      const normalizedCases = sanitizeGeneratedTestCases(rawTestCases, ep, null);
      const withIds = assignIdsToNormalizedCases(normalizedCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < endpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  const savedFiles = await saveOutput(allTestCases, opts, {
    coverageBasis,
    warnings: [],
  });
  return { testCases: allTestCases, savedFiles, warnings: [], coverageBasis };
}

/** Infer tag from route filename (e.g. auth.routes.js -> auth, user.routes.js -> users) */
function inferTagFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(js|ts|mjs|cjs)$/i, '');
  const match = base.match(/^(.+?)(?:\.(?:route|router|api|endpoint)s?)?$/i);
  return (match?.[1] ?? base).toLowerCase();
}

function toCoverageSourceEndpoints(endpoints: Endpoint[]): CoverageSourceEndpoint[] {
  return endpoints.map(endpoint => ({
    method: endpoint.method,
    path: endpoint.path,
    tags: endpoint.tags ?? [],
    sourceKind: endpoint.sourceKind ?? 'generated',
    sourceFileName: endpoint.sourceFileName,
  }));
}

export async function generateFromRoutes(
  routesDir: string,
  controllersDir: string | null,
  options: Partial<GenerationOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  logger.info('Scanning route files...');
  const routeResult = await parseRouteDirectory(routesDir);
  const routes = routeResult.routes;
  const warnings = [...routeResult.warnings];
  if (routes.length === 0) {
    throw new Error(
      `No routes found in "${routesDir}". Check that the path is correct and contains route files ` +
      `(.js/.ts with "route", "router", "api", or "endpoint" in the filename, or any .js/.ts if none match).`
    );
  }
  logger.success(`Found ${routes.length} routes`);
  logParseWarnings(routeResult.warnings);

  let controllerHints: ControllerHint[] = [];
  if (controllersDir) {
    logger.info('Scanning controller files...');
    const controllerResult = await parseControllerDirectory(controllersDir);
    controllerHints = controllerResult.hints;
    warnings.push(...controllerResult.warnings);
    logger.success(
      `Extracted hints from ${controllerHints.length} controller functions`
    );
    logParseWarnings(controllerResult.warnings);
  }

  // Build endpoints and apply filters (tags from filename, path by segment match)
  const endpoints: Endpoint[] = routes.map(route => {
    const tag = inferTagFromFileName(route.fileName);
    return {
      method: route.method,
      path: route.path,
      operationId: route.controllerFunction,
      summary: '',
      description: `Route from ${route.fileName}. Middlewares: ${route.middlewares.join(', ') || 'none'}`,
      tags: [tag],
      parameters: [],
      requestBody: null,
      responses: [],
      security: route.middlewares.some(
        m =>
          m.toLowerCase().includes('auth') ||
          m.toLowerCase().includes('protect')
      )
        ? [{ bearerAuth: [] }]
        : null,
      sourceFileName: route.fileName,
      sourceKind: 'routes',
    };
  });

  const filteredEndpoints = filterEndpoints(endpoints, opts);
  const coverageBasis = createCoverageBasis({
    sourceType: 'routes',
    discoveredTotal: endpoints.length,
    endpoints: toCoverageSourceEndpoints(filteredEndpoints),
    filters: {
      tags: opts.filterTags,
      paths: opts.filterPaths,
    },
    warnings,
  });
  if (filteredEndpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [], warnings, coverageBasis };
  }
  logger.info(`Generating test cases for ${filteredEndpoints.length} endpoints (filtered from ${routes.length})...`);

  const allTestCases: TestCase[] = [];
  let idCounter = 1;

  for (let i = 0; i < filteredEndpoints.length; i++) {
    const ep = filteredEndpoints[i];
    const label = `${ep.method} ${ep.path}`;

    const hint = controllerHints.find(
      h =>
        h.functionName.toLowerCase() ===
        (ep.operationId ?? '').toLowerCase()
    );
    const enrichedEndpoint = enrichEndpointWithControllerHint(ep, hint ?? null);

    try {
      const { systemPrompt, userPrompt } = buildPrompt(
        enrichedEndpoint,
        opts.businessContext,
        hint ?? null,
        opts.minTestsPerEndpoint ?? DEFAULT_OPTIONS.minTestsPerEndpoint
      );
      const rawTestCases = await generateTestCases(userPrompt, { systemPrompt });

      const normalizedCases = sanitizeGeneratedTestCases(
        rawTestCases,
        enrichedEndpoint,
        hint ?? null
      );
      const withIds = assignIdsToNormalizedCases(normalizedCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < filteredEndpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  const savedFiles = await saveOutput(allTestCases, opts, {
    coverageBasis,
    warnings,
  });
  return { testCases: allTestCases, savedFiles, warnings, coverageBasis };
}

export async function generateFromMixed(
  options: Partial<GenerationMixedOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  let endpoints: Endpoint[] = [];
  let controllerHints: ControllerHint[] = [];
  const warnings: ParseWarning[] = [];

  if (opts.swagger) {
    logger.info('Parsing Swagger file...');
    const swaggerEndpoints = (await parseSwaggerFile(opts.swagger)).map(endpoint => ({
      ...endpoint,
      sourceKind: endpoint.sourceKind ?? 'swagger',
    }));
    endpoints.push(...swaggerEndpoints);
    logger.success(`Found ${swaggerEndpoints.length} endpoints from Swagger`);
  }

  if (opts.routes) {
    logger.info('Scanning route files...');
    const routeResult = await parseRouteDirectory(opts.routes);
    const routes = routeResult.routes;
    warnings.push(...routeResult.warnings);
    if (routes.length === 0) {
      throw new Error(
        `No routes found in "${opts.routes}". Check that the path is correct and contains route files ` +
        `(.js/.ts with "route", "router", "api", or "endpoint" in the filename, or any .js/.ts if none match).`
      );
    }
    logger.success(`Found ${routes.length} routes`);
    logParseWarnings(routeResult.warnings);

    for (const route of routes) {
      const exists = endpoints.find(
        ep => ep.method === route.method && ep.path === route.path
      );
      if (!exists) {
        const tag = inferTagFromFileName(route.fileName);
        endpoints.push({
          method: route.method,
          path: route.path,
          operationId: route.controllerFunction,
          summary: '',
          description: `From route file: ${route.fileName}`,
          tags: [tag],
          parameters: [],
          requestBody: null,
          responses: [],
          security: route.middlewares.some(m =>
            m.toLowerCase().includes('auth')
          )
            ? [{ bearerAuth: [] }]
            : null,
          sourceFileName: route.fileName,
          sourceKind: 'routes',
        });
      }
    }
  }

  if (opts.controllers) {
    logger.info('Scanning controller files...');
    const controllerResult = await parseControllerDirectory(opts.controllers);
    controllerHints = controllerResult.hints;
    warnings.push(...controllerResult.warnings);
    logger.success(`Extracted hints from ${controllerHints.length} functions`);
    logParseWarnings(controllerResult.warnings);
  }

  const discoveredTotal = endpoints.length;
  endpoints = filterEndpoints(endpoints, opts);
  const coverageBasis = createCoverageBasis({
    sourceType: opts.swagger && opts.routes ? 'mixed' : opts.swagger ? 'swagger' : 'routes',
    discoveredTotal,
    endpoints: toCoverageSourceEndpoints(endpoints),
    filters: {
      tags: opts.filterTags,
      paths: opts.filterPaths,
    },
    warnings,
  });
  if (endpoints.length === 0) {
    logger.warn('No endpoints to generate test cases for');
    return { testCases: [], savedFiles: [], warnings, coverageBasis };
  }

  logger.info(`Generating test cases for ${endpoints.length} endpoints...`);

  const allTestCases: TestCase[] = [];
  let idCounter = 1;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const label = `${ep.method} ${ep.path}`;

    const hint = controllerHints.find(h => {
      if (!ep.operationId) return false;
      return (
        h.functionName.toLowerCase() === ep.operationId!.toLowerCase()
      );
    });
    const enrichedEndpoint = enrichEndpointWithControllerHint(ep, hint ?? null);

    try {
      const { systemPrompt, userPrompt } = buildPrompt(
        enrichedEndpoint,
        opts.businessContext,
        hint ?? null,
        opts.minTestsPerEndpoint ?? DEFAULT_OPTIONS.minTestsPerEndpoint
      );
      const rawTestCases = await generateTestCases(userPrompt, { systemPrompt });

      const normalizedCases = sanitizeGeneratedTestCases(
        rawTestCases,
        enrichedEndpoint,
        hint ?? null
      );
      const withIds = assignIdsToNormalizedCases(normalizedCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < endpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  const savedFiles = await saveOutput(allTestCases, opts, {
    coverageBasis,
    warnings,
  });
  return { testCases: allTestCases, savedFiles, warnings, coverageBasis };
}

export { filterEndpoints };
