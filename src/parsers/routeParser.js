/**
 * @module routeParser
 * @description Scans Express.js route files and extracts API structure using regex patterns.
 */

const path = require('path');
const logger = require('../utils/logger');
const { scanDirectory, readFileContent } = require('../utils/fileUtils');

/**
 * Regex patterns to match Express route definitions.
 */
const ROUTE_PATTERNS = [
  // router.get('/path', handler)  or router.get('/path', middleware, handler)
  /(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([^)]+)\)/gi,
];

const ROUTER_USE_PATTERN = /(?:router|app)\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([^)]+)\)/gi;
const ROUTER_INIT_PATTERN = /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router\(\)|require\(['"`]express['"`]\)\.Router\(\))/gi;
const MIDDLEWARE_PATTERNS = {
  expressValidator: /(?:body|param|query|header|check)\s*\(\s*['"`]([^'"`]+)['"`]\)/g,
  joi: /(?:Joi|joi)\.\w+/g,
  celebrate: /celebrate\s*\(\s*{/g,
  zod: /(?:z\.\w+|\.parse\(|\.safeParse\()/g,
};

/**
 * Parse a single route file for Express route definitions.
 * @param {string} filePath - Path to the route file.
 * @returns {Promise<Array<object>>} Array of route objects.
 */
async function parseRouteFile(filePath) {
  const routes = [];
  try {
    const content = await readFileContent(filePath);
    const filename = path.basename(filePath);
    const lines = content.split('\n');

    // Detect router initialization
    let routerName = 'router';
    const routerMatch = ROUTER_INIT_PATTERN.exec(content);
    if (routerMatch) {
      routerName = routerMatch[1];
    }
    ROUTER_INIT_PATTERN.lastIndex = 0;

    // Detect base path from router.use
    let basePath = '';
    let useMatch;
    const useRegex = new RegExp(
      `(?:app)\\.use\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*${routerName}`,
      'gi'
    );
    while ((useMatch = useRegex.exec(content)) !== null) {
      basePath = useMatch[1];
    }

    // Detect validation middleware in file
    const validationHints = [];
    for (const [name, pattern] of Object.entries(MIDDLEWARE_PATTERNS)) {
      if (pattern.test(content)) {
        validationHints.push(name);
      }
      pattern.lastIndex = 0;
    }

    // Build a more flexible regex for the detected router name
    const routeRegex = new RegExp(
      `(?:${routerName}|router|app)\\.(get|post|put|delete|patch)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*([^)]+)\\)`,
      'gi'
    );

    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const handlersRaw = match[3].trim();

      // Parse handler chain
      const handlers = handlersRaw
        .split(',')
        .map(h => h.trim())
        .filter(h => h && !h.startsWith('//'));

      const middlewares = handlers.slice(0, -1);
      const controllerRef = handlers[handlers.length - 1] || '';

      // Extract controller function name
      let controllerFunction = controllerRef;
      if (controllerRef.includes('.')) {
        controllerFunction = controllerRef.split('.').pop();
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
    logger.warn(`Failed to parse route file ${filePath}: ${err.message}`);
  }

  return routes;
}

/**
 * Parse multiple route files.
 * @param {string[]} filePaths - Array of file paths to parse.
 * @returns {Promise<Array<object>>} Combined array of route objects.
 */
async function parseRouteFiles(filePaths) {
  const allRoutes = [];
  for (const fp of filePaths) {
    const routes = await parseRouteFile(fp);
    allRoutes.push(...routes);
  }
  return allRoutes;
}

/**
 * Scan a directory for route files and parse them.
 * @param {string} dirPath - Directory to scan.
 * @returns {Promise<Array<object>>} Combined array of route objects.
 */
async function parseRouteDirectory(dirPath) {
  try {
    const resolvedDir = path.resolve(dirPath);
    logger.debug(`Scanning for route files in: ${resolvedDir}`);
    const files = await scanDirectory(resolvedDir, ['.js', '.ts']);

    // Filter to likely route files
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
    logger.error(`Failed to scan route directory: ${err.message}`);
    throw err;
  }
}

module.exports = {
  parseRouteDirectory,
  parseRouteFiles,
  parseRouteFile,
};
