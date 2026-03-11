#!/usr/bin/env node

/**
 * @module cli
 * @description CLI interface for the QA Test Case Generator using Commander.js.
 */

import 'dotenv/config';
import { Command } from 'commander';
import path from 'path';
import fs from 'fs-extra';
import readline from 'readline';
import * as logger from './utils/logger';
import {
  createAndSaveCoverageResult,
  loadExecutionReportFromFile,
  loadGeneratedBundleFromFile,
} from './coverage';
import { generateFromSwagger, generateFromRoutes, generateFromMixed } from './generators/testCaseGenerator';
import { executeTestCases } from './runner';
import { scanDirectory } from './utils/fileUtils';
import type {
  CoverageBasis,
  CoverageResult,
  ExecutionReport,
  ExecutionResult,
  GenerationOptions,
  ParseWarning,
  RunnerConfig,
  TestCase,
} from './types';

const program = new Command();

program
  .name('ai-agent-qa')
  .description(
    '🤖 AI-powered QA Test Case Generator — Generate comprehensive test cases from Swagger/OpenAPI specs, Express routes, and controller logic.'
  )
  .version('1.0.0');

interface GlobalOpts {
  format?: string;
  output?: string;
  verbose?: boolean;
  color?: boolean;
  quiet?: boolean;
  minTests?: number;
  context?: string;
  filterTags?: string;
  filterPaths?: string;
  jest?: boolean;
  jestDir?: string;
  baseUrl?: string;
  basePath?: string;
  strictAssertions?: boolean;
  run?: boolean;
  runMode?: string;
  runBaseUrl?: string;
  appModule?: string;
  runnerHooks?: string;
  allowMutations?: boolean;
  reportDir?: string;
  timeoutMs?: number;
}

function addRunnerOptions(cmd: Command, includeRunFlag = true): Command {
  if (includeRunFlag) {
    cmd.option('--run', 'Execute generated test cases after generation', false);
  }

  return cmd
    .option(
      '--run-mode <mode>',
      'Execution mode when running tests: base-url or app-import',
      'base-url'
    )
    .option(
      '--run-base-url <url>',
      'Base URL for executable runner (default: http://localhost:3000)',
      'http://localhost:3000'
    )
    .option('--app-module <path>', 'Path to the local app/server module for app-import mode')
    .option('--runner-hooks <path>', 'Optional JS/TS runner hook file')
    .option('--allow-mutations', 'Execute mutating endpoints (POST/PUT/PATCH/DELETE)', false)
    .option('--report-dir <path>', 'Directory for execution reports (default: <output>/reports)')
    .option(
      '--timeout-ms <number>',
      'Timeout per executable test in milliseconds',
      (v: string) => parseInt(v, 10),
      10000
    );
}

function addGlobalOptions(cmd: Command): Command {
  addRunnerOptions(cmd);
  return cmd
    .option('--format <type>', 'Output format: json, markdown, or both', 'json')
    .option('--output <dir>', 'Output directory', './output')
    .option('--verbose', 'Show detailed logs', false)
    .option('--no-color', 'Disable colored output')
    .option('--quiet', 'Suppress all output except errors', false)
    .option('--min-tests <number>', 'Minimum tests per endpoint', (v: string) => parseInt(v, 10), 10)
    .option('--context <string>', 'Business requirements description')
    .option('--filter-tags <tags>', 'Comma-separated swagger tags to include')
    .option('--filter-paths <paths>', 'Comma-separated paths to include')
    .option('--jest', 'Also generate Jest + Supertest test files', false)
    .option('--jest-dir <path>', 'Directory for Jest test files (default: <output>/jest)')
    .option('--base-url <url>', 'Base URL for API under test (default: http://localhost:3000)', 'http://localhost:3000')
    .option('--base-path <path>', 'Base path for routes (e.g. /api/v1 when app mounts under that)')
    .option('--strict-assertions', 'Use strict body assertions in Jest tests (default: status-only)', false);
}

