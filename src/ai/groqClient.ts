/**
 * @module groqClient
 * @description Groq API wrapper with retry logic and Gemini fallback when Groq is unavailable.
 */

import Groq from 'groq-sdk';
import * as logger from '../utils/logger';
import { hasGeminiKey, initGeminiClient, generateWithGemini } from './geminiClient';

type GroqClientInstance = InstanceType<typeof Groq>;

const GROQ_PLACEHOLDER = 'your_groq_api_key_here';

let groqClient: GroqClientInstance | null = null;

export function hasGroqKey(): boolean {
  const key = process.env.GROQ_API_KEY;
  return !!(key && key.trim() && key !== GROQ_PLACEHOLDER);
}

export function initGroqClient(apiKey?: string): GroqClientInstance | null {
  const key = (apiKey ?? process.env.GROQ_API_KEY ?? '').trim();
  if (!key || key === GROQ_PLACEHOLDER) {
    return null;
  }
  groqClient = new Groq({ apiKey: key });
  return groqClient;
}

/**
 * Initialize AI providers. Requires at least one of GROQ_API_KEY or GEMINI_API_KEY.
 * Prefers Groq when both are available.
 */
export function initAIProvider(): void {
  const groqOk = hasGroqKey();
  const geminiOk = hasGeminiKey();

  if (!groqOk && !geminiOk) {
    throw new Error(
      'No AI API key configured. Set at least one of:\n' +
        '  - GROQ_API_KEY (https://console.groq.com)\n' +
        '  - GEMINI_API_KEY (https://aistudio.google.com/apikey)'
    );
  }

  if (groqOk) {
    initGroqClient();
    if (geminiOk) {
      initGeminiClient();
      logger.debug('AI: Groq primary, Gemini fallback');
    } else {
      logger.debug('AI: Groq only');
    }
  } else {
    initGeminiClient();
    logger.debug('AI: Gemini only');
  }
}

export function getClient(): GroqClientInstance | null {
  if (!groqClient && hasGroqKey()) {
    initGroqClient();
  }
  return groqClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function repairJson(text: string): string {
  let s = text;

  s = s.replace(/,\s*([}\]])/g, '$1');

  s = s.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');

  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');

  s = s.replace(/,\s*$/gm, ',');

  return s;
}

function findMatchingBracket(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParseWithRepair(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // try repair
  }

  const repaired = repairJson(text);
  try {
    const parsed = JSON.parse(repaired) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // try further fixups
  }

  const trimmedForClose = repaired.replace(/,\s*$/, '');
  for (const suffix of ['', '}]', ']', '"}]', '"}}]']) {
    try {
      const parsed = JSON.parse(trimmedForClose + suffix) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      continue;
    }
  }

  return null;
}

export function extractJsonArray(text: string): unknown[] {
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/^[^[{]*(?=[\[{])/s, '')
    .trim();

  const directResult = tryParseWithRepair(cleaned);
  if (directResult) {
    if (directResult.length === 1 && typeof directResult[0] === 'object' && directResult[0] !== null) {
      const obj = directResult[0] as Record<string, unknown>;
      if (Array.isArray(obj.testCases)) return obj.testCases;
      if (Array.isArray(obj.test_cases)) return obj.test_cases;
      if (Array.isArray(obj.tests)) return obj.tests;
      if (Array.isArray(obj.data)) return obj.data;
      if (Array.isArray(obj.results)) return obj.results;
    }
    return directResult;
  }

  const firstBracket = cleaned.indexOf('[');
  if (firstBracket !== -1) {
    const closingBracket = findMatchingBracket(cleaned, firstBracket);
    if (closingBracket !== -1) {
      const candidate = cleaned.substring(firstBracket, closingBracket + 1);
      const result = tryParseWithRepair(candidate);
      if (result) return result;
    }

    const fromBracket = cleaned.substring(firstBracket);
    const result = tryParseWithRepair(fromBracket);
    if (result) return result;

    logger.warn('Found JSON array pattern but failed to parse it');
  }

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace !== -1) {
    const fromBrace = cleaned.substring(firstBrace);
    const objMatch = fromBrace.match(/\{[\s\S]*?\}(?=\s*$|\s*,|\s*\])/);
    if (objMatch) {
      const result = tryParseWithRepair(objMatch[0]);
      if (result) return result;
    }
    const result = tryParseWithRepair(fromBrace);
    if (result) return result;
  }

  throw new Error('Could not extract valid JSON from AI response');
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

async function generateWithGroq(
  prompt: string,
  options: GenerateTestCasesOptions
): Promise<unknown[]> {
  const client = getClient();
  if (!client) throw new Error('Groq client not initialized');

  const model = options.model ?? process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  const maxTokens = options.maxTokens ?? 8000;
  const temperature = options.temperature ?? 0.3;

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
    });
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? '';
    if (msg.includes('response_format') || msg.includes('json_object')) {
      logger.debug('Model does not support response_format, retrying without it');
      completion = await client.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      });
    } else {
      throw err;
    }
  }

  const responseText = completion.choices[0]?.message?.content;
  if (!responseText) throw new Error('Empty response from Groq API');

  return extractJsonArray(responseText);
}

export async function generateTestCases(
  prompt: string,
  options: GenerateTestCasesOptions = {}
): Promise<unknown[]> {
  const maxRetries = options.retries ?? 3;
  const useGroq = hasGroqKey() && getClient();
  const useGemini = hasGeminiKey();

  const tryGroq = async (): Promise<unknown[]> => {
    const model = options.model ?? process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Groq API attempt ${attempt}/${maxRetries} | model: ${model}`);
        const startTime = Date.now();
        const testCases = await generateWithGroq(prompt, options);
        logger.debug(`Groq responded in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        return testCases;
      } catch (err: unknown) {
        lastErr = err;
        if (isGroqErrorLike(err)) {
          const status = err.status;
          const message = err.message ?? '';
          const errText = [message, err.error?.message, JSON.stringify(err)]
            .filter(Boolean)
            .join(' ');
          const isDailyLimit = /tokens per day|\btpd\b/i.test(errText);

          if (status === 429 || message.includes('rate_limit')) {
            if (isDailyLimit) {
              const e = new Error('Groq daily limit') as Error & { code?: string };
              e.code = 'GROQ_DAILY_LIMIT';
              throw e;
            }
            await sleep(Math.pow(2, attempt) * 1000);
            continue;
          }
          if (status === 401) throw err;
          if (
            attempt < maxRetries &&
            ((typeof status === 'number' && status >= 500) || err.code === 'ECONNRESET')
          ) {
            await sleep(Math.pow(2, attempt) * 500);
            continue;
          }
        }
        if (
          err instanceof Error &&
          err.message.includes('Could not extract valid JSON') &&
          attempt < maxRetries
        ) {
          await sleep(1000);
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('Groq failed');
  };

  if (useGroq) {
    try {
      return await tryGroq();
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'GROQ_DAILY_LIMIT' && useGemini) {
        logger.warn('Groq daily limit reached. Falling back to Google Gemini.');
        return generateWithGemini(prompt, {
          systemPrompt: options.systemPrompt,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        });
      }
      throw err;
    }
  }

  if (useGemini) {
    return generateWithGemini(prompt, {
      systemPrompt: options.systemPrompt,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
  }

  throw new Error(
    'No AI provider configured. Set GROQ_API_KEY and/or GEMINI_API_KEY in .env'
  );
}
