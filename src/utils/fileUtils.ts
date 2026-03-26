/**
 * @module fileUtils
 * @description File system utilities for reading, writing, scanning, and path generation.
 */

import { parse as acornParse } from 'acorn';
import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { glob } from 'glob';

export async function ensureOutputDir(dirPath: string): Promise<void> {
  await fs.ensureDir(dirPath);
}

/** Build a filesystem-safe slug from method + path (e.g. "POST /users" -> "post-users") */
export function endpointToSlug(endpoint: string): string {
  return endpoint
    .toLowerCase()
    .replace(/^(get|post|put|delete|patch|options|head)\s*/i, (m) => m.trim().toLowerCase() + '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'api';
}

export function generateOutputFilename(endpoint: string, format: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = endpointToSlug(endpoint);
  const ext = format === 'markdown' ? 'md' : format;
  return `${date}_${slug}_testcases.${ext}`;
}

/** Filename for a Jest test file for one endpoint (e.g. "post-subscription-reminder.test.js") */
export function generateJestTestFilename(endpoint: string): string {
  return `${endpointToSlug(endpoint)}.test.js`;
}

export function generateBatchFilename(format: string): string {
  const date = new Date().toISOString().split('T')[0];
  const ext = format === 'markdown' ? 'md' : format;
  return `${date}_full-api_testcases.${ext}`;
}

export async function readJsonOrYaml(filePath: string): Promise<object> {
  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content) as object;
  }
  return JSON.parse(content) as object;
}

export async function scanDirectory(
  dir: string,
  extensions: string[] = ['.js', '.ts']
): Promise<string[]> {
  const pattern =
    extensions.length === 1 ? `**/*${extensions[0]}` : `**/*{${extensions.join(',')}}`;
  const files = await glob(pattern, {
    cwd: dir,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  });
  return files;
}

export async function readFileContent(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Validate generated Jest test file for syntax errors, then write.
 * Returns true if valid and written, false if invalid (file not written).
 */
export async function validateAndWriteJestFile(
  filePath: string,
  content: string
): Promise<boolean> {
  try {
    acornParse(content, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch {
    return false;
  }
  await writeFile(filePath, content);
  return true;
}

export async function listFiles(dir: string, recursive = false): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        files.push(entryPath);
        continue;
      }
      if (recursive && entry.isDirectory()) {
        files.push(...(await listFiles(entryPath, true)));
      }
    }

    return files;
  } catch {
    return [];
  }
}
