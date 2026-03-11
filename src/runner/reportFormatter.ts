import path from 'path';
import { writeFile } from '../utils/fileUtils';
import type { ExecutionReport, ExecutionTestResult } from '../types';

function formatCategoryRows(results: ExecutionTestResult[]): string {
  const grouped = new Map<string, ExecutionTestResult[]>();

  for (const result of results.filter(r => r.status === 'failed')) {
    const key = result.failureType ?? 'runner';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(result);
  }

  if (grouped.size === 0) {
    return '- None';
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, items]) => `- ${type}: ${items.length}`)
    .join('\n');
}

function renderFailureRows(results: ExecutionTestResult[]): string {
  const failed = results.filter(r => r.status === 'failed');
  if (failed.length === 0) {
    return 'No failed tests.';
  }

  return failed
    .map(result => {
      const message = result.message ?? 'No failure message';
      return `### ${result.testCaseId} ${result.method} ${result.endpoint}

- Scenario: ${result.scenario}
- Failure type: ${result.failureType ?? 'runner'}
- Duration: ${result.durationMs}ms
- Message: ${message}`;
    })
    .join('\n\n');
}

function renderSkippedRows(results: ExecutionTestResult[]): string {
  const skipped = results.filter(r => r.status === 'skipped');
  if (skipped.length === 0) {
    return 'No skipped tests.';
  }

  return skipped
    .map(
      result =>
        `- ${result.testCaseId} ${result.method} ${result.endpoint}: ${result.skippedReason ?? 'Skipped'}`
    )
    .join('\n');
}

export function formatExecutionReportMarkdown(report: ExecutionReport): string {
  const startedAt = report.metadata.startedAt;
  return `# Executable Test Run Report

**Started:** ${startedAt}  
**Mode:** ${report.metadata.mode}  
**Source:** ${report.metadata.source}  
**Duration:** ${report.metadata.durationMs}ms

## Summary

| Metric | Value |
|--------|-------|
| Total | ${report.summary.total} |
| Executed | ${report.summary.executed} |
| Passed | ${report.summary.passed} |
| Failed | ${report.summary.failed} |
| Skipped | ${report.summary.skipped} |
| Skipped Mutations | ${report.summary.skippedMutations} |
| Warnings | ${report.summary.warnings} |

## Endpoint Summary

| Method | Endpoint | Total | Passed | Failed | Skipped | Duration |
|--------|----------|-------|--------|--------|---------|----------|
${report.endpointSummaries
  .map(
    summary =>
      `| ${summary.method} | ${summary.endpoint} | ${summary.total} | ${summary.passed} | ${summary.failed} | ${summary.skipped} | ${summary.durationMs}ms |`
  )
  .join('\n')}

## Failure Types

${formatCategoryRows(report.results)}

## Failed Tests

${renderFailureRows(report.results)}

## Skipped Tests

${renderSkippedRows(report.results)}

## Parser Warnings

${
  report.warnings.length === 0
    ? 'No parser warnings.'
    : report.warnings
        .map(
          warning =>
            `- [${warning.kind}] ${warning.file}${warning.line ? `:${warning.line}` : ''} ${warning.message}`
        )
        .join('\n')
}
`;
}

export function generateExecutionReportFilenames(source: string): {
  json: string;
  markdown: string;
} {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSource =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'run';

  return {
    json: `${timestamp}_${safeSource}_execution-report.json`,
    markdown: `${timestamp}_${safeSource}_execution-report.md`,
  };
}

export async function saveExecutionReport(
  report: ExecutionReport,
  reportDir: string,
  source: string
): Promise<string[]> {
  const filenames = generateExecutionReportFilenames(source);
  const jsonPath = path.join(reportDir, filenames.json);
  const markdownPath = path.join(reportDir, filenames.markdown);

  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(markdownPath, formatExecutionReportMarkdown(report));

  return [jsonPath, markdownPath];
}
