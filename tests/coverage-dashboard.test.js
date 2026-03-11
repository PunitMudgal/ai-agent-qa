const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildCoverageReport,
  createAndSaveCoverageResult,
  createCoverageBasis,
  loadGeneratedBundleFromFile,
} = require('../dist/coverage');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeExecutionReport(results) {
  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const skipped = results.filter(result => result.status === 'skipped').length;

  return {
    metadata: {
      mode: 'base-url',
      source: 'test',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 5,
      reportDir: '/tmp',
      allowMutations: false,
      strictAssertions: false,
      baseUrl: 'http://localhost:3000',
    },
    summary: {
      total: results.length,
      executed: passed + failed,
      passed,
      failed,
      skipped,
      skippedMutations: results.filter(
        result => result.status === 'skipped' && result.skippedReason === 'Mutation skipped by safe mode'
      ).length,
      warnings: 0,
    },
    endpointSummaries: [],
    results,
    warnings: [],
  };
}

test('coverage report computes filtered-scope design coverage and uncovered endpoints', () => {
  const coverageBasis = createCoverageBasis({
    sourceType: 'swagger',
    discoveredTotal: 3,
    endpoints: [
      { method: 'GET', path: '/users', tags: ['users'], sourceKind: 'swagger' },
      { method: 'POST', path: '/users', tags: ['users'], sourceKind: 'swagger' },
    ],
    filters: { tags: ['users'], paths: [] },
  });

  const report = buildCoverageReport({
    source: 'unit-test',
    reportDir: '/tmp',
    coverageBasis,
    testCases: [
      { id: 'TC-1', method: 'GET', endpoint: 'GET /users', category: 'positive' },
      { id: 'TC-2', method: 'GET', endpoint: 'GET /users', category: 'negative' },
      { id: 'TC-3', method: 'POST', endpoint: 'POST /users', category: 'edge' },
    ],
  });

  assert.equal(report.summary.discoveredTotal, 3);
  assert.equal(report.summary.inScopeTotal, 2);
  assert.equal(report.summary.coveredEndpoints, 2);
  assert.equal(report.summary.uncoveredEndpoints, 0);
  assert.equal(report.summary.endpointCoveragePct, 100);
  assert.equal(report.summary.designScore, 65);
  assert.equal(report.summary.runtimeScore, null);
  assert.equal(report.summary.overallScore, 65);
  assert.equal(report.categorySummaries.find(item => item.category === 'positive').endpointsCovered, 1);
  assert.equal(report.categorySummaries.find(item => item.category === 'edge').testCount, 1);
});

test('coverage excludes safe-mode mutation skips from runtime denominator', () => {
  const coverageBasis = createCoverageBasis({
    sourceType: 'routes',
    discoveredTotal: 2,
    endpoints: [
      { method: 'GET', path: '/users/42', tags: ['users'], sourceKind: 'routes' },
      { method: 'POST', path: '/users', tags: ['users'], sourceKind: 'routes' },
    ],
  });

  const report = buildCoverageReport({
    source: 'runtime-test',
    reportDir: '/tmp',
    coverageBasis,
    testCases: [
      { id: 'TC-1', method: 'GET', endpoint: 'GET /users/42', category: 'positive' },
      { id: 'TC-2', method: 'POST', endpoint: 'POST /users', category: 'positive' },
    ],
    executionReport: makeExecutionReport([
      {
        testCaseId: 'TC-1',
        endpoint: '/users/42',
        method: 'GET',
        scenario: 'fetch user',
        status: 'passed',
        durationMs: 2,
      },
      {
        testCaseId: 'TC-2',
        endpoint: '/users',
        method: 'POST',
        scenario: 'create user',
        status: 'skipped',
        durationMs: 0,
        skippedReason: 'Mutation skipped by safe mode',
      },
    ]),
  });

  assert.equal(report.summary.mutationGatedEndpoints, 1);
  assert.equal(report.summary.passRate, 100);
  assert.equal(report.summary.runtimeScore, 100);
  assert.equal(report.summary.overallScore, 72);
  assert.equal(
    report.endpointSummaries.find(item => item.method === 'POST' && item.path === '/users').runtimeState,
    'mutation-gated'
  );
});

test('legacy generated bundles fall back to generated-only coverage basis with warning', async () => {
  const tempDir = makeTempDir('ai-agent-qa-coverage-legacy-');
  const inputPath = path.join(tempDir, 'legacy.json');

  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        metadata: { generatedAt: new Date().toISOString() },
        testCases: [
          { id: 'TC-1', method: 'GET', endpoint: 'GET /health', category: 'positive' },
        ],
      },
      null,
      2
    )
  );

  const bundle = await loadGeneratedBundleFromFile(inputPath);

  assert.equal(bundle.coverageBasis.scopeMode, 'generated-only');
  assert.equal(bundle.coverageBasis.filteredTotal, 1);
  assert.equal(bundle.warnings.some(warning => warning.kind === 'coverage'), true);
});

test('coverage reports are persisted as json and markdown artifacts', async () => {
  const tempDir = makeTempDir('ai-agent-qa-coverage-save-');
  const coverageBasis = createCoverageBasis({
    sourceType: 'swagger',
    discoveredTotal: 1,
    endpoints: [
      { method: 'GET', path: '/health', tags: ['system'], sourceKind: 'swagger' },
    ],
  });

  const result = await createAndSaveCoverageResult({
    source: 'save-test',
    reportDir: tempDir,
    coverageBasis,
    testCases: [{ id: 'TC-1', method: 'GET', endpoint: 'GET /health', category: 'positive' }],
  });

  assert.equal(result.savedFiles.length, 2);
  result.savedFiles.forEach(file => assert.equal(fs.existsSync(file), true));
  const markdownPath = result.savedFiles.find(file => file.endsWith('.md'));
  assert.match(fs.readFileSync(markdownPath, 'utf8'), /Coverage Dashboard Report/);
});

test('ui script remains syntactically valid after coverage tab additions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'script block not found');
  assert.doesNotThrow(() => new Function(match[1]));
});
