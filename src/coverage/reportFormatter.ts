import path from 'path';
import { writeFile } from '../utils/fileUtils';
import type { CoverageReport } from '../types';

function renderUncoveredEndpoints(report: CoverageReport): string {
  if (report.uncoveredEndpoints.length === 0) {
    return 'No uncovered endpoints.';
  }

  return report.uncoveredEndpoints
    .map(endpoint => `- ${endpoint.method} ${endpoint.path}`)
    .join('\n');
}

function renderEndpointRows(report: CoverageReport): string {
  if (report.endpointSummaries.length === 0) {
    return '| - | - | 0 | - | 0 | 0 | 0 | 0 | pending | 0 |';
  }

  return report.endpointSummaries
    .map(
      endpoint =>
        `| ${endpoint.method} | ${endpoint.path} | ${endpoint.generatedTests} | ${
          endpoint.categoriesCovered.join(', ') || '-'
        } | ${endpoint.executed} | ${endpoint.passed} | ${endpoint.failed} | ${
          endpoint.skipped
        } | ${endpoint.runtimeState} | ${endpoint.overallScore} |`
    )
    .join('\n');
}

export function formatCoverageReportMarkdown(report: CoverageReport): string {
  const runtimeScore =
    report.summary.runtimeScore == null ? 'Pending' : `${report.summary.runtimeScore}`;
  const passRate =
    report.summary.passRate == null ? 'Pending' : `${report.summary.passRate}%`;

  return `# Coverage Dashboard Report

**Generated:** ${report.metadata.generatedAt}  
**Source:** ${report.metadata.source}  
**Source Type:** ${report.metadata.sourceType}  
**Execution State:** ${report.metadata.executionState}

## Summary

| Metric | Value |
|--------|-------|
| Discovered | ${report.summary.discoveredTotal} |
| In Scope | ${report.summary.inScopeTotal} |
| Covered Endpoints | ${report.summary.coveredEndpoints} |
| Uncovered Endpoints | ${report.summary.uncoveredEndpoints} |
| Endpoint Coverage | ${report.summary.endpointCoveragePct}% |
| Total Tests | ${report.summary.totalTests} |
| Avg Tests / Covered Endpoint | ${report.summary.avgTestsPerCoveredEndpoint} |
| Executed Tests | ${report.summary.executedTests} |
| Pass Rate | ${passRate} |
| Mutation-Gated Endpoints | ${report.summary.mutationGatedEndpoints} |
| Design Score | ${report.summary.designScore} |
| Runtime Score | ${runtimeScore} |
| Overall Score | ${report.summary.overallScore} |
| Warnings | ${report.summary.warnings} |

## Category Coverage

| Category | Endpoints Covered | Total Endpoints | Test Count | Coverage |
|----------|-------------------|-----------------|------------|----------|
${report.categorySummaries
  .map(
    category =>
      `| ${category.category} | ${category.endpointsCovered} | ${category.totalEndpoints} | ${category.testCount} | ${category.coveragePct}% |`
  )
  .join('\n')}

## Uncovered Endpoints

${renderUncoveredEndpoints(report)}

## Endpoint Matrix

| Method | Path | Generated Tests | Categories | Executed | Passed | Failed | Skipped | Runtime State | Overall Score |
|--------|------|-----------------|------------|----------|--------|--------|---------|---------------|---------------|
${renderEndpointRows(report)}

## Warnings

${
  report.warnings.length === 0
    ? 'No warnings.'
    : report.warnings
        .map(
          warning =>
            `- [${warning.kind}] ${warning.file}${warning.line ? `:${warning.line}` : ''} ${warning.message}`
        )
        .join('\n')
}
`;
}

export function generateCoverageReportFilenames(source: string): {
  json: string;
  markdown: string;
} {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSource =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'coverage';

  return {
    json: `${timestamp}_${safeSource}_coverage-report.json`,
    markdown: `${timestamp}_${safeSource}_coverage-report.md`,
  };
}

export async function saveCoverageReport(
  report: CoverageReport,
  reportDir: string,
  source: string
): Promise<string[]> {
  const filenames = generateCoverageReportFilenames(source);
  const jsonPath = path.join(reportDir, filenames.json);
  const markdownPath = path.join(reportDir, filenames.markdown);

  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(markdownPath, formatCoverageReportMarkdown(report));

  return [jsonPath, markdownPath];
}