function addExecutionCommandOptions(cmd: Command): Command {
  addRunnerOptions(cmd, false);
  return cmd
    .option('--output <dir>', 'Output directory for execution reports', './output')
    .option('--verbose', 'Show detailed logs', false)
    .option('--no-color', 'Disable colored output')
    .option('--quiet', 'Suppress all output except errors', false)
    .option(
      '--strict-assertions',
      'Use strict body assertions during execution (default: status-only)',
      false
    );
}

interface NormalizedOptions extends GenerationOptions {
  verbose: boolean;
}

function configureLogger(opts: Pick<GlobalOpts, 'verbose' | 'quiet' | 'color'>): void {
  logger.configure({
    verbose: opts.verbose ?? false,
    quiet: opts.quiet ?? false,
    noColor: opts.color === false,
  });
}

function normalizeOptions(opts: GlobalOpts): NormalizedOptions {
  configureLogger(opts);

  const outputDir = opts.output ?? './output';
  return {
    format: (opts.format ?? 'json') as 'json' | 'markdown' | 'both',
    outputDir,
    businessContext: opts.context ?? '',
    filterTags: opts.filterTags ? opts.filterTags.split(',').map(t => t.trim()) : [],
    filterPaths: opts.filterPaths ? opts.filterPaths.split(',').map(p => p.trim()) : [],
    minTestsPerEndpoint: opts.minTests ?? 10,
    verbose: opts.verbose ?? false,
    outputJest: opts.jest ?? false,
    jestOutputDir: opts.jestDir ?? path.join(outputDir, 'jest'),
    jestBaseUrl: opts.baseUrl ?? 'http://localhost:3000',
    jestBasePath: opts.basePath?.trim() || undefined,
    jestExploratoryAssertions: opts.strictAssertions ? false : true,
  };
}

function buildRunnerConfig(opts: GlobalOpts, outputDir: string): Partial<RunnerConfig> {
  return {
    mode: (opts.runMode === 'app-import' ? 'app-import' : 'base-url'),
    baseUrl: opts.runBaseUrl ?? 'http://localhost:3000',
    appModulePath: opts.appModule?.trim() || undefined,
    hooksPath: opts.runnerHooks?.trim() || undefined,
    allowMutations: opts.allowMutations ?? false,
    reportDir: opts.reportDir?.trim() || path.join(outputDir, 'reports'),
    timeoutMs: opts.timeoutMs ?? 10000,
    strictAssertions: opts.strictAssertions ?? false,
  };
}

function printSummary(
  testCases: TestCase[],
  savedFiles: string[],
  startTime: number
): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const categories: Record<string, number> = {};
  const priorities: Record<string, number> = {};
  for (const tc of testCases) {
    const cat = tc.category ?? 'unknown';
    categories[cat] = (categories[cat] ?? 0) + 1;
    const pri = tc.priority ?? 'medium';
    priorities[pri] = (priorities[pri] ?? 0) + 1;
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
    const jestFiles = savedFiles.filter(f => f.endsWith('.test.ts'));
    const otherFiles = savedFiles.filter(f => !f.endsWith('.test.ts'));
    for (const f of otherFiles) {
      logger.success(path.resolve(f));
    }
    if (jestFiles.length > 0) {
      logger.info(`Jest tests (${jestFiles.length} file(s)):`);
      for (const f of jestFiles) {
        logger.success(path.resolve(f));
      }
    }
  }
}

function printExecutionSummary(result: ExecutionResult): void {
  logger.newline();
  logger.header('🧪 Execution Summary');
  logger.table([
    { label: 'Mode', value: result.report.metadata.mode },
    { label: 'Source', value: result.report.metadata.source },
    { label: 'Executed', value: result.report.summary.executed },
    { label: 'Passed', value: result.report.summary.passed },
    { label: 'Failed', value: result.report.summary.failed },
    { label: 'Skipped', value: result.report.summary.skipped },
    { label: 'Warnings', value: result.report.summary.warnings },
    { label: 'Duration', value: `${result.report.metadata.durationMs}ms` },
  ]);

  if (result.savedFiles.length > 0) {
    logger.header('📄 Execution Reports');
    for (const file of result.savedFiles) {
      logger.success(path.resolve(file));
    }
  }
}

