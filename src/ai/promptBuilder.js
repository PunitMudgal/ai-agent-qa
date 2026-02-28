/**
 * @module promptBuilder
 * @description Constructs system and user prompts for AI test case generation.
 */

const SYSTEM_PROMPT = `You are a senior QA engineer with 10+ years of experience in API testing. Your job is to generate comprehensive, realistic test cases for the given API endpoint.

For EVERY endpoint, you must generate test cases covering ALL of these categories:

POSITIVE TESTS:
- Happy path with valid, minimal required data
- Happy path with all optional fields provided
- Happy path with boundary-valid values (max length strings, max/min numbers)

NEGATIVE TESTS:
- Missing each required field (one test per required field)
- Invalid data types for each field (string where number expected, etc.)
- Invalid enum values
- Unauthorized access (missing/invalid auth token)
- Forbidden access (authenticated but wrong role/ownership)
- Non-existent resource ID (404 scenarios)

EDGE CASE TESTS:
- Empty string for string fields
- Null values for nullable fields
- Whitespace-only strings
- Very long strings (> max length)
- Special characters and Unicode in string fields
- SQL injection patterns in string inputs
- XSS patterns in string inputs
- Negative numbers where positive expected
- Zero values
- Future/past dates where relevant

VALIDATION TESTS:
- Each field format validation (email format, phone format, URL format)
- Regex pattern violations if schema specifies pattern
- Min/max length violations
- Min/max value violations

BOUNDARY CONDITIONS:
- Exactly at minimum length/value
- Exactly at maximum length/value
- One below minimum
- One above maximum
- Empty arrays
- Arrays with one item
- Arrays exceeding max items

Return ONLY a valid JSON array. No explanation, no markdown, no preamble, no code fences. Each test case object must have exactly these fields:
{
  "id": "TC-001",
  "endpoint": "POST /users",
  "method": "POST",
  "scenario": "Clear description of what is being tested",
  "category": "positive|negative|edge|validation|boundary",
  "priority": "high|medium|low",
  "inputData": {
    "headers": {},
    "pathParams": {},
    "queryParams": {},
    "body": {}
  },
  "expectedOutput": {
    "statusCode": 201,
    "bodyContains": {},
    "bodyExcludes": [],
    "headers": {}
  },
  "preconditions": "Any setup needed before running this test",
  "notes": "Additional context or edge case explanation",
  "status": "Pending"
}`;

