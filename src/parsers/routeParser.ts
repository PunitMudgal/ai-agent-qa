/**
 * @module routeParser
 * @description Parses Express.js route files using the TypeScript AST.
 */

import path from 'path';
import fs from 'fs-extra';
import ts from 'typescript';
import * as logger from '../utils/logger';
import { readFileContent, scanDirectory } from '../utils/fileUtils';
import type { ParseWarning, RouteInfo, RouteParseResult } from '../types';

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
]);

type ImportBindingMap = Map<string, string>;

interface ParseContext {
  rootDir: string;
  cache: Map<string, RouteParseResult>;
  active: Set<string>;
}

export async function parseRouteFile(filePath: string): Promise<RouteParseResult> {
  const resolvedPath = path.resolve(filePath);
  const rootDir = path.dirname(resolvedPath);
  return parseRouteFileInternal(resolvedPath, {
    rootDir,
    cache: new Map<string, RouteParseResult>(),
    active: new Set<string>(),
  });
}

export async function parseRouteFiles(filePaths: string[]): Promise<RouteParseResult> {
  const routes: RouteInfo[] = [];
  const warnings: ParseWarning[] = [];
  const cache = new Map<string, RouteParseResult>();
  const active = new Set<string>();
  const rootDir = commonParentDir(filePaths);

  for (const filePath of filePaths) {
    const result = await parseRouteFileInternal(path.resolve(filePath), {
      rootDir,
      cache,
      active,
    });
    routes.push(...result.routes);
    warnings.push(...result.warnings);
  }

  return {
    routes: dedupeRoutes(routes),
    warnings: dedupeWarnings(warnings),
  };
}

export async function parseRouteDirectory(dirPath: string): Promise<RouteParseResult> {
  const resolvedDir = path.resolve(dirPath);
  if (!(await fs.pathExists(resolvedDir))) {
    throw new Error(`Routes directory does not exist: ${resolvedDir}`);
  }
  const stat = await fs.stat(resolvedDir);
  if (!stat.isDirectory()) {
    throw new Error(`Routes path is not a directory: ${resolvedDir}`);
  }

  logger.debug(`Scanning for route files in: ${resolvedDir}`);
  const files = await scanDirectory(resolvedDir, ['.js', '.ts']);
  const routeFiles = files.filter(isLikelyRouteFile);

  if (routeFiles.length === 0) {
    logger.warn(`No route files found in ${resolvedDir}. Scanning all .js/.ts files...`);
    return parseRouteFiles(files);
  }

  logger.debug(`Found ${routeFiles.length} route file(s)`);
  return parseRouteFiles(routeFiles);
}

async function parseRouteFileInternal(
  filePath: string,
  context: ParseContext
): Promise<RouteParseResult> {
  if (context.cache.has(filePath)) {
    return context.cache.get(filePath)!;
  }
  if (context.active.has(filePath)) {
    return { routes: [], warnings: [] };
  }

  context.active.add(filePath);

  try {
    const content = await readFileContent(filePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFile(filePath)
    );
    const importBindings = collectImportBindings(sourceFile, filePath);
    const expressAliases = collectExpressAliases(sourceFile);
    const routerIdentifiers = collectRouterIdentifiers(sourceFile, expressAliases);
    const appIdentifiers = collectAppIdentifiers(sourceFile, expressAliases);

    const routes: RouteInfo[] = [];
    const warnings: ParseWarning[] = [];
    const seen = new Set<string>();

    const visitNode = async (node: ts.Node): Promise<void> => {
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) {
        return;
      }

      const call = node.expression;
      const directRoute = extractDirectRouteCall(call, sourceFile, routerIdentifiers, appIdentifiers);
      if (directRoute) {
        const routeInfo = buildRouteInfo(
          filePath,
          directRoute.method,
          directRoute.routePath,
          directRoute.handlers,
          '',
          sourceFile
        );
        addRoute(routeInfo, routes, seen);
      }

      const chainedRoute = extractChainedRouteCall(call, sourceFile, routerIdentifiers, appIdentifiers);
      if (chainedRoute) {
        const routeInfo = buildRouteInfo(
          filePath,
          chainedRoute.method,
          chainedRoute.routePath,
          chainedRoute.handlers,
          '',
          sourceFile
        );
        addRoute(routeInfo, routes, seen);
      }

      const nestedUse = extractNestedRouterUse(call, sourceFile, routerIdentifiers, appIdentifiers);
      if (nestedUse) {
        if (!nestedUse.routePath) {
          warnings.push(
            createWarning(filePath, 'Dynamic router.use prefix could not be resolved', nestedUse.node, sourceFile)
          );
          return;
        }
        if (!nestedUse.routerIdentifier) {
          warnings.push(
            createWarning(filePath, 'Nested router.use target could not be resolved', nestedUse.node, sourceFile)
          );
          return;
        }

        const importedPath = importBindings.get(nestedUse.routerIdentifier);
        if (!importedPath) {
          warnings.push(
            createWarning(
              filePath,
              `Nested router "${nestedUse.routerIdentifier}" is not a local import/require`,
              nestedUse.node,
              sourceFile
            )
          );
          return;
        }

        const childResult = await parseRouteFileInternal(importedPath, context);
        warnings.push(...childResult.warnings);
        for (const childRoute of childResult.routes) {
          addRoute(
            {
              ...childRoute,
              path: normalizeJoinedPath(nestedUse.routePath, childRoute.path),
              basePath: normalizeJoinedPath(nestedUse.routePath, childRoute.basePath || ''),
            },
            routes,
            seen
          );
        }
      }
    };

    await traverseAsync(sourceFile, visitNode);

    const result = {
      routes: dedupeRoutes(routes),
      warnings: dedupeWarnings(warnings),
    };

    logger.debug(`Found ${result.routes.length} routes in ${path.basename(filePath)}`);
    context.cache.set(filePath, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = {
      kind: 'route' as const,
      file: filePath,
      message: `Failed to parse route file: ${message}`,
    };
    logger.warn(`${warning.message} (${filePath})`);
    const result = { routes: [], warnings: [warning] };
    context.cache.set(filePath, result);
    return result;
  } finally {
    context.active.delete(filePath);
  }
}