function printCoverageSummary(result: CoverageResult): void {
  logger.newline();
  logger.header('📈 Coverage Summary');
  logger.table([
    { label: 'In Scope', value: result.report.summary.inScopeTotal },
    { label: 'Covered Endpoints', value: result.report.summary.coveredEndpoints },
    {
      label: 'Endpoint Coverage',
      value: `${result.report.summary.endpointCoveragePct}%`,
    },
    { label: 'Design Score', value: result.report.summary.designScore },
    {
      label: 'Runtime Score',
      value:
        result.report.summary.runtimeScore == null
          ? 'Pending'
          : result.report.summary.runtimeScore,
    },
    { label: 'Overall Score', value: result.report.summary.overallScore },
    {
      label: 'Mutation-Gated',
      value: result.report.summary.mutationGatedEndpoints,
    },
    {
      label: 'Warnings',
      value: result.report.summary.warnings,
    },
  ]);

  if (result.savedFiles.length > 0) {
    logger.header('📄 Coverage Reports');
    for (const file of result.savedFiles) {
      logger.success(path.resolve(file));
    }
  }
}

async function saveCoverage(
  source: string,
  outputDir: string,
  coverageBasis: CoverageBasis,
  testCases: TestCase[],
  warnings: ParseWarning[] = [],
  executionReport?: ExecutionReport,
  reportDirOverride?: string
): Promise<CoverageResult> {
  return createAndSaveCoverageResult({
    source,
    reportDir: reportDirOverride ?? path.join(outputDir, 'reports'),
    coverageBasis,
    testCases,
    warnings,
    executionReport,
  });
}

async function runExecutionIfRequested(
  opts: GlobalOpts,
  testCases: TestCase[],
  outputDir: string,
  source: string,
  coverageBasis: CoverageBasis,
  warnings: ParseWarning[] = []
): Promise<number> {
  if (!opts.run) {
    return 0;
  }

  if (testCases.length === 0) {
    logger.warn('Skipping executable run because generation produced 0 test cases.');
    return 0;
  }

  logger.startSpinner('Executing generated test cases...');
  const runnerConfig = buildRunnerConfig(opts, outputDir);
  const executionResult = await executeTestCases({
    testCases,
    runnerConfig,
    outputDir,
    source,
    warnings,
  });
  logger.stopSpinner(
    executionResult.exitCode === 0,
    executionResult.exitCode === 0
      ? 'Executable test run completed'
      : 'Executable test run completed with failures'
  );
  printExecutionSummary(executionResult);
  const coverageResult = await saveCoverage(
    source,
    outputDir,
    coverageBasis,
    testCases,
    warnings,
    executionResult.report,
    runnerConfig.reportDir
  );
  printCoverageSummary(coverageResult);
  return executionResult.exitCode;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

const swaggerCmd = program
  .command('swagger')
  .description('Generate test cases from a Swagger/OpenAPI file')
  .requiredOption('--input <path>', 'Path to swagger/openapi file (.json, .yaml, .yml)');
addGlobalOptions(swaggerCmd);

swaggerCmd.action(async (opts: GlobalOpts & { input: string }) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();

  try {
    logger.header('🤖 QA Test Case Generator — Swagger Mode');
    logger.keyValue('Input', path.resolve(opts.input));
    logger.keyValue('Format', options.format);
    logger.keyValue('Output', path.resolve(options.outputDir));
    logger.newline();

    logger.startSpinner('Parsing and generating test cases...');
    const { testCases, savedFiles, warnings, coverageBasis } = await generateFromSwagger(
      opts.input,
      options
    );
    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);

    printSummary(testCases, savedFiles, startTime);
    const coverageResult = await saveCoverage(
      `swagger:${path.basename(opts.input)}`,
      options.outputDir,
      coverageBasis,
      testCases,
      warnings,
      undefined,
      buildRunnerConfig(opts, options.outputDir).reportDir
    );
    printCoverageSummary(coverageResult);
    const exitCode = await runExecutionIfRequested(
      opts,
      testCases,
      options.outputDir,
      `swagger:${path.basename(opts.input)}`,
      coverageBasis,
      warnings
    );
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    if (options.verbose) {
      console.error(err instanceof Error ? err.stack : err);
    }
    process.exit(1);
  }
});

