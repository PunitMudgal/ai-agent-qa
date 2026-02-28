/**
 * @module markdownFormatter
 * @description Formats and saves test cases as readable Markdown documents.
 */

const { writeFile } = require('../utils/fileUtils');
const logger = require('../utils/logger');

/**
 * Format test cases into a Markdown string.
 * @param {Array<object>} testCases - Array of test case objects.
 * @returns {string} Markdown content.
 */
function formatTestCases(testCases) {
  const lines = [];
  const date = new Date().toISOString().split('T')[0];

  // Group by endpoint
  const groupedByEndpoint = {};
  for (const tc of testCases) {
    const key = tc.endpoint || 'Unknown Endpoint';
    if (!groupedByEndpoint[key]) groupedByEndpoint[key] = [];
    groupedByEndpoint[key].push(tc);
  }

  // Count by category (overall)
  const countByCategory = {};
  for (const tc of testCases) {
    const cat = tc.category || 'unknown';
    countByCategory[cat] = (countByCategory[cat] || 0) + 1;
  }

  // Title
  lines.push(`# QA Test Cases Report`);
  lines.push(`**Generated:** ${date} | **Total:** ${testCases.length} test cases | **Endpoints:** ${Object.keys(groupedByEndpoint).length}`);
  lines.push(`**Generator:** QA Test Generator (Groq + Llama 3.3)`);
  lines.push('');

  // Overall summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  for (const [cat, count] of Object.entries(countByCategory).sort()) {
    lines.push(`| ${capitalize(cat)} | ${count} |`);
  }
  lines.push('');

  // Endpoint summary
  lines.push('## Endpoints');
  lines.push('');
  lines.push('| Endpoint | Test Cases |');
  lines.push('|----------|------------|');
  for (const [ep, tcs] of Object.entries(groupedByEndpoint)) {
    lines.push(`| ${ep} | ${tcs.length} |`);
  }
  lines.push('');

  // Detailed test cases grouped by endpoint
  lines.push('---');
  lines.push('');
  lines.push('## Test Cases');
  lines.push('');

  for (const [endpoint, tcs] of Object.entries(groupedByEndpoint)) {
    lines.push(`### ${endpoint}`);
    lines.push('');

    for (const tc of tcs) {
      lines.push(`#### ${tc.id} — ${tc.scenario}`);
      lines.push(`**Category:** ${capitalize(tc.category || 'unknown')} | **Priority:** ${capitalize(tc.priority || 'medium')} | **Status:** ${tc.status || 'Pending'}`);
      lines.push('');

      // Input data
      lines.push('**Input:**');
      if (tc.inputData) {
        if (tc.inputData.headers && Object.keys(tc.inputData.headers).length > 0) {
          lines.push(`- **Headers:** \`${JSON.stringify(tc.inputData.headers)}\``);
        }
        if (tc.inputData.pathParams && Object.keys(tc.inputData.pathParams).length > 0) {
          lines.push(`- **Path Params:** \`${JSON.stringify(tc.inputData.pathParams)}\``);
        }
        if (tc.inputData.queryParams && Object.keys(tc.inputData.queryParams).length > 0) {
          lines.push(`- **Query Params:** \`${JSON.stringify(tc.inputData.queryParams)}\``);
        }
        if (tc.inputData.body && Object.keys(tc.inputData.body).length > 0) {
          lines.push('- **Body:**');
          lines.push('```json');
          lines.push(JSON.stringify(tc.inputData.body, null, 2));
          lines.push('```');
        }
      }
      lines.push('');

      // Expected output
      lines.push('**Expected Output:**');
      if (tc.expectedOutput) {
        lines.push(`- **Status Code:** ${tc.expectedOutput.statusCode}`);
        if (tc.expectedOutput.bodyContains && Object.keys(tc.expectedOutput.bodyContains).length > 0) {
          lines.push(`- **Body Contains:** \`${JSON.stringify(tc.expectedOutput.bodyContains)}\``);
        }
        if (tc.expectedOutput.bodyExcludes && tc.expectedOutput.bodyExcludes.length > 0) {
          lines.push(`- **Body Excludes:** ${tc.expectedOutput.bodyExcludes.join(', ')}`);
        }
      }
      lines.push('');

      // Preconditions & notes
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

/**
 * Capitalize the first letter of a string.
 * @param {string} str
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Save markdown content to a file.
 * @param {string} content - Markdown string.
 * @param {string} outputPath - File path.
 * @returns {Promise<void>}
 */
async function saveToFile(content, outputPath) {
  try {
    await writeFile(outputPath, content);
    logger.debug(`Markdown file written: ${outputPath}`);
  } catch (err) {
    logger.error(`Failed to save Markdown file: ${err.message}`);
    throw err;
  }
}

module.exports = {
  formatTestCases,
  saveToFile,
};
