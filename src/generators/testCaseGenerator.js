/**
 * @module testCaseGenerator
 * @description Main orchestration module that combines parsers, prompt builder, and AI client.
 */

const { parseSwaggerFile, parseSwaggerString } = require('../parsers/swaggerParser');
const { parseRouteDirectory, parseRouteFiles } = require('../parsers/routeParser');
const { parseControllerDirectory, parseControllerFiles } = require('../parsers/controllerParser');
const { buildPrompt, buildBatchPrompt } = require('../ai/promptBuilder');
const { generateTestCases, initGroqClient } = require('../ai/groqClient');
const { formatTestCases: formatJson, saveToFile: saveJson } = require('../formatters/jsonFormatter');
const { formatTestCases: formatMd, saveToFile: saveMd } = require('../formatters/markdownFormatter');
const { ensureOutputDir, generateBatchFilename } = require('../utils/fileUtils');
const logger = require('../utils/logger');
const path = require('path');

const GROQ_DAILY_LIMIT_MSG =
  'Daily token limit reached for Groq. Retrying will not help until the limit resets (usually next day).\n' +
  '  Options: 1) Wait and run again later  2) Use --filter-paths or --filter-tags to generate for fewer endpoints  3) Reduce --min-tests  4) Upgrade at https://console.groq.com/settings/billing';

/** If err is Groq daily limit, log once and rethrow so the run aborts without spamming. */
function handleGenerationError(err, label) {
  if (err.code === 'GROQ_DAILY_LIMIT') {
    logger.warn(GROQ_DAILY_LIMIT_MSG);
    throw err;
  }
  logger.warn(`Failed to generate for ${label}: ${err.message}`);
}

/**
 * Default options for generation.
 */
const DEFAULT_OPTIONS = {
  format: 'json',
  outputDir: './output',
  businessContext: '',
  filterTags: [],
  filterPaths: [],
  minTestsPerEndpoint: 10,
  includeCategories: ['positive', 'negative', 'edge', 'validation', 'boundary'],
};

/**
 * Filter endpoints by tags and paths.
 * @param {Array<object>} endpoints
 * @param {object} options
 * @returns {Array<object>}
 */
