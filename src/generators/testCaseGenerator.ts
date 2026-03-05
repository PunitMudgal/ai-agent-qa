/**
 * @module testCaseGenerator
 * @description Main orchestration module that combines parsers, prompt builder, and AI client.
 */

import path from 'path';
import { parseSwaggerFile, parseSwaggerString } from '../parsers/swaggerParser';
import { parseRouteDirectory } from '../parsers/routeParser';
import { parseControllerDirectory } from '../parsers/controllerParser';
import { buildPrompt } from '../ai/promptBuilder';
import { generateTestCases, initAIProvider } from '../ai/groqClient';
import { formatTestCases as formatJson, saveToFile as saveJson } from '../formatters/jsonFormatter';
import { formatTestCases as formatMd, saveToFile as saveMd } from '../formatters/markdownFormatter';
import { formatTestCasesAsJestByEndpoint } from '../formatters/jestSupertestFormatter';
import { ensureOutputDir, generateBatchFilename, writeFile, validateAndWriteJestFile } from '../utils/fileUtils';
import * as logger from '../utils/logger';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const API_CALL_DELAY_MS = 500;
import type {
  Endpoint,
  TestCase,
  ControllerHint,
  GenerationOptions,
  GenerationMixedOptions,
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
      ep => ep.tags && ep.tags.some(t => tags.includes(t.toLowerCase()))
    );
    logger.debug(`Filtered by tags: ${filtered.length} endpoints remaining`);
  }

  if (options.filterPaths && options.filterPaths.length > 0) {
    const paths = options.filterPaths.map(p => p.toLowerCase().trim());
    filtered = filtered.filter(ep =>
      paths.some(p => ep.path.toLowerCase().startsWith(p))
    );
    logger.debug(`Filtered by paths: ${filtered.length} endpoints remaining`);
  }

  return filtered;
}

function assignIds(testCases: unknown[], startId = 1): TestCase[] {
  return testCases.map((tc, i) => {
    const record = (typeof tc === 'object' && tc !== null ? tc : {}) as Record<
      string,
      unknown
    >;
    return {
      ...record,
      id: `TC-${String(startId + i).padStart(3, '0')}`,
      status: (record.status as string) ?? 'Pending',
    } as TestCase;
  });
}

async function saveOutput(
  testCases: TestCase[],
  options: GenerationOptions
): Promise<string[]> {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OPTIONS.outputDir);
  await ensureOutputDir(outputDir);
  const savedFiles: string[] = [];

  const format = options.format ?? 'json';

  if (format === 'json' || format === 'both') {
    const filename = generateBatchFilename('json');
    const filePath = path.join(outputDir, filename);
    const formatted = formatJson(testCases);
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
}

