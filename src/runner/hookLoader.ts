import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { RunnerHooks } from '../types';

interface LoadRunnerHooksResult {
  hooks: RunnerHooks;
  loadPath?: string;
  cleanup: () => Promise<void>;
}

export interface PreparedRunnerHooksPath {
  loadPath?: string;
  cleanup: () => Promise<void>;
}

export async function loadRunnerHooks(
  hooksPath?: string
): Promise<LoadRunnerHooksResult> {
  if (!hooksPath) {
    return {
      hooks: {},
      cleanup: async () => {},
    };
  }

  const prepared = await prepareRunnerHooksPath(hooksPath);
  const loadPath = prepared.loadPath;
  if (!loadPath) {
    throw new Error(`Runner hooks file could not be prepared: ${hooksPath}`);
  }
  const imported = await import(pathToFileURL(loadPath).href);
  const hooks = normalizeHookModule(imported);

  return {
    hooks,
    loadPath,
    cleanup: prepared.cleanup,
  };
}

export async function prepareRunnerHooksPath(
  hooksPath?: string
): Promise<PreparedRunnerHooksPath> {
  if (!hooksPath) {
    return {
      cleanup: async () => {},
    };
  }

  const resolved = path.resolve(hooksPath);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Runner hooks file not found: ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  let loadPath = resolved;
  let tempPath: string | null = null;

  if (ext === '.ts') {
    tempPath = await transpileTypeScriptHook(resolved);
    loadPath = tempPath;
  }

  return {
    loadPath,
    cleanup: async () => {
      if (tempPath) {
        await fs.remove(tempPath).catch(() => {});
      }
    },
  };
}

function normalizeHookModule(moduleValue: Record<string, unknown>): RunnerHooks {
  const candidate =
    (moduleValue.default as Record<string, unknown> | undefined) ?? moduleValue;

  return {
    beforeRun: asFn(candidate.beforeRun),
    beforeTest: asFn(candidate.beforeTest),
    afterTest: asFn(candidate.afterTest),
    afterRun: asFn(candidate.afterRun),
  };
}

function asFn<T>(value: unknown): T | undefined {
  return typeof value === 'function' ? (value as T) : undefined;
}

async function transpileTypeScriptHook(filePath: string): Promise<string> {
  let tsModule: typeof import('typescript');
  try {
    tsModule = (await import('typescript')) as typeof import('typescript');
  } catch {
    throw new Error(
      'TypeScript hooks require the "typescript" package to be available in the current environment'
    );
  }

  const source = await fs.readFile(filePath, 'utf-8');
  const transpiled = tsModule.transpileModule(source, {
    compilerOptions: {
      module: tsModule.ModuleKind.ES2020,
      target: tsModule.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: path.basename(filePath),
  });

  const tempPath = path.join(
    os.tmpdir(),
    `ai-agent-qa-hook-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );
  await fs.writeFile(tempPath, transpiled.outputText, 'utf-8');
  return tempPath;
}
