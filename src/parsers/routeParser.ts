/**
 * @module routeParser
 * @description Scans Express.js route files and extracts API structure using regex patterns.
 */

import path from 'path';
import fs from 'fs-extra';
import * as logger from '../utils/logger';
import { scanDirectory, readFileContent } from '../utils/fileUtils';
import type { RouteInfo } from '../types';

const MIDDLEWARE_PATTERNS: Record<string, RegExp> = {
  expressValidator: /(?:body|param|query|header|check)\s*\(\s*['"`]([^'"`]+)['"`]\)/g,
  joi: /(?:Joi|joi)\.\w+/g,
  celebrate: /celebrate\s*\(\s*{/g,
  zod: /(?:z\.\w+|\.parse\(|\.safeParse\()/g,
};

function findRouterNames(content: string): string[] {
  const names = new Set<string>();
  const pattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router\(\)|require\(['"`]express['"`]\)\.Router\(\)|new\s+(?:express\.)?Router\(\))/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    names.add(m[1]);
  }
  if (names.size === 0) names.add('router');
  return Array.from(names);
}

export async function parseRouteFile(filePath: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];
  const seen = new Set<string>();
  try {
    const content = await readFileContent(filePath);
    const filename = path.basename(filePath);

    const routerNames = findRouterNames(content);

    const basePathMap: Record<string, string> = {};
    for (const rName of routerNames) {
      const useRegex = new RegExp(
        `(?:app|module\\.exports)\\.use\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*${rName}`,
        'gi'
      );
      let useMatch: RegExpExecArray | null;
      while ((useMatch = useRegex.exec(content)) !== null) {
        basePathMap[rName] = useMatch[1];
      }
    }

    const validationHints: string[] = [];
    for (const [hintName, pattern] of Object.entries(MIDDLEWARE_PATTERNS)) {
      if (pattern.test(content)) {
        validationHints.push(hintName);
      }
      pattern.lastIndex = 0;
    }

    const routerNameAlts = [...new Set([...routerNames, 'router', 'app'])].join('|');

    function parseHandlers(handlersRaw: string): { middlewares: string[]; controllerRef: string } {
      let raw = handlersRaw
        .replace(/^\[/, '')
        .replace(/\]\s*,?\s*$/, '');
      const handlers = raw
        .split(',')
        .map(h => h.trim().replace(/[\[\]]/g, ''))
        .filter(h => h && !h.startsWith('//') && !h.startsWith('/*'));
      const middlewares = handlers.slice(0, Math.max(0, handlers.length - 1));
      const controllerRef = handlers[handlers.length - 1] ?? '';
      return {
        middlewares: middlewares.map(m => m.trim()),
        controllerRef: controllerRef.trim(),
      };
    }

    function addRoute(routePath: string, method: string, handlersRaw: string, matchedRouter: string | undefined) {
      const { middlewares, controllerRef } = parseHandlers(handlersRaw);
      const controllerFunction = controllerRef.includes('.') ? controllerRef.split('.').pop() ?? controllerRef : controllerRef;
      if (!controllerRef) return;
      const basePath = (matchedRouter && basePathMap[matchedRouter]) || basePathMap[routerNames[0]] || '';
      const fullPath = basePath + routePath;
      const key = `${method}|${fullPath}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push({
        method,
        path: fullPath,
        rawPath: routePath,
        basePath,
        middlewares,
        controllerFunction: controllerFunction.trim(),
        controllerRef,
        validationMiddleware: validationHints,
        sourceFile: filePath,
        fileName: filename,
      });
    }

    const routeRegex = new RegExp(
      `(?:${routerNameAlts})\\.(get|post|put|delete|patch|options|head|all)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*([\\s\\S]*?)\\)\\s*;?\\s*(?:\\n|$)`,
      'gi'
    );

    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const handlersRaw = match[3].trim();
      const matchedRouter = routerNames.find(rn => match![0].startsWith(rn + '.'));
      addRoute(routePath, method, handlersRaw, matchedRouter);
    }

    const routeChainRegex = new RegExp(
      `(?:${routerNameAlts})\\.route\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`,
      'gi'
    );
    const methodChainRegex = /\s*\.(get|post|put|delete|patch|options|head)\s*\(\s*([\s\S]*?)\)\s*(?=\s*\.(?:get|post|put|delete|patch|options|head)\s*\(|$)/gi;

    let routeMatch: RegExpExecArray | null;
    routeChainRegex.lastIndex = 0;
    while ((routeMatch = routeChainRegex.exec(content)) !== null) {
      const routePath = routeMatch[1];
      const chainStart = routeMatch.index + routeMatch[0].length;
      const nextRoute = content.slice(chainStart).search(
        new RegExp(`(?:${routerNameAlts})\\.(?:route|get|post|put|delete|patch|options|head)\\s*\\(`, 'i')
      );
      const chainEnd = nextRoute >= 0 ? chainStart + nextRoute : content.length;
      const chainBlock = content.slice(chainStart, chainEnd);
      const matchedRouter = routerNames.find(rn => routeMatch![0].startsWith(rn + '.'));

      methodChainRegex.lastIndex = 0;
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodChainRegex.exec(chainBlock)) !== null) {
        const method = methodMatch[1].toUpperCase();
        const handlersRaw = methodMatch[2].trim();
        addRoute(routePath, method, handlersRaw, matchedRouter);
      }
    }

    logger.debug(`Found ${routes.length} routes in ${filename}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to parse route file ${filePath}: ${message}`);
  }

  return routes;
}

export async function parseRouteFiles(filePaths: string[]): Promise<RouteInfo[]> {
  const allRoutes: RouteInfo[] = [];
  for (const fp of filePaths) {
    const routes = await parseRouteFile(fp);
    allRoutes.push(...routes);
  }
  return allRoutes;
}

export async function parseRouteDirectory(dirPath: string): Promise<RouteInfo[]> {
  try {
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

    const routeFiles = files.filter(f => {
      const base = path.basename(f).toLowerCase();
      return (
        base.includes('route') ||
        base.includes('router') ||
        base.includes('api') ||
        base.includes('endpoint')
      );
    });

    if (routeFiles.length === 0) {
      logger.warn(`No route files found in ${resolvedDir}. Scanning all .js/.ts files...`);
      return parseRouteFiles(files);
    }

    logger.debug(`Found ${routeFiles.length} route file(s)`);
    return parseRouteFiles(routeFiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to scan route directory: ${message}`);
    throw err;
  }
}