export async function generateFromSwagger(
  swaggerPath: string,
  options: Partial<GenerationOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  logger.info(`Parsing Swagger file: ${swaggerPath}`);
  let endpoints = await parseSwaggerFile(swaggerPath);
  logger.success(`Found ${endpoints.length} endpoints`);

  endpoints = filterEndpoints(endpoints, opts);
  if (endpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [] };
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
      const testCases = await generateTestCases(userPrompt, {
        systemPrompt,
      });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
      logger.debug(`Generated ${withIds.length} test cases for ${label}`);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < endpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  logger.info(`Total test cases generated: ${allTestCases.length}`);

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

export async function generateFromSwaggerString(
  swaggerContent: string,
  options: Partial<GenerationOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  logger.info('Parsing Swagger content...');
  let endpoints = await parseSwaggerString(swaggerContent);
  logger.success(`Found ${endpoints.length} endpoints`);

  endpoints = filterEndpoints(endpoints, opts);
  if (endpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [] };
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
      const testCases = await generateTestCases(userPrompt, { systemPrompt });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < endpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

export async function generateFromRoutes(
  routesDir: string,
  controllersDir: string | null,
  options: Partial<GenerationOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  logger.info('Scanning route files...');
  const routes = await parseRouteDirectory(routesDir);
  if (routes.length === 0) {
    throw new Error(
      `No routes found in "${routesDir}". Check that the path is correct and contains route files ` +
      `(.js/.ts with "route", "router", "api", or "endpoint" in the filename, or any .js/.ts if none match).`
    );
  }
  logger.success(`Found ${routes.length} routes`);

  let controllerHints: ControllerHint[] = [];
  if (controllersDir) {
    logger.info('Scanning controller files...');
    controllerHints = await parseControllerDirectory(controllersDir);
    logger.success(
      `Extracted hints from ${controllerHints.length} controller functions`
    );
  }

  const allTestCases: TestCase[] = [];
  let idCounter = 1;

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const label = `${route.method} ${route.path}`;

    const hint = controllerHints.find(
      h =>
        h.functionName.toLowerCase() ===
        route.controllerFunction.toLowerCase()
    );

    const endpoint: Endpoint = {
      method: route.method,
      path: route.path,
      operationId: route.controllerFunction,
      summary: '',
      description: `Route from ${route.fileName}. Middlewares: ${route.middlewares.join(', ') || 'none'}`,
      tags: [],
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
    };

    try {
      const { systemPrompt, userPrompt } = buildPrompt(
        endpoint,
        opts.businessContext,
        hint ?? null,
        opts.minTestsPerEndpoint ?? DEFAULT_OPTIONS.minTestsPerEndpoint
      );
      const testCases = await generateTestCases(userPrompt, { systemPrompt });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < routes.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

export async function generateFromMixed(
  options: Partial<GenerationMixedOptions> = {}
): Promise<GenerateResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initAIProvider();

  let endpoints: Endpoint[] = [];
  let controllerHints: ControllerHint[] = [];

  if (opts.swagger) {
    logger.info('Parsing Swagger file...');
    const swaggerEndpoints = await parseSwaggerFile(opts.swagger);
    endpoints.push(...swaggerEndpoints);
    logger.success(`Found ${swaggerEndpoints.length} endpoints from Swagger`);
  }

  if (opts.routes) {
    logger.info('Scanning route files...');
    const routes = await parseRouteDirectory(opts.routes);
    if (routes.length === 0) {
      throw new Error(
        `No routes found in "${opts.routes}". Check that the path is correct and contains route files ` +
        `(.js/.ts with "route", "router", "api", or "endpoint" in the filename, or any .js/.ts if none match).`
      );
    }
    logger.success(`Found ${routes.length} routes`);

    for (const route of routes) {
      const exists = endpoints.find(
        ep => ep.method === route.method && ep.path === route.path
      );
      if (!exists) {
        endpoints.push({
          method: route.method,
          path: route.path,
          operationId: route.controllerFunction,
          summary: '',
          description: `From route file: ${route.fileName}`,
          tags: [],
          parameters: [],
          requestBody: null,
          responses: [],
          security: route.middlewares.some(m =>
            m.toLowerCase().includes('auth')
          )
            ? [{ bearerAuth: [] }]
            : null,
        });
      }
    }
  }

  if (opts.controllers) {
    logger.info('Scanning controller files...');
    controllerHints = await parseControllerDirectory(opts.controllers);
    logger.success(`Extracted hints from ${controllerHints.length} functions`);
  }

  endpoints = filterEndpoints(endpoints, opts);
  if (endpoints.length === 0) {
    logger.warn('No endpoints to generate test cases for');
    return { testCases: [], savedFiles: [] };
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

    try {
      const { systemPrompt, userPrompt } = buildPrompt(
        ep,
        opts.businessContext,
        hint ?? null,
        opts.minTestsPerEndpoint ?? DEFAULT_OPTIONS.minTestsPerEndpoint
      );
      const testCases = await generateTestCases(userPrompt, { systemPrompt });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }

    if (i < endpoints.length - 1) await sleep(API_CALL_DELAY_MS);
  }

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

export { filterEndpoints };