function filterEndpoints(endpoints, options) {
  let filtered = [...endpoints];

  if (options.filterTags && options.filterTags.length > 0) {
    const tags = options.filterTags.map(t => t.toLowerCase().trim());
    filtered = filtered.filter(ep =>
      ep.tags && ep.tags.some(t => tags.includes(t.toLowerCase()))
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

/**
 * Assign sequential IDs to test cases, ensuring uniqueness.
 * @param {Array<object>} testCases
 * @param {number} [startId=1]
 * @returns {Array<object>}
 */
function assignIds(testCases, startId = 1) {
  return testCases.map((tc, i) => ({
    ...tc,
    id: `TC-${String(startId + i).padStart(3, '0')}`,
    status: tc.status || 'Pending',
  }));
}

/**
 * Save test cases to file(s) based on format option.
 * @param {Array<object>} testCases
 * @param {object} options
 * @returns {Promise<string[]>} Array of saved file paths.
 */
async function saveOutput(testCases, options) {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OPTIONS.outputDir);
  await ensureOutputDir(outputDir);
  const savedFiles = [];

  const format = options.format || 'json';

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

  return savedFiles;
}

/**
 * Generate test cases from a Swagger/OpenAPI file.
 * @param {string} swaggerPath - Path to swagger file.
 * @param {object} [options] - Generation options.
 * @returns {Promise<{testCases: Array, savedFiles: string[]}>}
 */
async function generateFromSwagger(swaggerPath, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initGroqClient();

  logger.info(`Parsing Swagger file: ${swaggerPath}`);
  let endpoints = await parseSwaggerFile(swaggerPath);
  logger.success(`Found ${endpoints.length} endpoints`);

  endpoints = filterEndpoints(endpoints, opts);
  if (endpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [] };
  }

  logger.info(`Generating test cases for ${endpoints.length} endpoints...`);

  const allTestCases = [];
  let idCounter = 1;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const label = `${ep.method} ${ep.path}`;
    logger.updateSpinner(`[${i + 1}/${endpoints.length}] Generating tests for ${label}...`);

    try {
      const { systemPrompt, userPrompt } = buildPrompt(ep, opts.businessContext);
      const testCases = await generateTestCases(userPrompt, {
        systemPrompt,
        maxTokens: 4000,
      });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
      logger.debug(`Generated ${withIds.length} test cases for ${label}`);
    } catch (err) {
      handleGenerationError(err, label);
    }
  }

  logger.info(`Total test cases generated: ${allTestCases.length}`);

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

/**
 * Generate test cases from a Swagger string (for web UI).
 * @param {string} swaggerContent - Raw JSON/YAML string.
 * @param {object} [options]
 * @returns {Promise<{testCases: Array, savedFiles: string[]}>}
 */
async function generateFromSwaggerString(swaggerContent, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initGroqClient();

  logger.info('Parsing Swagger content...');
  let endpoints = await parseSwaggerString(swaggerContent);
  logger.success(`Found ${endpoints.length} endpoints`);

  endpoints = filterEndpoints(endpoints, opts);
  if (endpoints.length === 0) {
    logger.warn('No endpoints match the given filters');
    return { testCases: [], savedFiles: [] };
  }

  const allTestCases = [];
  let idCounter = 1;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const label = `${ep.method} ${ep.path}`;

    try {
      const { systemPrompt, userPrompt } = buildPrompt(ep, opts.businessContext);
      const testCases = await generateTestCases(userPrompt, { systemPrompt });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }
  }

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

/**
 * Generate test cases from Express routes and controllers.
 * @param {string} routesDir - Path to routes directory.
 * @param {string} [controllersDir] - Path to controllers directory.
 * @param {object} [options]
 * @returns {Promise<{testCases: Array, savedFiles: string[]}>}
 */
async function generateFromRoutes(routesDir, controllersDir, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initGroqClient();

  logger.info('Scanning route files...');
  const routes = await parseRouteDirectory(routesDir);
  logger.success(`Found ${routes.length} routes`);

  let controllerHints = [];
  if (controllersDir) {
    logger.info('Scanning controller files...');
    controllerHints = await parseControllerDirectory(controllersDir);
    logger.success(`Extracted hints from ${controllerHints.length} controller functions`);
  }

  const allTestCases = [];
  let idCounter = 1;

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const label = `${route.method} ${route.path}`;

    // Find matching controller hint
    const hint = controllerHints.find(h =>
      h.functionName.toLowerCase() === route.controllerFunction.toLowerCase()
    );

    // Build a minimal endpoint object from routes
    const endpoint = {
      method: route.method,
      path: route.path,
      operationId: route.controllerFunction,
      summary: '',
      description: `Route from ${route.fileName}. Middlewares: ${route.middlewares.join(', ') || 'none'}`,
      tags: [],
      parameters: [],
      requestBody: null,
      responses: [],
      security: route.middlewares.some(m =>
        m.toLowerCase().includes('auth') || m.toLowerCase().includes('protect')
      ) ? [{ bearerAuth: [] }] : null,
    };

    try {
      const { systemPrompt, userPrompt } = buildPrompt(endpoint, opts.businessContext, hint);
      const testCases = await generateTestCases(userPrompt, { systemPrompt });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }
  }

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

/**
 * Generate test cases from all available sources combined.
 * @param {object} [options]
 * @param {string} [options.swagger] - Swagger file path.
 * @param {string} [options.routes] - Routes directory path.
 * @param {string} [options.controllers] - Controllers directory path.
 * @param {string} [options.businessContext] - Business context.
 * @returns {Promise<{testCases: Array, savedFiles: string[]}>}
 */
async function generateFromMixed(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  initGroqClient();

  let endpoints = [];
  let controllerHints = [];

  // Parse swagger if provided
  if (opts.swagger) {
    logger.info('Parsing Swagger file...');
    const swaggerEndpoints = await parseSwaggerFile(opts.swagger);
    endpoints.push(...swaggerEndpoints);
    logger.success(`Found ${swaggerEndpoints.length} endpoints from Swagger`);
  }

  // Parse routes if provided
  if (opts.routes) {
    logger.info('Scanning route files...');
    const routes = await parseRouteDirectory(opts.routes);
    logger.success(`Found ${routes.length} routes`);

    // Convert routes to endpoint format, avoiding duplicates
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
          ) ? [{ bearerAuth: [] }] : null,
        });
      }
    }
  }

  // Parse controllers if provided
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

  const allTestCases = [];
  let idCounter = 1;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const label = `${ep.method} ${ep.path}`;

    // Find matching controller hint
    const hint = controllerHints.find(h => {
      if (!ep.operationId) return false;
      return h.functionName.toLowerCase() === ep.operationId.toLowerCase();
    });

    try {
      const { systemPrompt, userPrompt } = buildPrompt(ep, opts.businessContext, hint);
      const testCases = await generateTestCases(userPrompt, { systemPrompt });

      const withIds = assignIds(testCases, idCounter);
      idCounter += withIds.length;
      allTestCases.push(...withIds);
    } catch (err) {
      handleGenerationError(err, label);
    }
  }

  const savedFiles = await saveOutput(allTestCases, opts);
  return { testCases: allTestCases, savedFiles };
}

module.exports = {
  generateFromSwagger,
  generateFromSwaggerString,
  generateFromRoutes,
  generateFromMixed,
  filterEndpoints,
};
