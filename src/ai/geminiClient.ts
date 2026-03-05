/**
 * @module geminiClient
 * @description Google Gemini API client for fallback when Groq is unavailable.
 */

import { GoogleGenAI } from '@google/genai';
import * as logger from '../utils/logger';
import { extractJsonArray } from './groqClient';

let geminiClient: GoogleGenAI | null = null;

const GEMINI_PLACEHOLDER = 'your_gemini_api_key_here';

export function hasGeminiKey(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return !!(key && key.trim() && key !== GEMINI_PLACEHOLDER);
}

export function initGeminiClient(apiKey?: string): GoogleGenAI | null {
  const key = (apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
  if (!key || key === GEMINI_PLACEHOLDER) {
    return null;
  }
  geminiClient = new GoogleGenAI({ apiKey: key });
  return geminiClient;
}

export function getGeminiClient(): GoogleGenAI | null {
  if (!geminiClient && hasGeminiKey()) {
    initGeminiClient();
  }
  return geminiClient;
}

export interface GeminiGenerateOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export async function generateWithGemini(
  prompt: string,
  options: GeminiGenerateOptions = {}
): Promise<unknown[]> {
  const client = getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API key not configured. Set GEMINI_API_KEY in your .env file.\n' +
        'Get a free API key at: https://aistudio.google.com/apikey'
    );
  }

  const model = options.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
  const maxTokens = options.maxTokens ?? 8192;
  const temperature = options.temperature ?? 0.3;

  const fullPrompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  logger.debug(`Gemini API call | model: ${model}`);

  const startTime = Date.now();

  let response: { text?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    response = await client.models.generateContent({
      model,
      contents: fullPrompt,
      config: {
        maxOutputTokens: maxTokens,
        temperature,
        responseMimeType: 'application/json',
      },
    });
  } catch (err) {
    if (String(err).includes('responseMimeType') || String(err).includes('response_mime_type')) {
      response = await client.models.generateContent({
        model,
        contents: fullPrompt,
        config: {
          maxOutputTokens: maxTokens,
          temperature,
        },
      });
    } else {
      throw err;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.debug(`Gemini API responded in ${elapsed}s`);

  let text =
    (response as { text?: string }).text ??
    response.candidates?.[0]?.content?.parts?.[0]?.text ??
    '';
  if (!text) {
    throw new Error('Empty response from Gemini API');
  }

  const testCases = extractJsonArray(text);
  logger.debug(`Parsed ${testCases.length} test cases from Gemini response`);
  return testCases;
}
