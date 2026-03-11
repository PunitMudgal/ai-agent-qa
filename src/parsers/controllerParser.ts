/**
 * @module controllerParser
 * @description Parses controller files using the TypeScript AST.
 */

import path from 'path';
import ts from 'typescript';
import * as logger from '../utils/logger';
import { readFileContent, scanDirectory } from '../utils/fileUtils';
import type {
  ControllerHint,
  ControllerParseResult,
  ParseWarning,
} from '../types';

const MODEL_METHODS = new Set([
  'find',
  'create',
  'update',
  'delete',
  'findOne',
  'findById',
  'findAll',
  'save',
  'remove',
  'destroy',
  'count',
  'aggregate',
  'insertMany',
]);

export async function parseControllerFile(filePath: string): Promise<ControllerParseResult> {
  try {
    const content = await readFileContent(filePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFile(filePath)
    );

    const functions = collectControllerFunctions(sourceFile);
    const hints = Array.from(functions.entries()).map(([functionName, fnNode]) =>
      analyzeControllerFunction(functionName, fnNode, filePath, sourceFile)
    );

    logger.debug(`Extracted ${hints.length} controller functions from ${path.basename(filePath)}`);
    return {
      hints,
      warnings: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = {
      kind: 'controller' as const,
      file: filePath,
      message: `Failed to parse controller file: ${message}`,
    };
    logger.warn(`${warning.message} (${filePath})`);
    return {
      hints: [],
      warnings: [warning],
    };
  }
}

export async function parseControllerFiles(filePaths: string[]): Promise<ControllerParseResult> {
  const hints: ControllerHint[] = [];
  const warnings: ParseWarning[] = [];

  for (const filePath of filePaths) {
    const result = await parseControllerFile(filePath);
    hints.push(...result.hints);
    warnings.push(...result.warnings);
  }

  return {
    hints,
    warnings: dedupeWarnings(warnings),
  };
}

export async function parseControllerDirectory(dirPath: string): Promise<ControllerParseResult> {
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
}

function collectControllerFunctions(
  sourceFile: ts.SourceFile
): Map<string, ts.FunctionLikeDeclarationBase> {
  const functions = new Map<string, ts.FunctionLikeDeclarationBase>();

  const addFunction = (name: string, fn: ts.FunctionLikeDeclarationBase): void => {
    if (!functions.has(name)) {
      functions.set(name, fn);
    }
  };

  traverseSync(sourceFile, node => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addFunction(node.name.text, node);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = getFunctionFromExpression(node.initializer);
      if (fn) {
        addFunction(node.name.text, fn);
      }
      if (ts.isObjectLiteralExpression(node.initializer)) {
        collectObjectLiteralFunctions(node.initializer, addFunction);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (ts.isPropertyAccessExpression(node.left)) {
        const fn = getFunctionFromExpression(node.right);
        if (fn) {
          addFunction(node.left.name.text, fn);
        }
      }

      if (
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.getText(sourceFile) === 'module.exports' &&
        ts.isObjectLiteralExpression(node.right)
      ) {
        collectObjectLiteralFunctions(node.right, addFunction);
      }
    }

    if (ts.isExportAssignment(node) && ts.isObjectLiteralExpression(node.expression)) {
      collectObjectLiteralFunctions(node.expression, addFunction);
    }
  });

  return functions;
}

function collectObjectLiteralFunctions(
  node: ts.ObjectLiteralExpression,
  addFunction: (name: string, fn: ts.FunctionLikeDeclarationBase) => void
): void {
  node.properties.forEach(property => {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      const fn = getFunctionFromExpression(property.initializer);
      if (fn) {
        addFunction(property.name.text, fn);
      }
    }
    if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) {
      addFunction(property.name.text, property);
    }
    if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      // Shorthand references are handled by the original declaration traversal.
      return;
    }
  });
}

function getFunctionFromExpression(
  node: ts.Expression
): ts.FunctionLikeDeclarationBase | null {
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return node;
  }
  return null;
}

function analyzeControllerFunction(
  functionName: string,
  fnNode: ts.FunctionLikeDeclarationBase,
  filePath: string,
  sourceFile: ts.SourceFile
): ControllerHint {
  const hint: ControllerHint = {
    functionName,
    sourceFile: filePath,
    fileName: path.basename(filePath),
    statusCodes: [],
    thrownErrors: [],
    modelReferences: [],
    authChecks: [],
    validationChecks: [],
    jsdoc: extractJsDoc(fnNode, sourceFile),
    conditionalBranches: 0,
  };

  traverseSync(fnNode, node => {
    if (ts.isIfStatement(node)) {
      hint.conditionalBranches += 1;
      const conditionText = node.expression.getText(sourceFile);
      if (containsAuthCheck(conditionText)) {
        pushUnique(hint.authChecks, normalizeAuthCheck(conditionText));
      } else if (containsExistenceCheck(conditionText)) {
        pushUnique(hint.validationChecks, 'existence check');
      }

      if (/(null|undefined|''|"")/.test(conditionText)) {
        pushUnique(hint.validationChecks, 'null/empty check');
      }
    }

    if (ts.isSwitchStatement(node)) {
      hint.conditionalBranches += 1;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'status' &&
      node.arguments.length > 0 &&
      ts.isNumericLiteral(node.arguments[0])
    ) {
      pushUnique(hint.statusCodes, parseInt(node.arguments[0].text, 10));
    }

    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const errType = node.expression.expression.getText(sourceFile);
      const firstArg = node.expression.arguments?.[0];
      if (/Error$/.test(errType) && firstArg && ts.isStringLiteralLike(firstArg)) {
        hint.thrownErrors.push({
          type: errType,
          message: firstArg.text,
        });
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      MODEL_METHODS.has(node.expression.name.text) &&
      /^[A-Z]/.test(node.expression.expression.text)
    ) {
      pushUnique(hint.modelReferences, node.expression.expression.text);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'trim'
    ) {
      pushUnique(hint.validationChecks, 'string trimming');
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toLowerCase'
    ) {
      pushUnique(hint.validationChecks, 'string normalization');
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'validationResult'
    ) {
      pushUnique(hint.validationChecks, 'express-validator check');
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(sourceFile) === 'req.user'
    ) {
      pushUnique(hint.authChecks, 'req.user');
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['authorize', 'isAuthenticated', 'isAdmin'].includes(node.expression.text)
    ) {
      pushUnique(hint.authChecks, node.expression.text);
    }
  });

  return hint;
}

function extractJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? [];
  const docRange = ranges.find(range => sourceFile.text.slice(range.pos, range.end).startsWith('/**'));
  if (!docRange) return '';
  return sourceFile.text.slice(docRange.pos, docRange.end).trim();
}

function containsAuthCheck(conditionText: string): boolean {
  return (
    /req\.user/.test(conditionText) ||
    /req\.auth/.test(conditionText) ||
    /isAuthenticated/.test(conditionText) ||
    /isAdmin/.test(conditionText) ||
    /authorize\s*\(/.test(conditionText)
  );
}

function normalizeAuthCheck(conditionText: string): string {
  return conditionText.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function containsExistenceCheck(conditionText: string): boolean {
  return /!\s*[\w.]+/.test(conditionText);
}

function pushUnique<T>(target: T[], value: T): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function dedupeWarnings(warnings: ParseWarning[]): ParseWarning[] {
  const seen = new Set<string>();
  const result: ParseWarning[] = [];

  for (const warning of warnings) {
    const key = `${warning.kind}|${warning.file}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }

  return result;
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.cts' || ext === '.mts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function traverseSync(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, child => traverseSync(child, visitor));
}
