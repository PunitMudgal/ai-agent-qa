const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildPrompt } = require('../dist/ai/promptBuilder');
const { parseControllerFile } = require('../dist/parsers/controllerParser');
const {
  enrichEndpointWithControllerHint,
  sanitizeGeneratedTestCases,
} = require('../dist/generators/testCaseSanitizer');
const { generateJestTestFilename } = require('../dist/utils/fileUtils');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('controller parser extracts request field names and direct return patterns', async () => {
  const tempDir = makeTempDir('ai-agent-qa-controller-fields-');
  const controllerFile = path.join(tempDir, 'search.service.js');

  fs.writeFileSync(
    controllerFile,
    [
      'const getMakeService = async (req, res) => {',
      '  const rawVtg = req.query.vehicletypegroupid;',
      '  const { YearID } = req.query;',
      '  const { id } = req.params;',
      '  const vehicleTypeGroupID = rawVtg != null && rawVtg !== "" ? parseInt(rawVtg, 10) : NaN;',
      '  if (Number.isNaN(vehicleTypeGroupID) || vehicleTypeGroupID < 1 || !id) {',
      '    return [];',
      '  }',
      '  return service.fetch({ YearID, vehicleTypeGroupID, id, MakeName: req.body.MakeName });',
      '};',
      'module.exports = { getMakeService };',
      '',
    ].join('\n')
  );

  const result = await parseControllerFile(controllerFile);
  const hint = result.hints.find(item => item.functionName === 'getMakeService');

  assert.deepEqual(hint.queryParamNames.sort(), ['YearID', 'vehicletypegroupid']);
  assert.deepEqual(hint.pathParamNames, ['id']);
  assert.deepEqual(hint.bodyFieldNames, ['MakeName']);
  assert.equal(hint.validationChecks.includes('numeric coercion via parseInt'), true);
  assert.equal(hint.validationChecks.includes('NaN check'), true);
  assert.equal(hint.returnPatterns.includes('returns empty array'), true);
});

test('sanitizer enriches route-derived endpoints and drops malformed unsupported cases', () => {
  const endpoint = {
    method: 'GET',
    path: '/getYear',
    operationId: 'getYearService',
    summary: '',
    description: '',
    tags: ['searchapi'],
    parameters: [],
    requestBody: null,
    responses: [],
    security: null,
  };
  const hint = {
    functionName: 'getYearService',
    sourceFile: '/tmp/service.js',
    fileName: 'service.js',
    statusCodes: [],
    thrownErrors: [],
    modelReferences: [],
    authChecks: [],
    validationChecks: ['numeric coercion via parseInt', 'NaN check'],
    queryParamNames: ['vehicletypegroupid'],
    bodyFieldNames: [],
    pathParamNames: [],
    returnPatterns: ['returns empty array'],
    jsdoc: '',
    conditionalBranches: 1,
  };

  const enrichedEndpoint = enrichEndpointWithControllerHint(endpoint, hint);
  assert.equal(enrichedEndpoint.parameters.some(param => param.name === 'vehicletypegroupid' && param.in === 'query'), true);

  const sanitized = sanitizeGeneratedTestCases(
    [
      {
        scenario: 'Unauthorized request',
        inputData: {},
        expectedOutput: { statusCode: 401 },
      },
      {
        scenario: 'Query parameters exceed maximum length',
        category: 'boundary',
        inputData: {
          queryParams: {
            param: 'a".repeat(1001)',
            body: {},
            expectedOutput: { statusCode: 414 },
          },
        },
        expectedOutput: { statusCode: 200 },
      },
      {
        scenario: 'Get year with invalid query parameter',
        category: 'negative',
        inputData: {
          queryParams: {
            invalidParam: 'test',
            body: {},
            expectedOutput: { statusCode: 414 },
          },
        },
        expectedOutput: { statusCode: '400' },
      },
    ],
    endpoint,
    hint
  );

  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].endpoint, 'GET /getYear');
  assert.equal(sanitized[0].method, 'GET');
  assert.deepEqual(sanitized[0].inputData.queryParams, {
    vehicletypegroupid: 'test',
  });
  assert.deepEqual(sanitized[0].inputData.body, {});
  assert.equal(sanitized[0].expectedOutput.statusCode, 400);
});

test('prompt builder includes observed controller fields and stricter generation rules', () => {
  const endpoint = {
    method: 'GET',
    path: '/getMake',
    operationId: 'getMakeService',
    summary: '',
    description: '',
    tags: ['searchapi'],
    parameters: [
      {
        name: 'vehicletypegroupid',
        in: 'query',
        required: false,
        type: 'string',
        description: 'Observed in controller implementation',
      },
      {
        name: 'YearID',
        in: 'query',
        required: false,
        type: 'string',
        description: 'Observed in controller implementation',
      },
    ],
    requestBody: null,
    responses: [],
    security: null,
  };
  const hint = {
    functionName: 'getMakeService',
    sourceFile: '/tmp/service.js',
    fileName: 'service.js',
    statusCodes: [],
    thrownErrors: [],
    modelReferences: [],
    authChecks: [],
    validationChecks: ['numeric coercion via parseInt'],
    queryParamNames: ['vehicletypegroupid', 'YearID'],
    bodyFieldNames: [],
    pathParamNames: [],
    returnPatterns: ['returns empty array'],
    jsdoc: '',
    conditionalBranches: 1,
  };

  const { systemPrompt, userPrompt } = buildPrompt(endpoint, '', hint, 6);

  assert.match(systemPrompt, /Never invent generic parameter names/);
  assert.match(systemPrompt, /Only generate unauthorized\/403 tests when authentication\/security is explicitly present/);
  assert.match(userPrompt, /Observed query params: vehicletypegroupid, YearID/);
  assert.match(userPrompt, /Observed direct returns: returns empty array/);
});

test('generated Jest filenames default to runnable .test.js files', () => {
  assert.equal(generateJestTestFilename('GET /getYear'), 'get-getyear.test.js');
});
