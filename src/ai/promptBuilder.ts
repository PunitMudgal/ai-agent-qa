/**
 * @module promptBuilder
 * @description Constructs system and user prompts for AI test case generation.
 */

import type { Endpoint, ControllerHint } from '../types';

export const SYSTEM_PROMPT = `You are a senior QA engineer. Generate test cases for API endpoints.

You MUST return ONLY valid JSON. No text before or after. No markdown. No code fences.

Return a JSON object with a "testCases" key containing an array.

Each test case has these fields:
- id: string like "TC-001"
- endpoint: string like "POST /users"
- method: string like "POST"
- scenario: string describing what is tested
- category: one of "positive", "negative", "edge", "validation", "boundary"
- priority: one of "high", "medium", "low"
- inputData: object with headers, pathParams, queryParams, body (all objects)
- expectedOutput: object with statusCode (number), bodyContains (object), bodyExcludes (array of strings), headers (object)
- preconditions: string
- notes: string
- status: "Pending"

Cover these categories:
- positive: happy path with valid data
- negative: missing required fields, invalid types, unauthorized, not found
- edge: empty strings, null values, special characters, SQL injection, XSS
- validation: format violations, min/max violations
- boundary: at limits, beyond limits

CRITICAL RULES:
- Use EXACT field names from the API spec/controller (e.g. if signIn expects "email", use "email", not "username")
- Do NOT invent error response shapes. Only assert error shapes that are explicitly documented in the spec
- Use simple, safe values for path/query/body (avoid code-like strings, unescaped quotes, or very long strings)
- For unauthorized/403: expect statusCode only unless the spec defines an exact error body`;

export interface BuildPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

export function buildPrompt(
  endpoint: Endpoint,
  businessContext = '',
  controllerHints: ControllerHint | null = null,
  minTestsPerEndpoint = 10
): BuildPromptResult {
  const parts: string[] = [];

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

  if (endpoint.security) {
    parts.push(
      `\n## Authentication\nThis endpoint requires authentication. Security schemes: ${JSON.stringify(endpoint.security)}`
    );
  }

  if (endpoint.parameters && endpoint.parameters.length > 0) {
    parts.push(`\n## Parameters`);
    for (const param of endpoint.parameters) {
      const reqStr = param.required ? '(REQUIRED)' : '(optional)';
      let desc = `- **${param.name}** [${param.in}] ${reqStr}: type=${param.type}`;
      if (param.format) desc += `, format=${param.format}`;
      if (param.enum) desc += `, enum=[${Array.isArray(param.enum) ? param.enum.join(', ') : param.enum}]`;
      if (param.description) desc += ` — ${param.description}`;
      parts.push(desc);
    }
  }

  if (endpoint.requestBody) {
    parts.push(
      `\n## Request Body ${endpoint.requestBody.required ? '(REQUIRED)' : '(optional)'}`
    );
    if (endpoint.requestBody.properties && endpoint.requestBody.properties.length > 0) {
      parts.push('Properties:');
      for (const prop of endpoint.requestBody.properties) {
        const reqStr = prop.required ? '(REQUIRED)' : '(optional)';
        let line = `- **${prop.name}** ${reqStr}: type=${prop.type}`;
        if (prop.format) line += `, format=${prop.format}`;
        if (prop.enum) line += `, enum=[${Array.isArray(prop.enum) ? prop.enum.join(', ') : prop.enum}]`;
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
      parts.push(
        `\nFull schema:\n\`\`\`json\n${JSON.stringify(endpoint.requestBody.schema, null, 2)}\n\`\`\``
      );
    }
  }

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

  if (controllerHints) {
    parts.push(`\n## Controller Implementation Hints`);
    if (controllerHints.statusCodes && controllerHints.statusCodes.length > 0) {
      parts.push(`- Status codes used: ${controllerHints.statusCodes.join(', ')}`);
    }
    if (controllerHints.thrownErrors && controllerHints.thrownErrors.length > 0) {
      parts.push(
        `- Thrown errors: ${controllerHints.thrownErrors.map(e => `${e.type}("${e.message}")`).join(', ')}`
      );
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
      parts.push(
        `- Conditional branches: ${controllerHints.conditionalBranches} (indicating complex logic)`
      );
    }
    if (controllerHints.jsdoc) {
      parts.push(`- Documentation:\n${controllerHints.jsdoc}`);
    }
  }

  if (businessContext) {
    parts.push(`\n## Business Rules & Context`);
    parts.push(businessContext);
  }

  parts.push(
    `\nGenerate at least ${minTestsPerEndpoint} test cases for this endpoint. Cover positive, negative, edge, validation, and boundary categories.`
  );
  parts.push(
    `\nIMPORTANT: Return ONLY valid JSON. The response must be a JSON object: {"testCases": [...]}`
  );
  parts.push(`Do NOT include any text, explanation, or markdown. ONLY JSON.`);

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: parts.join('\n'),
  };
}

export function buildBatchPrompt(
  endpoints: Endpoint[],
  businessContext = '',
  minTestsPerEndpoint = 5
): BuildPromptResult {
  const parts: string[] = [];
  parts.push(
    `Generate comprehensive test cases for the following ${endpoints.length} API endpoints:\n`
  );

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    parts.push(`### Endpoint ${i + 1}: ${ep.method} ${ep.path}`);
    if (ep.summary) parts.push(`Summary: ${ep.summary}`);
    if (ep.parameters && ep.parameters.length > 0) {
      parts.push(`Parameters: ${ep.parameters.map(p => `${p.name}(${p.type})`).join(', ')}`);
    }
    if (ep.requestBody && ep.requestBody.properties) {
      parts.push(
        `Body fields: ${ep.requestBody.properties.map(p => `${p.name}(${p.type}${p.required ? ',required' : ''})`).join(', ')}`
      );
    }
    parts.push('');
  }

  if (businessContext) {
    parts.push(`\n## Business Rules & Context\n${businessContext}`);
  }

  parts.push(`\nGenerate at least ${minTestsPerEndpoint} test cases per endpoint. Return ONLY valid JSON: {"testCases": [...]}`);
  parts.push(`Do NOT include any text, explanation, or markdown. ONLY JSON.`);

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: parts.join('\n'),
  };
}