function collectImportBindings(sourceFile: ts.SourceFile, filePath: string): ImportBindingMap {
  const bindings: ImportBindingMap = new Map();

  const addBinding = (localName: string, specifier: string): void => {
    const resolved = resolveLocalModule(filePath, specifier);
    if (resolved) {
      bindings.set(localName, resolved);
    }
  };

  sourceFile.statements.forEach(statement => {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const specifier = getModuleSpecifierText(statement.moduleSpecifier);
      if (!specifier) return;

      if (statement.importClause.name) {
        addBinding(statement.importClause.name.text, specifier);
      }

      const bindingsNode = statement.importClause.namedBindings;
      if (bindingsNode && ts.isNamespaceImport(bindingsNode)) {
        addBinding(bindingsNode.name.text, specifier);
      }
      if (bindingsNode && ts.isNamedImports(bindingsNode)) {
        bindingsNode.elements.forEach(element => {
          addBinding(element.name.text, specifier);
        });
      }
    }

    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length > 0
    ) {
      statement.declarationList.declarations.forEach(declaration => {
        if (
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === 'require' &&
          declaration.initializer.arguments.length > 0
        ) {
          const moduleText = literalText(declaration.initializer.arguments[0]);
          if (!moduleText) return;

          if (ts.isIdentifier(declaration.name)) {
            addBinding(declaration.name.text, moduleText);
          }

          if (ts.isObjectBindingPattern(declaration.name)) {
            declaration.name.elements.forEach(element => {
              addBinding(element.name.getText(sourceFile), moduleText);
            });
          }
        }
      });
    }
  });

  return bindings;
}

function collectExpressAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();

  sourceFile.statements.forEach(statement => {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const specifier = getModuleSpecifierText(statement.moduleSpecifier);
      if (specifier !== 'express') return;

      if (statement.importClause.name) {
        aliases.add(statement.importClause.name.text);
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        aliases.add(bindings.name.text);
      }
    }

    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length > 0
    ) {
      statement.declarationList.declarations.forEach(declaration => {
        if (
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === 'require' &&
          declaration.initializer.arguments.length > 0 &&
          literalText(declaration.initializer.arguments[0]) === 'express' &&
          ts.isIdentifier(declaration.name)
        ) {
          aliases.add(declaration.name.text);
        }
      });
    }
  });

  aliases.add('express');
  return aliases;
}

function collectRouterIdentifiers(sourceFile: ts.SourceFile, expressAliases: Set<string>): Set<string> {
  const identifiers = new Set<string>();
  const routerFactoryAliases = collectRouterFactoryAliases(sourceFile);

  traverseSync(sourceFile, node => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) {
      return;
    }

    if (isRouterFactoryCall(node.initializer, expressAliases, routerFactoryAliases)) {
      identifiers.add(node.name.text);
    }
  });

  identifiers.add('router');
  return identifiers;
}

