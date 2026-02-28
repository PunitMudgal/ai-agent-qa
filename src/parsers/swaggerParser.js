/**
 * @module swaggerParser
 * @description Parses OpenAPI 3.0 and Swagger 2.0 specifications to extract endpoint details.
 */

const SwaggerParser = require('@apidevtools/swagger-parser');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Flatten a JSON schema into a list of property descriptors.
 * @param {object} schema - JSON Schema object.
 * @param {string} [prefix=''] - Current nesting prefix.
 * @returns {Array<object>} Array of { name, type, required, format, enum, minLength, maxLength, minimum, maximum, pattern, description }.
 */
function flattenSchema(schema, prefix = '', requiredFields = []) {
  if (!schema) return [];
  const props = [];

  if (schema.type === 'object' && schema.properties) {
    const req = schema.required || requiredFields;
    for (const [name, prop] of Object.entries(schema.properties)) {
      const fullName = prefix ? `${prefix}.${name}` : name;
      if (prop.type === 'object' && prop.properties) {
        props.push(...flattenSchema(prop, fullName, prop.required || []));
      } else if (prop.type === 'array' && prop.items) {
        props.push({
          name: fullName,
          type: 'array',
          items: prop.items.type || 'object',
          required: req.includes(name),
          description: prop.description || '',
          minItems: prop.minItems,
          maxItems: prop.maxItems,
        });
        if (prop.items.type === 'object' && prop.items.properties) {
          props.push(...flattenSchema(prop.items, `${fullName}[]`, prop.items.required || []));
        }
      } else {
        props.push({
          name: fullName,
          type: prop.type || 'string',
          required: req.includes(name),
          format: prop.format || null,
          enum: prop.enum || null,
          minLength: prop.minLength != null ? prop.minLength : null,
          maxLength: prop.maxLength != null ? prop.maxLength : null,
          minimum: prop.minimum != null ? prop.minimum : null,
          maximum: prop.maximum != null ? prop.maximum : null,
          pattern: prop.pattern || null,
          description: prop.description || '',
          default: prop.default != null ? prop.default : null,
          nullable: prop.nullable || false,
          example: prop.example != null ? prop.example : null,
        });
      }
    }
  } else if (schema.allOf) {
    const merged = mergeAllOf(schema.allOf);
    props.push(...flattenSchema(merged, prefix, requiredFields));
  } else if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf;
    if (variants.length > 0) {
      props.push(...flattenSchema(variants[0], prefix, requiredFields));
    }
  }

  return props;
}

/**
 * Merge allOf schemas into a single object schema.
 * @param {Array<object>} schemas
 * @returns {object}
 */
function mergeAllOf(schemas) {
  const merged = { type: 'object', properties: {}, required: [] };
  for (const s of schemas) {
    if (s.properties) {
      Object.assign(merged.properties, s.properties);
    }
    if (s.required) {
      merged.required.push(...s.required);
    }
  }
  return merged;
}

/**
 * Extract parameter details from an operation.
 * @param {Array} params - OpenAPI parameter objects.
 * @returns {Array<object>}
 */
function extractParameters(params = []) {
  return params.map(p => ({
    name: p.name,
    in: p.in,
    required: p.required || false,
    type: p.schema ? p.schema.type : (p.type || 'string'),
    format: p.schema ? p.schema.format : (p.format || null),
    enum: p.schema ? p.schema.enum : (p.enum || null),
    description: p.description || '',
    example: p.example || (p.schema ? p.schema.example : null),
  }));
}

/**
 * Extract request body schema from an operation (OpenAPI 3.0).
 * @param {object} requestBody - OpenAPI requestBody object.
 * @returns {object|null}
 */
function extractRequestBody(requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content;
  if (!content) return null;

  const mediaType = content['application/json'] || content['application/x-www-form-urlencoded'] || Object.values(content)[0];
  if (!mediaType || !mediaType.schema) return null;

  return {
    required: requestBody.required || false,
    schema: mediaType.schema,
    properties: flattenSchema(mediaType.schema, '', mediaType.schema.required || []),
  };
}