const routesCmd = program
  .command('routes')
  .description('Generate test cases from Express route and controller files')
  .requiredOption('--routes <dir>', 'Path to routes directory')
  .option('--controllers <dir>', 'Path to controllers directory');
addGlobalOptions(routesCmd);

routesCmd.action(async (opts: GlobalOpts & { routes: string; controllers?: string }) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();

  try {
    logger.header('🤖 QA Test Case Generator — Routes Mode');
    logger.keyValue('Routes Dir', path.resolve(opts.routes));
    if (opts.controllers) logger.keyValue('Controllers Dir', path.resolve(opts.controllers));
    logger.keyValue('Format', options.format);
    logger.newline();

    logger.startSpinner('Scanning routes and generating...');
    const { testCases, savedFiles, warnings, coverageBasis } = await generateFromRoutes(
      opts.routes,
      opts.controllers ?? null,
      options
    );
    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);

    printSummary(testCases, savedFiles, startTime);
    const coverageResult = await saveCoverage(
      `routes:${path.basename(opts.routes)}`,
      options.outputDir,
      coverageBasis,
      testCases,
      warnings,
      undefined,
      buildRunnerConfig(opts, options.outputDir).reportDir
    );
    printCoverageSummary(coverageResult);
    const exitCode = await runExecutionIfRequested(
      opts,
      testCases,
      options.outputDir,
      `routes:${path.basename(opts.routes)}`,
      coverageBasis,
      warnings
    );
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  }
});

const generateCmd = program
  .command('generate')
  .description('Generate from all sources combined (most powerful)')
  .option('--swagger <path>', 'Path to swagger/openapi file')
  .option('--routes <dir>', 'Path to routes directory')
  .option('--controllers <dir>', 'Path to controllers directory');
addGlobalOptions(generateCmd);

generateCmd.action(
  async (opts: GlobalOpts & { swagger?: string; routes?: string; controllers?: string }) => {
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

      logger.startSpinner('Processing all sources...');
      const { testCases, savedFiles, warnings, coverageBasis } = await generateFromMixed({
        ...options,
        swagger: opts.swagger,
        routes: opts.routes,
        controllers: opts.controllers,
      });
      logger.stopSpinner(true, `Generated ${testCases.length} test cases`);

      printSummary(testCases, savedFiles, startTime);
      const sourceLabel =
        opts.swagger && opts.routes
          ? `mixed:${path.basename(opts.swagger)}+${path.basename(opts.routes)}`
          : opts.swagger
            ? `swagger:${path.basename(opts.swagger)}`
            : `routes:${path.basename(opts.routes!)}`
;
      const coverageResult = await saveCoverage(
        sourceLabel,
        options.outputDir,
        coverageBasis,
        testCases,
        warnings,
        undefined,
        buildRunnerConfig(opts, options.outputDir).reportDir
      );
      printCoverageSummary(coverageResult);
      const exitCode = await runExecutionIfRequested(
        opts,
        testCases,
        options.outputDir,
        sourceLabel,
        coverageBasis,
        warnings
      );
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    } catch (err) {
      logger.stopSpinner(false, 'Generation failed');
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      process.exit(1);
    }
  }
);

const scanCmd = program
  .command('scan')
  .description('Auto-detect and scan project sources')
  .option('--project <dir>', 'Project root directory', './');
addGlobalOptions(scanCmd);

