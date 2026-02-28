/**
 * @module controllerParser
 * @description Reads controller files and extracts business-logic hints for AI context.
 */

const path = require('path');
const logger = require('../utils/logger');
const { scanDirectory, readFileContent } = require('../utils/fileUtils');

/**
 * Extract hints from a single controller file.
 * @param {string} filePath - Path to the controller file.
 * @returns {Promise<Array<object>>} Array of controller-function hint objects.
 */
async function parseControllerFile(filePath) {
  const hints = [];
  try {
    const content = await readFileContent(filePath);
    const filename = path.basename(filePath);

    // Find exported functions (multiple patterns)
    const functionPatterns = [
      // module.exports = { funcName: async (req, res) => { ... } }
      /(\w+)\s*[:=]\s*async\s*(?:function\s*)?\((?:req|request)[\s,]/g,
      // exports.funcName = async (req, res) => { ... }
      /exports\.(\w+)\s*=\s*async\s*(?:function\s*)?\(/g,
      // const funcName = async (req, res) => { ... }
      /(?:const|let|var)\s+(\w+)\s*=\s*async\s*(?:function\s*)?\((?:req|request)[\s,]/g,
      // async function funcName(req, res) { ... }
      /async\s+function\s+(\w+)\s*\((?:req|request)[\s,]/g,
      // Non-async variants
      /(\w+)\s*[:=]\s*(?:function\s*)?\((?:req|request)[\s,][^)]*\)\s*(?:=>)?\s*{/g,
      /exports\.(\w+)\s*=\s*(?:function\s*)?\((?:req|request)/g,
    ];

    const funcNames = new Set();
    for (const pattern of functionPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        funcNames.add(match[1]);
      }
      pattern.lastIndex = 0;
    }

    for (const funcName of funcNames) {
      // Try to extract the function body (rough heuristic: find from name to next export/function)
      const funcBodyRegex = new RegExp(
        `(?:${funcName}[\\s\\S]*?(?:async\\s+)?(?:function\\s*)?\\([^)]*\\)\\s*(?:=>)?\\s*{)([\\s\\S]*?)(?=\\n(?:exports\\.|module\\.exports|(?:const|let|var)\\s+\\w+\\s*=\\s*async|async\\s+function|\\}\\s*;?\\s*$))`,
        'i'
      );
      const bodyMatch = funcBodyRegex.exec(content);
      const funcBody = bodyMatch ? bodyMatch[1] : content; // Fallback to full file

      const hint = {
        functionName: funcName,
        sourceFile: filePath,
        fileName: filename,
        statusCodes: [],
        thrownErrors: [],
        modelReferences: [],
        authChecks: [],
        validationChecks: [],
        jsdoc: '',
        conditionalBranches: 0,
      };

      // Extract status codes: res.status(XXX) or .status(XXX)
      const statusRegex = /\.status\s*\(\s*(\d{3})\s*\)/g;
      let statusMatch;
      while ((statusMatch = statusRegex.exec(funcBody)) !== null) {
        const code = parseInt(statusMatch[1]);
        if (!hint.statusCodes.includes(code)) {
          hint.statusCodes.push(code);
        }
      }

      // Extract thrown errors
      const throwRegex = /throw\s+new\s+(\w*Error)\s*\(\s*['"`]([^'"`]*)['"`]/g;
      let throwMatch;
      while ((throwMatch = throwRegex.exec(funcBody)) !== null) {
        hint.thrownErrors.push({ type: throwMatch[1], message: throwMatch[2] });
      }

      // Extract database model references (PascalCase names likely models)
      const modelRegex = /(?:await\s+)?([A-Z][a-zA-Z]+)\.(find|create|update|delete|findOne|findById|findAll|save|remove|destroy|count|aggregate|insertMany)/g;
      let modelMatch;
      while ((modelMatch = modelRegex.exec(funcBody)) !== null) {
        if (!hint.modelReferences.includes(modelMatch[1])) {
          hint.modelReferences.push(modelMatch[1]);
        }
      }

      // Detect auth checks
      const authPatterns = [
        /if\s*\(\s*!req\.user/g,
        /if\s*\(\s*!req\.auth/g,
        /req\.user\.role/g,
        /req\.user\.id/g,
        /isAuthenticated/g,
        /isAdmin/g,
        /authorize\s*\(/g,
      ];
      for (const pattern of authPatterns) {
        if (pattern.test(funcBody)) {
          hint.authChecks.push(pattern.source.replace(/\\s\*/g, ' ').replace(/\\/g, ''));
        }
        pattern.lastIndex = 0;
      }

      // Detect validation checks
      const validationPatterns = [
        { regex: /if\s*\(\s*![\w.]+\s*\)/g, desc: 'existence check' },
        { regex: /if\s*\(\s*[\w.]+\s*(?:===?|!==?)\s*(?:null|undefined|''|"")/g, desc: 'null/empty check' },
        { regex: /\.trim\(\)/g, desc: 'string trimming' },
        { regex: /\.toLowerCase\(\)/g, desc: 'string normalization' },
        { regex: /validationResult\s*\(req\)/g, desc: 'express-validator check' },
      ];
      for (const { regex, desc } of validationPatterns) {
        if (regex.test(funcBody)) {
          hint.validationChecks.push(desc);
        }
        regex.lastIndex = 0;
      }

      // Count conditional branches (if/else/switch)
      const ifCount = (funcBody.match(/\bif\s*\(/g) || []).length;
      const switchCount = (funcBody.match(/\bswitch\s*\(/g) || []).length;
      hint.conditionalBranches = ifCount + switchCount;

      // Extract JSDoc comment above the function
      const jsdocRegex = new RegExp(
        `(/\\*\\*[\\s\\S]*?\\*/)[\\s\\n]*(?:(?:exports\\.)?${funcName}|(?:async\\s+)?function\\s+${funcName})`,
        'i'
      );
      const jsdocMatch = jsdocRegex.exec(content);
      if (jsdocMatch) {
        hint.jsdoc = jsdocMatch[1].trim();
      }

      hints.push(hint);
    }

    logger.debug(`Extracted ${hints.length} controller functions from ${filename}`);
  } catch (err) {
    logger.warn(`Failed to parse controller file ${filePath}: ${err.message}`);
  }

  return hints;
}

/**
 * Parse multiple controller files.
 * @param {string[]} filePaths
 * @returns {Promise<Array<object>>}
 */
async function parseControllerFiles(filePaths) {
  const allHints = [];
  for (const fp of filePaths) {
    const hints = await parseControllerFile(fp);
    allHints.push(...hints);
  }
  return allHints;
}

/**
 * Scan a directory for controller files and parse them.
 * @param {string} dirPath
 * @returns {Promise<Array<object>>}
 */
async function parseControllerDirectory(dirPath) {
  try {
    const resolvedDir = path.resolve(dirPath);
    logger.debug(`Scanning for controller files in: ${resolvedDir}`);
    const files = await scanDirectory(resolvedDir, ['.js', '.ts']);

    // Filter to likely controller files
    const controllerFiles = files.filter(f => {
      const base = path.basename(f).toLowerCase();
      return (
        base.includes('controller') ||
        base.includes('handler') ||
        base.includes('service') ||
        base.includes('middleware')
      );
    });

    if (controllerFiles.length === 0) {
      logger.warn(`No controller files found in ${resolvedDir}. Scanning all files...`);
      return parseControllerFiles(files);
    }

    logger.debug(`Found ${controllerFiles.length} controller file(s)`);
    return parseControllerFiles(controllerFiles);
  } catch (err) {
    logger.error(`Failed to scan controller directory: ${err.message}`);
    throw err;
  }
}

module.exports = {
  parseControllerDirectory,
  parseControllerFiles,
  parseControllerFile,
};