/**
 * Build a prompt for a single endpoint.
 * @param {object} endpoint - Parsed endpoint object from swaggerParser.
 * @param {string} [businessContext=''] - Additional business rules.
 * @param {object} [controllerHints=null] - Controller analysis hints.
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildPrompt(endpoint, businessContext = '', controllerHints = null) {
  const parts = [];

  parts.push(`Generate comprehensive test cases for the following API endpoint:\n`);
  parts.push(`## Endpoint`);
  parts.push(`- **Method**: ${endpoint.method}`);
  parts.push(`- **Path**: ${endpoint.path}`);
  if (endpoint.operationId) parts.push(`- **Operation ID**: ${endpoint.operationId}`);
  if (endpoint.summary) parts.push(`- **Summary**: ${endpoint.summary}`);
  if (endpoint.description) parts.push(`- **Description**: ${endpoint.description}`);
  if (endpoint.tags && endpoint.tags.length > 0) {
    parts.push(`- **Tags**: ${endpoint.tags.join(', ')}`);
  }

  // Security
  if (endpoint.security) {
    parts.push(`\n## Authentication`);
    parts.push(`This endpoint requires authentication. Security schemes: ${JSON.stringify(endpoint.security)}`);
  }

  // Parameters
  if (endpoint.parameters && endpoint.parameters.length > 0) {
    parts.push(`\n## Parameters`);
    for (const param of endpoint.parameters) {
      const reqStr = param.required ? '(REQUIRED)' : '(optional)';
      let desc = `- **${param.name}** [${param.in}] ${reqStr}: type=${param.type}`;
      if (param.format) desc += `, format=${param.format}`;
      if (param.enum) desc += `, enum=[${param.enum.join(', ')}]`;
      if (param.description) desc += ` — ${param.description}`;
      parts.push(desc);
    }
  }

  // Request Body
  if (endpoint.requestBody) {
    parts.push(`\n## Request Body ${endpoint.requestBody.required ? '(REQUIRED)' : '(optional)'}`);
    if (endpoint.requestBody.properties && endpoint.requestBody.properties.length > 0) {
      parts.push('Properties:');
      for (const prop of endpoint.requestBody.properties) {
        const reqStr = prop.required ? '(REQUIRED)' : '(optional)';
        let line = `- **${prop.name}** ${reqStr}: type=${prop.type}`;
        if (prop.format) line += `, format=${prop.format}`;
        if (prop.enum) line += `, enum=[${prop.enum.join(', ')}]`;
        if (prop.minLength != null) line += `, minLength=${prop.minLength}`;
        if (prop.maxLength != null) line += `, maxLength=${prop.maxLength}`;
        if (prop.minimum != null) line += `, min=${prop.minimum}`;
        if (prop.maximum != null) line += `, max=${prop.maximum}`;
        if (prop.pattern) line += `, pattern=${prop.pattern}`;
        if (prop.nullable) line += `, nullable=true`;
        if (prop.description) line += ` — ${prop.description}`;
        parts.push(line);
      }
    }
    if (endpoint.requestBody.schema) {
      parts.push(`\nFull schema:\n\`\`\`json\n${JSON.stringify(endpoint.requestBody.schema, null, 2)}\n\`\`\``);
    }
  }

  // Responses
  if (endpoint.responses && endpoint.responses.length > 0) {
    parts.push(`\n## Expected Responses`);
    for (const resp of endpoint.responses) {
      parts.push(`- **${resp.statusCode}**: ${resp.description}`);
      if (resp.properties && resp.properties.length > 0) {
        for (const prop of resp.properties) {
          parts.push(`  - ${prop.name}: ${prop.type}`);
        }
      }
    }
  }

  // Controller hints
  if (controllerHints) {
    parts.push(`\n## Controller Implementation Hints`);
    if (controllerHints.statusCodes && controllerHints.statusCodes.length > 0) {
      parts.push(`- Status codes used: ${controllerHints.statusCodes.join(', ')}`);
    }
    if (controllerHints.thrownErrors && controllerHints.thrownErrors.length > 0) {
      parts.push(`- Thrown errors: ${controllerHints.thrownErrors.map(e => `${e.type}("${e.message}")`).join(', ')}`);
    }
    if (controllerHints.modelReferences && controllerHints.modelReferences.length > 0) {
      parts.push(`- Database models used: ${controllerHints.modelReferences.join(', ')}`);
    }
    if (controllerHints.authChecks && controllerHints.authChecks.length > 0) {
      parts.push(`- Auth checks: ${controllerHints.authChecks.join(', ')}`);
    }
    if (controllerHints.validationChecks && controllerHints.validationChecks.length > 0) {
      parts.push(`- Validation: ${controllerHints.validationChecks.join(', ')}`);
    }
    if (controllerHints.conditionalBranches > 0) {
      parts.push(`- Conditional branches: ${controllerHints.conditionalBranches} (indicating complex logic)`);
    }
    if (controllerHints.jsdoc) {
      parts.push(`- Documentation:\n${controllerHints.jsdoc}`);
    }
  }

  // Business context
  if (businessContext) {
    parts.push(`\n## Business Rules & Context`);
    parts.push(businessContext);
  }

  parts.push(`\nGenerate at least 10 test cases for this endpoint. For endpoints with many fields or complex business logic, generate 15-25 test cases. Cover ALL categories: positive, negative, edge, validation, and boundary.`);

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: parts.join('\n'),
  };
}

/**
 * Build a batch prompt for multiple endpoints.
 * @param {Array<object>} endpoints - Array of parsed endpoint objects.
 * @param {string} [businessContext='']
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildBatchPrompt(endpoints, businessContext = '') {
  const parts = [];
  parts.push(`Generate comprehensive test cases for the following ${endpoints.length} API endpoints:\n`);

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    parts.push(`### Endpoint ${i + 1}: ${ep.method} ${ep.path}`);
    if (ep.summary) parts.push(`Summary: ${ep.summary}`);
    if (ep.parameters && ep.parameters.length > 0) {
      parts.push(`Parameters: ${ep.parameters.map(p => `${p.name}(${p.type})`).join(', ')}`);
    }
    if (ep.requestBody && ep.requestBody.properties) {
      parts.push(`Body fields: ${ep.requestBody.properties.map(p => `${p.name}(${p.type}${p.required ? ',required' : ''})`).join(', ')}`);
    }
    parts.push('');
  }

  if (businessContext) {
    parts.push(`\n## Business Rules & Context\n${businessContext}`);
  }

  parts.push(`\nGenerate at least 5 test cases per endpoint. Return ALL test cases in a single JSON array.`);

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: parts.join('\n'),
  };
}

module.exports = {
  buildPrompt,
  buildBatchPrompt,
  SYSTEM_PROMPT,
};