scanCmd.action(async (opts: GlobalOpts & { project?: string }) => {
  const options = normalizeOptions(opts);
  const startTime = Date.now();
  const projectDir = path.resolve(opts.project ?? './');

  try {
    logger.header('🤖 QA Test Case Generator — Scan Mode');
    logger.keyValue('Project', projectDir);
    logger.newline();

    logger.startSpinner('Scanning project structure...');

    const swaggerFiles = await scanDirectory(projectDir, ['.json', '.yaml', '.yml']);
    const swaggerFile = swaggerFiles.find(f => {
      const base = path.basename(f).toLowerCase();
      return (
        base.includes('swagger') || base.includes('openapi') || base.includes('api-doc')
      );
    });

    const allJsFiles = await scanDirectory(projectDir, ['.js', '.ts']);
    const routeFiles = allJsFiles.filter(f => {
      const base = path.basename(f).toLowerCase();
      return base.includes('route') || base.includes('router');
    });
    const routeDir = routeFiles.length > 0 ? path.dirname(routeFiles[0]) : null;

    const controllerFiles = allJsFiles.filter(f => {
      const base = path.basename(f).toLowerCase();
      return (
        base.includes('controller') || base.includes('handler')
      );
    });
    const controllerDir =
      controllerFiles.length > 0 ? path.dirname(controllerFiles[0]) : null;

    logger.stopSpinner(true, 'Project scan complete');

    if (swaggerFile) logger.success(`Found Swagger: ${swaggerFile}`);
    if (routeDir) logger.success(`Found Routes: ${routeDir} (${routeFiles.length} files)`);
    if (controllerDir)
      logger.success(`Found Controllers: ${controllerDir} (${controllerFiles.length} files)`);

    if (!swaggerFile && !routeDir) {
      logger.error(
        'No API sources found in the project. Provide a swagger file or routes directory.'
      );
      process.exit(1);
    }

    logger.newline();
    logger.startSpinner('Generating test cases...');

    const { testCases, savedFiles, warnings, coverageBasis } = await generateFromMixed({
      ...options,
      swagger: swaggerFile ?? undefined,
      routes: routeDir ?? undefined,
      controllers: controllerDir ?? undefined,
    });

    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);
    printSummary(testCases, savedFiles, startTime);
    const coverageResult = await saveCoverage(
      `scan:${path.basename(projectDir)}`,
      options.outputDir,
      coverageBasis,
      testCases,
      warnings,
      undefined,
      buildRunnerConfig(opts, options.outputDir).reportDir
    );
    printCoverageSummary(coverageResult);
    const exitCode = await runExecutionIfRequested(
      opts,
      testCases,
      options.outputDir,
      `scan:${path.basename(projectDir)}`,
      coverageBasis,
      warnings
    );
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    logger.stopSpinner(false, 'Scan failed');
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  }
});

const interactiveCmd = program
  .command('interactive')
  .description('Interactive mode — prompts for all options');

interactiveCmd.action(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    logger.header('🤖 QA Test Case Generator — Interactive Mode');
    console.log('Answer the prompts to configure generation.\n');

    const swaggerPath = (await ask('Swagger/OpenAPI file path (leave empty to skip): ')).trim();
    const routesDir = (await ask('Routes directory path (leave empty to skip): ')).trim();
    const controllersDir = (await ask('Controllers directory path (leave empty to skip): ')).trim();
    const context = await ask('Business context/rules (leave empty to skip): ');
    const format = (await ask('Output format (json/markdown/both) [json]: ')) || 'json';
    const output = (await ask('Output directory [./output]: ')) || './output';
    const minTestsStr = (await ask('Min tests per endpoint [10]: ')) || '10';

    rl.close();

    if (!swaggerPath && !routesDir) {
      logger.error('At least a swagger file or routes directory is required.');
      process.exit(1);
    }

    logger.configure({ verbose: false, quiet: false });
    const startTime = Date.now();
    logger.startSpinner('Generating test cases...');

    const { testCases, savedFiles, warnings, coverageBasis } = await generateFromMixed({
      format: format as 'json' | 'markdown' | 'both',
      outputDir: output,
      businessContext: context,
      minTestsPerEndpoint: parseInt(minTestsStr, 10) || 10,
      swagger: swaggerPath || undefined,
      routes: routesDir || undefined,
      controllers: controllersDir || undefined,
    });

    logger.stopSpinner(true, `Generated ${testCases.length} test cases`);
    printSummary(testCases, savedFiles, startTime);
    const coverageResult = await saveCoverage(
      'interactive',
      output,
      coverageBasis,
      testCases,
      warnings
    );
    printCoverageSummary(coverageResult);
  } catch (err) {
    logger.stopSpinner(false, 'Generation failed');
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  }
});

