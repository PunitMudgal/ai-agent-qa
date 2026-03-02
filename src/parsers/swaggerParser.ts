/**
 * @module swaggerParser
 * @description Parses OpenAPI 3.0 and Swagger 2.0 specifications to extract endpoint details.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import path from 'path';
import yaml from 'js-yaml';
import * as logger from '../utils/logger';
import type { Endpoint, Parameter, RequestBody, ResponseItem, SchemaProperty } from '../types';

/** Minimal OpenAPI schema shape for parsing */
interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchema & { required?: string[]; items?: OpenAPISchema }>;
  required?: string[];
  format?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  description?: string;
  default?: unknown;
  nullable?: boolean;
  example?: unknown;
  minItems?: number;
  maxItems?: number;
  items?: OpenAPISchema;
  allOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
}

export function flattenSchema(
  schema: OpenAPISchema | null | undefined,
  prefix = '',
  requiredFields: string[] = []
): SchemaProperty[] {
  if (!schema) return [];
  const props: SchemaProperty[] = [];

  if ((schema.type === 'object' || (!schema.type && schema.properties)) && schema.properties) {
    const req = schema.required ?? requiredFields;
    for (const [name, prop] of Object.entries(schema.properties)) {
      const fullName = prefix ? `${prefix}.${name}` : name;
      if (prop && typeof prop === 'object' && prop.type === 'object' && prop.properties) {
        props.push(
          ...flattenSchema(prop, fullName, (prop as OpenAPISchema).required ?? [])
        );
      } else if (prop && typeof prop === 'object' && prop.type === 'array' && prop.items) {
        const itemType = (prop as OpenAPISchema).items;
        props.push({
          name: fullName,
          type: 'array',
          items: itemType?.type ?? 'object',
          required: req.includes(name),
          description: (prop as OpenAPISchema).description ?? '',
          minItems: (prop as OpenAPISchema).minItems,
          maxItems: (prop as OpenAPISchema).maxItems,
        });
        if (itemType?.type === 'object' && itemType.properties) {
          props.push(
            ...flattenSchema(itemType, `${fullName}[]`, itemType.required ?? [])
          );
        }
      } else if (prop && typeof prop === 'object') {
        const p = prop as OpenAPISchema;
        props.push({
          name: fullName,
          type: p.type ?? 'string',
          required: req.includes(name),
          format: p.format ?? null,
          enum: p.enum ?? null,
          minLength: p.minLength != null ? p.minLength : null,
          maxLength: p.maxLength != null ? p.maxLength : null,
          minimum: p.minimum != null ? p.minimum : null,
          maximum: p.maximum != null ? p.maximum : null,
          pattern: p.pattern ?? null,
          description: p.description ?? '',
          default: p.default != null ? p.default : null,
          nullable: p.nullable ?? false,
          example: p.example != null ? p.example : null,
        });
      }
    }
  } else if (schema.allOf) {
    const merged = mergeAllOf(schema.allOf);
    props.push(...flattenSchema(merged, prefix, requiredFields));
  } else if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf ?? schema.anyOf ?? [];
    if (variants.length > 0) {
      props.push(...flattenSchema(variants[0], prefix, requiredFields));
    }
  }

  return props;
}

interface MergedSchema {
  type: string;
  properties: Record<string, OpenAPISchema>;
  required: string[];
}

