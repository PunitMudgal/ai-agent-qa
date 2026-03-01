/**
 * @module groqClient
 * @description Groq API wrapper with retry logic and error handling.
 */

import Groq from 'groq-sdk';
import * as logger from '../utils/logger';

type GroqClientInstance = InstanceType<typeof Groq>;

let groqClient: GroqClientInstance | null = null;

export function initGroqClient(apiKey?: string): GroqClientInstance {
  const key = apiKey ?? process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') {
    throw new Error(
      'Groq API key not configured. Set GROQ_API_KEY in your .env file.\n' +
        'Get a free API key at: https://console.groq.com'
    );
  }
  groqClient = new Groq({ apiKey: key });
  return groqClient;
}

export function getClient(): GroqClientInstance {
  if (!groqClient) {
    return initGroqClient();
  }
  return groqClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function extractJsonArray(text: string): unknown[] {
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]) as unknown[];
      } catch {
        logger.warn('Found JSON array pattern but failed to parse it');
      }
    }

    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return [JSON.parse(objMatch[0]) as object];
      } catch {
        // ignore
      }
    }

    throw new Error('Could not extract valid JSON from AI response');
  }
}

export interface GenerateTestCasesOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  model?: string;
}

interface GroqErrorLike {
  status?: number;
  code?: string;
  message?: string;
  error?: { message?: string };
}

function isGroqErrorLike(err: unknown): err is GroqErrorLike {
  return typeof err === 'object' && err !== null;
}

export async function generateTestCases(
  prompt: string,
  options: GenerateTestCasesOptions = {}
): Promise<unknown[]> {
  const client = getClient();
  const model = options.model ?? process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  const maxTokens = options.maxTokens ?? 4000;
  const temperature = options.temperature ?? 0.3;
  const maxRetries = options.retries ?? 3;

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  let lastError: unknown = null;
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
    } catch (err: unknown) {
      lastError = err;

      if (isGroqErrorLike(err)) {
        const status = err.status;
        const message = err.message ?? '';

        if (status === 429 || message.includes('rate_limit')) {
          const errText = [message, err.error?.message, JSON.stringify(err)]
            .filter(Boolean)
            .join(' ');
          const isDailyLimit = /tokens per day|\btpd\b/i.test(errText);
          if (isDailyLimit) {
            const e = new Error(
              'Groq daily token limit reached. Use --filter-paths or --filter-tags to generate for fewer endpoints, or try again after the limit resets.'
            ) as Error & { code?: string };
            e.code = 'GROQ_DAILY_LIMIT';
            throw e;
          }
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(
            `Rate limited. Retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`
          );
          await sleep(delay);
          continue;
        }

        if (status === 401) {
          throw new Error(
            'Invalid Groq API key. Please check your GROQ_API_KEY in .env file.\n' +
              'Get a free key at: https://console.groq.com'
          );
        }

        if (
          attempt < maxRetries &&
          ((typeof status === 'number' && status >= 500) || err.code === 'ECONNRESET')
        ) {
          const delay = Math.pow(2, attempt) * 500;
          logger.warn(`API error: ${message}. Retrying in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
      }

      if (
        err instanceof Error &&
        err.message.includes('Could not extract valid JSON') &&
        attempt < maxRetries
      ) {
        logger.warn(`Malformed JSON response. Retrying (attempt ${attempt}/${maxRetries})...`);
        await sleep(1000);
        continue;
      }

      throw err;
    }
  }

  throw lastError ?? new Error('Failed to generate test cases after all retries');
}
