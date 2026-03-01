/**
 * @module markdownFormatter
 * @description Formats and saves test cases as readable Markdown documents.
 */

import { writeFile } from '../utils/fileUtils';
import * as logger from '../utils/logger';
import type { TestCase } from '../types';

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatTestCases(testCases: TestCase[]): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0];

  const groupedByEndpoint: Record<string, TestCase[]> = {};
  for (const tc of testCases) {
    const key = tc.endpoint ?? 'Unknown Endpoint';
    if (!groupedByEndpoint[key]) groupedByEndpoint[key] = [];
    groupedByEndpoint[key].push(tc);
  }

  const countByCategory: Record<string, number> = {};
  for (const tc of testCases) {
    const cat = tc.category ?? 'unknown';
    countByCategory[cat] = (countByCategory[cat] ?? 0) + 1;
  }

  lines.push(`# QA Test Cases Report`);
  lines.push(
    `**Generated:** ${date} | **Total:** ${testCases.length} test cases | **Endpoints:** ${Object.keys(groupedByEndpoint).length}`
  );
  lines.push(`**Generator:** QA Test Generator (Groq + Llama 3.3)`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  for (const [cat, count] of Object.entries(countByCategory).sort()) {
    lines.push(`| ${capitalize(cat)} | ${count} |`);
  }
  lines.push('');

  lines.push('## Endpoints');
  lines.push('');
  lines.push('| Endpoint | Test Cases |');
  lines.push('|----------|------------|');
  for (const [ep, tcs] of Object.entries(groupedByEndpoint)) {
    lines.push(`| ${ep} | ${tcs.length} |`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## Test Cases');
  lines.push('');

  for (const [endpoint, tcs] of Object.entries(groupedByEndpoint)) {
    lines.push(`### ${endpoint}`);
    lines.push('');

    for (const tc of tcs) {
      lines.push(`#### ${tc.id} — ${tc.scenario}`);
      lines.push(
        `**Category:** ${capitalize(tc.category ?? 'unknown')} | **Priority:** ${capitalize(tc.priority ?? 'medium')} | **Status:** ${tc.status ?? 'Pending'}`
      );
      lines.push('');

      lines.push('**Input:**');
      if (tc.inputData) {
        if (tc.inputData.headers && Object.keys(tc.inputData.headers).length > 0) {
          lines.push(`- **Headers:** \`${JSON.stringify(tc.inputData.headers)}\``);
        }
        if (tc.inputData.pathParams && Object.keys(tc.inputData.pathParams ?? {}).length > 0) {
          lines.push(`- **Path Params:** \`${JSON.stringify(tc.inputData.pathParams)}\``);
        }
        if (tc.inputData.queryParams && Object.keys(tc.inputData.queryParams ?? {}).length > 0) {
          lines.push(`- **Query Params:** \`${JSON.stringify(tc.inputData.queryParams)}\``);
        }
        if (tc.inputData.body && Object.keys(tc.inputData.body ?? {}).length > 0) {
          lines.push('- **Body:**');
          lines.push('```json');
          lines.push(JSON.stringify(tc.inputData.body, null, 2));
          lines.push('```');
        }
      }
      lines.push('');

      lines.push('**Expected Output:**');
      if (tc.expectedOutput) {
        lines.push(`- **Status Code:** ${tc.expectedOutput.statusCode}`);
        if (
          tc.expectedOutput.bodyContains &&
          Object.keys(tc.expectedOutput.bodyContains ?? {}).length > 0
        ) {
          lines.push(
            `- **Body Contains:** \`${JSON.stringify(tc.expectedOutput.bodyContains)}\``
          );
        }
        if (
          tc.expectedOutput.bodyExcludes &&
          tc.expectedOutput.bodyExcludes.length > 0
        ) {
          lines.push(
            `- **Body Excludes:** ${tc.expectedOutput.bodyExcludes.join(', ')}`
          );
        }
      }
      lines.push('');

      if (tc.preconditions) {
        lines.push(`**Preconditions:** ${tc.preconditions}`);
        lines.push('');
      }
      if (tc.notes) {
        lines.push(`**Notes:** ${tc.notes}`);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

export async function saveToFile(content: string, outputPath: string): Promise<void> {
  try {
    await writeFile(outputPath, content);
    logger.debug(`Markdown file written: ${outputPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to save Markdown file: ${message}`);
    throw err;
  }
}