/**
 * Extract response details.
 * @param {object} responses - OpenAPI responses object.
 * @returns {Array<object>}
 */
function extractResponses(responses = {}) {
  return Object.entries(responses).map(([statusCode, resp]) => {
    let schema = null;
    let properties = [];
    if (resp.content && resp.content['application/json'] && resp.content['application/json'].schema) {
      schema = resp.content['application/json'].schema;
      properties = flattenSchema(schema, '', schema.required || []);
    } else if (resp.schema) {
      // Swagger 2.0
      schema = resp.schema;
      properties = flattenSchema(schema, '', schema.required || []);
    }
    return {
      statusCode,
      description: resp.description || '',
      schema,
      properties,
    };
  });
}

/**
 * Parse a dereferenced OpenAPI/Swagger spec into an array of endpoint objects.
 * @param {object} api - Dereferenced API spec object.
 * @returns {Array<object>}
 */
function extractEndpoints(api) {
  const endpoints = [];
  const paths = api.paths || {};

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
    // Path-level parameters
    const pathParams = pathItem.parameters || [];

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      // Merge path-level and operation-level parameters
      const allParams = [...pathParams, ...(operation.parameters || [])];

      // OpenAPI 3.0 requestBody or Swagger 2.0 body parameter
      let requestBody = null;
      if (operation.requestBody) {
        requestBody = extractRequestBody(operation.requestBody);
      } else {
        // Swagger 2.0: look for body param
        const bodyParam = allParams.find(p => p.in === 'body');
        if (bodyParam && bodyParam.schema) {
          requestBody = {
            required: bodyParam.required || false,
            schema: bodyParam.schema,
            properties: flattenSchema(bodyParam.schema, '', bodyParam.schema.required || []),
          };
        }
      }

      // Security
      const security = operation.security || api.security || [];

      endpoints.push({
        method: method.toUpperCase(),
        path: pathStr,
        operationId: operation.operationId || null,
        summary: operation.summary || '',
        description: operation.description || '',
        tags: operation.tags || [],
        parameters: extractParameters(allParams.filter(p => p.in !== 'body')),
        requestBody,
        responses: extractResponses(operation.responses),
        security: security.length > 0 ? security : null,
        deprecated: operation.deprecated || false,
      });
    }
  }

  return endpoints;
}

/**
 * Parse a Swagger/OpenAPI file from a file path.
 * @param {string} filePath - Path to .json, .yaml, or .yml file.
 * @returns {Promise<Array<object>>} Array of endpoint objects.
 */
async function parseSwaggerFile(filePath) {
  try {
    const resolvedPath = path.resolve(filePath);
    logger.debug(`Parsing swagger file: ${resolvedPath}`);

    const api = await SwaggerParser.dereference(resolvedPath, {
      dereference: { circular: 'ignore' },
    });

    const endpoints = extractEndpoints(api);
    logger.debug(`Extracted ${endpoints.length} endpoints from ${path.basename(filePath)}`);
    return endpoints;
  } catch (err) {
    logger.error(`Failed to parse swagger file: ${err.message}`);
    throw err;
  }
}

/**
 * Parse a Swagger/OpenAPI spec from a raw JSON or YAML string.
 * @param {string} content - Raw JSON or YAML string.
 * @returns {Promise<Array<object>>} Array of endpoint objects.
 */
async function parseSwaggerString(content) {
  try {
    let spec;
    try {
      spec = JSON.parse(content);
    } catch {
      spec = yaml.load(content);
    }

    const api = await SwaggerParser.dereference(spec, {
      dereference: { circular: 'ignore' },
    });

    const endpoints = extractEndpoints(api);
    logger.debug(`Extracted ${endpoints.length} endpoints from string input`);
    return endpoints;
  } catch (err) {
    logger.error(`Failed to parse swagger content: ${err.message}`);
    throw err;
  }
}

module.exports = {
  parseSwaggerFile,
  parseSwaggerString,
  extractEndpoints,
  flattenSchema,
};