function collectRouterFactoryAliases(sourceFile: ts.SourceFile): Set<string> {
  const identifiers = new Set<string>();

  sourceFile.statements.forEach(statement => {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings) {
      const specifier = getModuleSpecifierText(statement.moduleSpecifier);
      if (specifier !== 'express') return;

      if (ts.isNamedImports(statement.importClause.namedBindings)) {
        statement.importClause.namedBindings.elements.forEach(element => {
          const importName = element.propertyName?.text ?? element.name.text;
          if (importName === 'Router') {
            identifiers.add(element.name.text);
          }
        });
      }
    }

    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length > 0
    ) {
      statement.declarationList.declarations.forEach(declaration => {
        if (
          !ts.isObjectBindingPattern(declaration.name) ||
          !declaration.initializer ||
          !ts.isCallExpression(declaration.initializer) ||
          !ts.isIdentifier(declaration.initializer.expression) ||
          declaration.initializer.expression.text !== 'require' ||
          literalText(declaration.initializer.arguments[0]) !== 'express'
        ) {
          return;
        }

        declaration.name.elements.forEach(element => {
          const importName = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          if (importName === 'Router') {
            identifiers.add(element.name.getText(sourceFile));
          }
        });
      });
    }
  });

  identifiers.add('Router');
  return identifiers;
}

function collectAppIdentifiers(sourceFile: ts.SourceFile, expressAliases: Set<string>): Set<string> {
  const identifiers = new Set<string>(['app']);

  traverseSync(sourceFile, node => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) {
      return;
    }

    if (
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      expressAliases.has(node.initializer.expression.text)
    ) {
      identifiers.add(node.name.text);
    }
  });

  return identifiers;
}

function isRouterFactoryCall(
  node: ts.Expression,
  expressAliases: Set<string>,
  routerFactoryAliases: Set<string>
): boolean {
  if (!ts.isCallExpression(node)) return false;

  if (ts.isPropertyAccessExpression(node.expression)) {
    return (
      node.expression.name.text === 'Router' &&
      ts.isIdentifier(node.expression.expression) &&
      expressAliases.has(node.expression.expression.text)
    );
  }

  return ts.isIdentifier(node.expression) && routerFactoryAliases.has(node.expression.text);
}

function extractDirectRouteCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  routerIdentifiers: Set<string>,
  appIdentifiers: Set<string>
): { method: string; routePath: string; handlers: string[] } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (!HTTP_METHODS.has(call.expression.name.text.toLowerCase())) return null;
  if (!ts.isIdentifier(call.expression.expression)) return null;

  const baseIdentifier = call.expression.expression.text;
  if (!routerIdentifiers.has(baseIdentifier) && !appIdentifiers.has(baseIdentifier)) {
    return null;
  }

  const routePath = literalText(call.arguments[0]);
  if (!routePath) return null;

  return {
    method: call.expression.name.text.toUpperCase(),
    routePath,
    handlers: flattenHandlers(call.arguments.slice(1), sourceFile),
  };
}

function extractChainedRouteCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  routerIdentifiers: Set<string>,
  appIdentifiers: Set<string>
): { method: string; routePath: string; handlers: string[] } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (!HTTP_METHODS.has(call.expression.name.text.toLowerCase())) return null;

  const routeCall = call.expression.expression;
  if (
    !ts.isCallExpression(routeCall) ||
    !ts.isPropertyAccessExpression(routeCall.expression) ||
    routeCall.expression.name.text !== 'route' ||
    !ts.isIdentifier(routeCall.expression.expression)
  ) {
    return null;
  }

  const baseIdentifier = routeCall.expression.expression.text;
  if (!routerIdentifiers.has(baseIdentifier) && !appIdentifiers.has(baseIdentifier)) {
    return null;
  }

  const routePath = literalText(routeCall.arguments[0]);
  if (!routePath) return null;

  return {
    method: call.expression.name.text.toUpperCase(),
    routePath,
    handlers: flattenHandlers(call.arguments, sourceFile),
  };
}

