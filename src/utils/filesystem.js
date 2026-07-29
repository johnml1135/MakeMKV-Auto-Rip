import fs from "fs";
import { join } from "path";
import { Logger } from "./logger.js";
import { PLATFORM_DEFAULTS } from "../constants/index.js";
import { access, readdir } from "fs/promises";
import os from "os";

/**
 * Filesystem utilities for file and folder operations
 */
export class FileSystemUtils {
  /**
   * Make a title valid for use as a folder path by removing invalid characters
   * @param {string} title - The title to sanitize
   * @returns {string} - Sanitized title safe for filesystem use
   */
  static makeTitleValidFolderPath(title) {
    return title
      .replace(/\\/g, "")
      .replace(/\//g, "")
      .replace(/:/g, "")
      .replace(/\*/g, "")
      .replace(/\?/g, "")
      .replace(/</g, "")
      .replace(/>/g, "")
      .replace(/\|/g, "")
      .replace(/['"]+/g, "");
  }

  /**
   * Create a unique folder by appending a number if the folder already exists
   * @param {string} outputPath - The base path where to create the folder
   * @param {string} folderName - The desired folder name
   * @returns {string} - The full path of the created folder
   */
  static createUniqueFolder(outputPath, folderName) {
    let dir = join(outputPath, folderName);
    let folderCounter = 1;

    if (fs.existsSync(dir)) {
      while (fs.existsSync(`${dir}-${folderCounter}`)) {
        folderCounter++;
      }
      dir += `-${folderCounter}`;
    }

    // Recursive so a configured media directory that does not exist yet is
    // created rather than failing the rip with ENOENT.
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Read the contents of a directory
   * @param {string} dirPath - The path to the directory to read
   * @returns {Promise<string[]>} - Array of file/directory names in the directory
   */
  static async readdir(dirPath) {
    try {
      const files = await readdir(dirPath);
      Logger.debug(`Read ${files.length} entries from ${dirPath}`);
      return files;
    } catch (error) {
      Logger.error(`Error reading directory ${dirPath}:`, error);
      throw error;
    }
  }

  /**
   * Delete a file asynchronously
   * @param {string} filePath - The path to the file to delete
   * @returns {Promise<void>}
   */
  static async unlink(filePath) {
    try {
      await fs.promises.unlink(filePath);
      Logger.debug(`Deleted file: ${filePath}`);
    } catch (error) {
      Logger.error(`Error deleting file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Create a unique log file name by appending a number if the file already exists
   * @param {string} logDir - The directory where to create the log file
   * @param {string} fileName - The base file name
   * @returns {string} - The full path of the unique log file
   */
  static createUniqueLogFile(logDir, fileName) {
    let dir = join(logDir, `Log-${fileName}`);
    let fileCounter = 1;

    if (fs.existsSync(`${dir}.txt`)) {
      while (fs.existsSync(`${dir}-${fileCounter}.txt`)) {
        fileCounter++;
      }
      dir += `-${fileCounter}`;
    }

    return `${dir}.txt`;
  }

  /**
   * Write content to a log file
   * @param {string} filePath - The full path to the log file
   * @param {string} content - The content to write
   * @param {string} titleName - The title name for logging purposes
   * @returns {Promise<void>}
   */
  static async writeLogFile(filePath, content, titleName) {
    return new Promise((resolve, reject) => {
      fs.writeFile(filePath, content, "utf8", (err) => {
        if (err) {
          Logger.error("Directory for logs does not exist. Please create it.");
          reject(err);
        } else {
          Logger.info(
            `Full log file for ${titleName} has been written to file`
          );
          resolve();
        }
      });
    });
  }

  /**
   * Detect MakeMKV installation path for the current platform
   * @returns {Promise<string|null>} - Path to MakeMKV directory or null if not found
   */
  static async detectMakeMKVInstallation() {
    const platform = os.platform();
    const platformPaths = PLATFORM_DEFAULTS.MAKEMKV_PATHS[platform];

    if (!platformPaths) {
      Logger.warning(`Unsupported platform: ${platform}`);
      return null;
    }

    for (const basePath of platformPaths) {
      try {
        // Check if the directory exists
        await access(basePath);

        // Check if makemkvcon executable exists in this path
        const executableName =
          platform === "win32" ? "makemkvcon.exe" : "makemkvcon";
        const executablePath = join(basePath, executableName);

        try {
          await access(executablePath);
          Logger.info(`Found MakeMKV installation at: ${basePath}`);
          return basePath;
        } catch {
          // Executable not found in this directory, try next
          continue;
        }
      } catch {
        // Directory doesn't exist, try next
        continue;
      }
    }

    Logger.warning(
      `MakeMKV installation not found in default locations for ${platform}`
    );
    return null;
  }

  /**
   * Validate that MakeMKV executable exists at given path
   * @param {string} mkvDir - Path to MakeMKV directory
   * @returns {Promise<boolean>} - True if executable exists
   */
  static async validateMakeMKVInstallation(mkvDir) {
    if (!mkvDir) return false;

    try {
      const platform = os.platform();
      const executableName =
        platform === "win32" ? "makemkvcon.exe" : "makemkvcon";
      const executablePath = join(mkvDir, executableName);

      await access(executablePath);
      return true;
    } catch {
      return false;
    }
  }
}