function mergeAllOf(schemas: OpenAPISchema[]): MergedSchema {
  const merged: MergedSchema = { type: 'object', properties: {}, required: [] };
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

interface OpenAPIParameter {
  name: string;
  in: string;
  required?: boolean;
  type?: string;
  format?: string;
  enum?: unknown[];
  description?: string;
  example?: unknown;
  schema?: OpenAPISchema;
}

function extractParameters(params: OpenAPIParameter[] = []): Parameter[] {
  return params.map(p => ({
    name: p.name,
    in: p.in,
    required: p.required ?? false,
    type: p.schema ? (p.schema.type as string) : (p.type ?? 'string'),
    format: p.schema ? (p.schema.format as string | null) : (p.format ?? null),
    enum: p.schema ? p.schema.enum : (p.enum ?? null),
    description: p.description ?? '',
    example: p.schema?.example ?? p.example ?? undefined,
  }));
}

interface OpenAPIRequestBody {
  required?: boolean;
  content?: Record<
    string,
    { schema?: OpenAPISchema }
  >;
}

function extractRequestBody(requestBody: OpenAPIRequestBody | null): RequestBody | null {
  if (!requestBody) return null;
  const content = requestBody.content;
  if (!content) return null;

  const mediaType =
    content['application/json'] ??
    content['application/x-www-form-urlencoded'] ??
    (Object.values(content)[0] as { schema?: OpenAPISchema } | undefined);
  if (!mediaType?.schema) return null;

  const schema = mediaType.schema;
  return {
    required: requestBody.required ?? false,
    schema: schema as Record<string, unknown>,
    properties: flattenSchema(schema, '', schema.required ?? []),
  };
}

interface OpenAPIResponse {
  description?: string;
  schema?: OpenAPISchema;
  content?: Record<string, { schema?: OpenAPISchema }>;
}

function extractResponses(responses: Record<string, OpenAPIResponse> = {}): ResponseItem[] {
  return Object.entries(responses).map(([statusCode, resp]) => {
    let schema: OpenAPISchema | null = null;
    let properties: SchemaProperty[] = [];
    if (
      resp.content?.['application/json']?.schema
    ) {
      schema = resp.content['application/json'].schema;
      properties = flattenSchema(schema, '', schema?.required ?? []);
    } else if (resp.schema) {
      schema = resp.schema;
      properties = flattenSchema(schema, '', schema.required ?? []);
    }
    return {
      statusCode,
      description: resp.description ?? '',
      schema: schema as Record<string, unknown> | null,
      properties,
    };
  });
}

interface OpenAPIPathItem {
  parameters?: OpenAPIParameter[];
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  options?: OpenAPIOperation;
  head?: OpenAPIOperation;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, OpenAPIResponse>;
  security?: unknown[];
  deprecated?: boolean;
}

interface OpenAPISpec {
  paths?: Record<string, OpenAPIPathItem>;
  security?: unknown[];
}

export function extractEndpoints(api: OpenAPISpec): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const paths = api.paths ?? {};

  const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'] as const;

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    const pathParams = pathItem.parameters ?? [];

    for (const method of methods) {
      const operation = pathItem[method] as OpenAPIOperation | undefined;
      if (!operation) continue;

      const allParams = [...pathParams, ...(operation.parameters ?? [])];

      let requestBody: RequestBody | null = null;
      if (operation.requestBody) {
        requestBody = extractRequestBody(operation.requestBody);
      } else {
        const bodyParam = allParams.find((p: OpenAPIParameter) => p.in === 'body');
        if (bodyParam?.schema) {
          requestBody = {
            required: bodyParam.required ?? false,
            schema: bodyParam.schema as Record<string, unknown>,
            properties: flattenSchema(bodyParam.schema, '', bodyParam.schema.required ?? []),
          };
        }
      }

      const security = operation.security ?? api.security ?? [];

      endpoints.push({
        method: method.toUpperCase(),
        path: pathStr,
        operationId: operation.operationId ?? null,
        summary: operation.summary ?? '',
        description: operation.description ?? '',
        tags: operation.tags ?? [],
        parameters: extractParameters(allParams.filter((p: OpenAPIParameter) => p.in !== 'body')),
        requestBody,
        responses: extractResponses(operation.responses),
        security: security.length > 0 ? security : null,
        deprecated: operation.deprecated ?? false,
      });
    }
  }

  return endpoints;
}

export async function parseSwaggerFile(filePath: string): Promise<Endpoint[]> {
  try {
    const resolvedPath = path.resolve(filePath);
    logger.debug(`Parsing swagger file: ${resolvedPath}`);

    const api = (await SwaggerParser.dereference(resolvedPath, {
      dereference: { circular: 'ignore' },
    })) as OpenAPISpec;

    const endpoints = extractEndpoints(api);
    logger.debug(`Extracted ${endpoints.length} endpoints from ${path.basename(filePath)}`);
    return endpoints;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to parse swagger file: ${message}`);
    throw err;
  }
}

export async function parseSwaggerString(content: string): Promise<Endpoint[]> {
  try {
    let spec: OpenAPISpec;
    try {
      spec = JSON.parse(content) as OpenAPISpec;
    } catch {
      spec = yaml.load(content) as OpenAPISpec;
    }

    const api = (await SwaggerParser.dereference(spec as unknown as Parameters<typeof SwaggerParser.dereference>[0], {
      dereference: { circular: 'ignore' },
    })) as OpenAPISpec;

    const endpoints = extractEndpoints(api);
    logger.debug(`Extracted ${endpoints.length} endpoints from string input`);
    return endpoints;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to parse swagger content: ${message}`);
    throw err;
  }
}
