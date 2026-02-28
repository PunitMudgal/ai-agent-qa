#!/usr/bin/env node

/**
 * @module cli
 * @description CLI interface for the QA Test Case Generator using Commander.js.
 */

require('dotenv').config();

const { Command } = require('commander');
const path = require('path');
const fs = require('fs-extra');
const logger = require('./utils/logger');
const { generateFromSwagger, generateFromRoutes, generateFromMixed } = require('./generators/testCaseGenerator');
const { parseSwaggerFile } = require('./parsers/swaggerParser');
const { scanDirectory, readJsonOrYaml } = require('./utils/fileUtils');
const { formatTestCases: formatJson } = require('./formatters/jsonFormatter');
const readline = require('readline');

const program = new Command();

program
  .name('qa-gen')
  .description('🤖 AI-powered QA Test Case Generator — Generate comprehensive test cases from Swagger/OpenAPI specs, Express routes, and controller logic.')
  .version('1.0.0');

// ──────────────────────────────────────────────
// Global options
// ──────────────────────────────────────────────
function addGlobalOptions(cmd) {
  return cmd
    .option('--format <type>', 'Output format: json, markdown, or both', 'json')
    .option('--output <dir>', 'Output directory', './output')
    .option('--verbose', 'Show detailed logs', false)
    .option('--no-color', 'Disable colored output')
    .option('--quiet', 'Suppress all output except errors', false)
    .option('--min-tests <number>', 'Minimum tests per endpoint', parseInt, 10)
    .option('--context <string>', 'Business requirements description')
    .option('--filter-tags <tags>', 'Comma-separated swagger tags to include')
    .option('--filter-paths <paths>', 'Comma-separated paths to include');
}

/**
 * Normalize global options into a standard options object.
 */
function normalizeOptions(opts) {
  logger.configure({
    verbose: opts.verbose,
    quiet: opts.quiet,
    noColor: opts.color === false,
  });

  return {
    format: opts.format || 'json',
    outputDir: opts.output || './output',
    businessContext: opts.context || '',
    filterTags: opts.filterTags ? opts.filterTags.split(',').map(t => t.trim()) : [],
    filterPaths: opts.filterPaths ? opts.filterPaths.split(',').map(p => p.trim()) : [],
    minTestsPerEndpoint: opts.minTests || 10,
    verbose: opts.verbose || false,
  };
}

/**
 * Print a summary table after generation.
 */
function printSummary(testCases, savedFiles, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Count by category
  const categories = {};
  const priorities = {};
  for (const tc of testCases) {
    categories[tc.category || 'unknown'] = (categories[tc.category || 'unknown'] || 0) + 1;
    priorities[tc.priority || 'medium'] = (priorities[tc.priority || 'medium'] || 0) + 1;
  }

  logger.newline();
  logger.header('📊 Generation Summary');
  logger.table([
    { label: 'Total Test Cases', value: testCases.length },
    { label: 'Time Elapsed', value: `${elapsed}s` },
    ...Object.entries(categories).map(([k, v]) => ({
      label: `  ${capitalize(k)}`,
      value: v,
    })),
  ]);

  if (savedFiles.length > 0) {
    logger.header('📁 Output Files');
    for (const f of savedFiles) {
      logger.success(path.resolve(f));
    }
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ──────────────────────────────────────────────
// COMMAND 1: swagger
// ──────────────────────────────────────────────
const swaggerCmd = program.command('swagger')
  .description('Generate test cases from a Swagger/OpenAPI file')
  .requiredOption('--input <path>', 'Path to swagger/openapi file (.json, .yaml, .yml)');
addGlobalOptions(swaggerCmd);

swaggerCmd.action(async (opts) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();

  try {
    logger.header('🤖 QA Test Case Generator — Swagger Mode');
    logger.keyValue('Input', path.resolve(opts.input));
    logger.keyValue('Format', options.format);
    logger.keyValue('Output', path.resolve(options.outputDir));
    logger.newline();

    const spinner = logger.startSpinner('Parsing and generating test cases...');
    const { testCases, savedFiles } = await generateFromSwagger(opts.input, options);
    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);

    printSummary(testCases, savedFiles, startTime);
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    logger.error(err.message);
    if (options.verbose) {
      console.error(err.stack);
    }
    process.exit(1);
  }
});

// ──────────────────────────────────────────────
// COMMAND 2: routes
// ──────────────────────────────────────────────
const routesCmd = program.command('routes')
  .description('Generate test cases from Express route and controller files')
  .requiredOption('--routes <dir>', 'Path to routes directory')
  .option('--controllers <dir>', 'Path to controllers directory');
addGlobalOptions(routesCmd);

routesCmd.action(async (opts) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();

  try {
    logger.header('🤖 QA Test Case Generator — Routes Mode');
    logger.keyValue('Routes Dir', path.resolve(opts.routes));
    if (opts.controllers) logger.keyValue('Controllers Dir', path.resolve(opts.controllers));
    logger.keyValue('Format', options.format);
    logger.newline();

    const spinner = logger.startSpinner('Scanning routes and generating...');
    const { testCases, savedFiles } = await generateFromRoutes(
      opts.routes,
      opts.controllers || null,
      options
    );
    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);

    printSummary(testCases, savedFiles, startTime);
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    logger.error(err.message);
    process.exit(1);
  }
});

