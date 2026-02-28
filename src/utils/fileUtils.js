/**
 * @module fileUtils
 * @description File system utilities for reading, writing, scanning, and path generation.
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { glob } = require('glob');

/**
 * Ensure that the output directory exists; create it if missing.
 * @param {string} dirPath - Directory path to ensure.
 * @returns {Promise<void>}
 */
async function ensureOutputDir(dirPath) {
  await fs.ensureDir(dirPath);
}

/**
 * Generate a slugified output filename with date prefix.
 * @param {string} endpoint - Endpoint path, e.g. "POST /users/register".
 * @param {string} format - File format: 'json' or 'md'.
 * @returns {string} Filename like "2024-01-15_post-users-register_testcases.json".
 */
function generateOutputFilename(endpoint, format) {
  const date = new Date().toISOString().split('T')[0];
  const slug = endpoint
    .toLowerCase()
    .replace(/^(get|post|put|delete|patch)\s*/i, (m) => m.trim().toLowerCase() + '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const ext = format === 'markdown' ? 'md' : format;
  return `${date}_${slug}_testcases.${ext}`;
}

/**
 * Generate a batch output filename.
 * @param {string} format - 'json' or 'md'.
 * @returns {string}
 */
function generateBatchFilename(format) {
  const date = new Date().toISOString().split('T')[0];
  const ext = format === 'markdown' ? 'md' : format;
  return `${date}_full-api_testcases.${ext}`;
}

/**
 * Read a file and parse it as JSON or YAML based on extension.
 * @param {string} filePath - Path to the file.
 * @returns {Promise<object>} Parsed content.
 */
async function readJsonOrYaml(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content);
  }
  return JSON.parse(content);
}

/**
 * Scan a directory recursively for files matching given extensions.
 * @param {string} dir - Directory to scan.
 * @param {string[]} extensions - Array of extensions to match (e.g., ['.js', '.ts']).
 * @returns {Promise<string[]>} Array of matching file paths.
 */
async function scanDirectory(dir, extensions = ['.js', '.ts']) {
  const pattern = extensions.length === 1
    ? `**/*${extensions[0]}`
    : `**/*{${extensions.join(',')}}`;
  const files = await glob(pattern, {
    cwd: dir,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  });
  return files;
}

/**
 * Read a file as UTF-8 string.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileContent(filePath) {
  return fs.readFile(filePath, 'utf-8');
}

/**
 * Write content to a file, ensuring the parent directory exists.
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeFile(filePath, content) {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * List files in a directory (non-recursive).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile())
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

module.exports = {
  ensureOutputDir,
  generateOutputFilename,
  generateBatchFilename,
  readJsonOrYaml,
  scanDirectory,
  readFileContent,
  writeFile,
  listFiles,
};
