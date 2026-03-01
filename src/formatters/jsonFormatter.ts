/**
 * @module jsonFormatter
 * @description Formats and saves test cases as structured JSON with metadata.
 */

import { writeFile } from '../utils/fileUtils';
import * as logger from '../utils/logger';
import type { TestCase, FormattedJsonOutput } from '../types';

export function formatTestCases(testCases: TestCase[]): FormattedJsonOutput {
  const countByCategory: Record<string, number> = {};
  const countByEndpoint: Record<string, number> = {};
  const countByPriority: Record<string, number> = {};

  for (const tc of testCases) {
    const cat = tc.category ?? 'unknown';
    countByCategory[cat] = (countByCategory[cat] ?? 0) + 1;

    const ep = tc.endpoint ?? 'unknown';
    countByEndpoint[ep] = (countByEndpoint[ep] ?? 0) + 1;

    const pri = tc.priority ?? 'medium';
    countByPriority[pri] = (countByPriority[pri] ?? 0) + 1;
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalCount: testCases.length,
      countByCategory,
      countByEndpoint,
      countByPriority,
      generator: 'QA Test Generator (Groq + Llama 3.3)',
    },
    testCases: testCases.map(tc => ({
      id: tc.id ?? '',
      endpoint: tc.endpoint ?? '',
      method: tc.method ?? '',
      scenario: tc.scenario ?? '',
      category: tc.category ?? 'unknown',
      priority: tc.priority ?? 'medium',
      inputData: tc.inputData ?? {
        headers: {},
        pathParams: {},
        queryParams: {},
        body: {},
      },
      expectedOutput: tc.expectedOutput ?? {
        statusCode: 200,
        bodyContains: {},
        bodyExcludes: [],
        headers: {},
      },
      preconditions: tc.preconditions ?? '',
      notes: tc.notes ?? '',
      status: tc.status ?? 'Pending',
    })),
  };
}

export async function saveToFile(
  formatted: FormattedJsonOutput,
  outputPath: string
): Promise<void> {
  try {
    const content = JSON.stringify(formatted, null, 2);
    await writeFile(outputPath, content);
    logger.debug(`JSON file written: ${outputPath} (${content.length} bytes)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to save JSON file: ${message}`);
    throw err;
  }
}
