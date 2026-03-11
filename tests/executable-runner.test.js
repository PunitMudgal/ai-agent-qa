const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeTestCases } = require('../dist/runner');
const { parseRouteDirectory, parseRouteFile } = require('../dist/parsers/routeParser');
const { parseControllerFile } = require('../dist/parsers/controllerParser');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('AST route parser resolves nested routers and avoids non-router false positives', async () => {
  const routeDir = makeTempDir('ai-agent-qa-routes-');

  const mainRoute = path.join(routeDir, 'main.routes.js');
  const childRoute = path.join(routeDir, 'child.routes.js');
  const serviceFile = path.join(routeDir, 'service.js');

  fs.writeFileSync(
    mainRoute,
    [
      "const express = require('express');",
      "const router = express.Router();",
      "const childRouter = require('./child.routes');",
      "router.use('/api', childRouter);",
      "router.get('/health', healthController.show);",
      'module.exports = router;',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    childRoute,
    [
      "const { Router } = require('express');",
      'const child = Router();',
      "child.get('/users/:id', userController.show);",
      'module.exports = child;',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    serviceFile,
    [
      'const myapp = { get() {} };',
      "myapp.get('/should-not-be-a-route', metricsCollector);",
      '',
    ].join('\n')
  );

  const routeResult = await parseRouteDirectory(routeDir);
  const standaloneResult = await parseRouteFile(serviceFile);

  assert.equal(
    routeResult.routes.some(route => route.path === '/api/users/:id' && route.method === 'GET'),
    true
  );
  assert.equal(
    routeResult.routes.some(route => route.path === '/health' && route.method === 'GET'),
    true
  );
  assert.equal(standaloneResult.routes.length, 0);
});

test('AST controller parser keeps object-literal handlers isolated', async () => {
  const tempDir = makeTempDir('ai-agent-qa-controllers-');
  const controllerFile = path.join(tempDir, 'users.controller.js');

  fs.writeFileSync(
    controllerFile,
    [
      'const handlers = {',
      '  createUser: async (req, res) => {',
      "    if (!req.body.email) return res.status(400).json({ error: 'email required' });",
      "    return res.status(201).json({ ok: true });",
      '  },',
      '  deleteUser: async (req, res) => {',
      "    if (!req.user) return res.status(401).json({ error: 'unauthorized' });",
      '    return res.status(204).send();',
      '  }',
      '};',
      'module.exports = handlers;',
      '',
    ].join('\n')
  );

  const result = await parseControllerFile(controllerFile);
  const createUser = result.hints.find(hint => hint.functionName === 'createUser');
  const deleteUser = result.hints.find(hint => hint.functionName === 'deleteUser');

  assert.deepEqual(createUser.statusCodes.sort((a, b) => a - b), [201, 400]);
  assert.deepEqual(deleteUser.statusCodes.sort((a, b) => a - b), [204, 401]);
});

test('base-url runner executes safe requests and skips mutations by default', async () => {
  const tempDir = makeTempDir('ai-agent-qa-runner-');
  const originalFetch = global.fetch;

  global.fetch = async (url, init = {}) => {
    assert.equal(init.method, 'GET');
    assert.equal(String(url), 'http://localhost:3000/users/42');

    return new Response(JSON.stringify({ id: '42', ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  };

  try {
    const execution = await executeTestCases({
      testCases: [
        {
          id: 'TC-001',
          method: 'GET',
          endpoint: 'GET /users/{id}',
          scenario: 'fetch user',
          inputData: { pathParams: { id: 42 } },
          expectedOutput: {
            statusCode: 200,
            bodyContains: { id: '42', ok: true },
          },
        },
        {
          id: 'TC-002',
          method: 'POST',
          endpoint: 'POST /users',
          scenario: 'create user',
          inputData: { body: { name: 'Alice' } },
          expectedOutput: { statusCode: 201 },
        },
      ],
      runnerConfig: {
        mode: 'base-url',
        baseUrl: 'http://localhost:3000',
        allowMutations: false,
        strictAssertions: true,
        reportDir: tempDir,
      },
      outputDir: tempDir,
      source: 'base-url-test',
    });

    assert.equal(execution.report.summary.passed, 1);
    assert.equal(execution.report.summary.failed, 0);
    assert.equal(execution.report.summary.skipped, 1);
    assert.equal(execution.report.summary.skippedMutations, 1);
    assert.equal(execution.exitCode, 0);
    execution.savedFiles.forEach(file => {
      assert.equal(fs.existsSync(file), true);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('app-import runner reports preflight failures when local jest/supertest are missing', async () => {
  const tempDir = makeTempDir('ai-agent-qa-app-import-');
  const appFile = path.join(tempDir, 'app.js');
  const pkgFile = path.join(tempDir, 'package.json');

  fs.writeFileSync(appFile, 'module.exports = {};\n');
  fs.writeFileSync(pkgFile, JSON.stringify({ name: 'temp-app', version: '1.0.0' }, null, 2));

  const execution = await executeTestCases({
    testCases: [
      {
        id: 'TC-001',
        method: 'GET',
        endpoint: 'GET /health',
        scenario: 'health check',
        expectedOutput: { statusCode: 200 },
      },
    ],
    runnerConfig: {
      mode: 'app-import',
      appModulePath: appFile,
      reportDir: tempDir,
      allowMutations: false,
      strictAssertions: false,
    },
    outputDir: tempDir,
    source: 'app-import-test',
  });

  assert.equal(execution.report.summary.failed, 1);
  assert.equal(execution.exitCode, 1);
  assert.match(execution.report.results[0].message, /Missing runtime dependency "jest\/bin\/jest\.js"/);
});
