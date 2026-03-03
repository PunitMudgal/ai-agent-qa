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
import { generateFromSwaggerString, generateFromRoutes, generateFromMixed } from './generators/testCaseGenerator';
import { parseSwaggerString } from './parsers/swaggerParser';
import { listFiles } from './utils/fileUtils';
import { formatTestCases as formatJson } from './formatters/jsonFormatter';
import { formatTestCases as formatMd } from './formatters/markdownFormatter';
import type { GenerateRequestBody } from './types';

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
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    apiKeyConfigured:
      !!process.env.GROQ_API_KEY &&
      process.env.GROQ_API_KEY !== 'your_groq_api_key_here',
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
    } = body;

    if (!swaggerContent && !routesPath) {
      return res.status(400).json({
        error:
          'Provide either Swagger (upload/paste) or a Routes directory path (or both).',
      });
    }

    if (
      !process.env.GROQ_API_KEY ||
      process.env.GROQ_API_KEY === 'your_groq_api_key_here'
    ) {
      return res.status(400).json({
        error:
          'Groq API key not configured. Add GROQ_API_KEY to your .env file. Get a free key at console.groq.com',
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

    let testCases: import('./types').TestCase[];
    let savedFiles: string[];
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
    } else {
      logger.info(`Web UI: Generating from Swagger (format: ${format})`);
      const result = await generateFromSwaggerString(
        swaggerContent as string,
        options
      );
      testCases = result.testCases;
      savedFiles = result.savedFiles;
    }

    const jsonOutput = formatJson(testCases);
    const mdOutput = formatMd(testCases);

    res.json({
      success: true,
      testCases: jsonOutput.testCases,
      metadata: jsonOutput.metadata,
      markdown: mdOutput,
      savedFiles: savedFiles.map(f => path.relative(outputDir, path.resolve(f))),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Generation failed: ${message}`);
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
    const files = await listFiles(outputDir);
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
        filename: base,
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
  console.log(
    `  🔑 API Key: ${process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here' ? 'Configured ✅' : 'Not configured ❌'}`
  );
  console.log();
});

export default app;
