import fs from 'fs-extra';
import { loadGeneratedBundleFromFile } from '../coverage';
import { runAgainstAppImport } from './appImportRunner';
import { runAgainstBaseUrl } from './baseUrlRunner';
import { loadRunnerHooks } from './hookLoader';
import { saveExecutionReport } from './reportFormatter';
import {
  createExecutionReport,
  normalizeRunnerConfig,
  normalizeTestCases,
} from './utils';
import { ensureOutputDir } from '../utils/fileUtils';
import type {
  ExecutionResult,
  ParseWarning,
  RunnerConfig,
  TestCase,
} from '../types';

interface ExecuteTestCasesInput {
  testCases: TestCase[];
  runnerConfig: Partial<RunnerConfig>;
  outputDir: string;
  source: string;
  warnings?: ParseWarning[];
}

export async function executeTestCases(
  input: ExecuteTestCasesInput
): Promise<ExecutionResult> {
  const config = normalizeRunnerConfig(input.runnerConfig, input.outputDir);
  await ensureOutputDir(config.reportDir);

  const startedAt = new Date();
  const normalizedCases = normalizeTestCases(input.testCases);
  const warnings = [...(input.warnings ?? [])];
  let results;

  try {
    if (config.mode === 'base-url') {
      const hookLoad = await loadRunnerHooks(config.hooksPath);
      try {
        results = await runAgainstBaseUrl({
          testCases: normalizedCases,
          config,
          hooks: hookLoad.hooks,
        });
      } finally {
        await hookLoad.cleanup();
      }
    } else {
      results = await runAgainstAppImport({
        testCases: normalizedCases,
        config,
      });
    }
  } catch (err) {
    results = [
      {
        testCaseId: 'RUNNER',
        endpoint: 'Runner setup',
        method: 'N/A',
        scenario: 'Executable runner bootstrap',
        status: 'failed' as const,
        durationMs: 0,
        failureType:
          config.hooksPath && err instanceof Error && err.message.toLowerCase().includes('hook')
            ? ('hook' as const)
            : ('setup' as const),
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  const endedAt = new Date();
  const report = createExecutionReport(
    config,
    input.source,
    startedAt,
    endedAt,
    results,
    warnings
  );
  const savedFiles = await saveExecutionReport(report, config.reportDir, input.source);

  return {
    report,
    savedFiles,
    exitCode: report.summary.failed > 0 ? 1 : 0,
  };
}

export async function loadTestCasesFromFile(inputPath: string): Promise<TestCase[]> {
  const bundle = await loadGeneratedBundleFromFile(inputPath);
  return bundle.testCases;
}
