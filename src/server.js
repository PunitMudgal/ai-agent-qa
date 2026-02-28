/**
 * @module server
 * @description Express server for the QA Test Generator web UI.
 */

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const logger = require('./utils/logger');
const { generateFromSwaggerString, generateFromSwagger, generateFromMixed } = require('./generators/testCaseGenerator');
const { parseSwaggerFile, parseSwaggerString } = require('./parsers/swaggerParser');
const { listFiles } = require('./utils/fileUtils');
const { formatTestCases: formatJson } = require('./formatters/jsonFormatter');
const { formatTestCases: formatMd } = require('./formatters/markdownFormatter');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve output directory for downloads
const outputDir = path.resolve(process.env.DEFAULT_OUTPUT_DIR || './output');
fs.ensureDirSync(outputDir);
app.use('/output', express.static(outputDir));

// ──────────────────────────────────────────────
// File upload (multer)
// ──────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.json', '.yaml', '.yml'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .json, .yaml, and .yml files are allowed'));
    }
  },
});

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────

// Serve the Web UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    apiKeyConfigured: !!process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here',
  });
});

// Upload swagger file
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const content = req.file.buffer.toString('utf-8');

    // Validate by parsing
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
    res.status(400).json({ error: `Failed to parse file: ${err.message}` });
  }
});

// Main generation endpoint
app.post('/generate', async (req, res) => {
  try {
    const {
      type = 'swagger',
      swaggerContent,
      businessContext = '',
      format = 'json',
      filterTags = [],
      filterPaths = [],
      minTests = 10,
    } = req.body;

    if (!swaggerContent) {
      return res.status(400).json({ error: 'Swagger content is required' });
    }

    // Check API key
    if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here') {
      return res.status(400).json({
        error: 'Groq API key not configured. Add GROQ_API_KEY to your .env file. Get a free key at console.groq.com',
      });
    }

    const options = {
      format,
      outputDir,
      businessContext,
      filterTags: Array.isArray(filterTags) ? filterTags : filterTags.split(',').filter(Boolean),
      filterPaths: Array.isArray(filterPaths) ? filterPaths : filterPaths.split(',').filter(Boolean),
      minTestsPerEndpoint: parseInt(minTests) || 10,
    };

    logger.info(`Web UI: Generating test cases (format: ${format})`);

    const { testCases, savedFiles } = await generateFromSwaggerString(swaggerContent, options);

    // Format output for response
    const jsonOutput = formatJson(testCases);
    const mdOutput = formatMd(testCases);

    res.json({
      success: true,
      testCases: jsonOutput.testCases,
      metadata: jsonOutput.metadata,
      markdown: mdOutput,
      savedFiles: savedFiles.map(f => path.basename(f)),
    });
  } catch (err) {
    logger.error(`Generation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Download generated file
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(outputDir, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});

// List generated files (history)
app.get('/history', async (req, res) => {
  try {
    const files = await listFiles(outputDir);
    const fileInfos = [];

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

    // Sort by modified date descending
    fileInfos.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({ files: fileInfos.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log();
  console.log('  🤖 QA Test Case Generator — Web UI');
  console.log('  ──────────────────────────────────');
  console.log(`  🌐 URL:    http://localhost:${PORT}`);
  console.log(`  📁 Output: ${outputDir}`);
  console.log(`  🔑 API Key: ${process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here' ? 'Configured ✅' : 'Not configured ❌'}`);
  console.log();
});

module.exports = app;