// ──────────────────────────────────────────────
// COMMAND 3: generate (mixed)
// ──────────────────────────────────────────────
const generateCmd = program.command('generate')
  .description('Generate from all sources combined (most powerful)')
  .option('--swagger <path>', 'Path to swagger/openapi file')
  .option('--routes <dir>', 'Path to routes directory')
  .option('--controllers <dir>', 'Path to controllers directory');
addGlobalOptions(generateCmd);

generateCmd.action(async (opts) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();

  if (!opts.swagger && !opts.routes) {
    logger.error('At least --swagger or --routes must be provided');
    process.exit(1);
  }

  try {
    logger.header('🤖 QA Test Case Generator — Mixed Mode');
    if (opts.swagger) logger.keyValue('Swagger', path.resolve(opts.swagger));
    if (opts.routes) logger.keyValue('Routes', path.resolve(opts.routes));
    if (opts.controllers) logger.keyValue('Controllers', path.resolve(opts.controllers));
    logger.newline();

    const spinner = logger.startSpinner('Processing all sources...');
    const { testCases, savedFiles } = await generateFromMixed({
      ...options,
      swagger: opts.swagger,
      routes: opts.routes,
      controllers: opts.controllers,
    });
    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);

    printSummary(testCases, savedFiles, startTime);
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    logger.error(err.message);
    process.exit(1);
  }
});

// ──────────────────────────────────────────────
// COMMAND 4: scan
// ──────────────────────────────────────────────
const scanCmd = program.command('scan')
  .description('Auto-detect and scan project sources')
  .option('--project <dir>', 'Project root directory', './');
addGlobalOptions(scanCmd);

scanCmd.action(async (opts) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();
  const projectDir = path.resolve(opts.project || './');

  try {
    logger.header('🤖 QA Test Case Generator — Scan Mode');
    logger.keyValue('Project', projectDir);
    logger.newline();

    const spinner = logger.startSpinner('Scanning project structure...');

    // Auto-detect swagger files
    const swaggerFiles = await scanDirectory(projectDir, ['.json', '.yaml', '.yml']);
    const swaggerFile = swaggerFiles.find(f => {
      const base = path.basename(f).toLowerCase();
      return base.includes('swagger') || base.includes('openapi') || base.includes('api-doc');
    });

    // Auto-detect route directories
    const allJsFiles = await scanDirectory(projectDir, ['.js', '.ts']);
    const routeFiles = allJsFiles.filter(f => {
      const base = path.basename(f).toLowerCase();
      return base.includes('route') || base.includes('router');
    });
    const routeDir = routeFiles.length > 0 ? path.dirname(routeFiles[0]) : null;

    // Auto-detect controller directory
    const controllerFiles = allJsFiles.filter(f => {
      const base = path.basename(f).toLowerCase();
      return base.includes('controller') || base.includes('handler');
    });
    const controllerDir = controllerFiles.length > 0 ? path.dirname(controllerFiles[0]) : null;

    logger.stopSpinner(true, 'Project scan complete');

    if (swaggerFile) logger.success(`Found Swagger: ${swaggerFile}`);
    if (routeDir) logger.success(`Found Routes: ${routeDir} (${routeFiles.length} files)`);
    if (controllerDir) logger.success(`Found Controllers: ${controllerDir} (${controllerFiles.length} files)`);

    if (!swaggerFile && !routeDir) {
      logger.error('No API sources found in the project. Provide a swagger file or routes directory.');
      process.exit(1);
    }

    logger.newline();
    const genSpinner = logger.startSpinner('Generating test cases...');

    const { testCases, savedFiles } = await generateFromMixed({
      ...options,
      swagger: swaggerFile || undefined,
      routes: routeDir || undefined,
      controllers: controllerDir || undefined,
    });

    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);
    printSummary(testCases, savedFiles, startTime);
  } catch (err) {
    logger.stopSpinner(false, 'Scan failed');
    logger.error(err.message);
    process.exit(1);
  }
});

// ──────────────────────────────────────────────
// COMMAND 5: interactive
// ──────────────────────────────────────────────
const interactiveCmd = program.command('interactive')
  .description('Interactive mode — prompts for all options');

