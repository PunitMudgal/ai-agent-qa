/**
 * @module routeParser
 * @description Scans Express.js route files and extracts API structure using regex patterns.
 */

import path from 'path';
import * as logger from '../utils/logger';
import { scanDirectory, readFileContent } from '../utils/fileUtils';
import type { RouteInfo } from '../types';

const ROUTER_INIT_PATTERN =
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router\(\)|require\(['"`]express['"`]\)\.Router\(\))/gi;
const MIDDLEWARE_PATTERNS: Record<string, RegExp> = {
  expressValidator: /(?:body|param|query|header|check)\s*\(\s*['"`]([^'"`]+)['"`]\)/g,
  joi: /(?:Joi|joi)\.\w+/g,
  celebrate: /celebrate\s*\(\s*{/g,
  zod: /(?:z\.\w+|\.parse\(|\.safeParse\()/g,
};

export async function parseRouteFile(filePath: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];
  try {
    const content = await readFileContent(filePath);
    const filename = path.basename(filePath);

    let routerName = 'router';
    const routerMatch = ROUTER_INIT_PATTERN.exec(content);
    if (routerMatch) {
      routerName = routerMatch[1];
    }
    ROUTER_INIT_PATTERN.lastIndex = 0;

    let basePath = '';
    const useRegex = new RegExp(
      `(?:app)\\.use\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*${routerName}`,
      'gi'
    );
    let useMatch: RegExpExecArray | null;
    while ((useMatch = useRegex.exec(content)) !== null) {
      basePath = useMatch[1];
    }

    const validationHints: string[] = [];
    for (const [hintName, pattern] of Object.entries(MIDDLEWARE_PATTERNS)) {
      if (pattern.test(content)) {
        validationHints.push(hintName);
      }
      pattern.lastIndex = 0;
    }

    const routeRegex = new RegExp(
      `(?:${routerName}|router|app)\\.(get|post|put|delete|patch)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*([^)]+)\\)`,
      'gi'
    );

    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const handlersRaw = match[3].trim();

      const handlers = handlersRaw
        .split(',')
        .map(h => h.trim())
        .filter(h => h && !h.startsWith('//'));

      const middlewares = handlers.slice(0, -1);
      const controllerRef = handlers[handlers.length - 1] ?? '';

      let controllerFunction: string = controllerRef;
      if (controllerRef.includes('.')) {
        controllerFunction = controllerRef.split('.').pop() ?? controllerRef;
      }

      const fullPath = basePath + routePath;

      routes.push({
        method,
        path: fullPath,
        rawPath: routePath,
        basePath,
        middlewares: middlewares.map(m => m.trim()),
        controllerFunction: controllerFunction.trim(),
        controllerRef: controllerRef.trim(),
        validationMiddleware: validationHints,
        sourceFile: filePath,
        fileName: filename,
      });
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
