/**
 * @module groqClient
 * @description Groq API wrapper with retry logic and error handling.
 */

const Groq = require('groq-sdk');
const logger = require('../utils/logger');

let groqClient = null;

/**
 * Initialize the Groq API client.
 * @param {string} [apiKey] - Groq API key. Falls back to GROQ_API_KEY env var.
 * @returns {Groq} Groq client instance.
 */
function initGroqClient(apiKey) {
  const key = apiKey || process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') {
    throw new Error(
      'Groq API key not configured. Set GROQ_API_KEY in your .env file.\n' +
      'Get a free API key at: https://console.groq.com'
    );
  }
  groqClient = new Groq({ apiKey: key });
  return groqClient;
}

/**
 * Get the Groq client, initializing if needed.
 * @returns {Groq}
 */
function getClient() {
  if (!groqClient) {
    return initGroqClient();
  }
  return groqClient;
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract a JSON array from an LLM response that may include markdown fences or explanatory text.
 * @param {string} text - Raw response text.
 * @returns {Array} Parsed JSON array.
 */
function extractJsonArray(text) {
  // Strip markdown code fences
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Try to extract JSON array using regex
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {
        logger.warn('Found JSON array pattern but failed to parse it');
      }
    }

    // Try to extract JSON object
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return [JSON.parse(objMatch[0])];
      } catch {
        // ignore
      }
    }

    throw new Error('Could not extract valid JSON from AI response');
  }
}

/**
 * Generate test cases by calling the Groq API with retry logic.
 * @param {string} prompt - The user/system prompt content.
 * @param {object} [options]
 * @param {string} [options.systemPrompt] - System prompt.
 * @param {number} [options.maxTokens=4000] - Max tokens.
 * @param {number} [options.temperature=0.3] - Temperature.
 * @param {number} [options.retries=3] - Max retries.
 * @param {string} [options.model] - Model override.
 * @returns {Promise<Array>} Parsed test case array.
 */
async function generateTestCases(prompt, options = {}) {
  const client = getClient();
  const model = options.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const maxTokens = options.maxTokens || 4000;
  const temperature = options.temperature || 0.3;
  const maxRetries = options.retries || 3;

  const messages = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Groq API call attempt ${attempt}/${maxRetries} | model: ${model}`);

      const startTime = Date.now();
      const completion = await client.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.debug(`Groq API responded in ${elapsed}s`);

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        throw new Error('Empty response from Groq API');
      }

      const testCases = extractJsonArray(responseText);
      logger.debug(`Parsed ${testCases.length} test cases from response`);
      return testCases;
    } catch (err) {
      lastError = err;

      // Rate limit handling
      if (err.status === 429 || (err.message && err.message.includes('rate_limit'))) {
        const errText = [err.message, err.error?.message, JSON.stringify(err)].filter(Boolean).join(' ');
        const isDailyLimit = /tokens per day|\btpd\b/i.test(errText);
        if (isDailyLimit) {
          const e = new Error(
            'Groq daily token limit reached. Use --filter-paths or --filter-tags to generate for fewer endpoints, or try again after the limit resets.'
          );
          e.code = 'GROQ_DAILY_LIMIT';
          throw e;
        }
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        logger.warn(`Rate limited. Retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`);
        await sleep(delay);
        continue;
      }

      // Auth error
      if (err.status === 401) {
        throw new Error(
          'Invalid Groq API key. Please check your GROQ_API_KEY in .env file.\n' +
          'Get a free key at: https://console.groq.com'
        );
      }

      // Other retryable errors
      if (attempt < maxRetries && (err.status >= 500 || err.code === 'ECONNRESET')) {
        const delay = Math.pow(2, attempt) * 500;
        logger.warn(`API error: ${err.message}. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }

      // JSON parsing error — still retryable
      if (err.message && err.message.includes('Could not extract valid JSON') && attempt < maxRetries) {
        logger.warn(`Malformed JSON response. Retrying (attempt ${attempt}/${maxRetries})...`);
        await sleep(1000);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('Failed to generate test cases after all retries');
}

module.exports = {
  initGroqClient,
  getClient,
  generateTestCases,
  extractJsonArray,
};