const runCmd = program
  .command('run')
  .description('Execute generated test cases from an existing JSON file')
  .requiredOption('--input <path>', 'Path to generated test cases JSON file');
addExecutionCommandOptions(runCmd);

runCmd.action(async (opts: GlobalOpts & { input: string }) => {
  configureLogger(opts);
  const outputDir = opts.output ?? './output';

  try {
    logger.header('🧪 QA Test Case Runner');
    logger.keyValue('Input', path.resolve(opts.input));
    logger.keyValue('Mode', opts.runMode === 'app-import' ? 'app-import' : 'base-url');
    logger.keyValue('Output', path.resolve(outputDir));
    logger.newline();

    logger.startSpinner('Loading test cases...');
    const bundle = await loadGeneratedBundleFromFile(path.resolve(opts.input));
    const testCases = bundle.testCases;
    logger.stopSpinner(true, `Loaded ${testCases.length} test cases`);

    logger.startSpinner('Executing test cases...');
    const runnerConfig = buildRunnerConfig(opts, outputDir);
    const executionResult = await executeTestCases({
      testCases,
      runnerConfig,
      outputDir,
      source: `file:${path.basename(opts.input)}`,
      warnings: bundle.warnings,
    });
    logger.stopSpinner(
      executionResult.exitCode === 0,
      executionResult.exitCode === 0
        ? 'Executable test run completed'
        : 'Executable test run completed with failures'
    );
    printExecutionSummary(executionResult);
    const coverageResult = await saveCoverage(
      `file:${path.basename(opts.input)}`,
      outputDir,
      bundle.coverageBasis,
      testCases,
      bundle.warnings,
      executionResult.report,
      runnerConfig.reportDir
    );
    printCoverageSummary(coverageResult);

    if (executionResult.exitCode !== 0) {
      process.exit(executionResult.exitCode);
    }
  } catch (err) {
    logger.stopSpinner(false, 'Execution failed');
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  }
});

const validateCmd = program
  .command('validate')
  .description('Validate existing test cases JSON file')
  .requiredOption('--input <path>', 'Path to test cases JSON file');

