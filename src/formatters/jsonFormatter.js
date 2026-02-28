/**
 * @module jsonFormatter
 * @description Formats and saves test cases as structured JSON with metadata.
 */

const { writeFile } = require('../utils/fileUtils');
const logger = require('../utils/logger');

/**
 * Format test cases with metadata wrapper.
 * @param {Array<object>} testCases - Raw test case array.
 * @returns {object} Formatted output with metadata.
 */
function formatTestCases(testCases) {
  // Count by category
  const countByCategory = {};
  const countByEndpoint = {};
  const countByPriority = {};

  for (const tc of testCases) {
    const cat = tc.category || 'unknown';
    countByCategory[cat] = (countByCategory[cat] || 0) + 1;

    const ep = tc.endpoint || 'unknown';
    countByEndpoint[ep] = (countByEndpoint[ep] || 0) + 1;

    const pri = tc.priority || 'medium';
    countByPriority[pri] = (countByPriority[pri] || 0) + 1;
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
      id: tc.id || '',
      endpoint: tc.endpoint || '',
      method: tc.method || '',
      scenario: tc.scenario || '',
      category: tc.category || 'unknown',
      priority: tc.priority || 'medium',
      inputData: tc.inputData || { headers: {}, pathParams: {}, queryParams: {}, body: {} },
      expectedOutput: tc.expectedOutput || { statusCode: 200, bodyContains: {}, bodyExcludes: [], headers: {} },
      preconditions: tc.preconditions || '',
      notes: tc.notes || '',
      status: tc.status || 'Pending',
    })),
  };
}

/**
 * Save formatted test cases to a JSON file.
 * @param {object} formatted - Output from formatTestCases.
 * @param {string} outputPath - File path to save to.
 * @returns {Promise<void>}
 */
async function saveToFile(formatted, outputPath) {
  try {
    const content = JSON.stringify(formatted, null, 2);
    await writeFile(outputPath, content);
    logger.debug(`JSON file written: ${outputPath} (${content.length} bytes)`);
  } catch (err) {
    logger.error(`Failed to save JSON file: ${err.message}`);
    throw err;
  }
}

module.exports = {
  formatTestCases,
  saveToFile,
};
