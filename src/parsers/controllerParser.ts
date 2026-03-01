/**
 * @module controllerParser
 * @description Reads controller files and extracts business-logic hints for AI context.
 */

import path from 'path';
import * as logger from '../utils/logger';
import { scanDirectory, readFileContent } from '../utils/fileUtils';
import type { ControllerHint } from '../types';

const FUNCTION_PATTERNS = [
  /(\w+)\s*[:=]\s*async\s*(?:function\s*)?\((?:req|request)[\s,]/g,
  /exports\.(\w+)\s*=\s*async\s*(?:function\s*)?\(/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s*(?:function\s*)?\((?:req|request)[\s,]/g,
  /async\s+function\s+(\w+)\s*\((?:req|request)[\s,]/g,
  /(\w+)\s*[:=]\s*(?:function\s*)?\((?:req|request)[\s,][^)]*\)\s*(?:=>)?\s*{/g,
  /exports\.(\w+)\s*=\s*(?:function\s*)?\((?:req|request)/g,
];

export async function parseControllerFile(filePath: string): Promise<ControllerHint[]> {
  const hints: ControllerHint[] = [];
  try {
    const content = await readFileContent(filePath);
    const filename = path.basename(filePath);

    const funcNames = new Set<string>();
    for (const pattern of FUNCTION_PATTERNS) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        funcNames.add(match[1]);
      }
      pattern.lastIndex = 0;
    }

    for (const funcName of funcNames) {
      const funcBodyRegex = new RegExp(
        `(?:${funcName}[\\s\\S]*?(?:async\\s+)?(?:function\\s*)?\\([^)]*\\)\\s*(?:=>)?\\s*{)([\\s\\S]*?)(?=\\n(?:exports\\.|module\\.exports|(?:const|let|var)\\s+\\w+\\s*=\\s*async|async\\s+function|\\}\\s*;?\\s*$))`,
        'i'
      );
      const bodyMatch = funcBodyRegex.exec(content);
      const funcBody = bodyMatch ? bodyMatch[1] : content;

      const hint: ControllerHint = {
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

      const statusRegex = /\.status\s*\(\s*(\d{3})\s*\)/g;
      let statusMatch: RegExpExecArray | null;
      while ((statusMatch = statusRegex.exec(funcBody)) !== null) {
        const code = parseInt(statusMatch[1], 10);
        if (!hint.statusCodes.includes(code)) {
          hint.statusCodes.push(code);
        }
      }

      const throwRegex = /throw\s+new\s+(\w*Error)\s*\(\s*['"`]([^'"`]*)['"`]/g;
      let throwMatch: RegExpExecArray | null;
      while ((throwMatch = throwRegex.exec(funcBody)) !== null) {
        hint.thrownErrors.push({ type: throwMatch[1], message: throwMatch[2] });
      }

      const modelRegex =
        /(?:await\s+)?([A-Z][a-zA-Z]+)\.(find|create|update|delete|findOne|findById|findAll|save|remove|destroy|count|aggregate|insertMany)/g;
      let modelMatch: RegExpExecArray | null;
      while ((modelMatch = modelRegex.exec(funcBody)) !== null) {
        if (!hint.modelReferences.includes(modelMatch[1])) {
          hint.modelReferences.push(modelMatch[1]);
        }
      }

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

      const validationPatterns: { regex: RegExp; desc: string }[] = [
        { regex: /if\s*\(\s*![\w.]+\s*\)/g, desc: 'existence check' },
        {
          regex: /if\s*\(\s*[\w.]+\s*(?:===?|!==?)\s*(?:null|undefined|''|"")/g,
          desc: 'null/empty check',
        },
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

      const ifCount = (funcBody.match(/\bif\s*\(/g) ?? []).length;
      const switchCount = (funcBody.match(/\bswitch\s*\(/g) ?? []).length;
      hint.conditionalBranches = ifCount + switchCount;

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
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to parse controller file ${filePath}: ${message}`);
  }

  return hints;
}

export async function parseControllerFiles(filePaths: string[]): Promise<ControllerHint[]> {
  const allHints: ControllerHint[] = [];
  for (const fp of filePaths) {
    const hints = await parseControllerFile(fp);
    allHints.push(...hints);
  }
  return allHints;
}

export async function parseControllerDirectory(dirPath: string): Promise<ControllerHint[]> {
  try {
    const resolvedDir = path.resolve(dirPath);
    logger.debug(`Scanning for controller files in: ${resolvedDir}`);
    const files = await scanDirectory(resolvedDir, ['.js', '.ts']);

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
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to scan controller directory: ${message}`);
    throw err;
  }
}
