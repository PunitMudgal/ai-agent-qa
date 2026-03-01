/**
 * @module logger
 * @description Colored console logging with spinner support using chalk and ora.
 */

import chalk from 'chalk';
import ora from 'ora';

type SpinnerInstance = ReturnType<typeof ora>;

let currentSpinner: SpinnerInstance | null = null;
let isQuiet = false;
let isVerbose = false;

export interface LoggerConfigureOptions {
  quiet?: boolean;
  verbose?: boolean;
  noColor?: boolean;
}

export function configure(options: LoggerConfigureOptions = {}): void {
  isQuiet = options.quiet ?? false;
  isVerbose = options.verbose ?? false;
  if (options.noColor) {
    chalk.level = 0;
  }
}

export function info(msg: string): void {
  if (!isQuiet) {
    console.log(chalk.blue('ℹ'), msg);
  }
}

export function success(msg: string): void {
  if (!isQuiet) {
    console.log(chalk.green('✔'), chalk.green(msg));
  }
}

export function warn(msg: string): void {
  if (!isQuiet) {
    console.log(chalk.yellow('⚠'), chalk.yellow(msg));
  }
}

export function error(msg: string): void {
  console.error(chalk.red('✖'), chalk.red(msg));
}

export function debug(msg: string): void {
  if (isVerbose && !isQuiet) {
    console.log(chalk.gray('🔍'), chalk.gray(msg));
  }
}

export function newline(): void {
  if (!isQuiet) {
    console.log();
  }
}

export function header(msg: string): void {
  if (!isQuiet) {
    console.log();
    console.log(chalk.bold.underline(msg));
    console.log();
  }
}

export function keyValue(key: string, value: string | number): void {
  if (!isQuiet) {
    console.log(`  ${chalk.gray(key + ':')} ${value}`);
  }
}

export function startSpinner(text: string): SpinnerInstance | null {
  if (isQuiet) return null;
  if (currentSpinner) {
    currentSpinner.stop();
  }
  currentSpinner = ora({ text, color: 'cyan' }).start();
  return currentSpinner;
}

export function stopSpinner(succeeded = true, text?: string): void {
  if (!currentSpinner) return;
  if (succeeded) {
    currentSpinner.succeed(text);
  } else {
    currentSpinner.fail(text);
  }
  currentSpinner = null;
}

export function updateSpinner(text: string): void {
  if (currentSpinner) {
    currentSpinner.text = text;
  }
}

export interface TableRow {
  label: string;
  value: string | number;
}

export function table(rows: TableRow[]): void {
  if (isQuiet) return;
  const maxLabel = Math.max(...rows.map(r => r.label.length), 0);
  console.log();
  rows.forEach(({ label, value }) => {
    console.log(`  ${chalk.cyan(label.padEnd(maxLabel + 2))} ${value}`);
  });
  console.log();
}