interactiveCmd.action(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    logger.header('🤖 QA Test Case Generator — Interactive Mode');
    console.log('Answer the prompts to configure generation.\n');

    const swaggerPath = await ask('Swagger/OpenAPI file path (leave empty to skip): ');
    const routesDir = await ask('Routes directory path (leave empty to skip): ');
    const controllersDir = await ask('Controllers directory path (leave empty to skip): ');
    const context = await ask('Business context/rules (leave empty to skip): ');
    const format = await ask('Output format (json/markdown/both) [json]: ') || 'json';
    const output = await ask('Output directory [./output]: ') || './output';
    const minTests = await ask('Min tests per endpoint [10]: ') || '10';

    rl.close();

    if (!swaggerPath && !routesDir) {
      logger.error('At least a swagger file or routes directory is required.');
      process.exit(1);
    }

    logger.configure({ verbose: false, quiet: false });
    const startTime = Date.now();
    const spinner = logger.startSpinner('Generating test cases...');

    const { testCases, savedFiles } = await generateFromMixed({
      format,
      outputDir: output,
      businessContext: context,
      minTestsPerEndpoint: parseInt(minTests),
      swagger: swaggerPath || undefined,
      routes: routesDir || undefined,
      controllers: controllersDir || undefined,
    });

    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);
    printSummary(testCases, savedFiles, startTime);
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    logger.error(err.message);
    process.exit(1);
  }
});

// ──────────────────────────────────────────────
// COMMAND 6: validate
// ──────────────────────────────────────────────
const validateCmd = program.command('validate')
  .description('Validate existing test cases JSON file')
  .requiredOption('--input <path>', 'Path to test cases JSON file');

validateCmd.action(async (opts) => {
  try {
    logger.header('🔍 Test Case Validator');

    const content = await fs.readFile(path.resolve(opts.input), 'utf-8');
    const data = JSON.parse(content);

    const testCases = data.testCases || data;
    const cases = Array.isArray(testCases) ? testCases : [];

    const requiredFields = ['id', 'endpoint', 'method', 'scenario', 'category', 'priority', 'inputData', 'expectedOutput', 'status'];
    let valid = 0;
    let invalid = 0;
    const issues = [];

    for (const tc of cases) {
      const missing = requiredFields.filter(f => tc[f] === undefined);
      if (missing.length > 0) {
        invalid++;
        issues.push(`${tc.id || '(no id)'}: missing fields: ${missing.join(', ')}`);
      } else {
        valid++;
      }
    }

    logger.table([
      { label: 'Total test cases', value: cases.length },
      { label: 'Valid', value: valid },
      { label: 'Invalid', value: invalid },
    ]);

    if (issues.length > 0) {
      logger.warn('Issues found:');
      issues.slice(0, 20).forEach(i => logger.warn(`  ${i}`));
      if (issues.length > 20) logger.warn(`  ...and ${issues.length - 20} more`);
    } else {
      logger.success('All test cases are valid! ✅');
    }
  } catch (err) {
    logger.error(`Validation failed: ${err.message}`);
    process.exit(1);
  }
});

// ──────────────────────────────────────────────
// COMMAND 7: stats
// ──────────────────────────────────────────────
const statsCmd = program.command('stats')
  .description('Show summary/stats of generated test cases')
  .requiredOption('--input <path>', 'Path to test cases JSON file');

statsCmd.action(async (opts) => {
  try {
    logger.header('📊 Test Case Statistics');

    const content = await fs.readFile(path.resolve(opts.input), 'utf-8');
    const data = JSON.parse(content);

    const testCases = data.testCases || data;
    const cases = Array.isArray(testCases) ? testCases : [];

    const byCategory = {};
    const byPriority = {};
    const byEndpoint = {};
    const byStatus = {};

    for (const tc of cases) {
      byCategory[tc.category || 'unknown'] = (byCategory[tc.category || 'unknown'] || 0) + 1;
      byPriority[tc.priority || 'medium'] = (byPriority[tc.priority || 'medium'] || 0) + 1;
      byEndpoint[tc.endpoint || 'unknown'] = (byEndpoint[tc.endpoint || 'unknown'] || 0) + 1;
      byStatus[tc.status || 'Pending'] = (byStatus[tc.status || 'Pending'] || 0) + 1;
    }

    logger.table([
      { label: 'Total Test Cases', value: cases.length },
      { label: '', value: '' },
      { label: '── By Category ──', value: '' },
      ...Object.entries(byCategory).sort().map(([k, v]) => ({ label: `  ${capitalize(k)}`, value: v })),
      { label: '', value: '' },
      { label: '── By Priority ──', value: '' },
      ...Object.entries(byPriority).sort().map(([k, v]) => ({ label: `  ${capitalize(k)}`, value: v })),
      { label: '', value: '' },
      { label: '── By Endpoint ──', value: '' },
      ...Object.entries(byEndpoint).sort().map(([k, v]) => ({ label: `  ${k}`, value: v })),
      { label: '', value: '' },
      { label: '── By Status ──', value: '' },
      ...Object.entries(byStatus).sort().map(([k, v]) => ({ label: `  ${k}`, value: v })),
    ]);

    if (data.metadata) {
      logger.keyValue('Generated At', data.metadata.generatedAt);
      logger.keyValue('Generator', data.metadata.generator);
    }
  } catch (err) {
    logger.error(`Stats failed: ${err.message}`);
    process.exit(1);
  }
});

// Parse and run
program.parse(process.argv);

// Show help if no command provided
if (process.argv.length <= 2) {
  program.help();
}
