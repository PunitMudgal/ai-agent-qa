/**
 * @module server
 * @description Express server for the QA Test Generator web UI.
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import * as logger from './utils/logger';
import {
  createAndSaveCoverageResult,
  createGeneratedOnlyCoverageBasis,
  loadGeneratedBundleFromFile,
} from './coverage';
import { generateFromSwaggerString, generateFromRoutes, generateFromMixed } from './generators/testCaseGenerator';
import { executeTestCases } from './runner';
import { parseSwaggerString } from './parsers/swaggerParser';
import { listFiles } from './utils/fileUtils';
import { formatTestCases as formatJson } from './formatters/jsonFormatter';
import { formatTestCases as formatMd } from './formatters/markdownFormatter';
import type {
  CoverageBasis,
  GenerateRequestBody,
  ParseWarning,
  RunRequestBody,
  RunnerConfig,
} from './types';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const outputDir = path.resolve(process.env.DEFAULT_OUTPUT_DIR ?? './output');
fs.ensureDirSync(outputDir);
app.use('/output', express.static(outputDir));

function buildRunnerConfigFromBody(
  body: GenerateRequestBody | RunRequestBody,
  fallbackOutputDir: string
): Partial<RunnerConfig> {
  return {
    mode: body.runnerMode === 'app-import' ? 'app-import' : 'base-url',
    baseUrl: body.runBaseUrl ? String(body.runBaseUrl).trim() : 'http://localhost:3000',
    appModulePath: body.appModulePath ? path.resolve(String(body.appModulePath).trim()) : undefined,
    hooksPath: body.runnerHooksPath ? path.resolve(String(body.runnerHooksPath).trim()) : undefined,
    allowMutations: !!body.allowMutations,
    reportDir: body.reportDir
      ? path.resolve(String(body.reportDir).trim())
      : path.join(fallbackOutputDir, 'reports'),
    timeoutMs: body.timeoutMs ? parseInt(String(body.timeoutMs), 10) || 10000 : 10000,
    strictAssertions:
      'strictAssertions' in body
        ? !!body.strictAssertions
        : false,
  };
}

function relativeToOutput(filePath: string): string {
  return path.relative(outputDir, path.resolve(filePath));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.json', '.yaml', '.yml'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .json, .yaml, and .yml files are allowed'));
    }
  },
});

app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

app.get('/health', (req: Request, res: Response) => {
  const groqOk =
    !!process.env.GROQ_API_KEY &&
    process.env.GROQ_API_KEY !== 'your_groq_api_key_here';
  const geminiOk =
    !!process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    apiKeyConfigured: groqOk || geminiOk,
    groqConfigured: groqOk,
    geminiConfigured: geminiOk,
  });
});

app.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const content = req.file.buffer.toString('utf-8');
    const endpoints = await parseSwaggerString(content);

    res.json({
      success: true,
      filename: req.file.originalname,
      endpointCount: endpoints.length,
      endpoints: endpoints.map(ep => ({
        method: ep.method,
        path: ep.path,
        summary: ep.summary,
        tags: ep.tags,
      })),
      content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: `Failed to parse file: ${message}` });
  }
});

app.post('/generate', async (req: Request, res: Response) => {
  try {
    const body = req.body as GenerateRequestBody;
    const {
      swaggerContent,
      routesPath,
      controllersPath,
      businessContext = '',
      format = 'json',
      filterTags = [],
      filterPaths = [],
      minTests = 10,
      outputJest = false,
      jestDir,
      jestBaseUrl = 'http://localhost:3000',
      jestBasePath,
      jestExploratoryAssertions,
      runAfterGenerate = false,
    } = body;

    if (!swaggerContent && !routesPath) {
      return res.status(400).json({
        error:
          'Provide either Swagger (upload/paste) or a Routes directory path (or both).',
      });
    }

    const groqOk =
      !!process.env.GROQ_API_KEY &&
      process.env.GROQ_API_KEY !== 'your_groq_api_key_here';
    const geminiOk =
      !!process.env.GEMINI_API_KEY &&
      process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';
    if (!groqOk && !geminiOk) {
      return res.status(400).json({
        error:
          'No AI API key configured. Add GROQ_API_KEY and/or GEMINI_API_KEY to your .env file. ' +
          'Get Groq at console.groq.com, Gemini at aistudio.google.com/apikey',
      });
    }

    const filterTagsArr = Array.isArray(filterTags)
      ? filterTags
      : (typeof filterTags === 'string' ? filterTags : '')
          .split(',')
          .filter(Boolean);
    const filterPathsArr = Array.isArray(filterPaths)
      ? filterPaths
      : (typeof filterPaths === 'string' ? filterPaths : '')
          .split(',')
          .filter(Boolean);

    const options = {
      format: format as 'json' | 'markdown' | 'both',
      outputDir,
      businessContext,
      filterTags: filterTagsArr,
      filterPaths: filterPathsArr,
      minTestsPerEndpoint: parseInt(String(minTests), 10) || 10,
      outputJest: !!outputJest,
      jestOutputDir: jestDir ? path.resolve(String(jestDir).trim()) : path.join(outputDir, 'jest'),
      jestBaseUrl: String(jestBaseUrl || 'http://localhost:3000').trim(),
      jestBasePath: jestBasePath ? String(jestBasePath).trim() : undefined,
      jestExploratoryAssertions: jestExploratoryAssertions === false ? false : true,
    };
    const runnerConfig = buildRunnerConfigFromBody(body, outputDir);

    let testCases: import('./types').TestCase[];
    let savedFiles: string[];
    let warnings: ParseWarning[];
    let coverageBasis: CoverageBasis;
    const resolvedRoutesPath = routesPath
      ? path.resolve(String(routesPath).trim())
      : null;
    const resolvedControllersPath = controllersPath
      ? path.resolve(String(controllersPath).trim())
      : null;

    if (swaggerContent && resolvedRoutesPath) {
      const tempDir = os.tmpdir();
      const tempPath = path.join(tempDir, `swagger-${Date.now()}.json`);
      await fs.writeFile(tempPath, swaggerContent, 'utf-8');
      try {
        logger.info(`Web UI: Generating from Swagger + Routes (format: ${format})`);
        const result = await generateFromMixed({
          ...options,
          swagger: tempPath,
          routes: resolvedRoutesPath,
          controllers: resolvedControllersPath ?? undefined,
        });
        testCases = result.testCases;
        savedFiles = result.savedFiles;
        warnings = result.warnings;
        coverageBasis = result.coverageBasis;
      } finally {
        await fs.remove(tempPath).catch(() => {});
      }
    } else if (resolvedRoutesPath && !swaggerContent) {
      logger.info(`Web UI: Generating from Routes only (format: ${format})`);
      const result = await generateFromRoutes(
        resolvedRoutesPath,
        resolvedControllersPath ?? null,
        options
      );
      testCases = result.testCases;
      savedFiles = result.savedFiles;
      warnings = result.warnings;
      coverageBasis = result.coverageBasis;
    } else {
      logger.info(`Web UI: Generating from Swagger (format: ${format})`);
      const result = await generateFromSwaggerString(
        swaggerContent as string,
        options
      );
      testCases = result.testCases;
      savedFiles = result.savedFiles;
      warnings = result.warnings;
      coverageBasis = result.coverageBasis;
    }

    const generationSource =
      body.type === 'routes'
        ? `routes:${path.basename(resolvedRoutesPath ?? 'routes')}`
        : 'web-generate';
    let coverageResult = await createAndSaveCoverageResult({
      source: generationSource,
      reportDir: runnerConfig.reportDir ?? path.join(outputDir, 'reports'),
      coverageBasis,
      testCases,
      warnings,
    });
    let coverageSavedFiles = coverageResult.savedFiles.map(relativeToOutput);

    const jsonOutput = formatJson(testCases, { coverageBasis, warnings });
    const mdOutput = formatMd(testCases);
    const responsePayload: Record<string, unknown> = {
      success: true,
      testCases: jsonOutput.testCases,
      metadata: jsonOutput.metadata,
      markdown: mdOutput,
      savedFiles: savedFiles.map(relativeToOutput),
      warnings,
      coverageBasis,
      coverage: {
        report: coverageResult.report,
        savedFiles: coverageSavedFiles,
      },
    };

    if (testCases.length === 0) {
      responsePayload.message =
        'Generation produced 0 test cases. Check your filters, route/controller paths, or parser warnings.';
    }

    if (runAfterGenerate && testCases.length > 0) {
      const executionResult = await executeTestCases({
        testCases,
        runnerConfig,
        outputDir,
        source: generationSource,
        warnings,
      });
      coverageResult = await createAndSaveCoverageResult({
        source: generationSource,
        reportDir: runnerConfig.reportDir ?? path.join(outputDir, 'reports'),
        coverageBasis,
        testCases,
        warnings,
        executionReport: executionResult.report,
      });
      coverageSavedFiles = [
        ...new Set([...coverageSavedFiles, ...coverageResult.savedFiles.map(relativeToOutput)]),
      ];
      responsePayload.execution = {
        report: executionResult.report,
        savedFiles: executionResult.savedFiles.map(relativeToOutput),
        exitCode: executionResult.exitCode,
      };
      responsePayload.coverage = {
        report: coverageResult.report,
        savedFiles: coverageSavedFiles,
      };
    } else if (runAfterGenerate) {
      responsePayload.execution = null;
    }

    res.json(responsePayload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Generation failed: ${message}`);
    res.status(500).json({ error: message });
  }
});

app.post('/run', async (req: Request, res: Response) => {
  try {
    const body = req.body as RunRequestBody;
    let testCases: import('./types').TestCase[] | null = null;
    let coverageBasis: CoverageBasis | null = null;
    let warnings: ParseWarning[] = [];

    if (body.testCases) {
      testCases = body.testCases;
      warnings = body.warnings ?? [];
      coverageBasis =
        body.coverageBasis ??
        createGeneratedOnlyCoverageBasis(testCases, warnings, body.sourceLabel ?? 'web-run');
    } else if (body.inputPath) {
      const bundle = await loadGeneratedBundleFromFile(
        path.resolve(String(body.inputPath).trim())
      );
      testCases = bundle.testCases;
      coverageBasis = bundle.coverageBasis;
      warnings = bundle.warnings;
    }

    if (!testCases) {
      return res.status(400).json({
        error: 'Provide either testCases or inputPath for execution.',
      });
    }
    const runnerConfig = buildRunnerConfigFromBody(
      body,
      body.outputDir ? path.resolve(body.outputDir) : outputDir
    );

    const executionResult = await executeTestCases({
      testCases,
      runnerConfig,
      outputDir: body.outputDir ? path.resolve(body.outputDir) : outputDir,
      source: body.sourceLabel ?? 'web-run',
      warnings,
    });
    const coverageResult = await createAndSaveCoverageResult({
      source: body.sourceLabel ?? 'web-run',
      reportDir: runnerConfig.reportDir ?? path.join(outputDir, 'reports'),
      coverageBasis: coverageBasis ?? createGeneratedOnlyCoverageBasis(testCases, warnings),
      testCases,
      warnings,
      executionReport: executionResult.report,
    });

    res.json({
      success: true,
      report: executionResult.report,
      savedFiles: executionResult.savedFiles.map(relativeToOutput),
      exitCode: executionResult.exitCode,
      coverage: {
        report: coverageResult.report,
        savedFiles: coverageResult.savedFiles.map(relativeToOutput),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Execution failed: ${message}`);
    res.status(500).json({ error: message });
  }
});

app.get('/download/:filename(.+)', (req: Request, res: Response) => {
  const filename = req.params.filename;
  const filePath = path.join(outputDir, filename);
  if (!path.resolve(filePath).startsWith(path.resolve(outputDir)) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});

app.get('/history', async (req: Request, res: Response) => {
  try {
    const files = await listFiles(outputDir, true);
    const fileInfos: Array<{
      filename: string;
      size: number;
      created: Date;
      modified: Date;
    }> = [];

    for (const f of files) {
      const base = path.basename(f);
      if (base === '.gitkeep') continue;
      const stat = await fs.stat(f);
      fileInfos.push({
        filename: path.relative(outputDir, f),
        size: stat.size,
        created: stat.birthtime,
        modified: stat.mtime,
      });
    }

    fileInfos.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    res.json({ files: fileInfos.slice(0, 50) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log();
  console.log('  🤖 QA Test Case Generator — Web UI');
  console.log('  ──────────────────────────────────');
  console.log(`  🌐 URL:    http://localhost:${PORT}`);
  console.log(`  📁 Output: ${outputDir}`);
  const groqOk =
    !!process.env.GROQ_API_KEY &&
    process.env.GROQ_API_KEY !== 'your_groq_api_key_here';
  const geminiOk =
    !!process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';
  const apiStatus =
    groqOk && geminiOk
      ? 'Groq + Gemini ✅'
      : groqOk
        ? 'Groq ✅'
        : geminiOk
          ? 'Gemini ✅'
          : 'Not configured ❌';
  console.log(`  🔑 API Key: ${apiStatus}`);
  console.log();
});

export default app;
