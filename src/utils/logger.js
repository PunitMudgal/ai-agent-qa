/**
 * @module logger
 * @description Colored console logging with spinner support using chalk and ora.
 */

const chalk = require('chalk');
const ora = require('ora');

let currentSpinner = null;
let isQuiet = false;
let isVerbose = false;

/**
 * Configure logger behavior.
 * @param {object} options
 * @param {boolean} [options.quiet] - Suppress all output except errors.
 * @param {boolean} [options.verbose] - Show detailed debug logs.
 * @param {boolean} [options.noColor] - Disable colored output.
 */
function configure(options = {}) {
  isQuiet = options.quiet || false;
  isVerbose = options.verbose || false;
  if (options.noColor) {
    chalk.level = 0;
  }
}

/**
 * Log an informational message.
 * @param {string} msg
 */
function info(msg) {
  if (!isQuiet) {
    console.log(chalk.blue('ℹ'), msg);
  }
}

/**
 * Log a success message.
 * @param {string} msg
 */
function success(msg) {
  if (!isQuiet) {
    console.log(chalk.green('✔'), chalk.green(msg));
  }
}

/**
 * Log a warning message.
 * @param {string} msg
 */
function warn(msg) {
  if (!isQuiet) {
    console.log(chalk.yellow('⚠'), chalk.yellow(msg));
  }
}

/**
 * Log an error message.
 * @param {string} msg
 */
function error(msg) {
  console.error(chalk.red('✖'), chalk.red(msg));
}

/**
 * Log a debug message (only when verbose mode is on).
 * @param {string} msg
 */
function debug(msg) {
  if (isVerbose && !isQuiet) {
    console.log(chalk.gray('🔍'), chalk.gray(msg));
  }
}

/**
 * Log a blank line.
 */
function newline() {
  if (!isQuiet) {
    console.log();
  }
}

/**
 * Log a header / section title.
 * @param {string} msg
 */
function header(msg) {
  if (!isQuiet) {
    console.log();
    console.log(chalk.bold.underline(msg));
    console.log();
  }
}

/**
 * Log a key-value pair.
 * @param {string} key
 * @param {string} value
 */
function keyValue(key, value) {
  if (!isQuiet) {
    console.log(`  ${chalk.gray(key + ':')} ${value}`);
  }
}

/**
 * Start a spinner with the given text.
 * @param {string} text
 * @returns {object} The ora spinner instance.
 */
function startSpinner(text) {
  if (isQuiet) return null;
  if (currentSpinner) {
    currentSpinner.stop();
  }
  currentSpinner = ora({ text, color: 'cyan' }).start();
  return currentSpinner;
}

/**
 * Stop the current spinner.
 * @param {boolean} success - If true, mark as succeeded; otherwise mark as failed.
 * @param {string} [text] - Optional replacement text.
 */
function stopSpinner(succeeded = true, text) {
  if (!currentSpinner) return;
  if (succeeded) {
    currentSpinner.succeed(text);
  } else {
    currentSpinner.fail(text);
  }
  currentSpinner = null;
}

/**
 * Update spinner text.
 * @param {string} text
 */
function updateSpinner(text) {
  if (currentSpinner) {
    currentSpinner.text = text;
  }
}

/**
 * Display a summary table.
 * @param {Array<{label: string, value: string|number}>} rows
 */
function table(rows) {
  if (isQuiet) return;
  const maxLabel = Math.max(...rows.map(r => r.label.length));
  console.log();
  rows.forEach(({ label, value }) => {
    console.log(`  ${chalk.cyan(label.padEnd(maxLabel + 2))} ${value}`);
  });
  console.log();
}

module.exports = {
  configure,
  info,
  success,
  warn,
  error,
  debug,
  newline,
  header,
  keyValue,
  table,
  startSpinner,
  stopSpinner,
  updateSpinner,
};