function extractNestedRouterUse(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  routerIdentifiers: Set<string>,
  appIdentifiers: Set<string>
): { routePath: string | null; routerIdentifier: string | null; node: ts.Node } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (call.expression.name.text !== 'use') return null;
  if (!ts.isIdentifier(call.expression.expression)) return null;

  const baseIdentifier = call.expression.expression.text;
  if (!routerIdentifiers.has(baseIdentifier) && !appIdentifiers.has(baseIdentifier)) {
    return null;
  }

  if (call.arguments.length === 0) return null;

  const firstArgPath = literalText(call.arguments[0]);
  const routePath = firstArgPath ?? '';
  const routerArg =
    firstArgPath != null
      ? call.arguments[call.arguments.length - 1]
      : call.arguments[0];
  const routerIdentifier = extractIdentifierName(routerArg, sourceFile);
  return { routePath, routerIdentifier, node: call };
}

function flattenHandlers(
  expressions: readonly ts.Expression[],
  sourceFile: ts.SourceFile
): string[] {
  const handlers: string[] = [];
  expressions.forEach(expression => {
    if (ts.isArrayLiteralExpression(expression)) {
      handlers.push(...flattenHandlers(expression.elements.slice(), sourceFile));
      return;
    }
    const text = expression.getText(sourceFile).trim();
    if (text) {
      handlers.push(text);
    }
  });
  return handlers;
}

function buildRouteInfo(
  filePath: string,
  method: string,
  routePath: string,
  handlers: string[],
  basePath: string,
  sourceFile: ts.SourceFile
): RouteInfo {
  const filename = path.basename(filePath);
  const controllerRef = handlers[handlers.length - 1] ?? '';
  const middlewares = handlers.slice(0, Math.max(0, handlers.length - 1));
  const controllerFunction = controllerRef.includes('.')
    ? controllerRef.split('.').pop() ?? controllerRef
    : controllerRef;

  return {
    method,
    path: normalizeJoinedPath(basePath, routePath),
    rawPath: routePath,
    basePath,
    middlewares,
    controllerFunction: controllerFunction.trim(),
    controllerRef: controllerRef.trim(),
    validationMiddleware: middlewares.filter(handler =>
      /(validate|schema|zod|joi|body|query|param|check)/i.test(handler)
    ),
    sourceFile: filePath,
    fileName: filename,
  };
}

function addRoute(routeInfo: RouteInfo, routes: RouteInfo[], seen: Set<string>): void {
  if (!routeInfo.controllerRef) return;
  const key = `${routeInfo.method}|${routeInfo.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  routes.push(routeInfo);
}

function createWarning(
  filePath: string,
  message: string,
  node: ts.Node,
  sourceFile: ts.SourceFile
): ParseWarning {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    kind: 'route',
    file: filePath,
    message,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function normalizeJoinedPath(prefix: string, routePath: string): string {
  const joined = `${prefix || ''}/${routePath || ''}`.replace(/\/+/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function extractIdentifierName(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.getText(sourceFile);
  return null;
}

function literalText(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function getModuleSpecifierText(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function resolveLocalModule(baseFilePath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const target = path.resolve(path.dirname(baseFilePath), specifier);
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.js`,
    `${target}.mts`,
    `${target}.cts`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.js'),
    path.join(target, 'index.mts'),
    path.join(target, 'index.cts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function isLikelyRouteFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return (
    base.includes('route') ||
    base.includes('router') ||
    base.includes('api') ||
    base.includes('endpoint')
  );
}

function dedupeRoutes(routes: RouteInfo[]): RouteInfo[] {
  const seen = new Set<string>();
  const result: RouteInfo[] = [];

  for (const route of routes) {
    const key = `${route.method}|${route.path}|${route.sourceFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(route);
  }

  return result;
}

function dedupeWarnings(warnings: ParseWarning[]): ParseWarning[] {
  const seen = new Set<string>();
  const result: ParseWarning[] = [];

  for (const warning of warnings) {
    const key = `${warning.kind}|${warning.file}|${warning.line ?? 0}|${warning.column ?? 0}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }

  return result;
}

function commonParentDir(filePaths: string[]): string {
  if (filePaths.length === 0) return process.cwd();
  return path.dirname(path.resolve(filePaths[0]));
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

async function traverseAsync(
  node: ts.Node,
  visitor: (node: ts.Node) => Promise<void>
): Promise<void> {
  await visitor(node);
  const children: ts.Node[] = [];
  ts.forEachChild(node, child => {
    children.push(child);
  });
  for (const child of children) {
    await traverseAsync(child, visitor);
  }
}
