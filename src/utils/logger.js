import chalk from "chalk";
import { format } from "date-fns";
import { AppConfig } from "../config/index.js";

/**
 * Color styling functions using chalk
 */
export const colors = {
  info: chalk.green,
  error: chalk.red,
  time: chalk.yellow,
  dash: chalk.gray,
  title: chalk.cyan,
  line1: chalk.white.bgBlack,
  line2: chalk.black.bgWhite,
  warning: chalk.white.bgRed,
  white: {
    underline: chalk.white.underline,
  },
  blue: chalk.blue,
  debug: chalk.gray,
};

/**
 * Logger utility class for consistent logging throughout the application
 */
export class Logger {
  static #verbose = false;

  /**
   * Enable or disable verbose/debug logging
   * @param {boolean} enabled - Whether verbose logging should be enabled
   */
  static setVerbose(enabled) {
    Logger.#verbose = !!enabled;
  }

  /**
   * Check if verbose logging is enabled
   * @returns {boolean} Whether verbose logging is enabled
   */
  static isVerbose() {
    return Logger.#verbose;
  }

  static info(message, title = null) {
    const timeFormat =
      AppConfig.logTimeFormat === "12hr" ? "h:mm:ss a" : "HH:mm:ss";
    const timestamp = colors.time(format(new Date(), timeFormat));
    const dash = colors.dash(" - ");
    const infoText = colors.info(message);

    if (title) {
      console.info(`${timestamp}${dash}${infoText}${colors.title(title)}`);
    } else {
      console.info(`${timestamp}${dash}${infoText}`);
    }
  }

  /**
   * Log a debug message (only shown when verbose mode is enabled)
   * @param {string} message - The debug message to log
   * @param {string} [title] - Optional title to append
   */
  static debug(message, title = null) {
    if (!Logger.#verbose) {
      return;
    }
    const timeFormat =
      AppConfig.logTimeFormat === "12hr" ? "h:mm:ss a" : "HH:mm:ss";
    const timestamp = colors.time(format(new Date(), timeFormat));
    const dash = colors.dash(" - ");
    const debugText = colors.debug(`[DEBUG] ${message}`);

    if (title) {
      console.info(`${timestamp}${dash}${debugText}${colors.title(title)}`);
    } else {
      console.info(`${timestamp}${dash}${debugText}`);
    }
  }

  static error(message, details = null) {
    const timeFormat =
      AppConfig.logTimeFormat === "12hr" ? "h:mm:ss a" : "HH:mm:ss";
    const timestamp = colors.time(format(new Date(), timeFormat));
    const dash = colors.dash(" - ");
    const errorText = colors.error(message);

    console.error(`${timestamp}${dash}${errorText}`);
    if (details) {
      console.error(colors.blue(details));
    }
  }

  static warning(message) {
    console.info(colors.warning(message));
  }

  static plain(message) {
    console.info(message);
  }

  static separator() {
    console.info("");
  }

  static header(message) {
    console.info(colors.line1(message));
  }

  static headerAlt(message) {
    console.info(colors.line2(message));
  }

  static underline(message) {
    console.info(colors.white.underline(message));
  }
}