validateCmd.action(async (opts: { input: string }) => {
  try {
    logger.header('🔍 Test Case Validator');

    const content = await fs.readFile(path.resolve(opts.input), 'utf-8');
    const data = JSON.parse(content) as { testCases?: unknown; metadata?: { generatedAt?: string; generator?: string } };

    const testCases = data.testCases ?? data;
    const cases = Array.isArray(testCases) ? testCases : [];

    const requiredFields = [
      'id',
      'endpoint',
      'method',
      'scenario',
      'category',
      'priority',
      'inputData',
      'expectedOutput',
      'status',
    ];
    let valid = 0;
    let invalid = 0;
    const issues: string[] = [];

    for (const tc of cases) {
      const rec = tc as Record<string, unknown>;
      const missing = requiredFields.filter(f => rec[f] === undefined);
      if (missing.length > 0) {
        invalid++;
        issues.push(`${rec.id ?? '(no id)'}: missing fields: ${missing.join(', ')}`);
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
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Validation failed: ${message}`);
    process.exit(1);
  }
});

const coverageCmd = program
  .command('coverage')
  .description('Build a coverage dashboard report from generated test cases JSON')
  .requiredOption('--input <path>', 'Path to generated test cases JSON file')
  .option('--execution-report <path>', 'Optional execution report JSON to overlay runtime coverage')
  .option('--output <dir>', 'Output directory for coverage reports', './output')
  .option('--report-dir <path>', 'Directory for coverage reports (default: <output>/reports)')
  .option('--verbose', 'Show detailed logs', false)
  .option('--no-color', 'Disable colored output')
  .option('--quiet', 'Suppress all output except errors', false);

coverageCmd.action(
  async (opts: {
    input: string;
    executionReport?: string;
    output?: string;
    reportDir?: string;
    verbose?: boolean;
    color?: boolean;
    quiet?: boolean;
  }) => {
    configureLogger(opts);
    const outputDir = opts.output ?? './output';

    try {
      logger.header('📈 QA Coverage Dashboard');
      logger.keyValue('Input', path.resolve(opts.input));
      if (opts.executionReport) {
        logger.keyValue('Execution Report', path.resolve(opts.executionReport));
      }
      logger.keyValue('Output', path.resolve(outputDir));
      logger.newline();

      logger.startSpinner('Loading generated bundle...');
      const bundle = await loadGeneratedBundleFromFile(path.resolve(opts.input));
      const executionReport = opts.executionReport
        ? await loadExecutionReportFromFile(path.resolve(opts.executionReport))
        : undefined;
      logger.stopSpinner(true, 'Coverage inputs loaded');

      logger.startSpinner('Building coverage dashboard...');
      const coverageResult = await saveCoverage(
        `coverage:${path.basename(opts.input)}`,
        outputDir,
        bundle.coverageBasis,
        bundle.testCases,
        bundle.warnings,
        executionReport,
        opts.reportDir?.trim() || path.join(outputDir, 'reports')
      );
      logger.stopSpinner(true, 'Coverage dashboard saved');
      printCoverageSummary(coverageResult);
    } catch (err) {
      logger.stopSpinner(false, 'Coverage build failed');
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      process.exit(1);
    }
  }
);

const statsCmd = program
  .command('stats')
  .description('Show summary/stats of generated test cases')
  .requiredOption('--input <path>', 'Path to test cases JSON file');

statsCmd.action(async (opts: { input: string }) => {
  try {
    logger.header('📊 Test Case Statistics');

    const content = await fs.readFile(path.resolve(opts.input), 'utf-8');
    const data = JSON.parse(content) as {
      testCases?: unknown;
      metadata?: { generatedAt?: string; generator?: string };
    };

    const testCases = data.testCases ?? data;
    const cases = Array.isArray(testCases) ? testCases : [];

    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const byEndpoint: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const tc of cases) {
      const rec = tc as Record<string, unknown>;
      const cat = (rec.category as string) ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const pri = (rec.priority as string) ?? 'medium';
      byPriority[pri] = (byPriority[pri] ?? 0) + 1;
      const ep = (rec.endpoint as string) ?? 'unknown';
      byEndpoint[ep] = (byEndpoint[ep] ?? 0) + 1;
      const st = (rec.status as string) ?? 'Pending';
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }

    logger.table([
      { label: 'Total Test Cases', value: cases.length },
      { label: '', value: '' },
      { label: '── By Category ──', value: '' },
      ...Object.entries(byCategory)
        .sort()
        .map(([k, v]) => ({ label: `  ${capitalize(k)}`, value: v })),
      { label: '', value: '' },
      { label: '── By Priority ──', value: '' },
      ...Object.entries(byPriority)
        .sort()
        .map(([k, v]) => ({ label: `  ${capitalize(k)}`, value: v })),
      { label: '', value: '' },
      { label: '── By Endpoint ──', value: '' },
      ...Object.entries(byEndpoint)
        .sort()
        .map(([k, v]) => ({ label: `  ${k}`, value: v })),
      { label: '', value: '' },
      { label: '── By Status ──', value: '' },
      ...Object.entries(byStatus)
        .sort()
        .map(([k, v]) => ({ label: `  ${k}`, value: v })),
    ]);

    if (data.metadata) {
      if (data.metadata.generatedAt)
        logger.keyValue('Generated At', data.metadata.generatedAt);
      if (data.metadata.generator)
        logger.keyValue('Generator', data.metadata.generator);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Stats failed: ${message}`);
    process.exit(1);
  }
});

program.parse(process.argv);

if (process.argv.length <= 2) {
  program.help();
}
