import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import fs from "fs";
import { AppConfig } from "../config/index.js";
import { Logger } from "../utils/logger.js";
import { FileSystemUtils } from "../utils/filesystem.js";
import { ValidationUtils } from "../utils/validation.js";
import { HANDBRAKE_CONSTANTS } from "../constants/index.js";

const execAsync = promisify(exec);

/**
 * Error class for HandBrake-specific errors
 * @extends Error
 */
class HandBrakeError extends Error {
  /**
   * Create a HandBrake error
   * @param {string} message - The error message
   * @param {string|Object|null} details - Additional error details
   */
  constructor(message, details = null) {
    super(message);
    this.name = 'HandBrakeError';
    this.details = details;
  }
}

/**
 * Service for handling HandBrake post-processing operations
 */
export class HandBrakeService {
  /**
   * Retry a conversion with fallback preset on failure
   * @param {string} inputPath - Path to input file
   * @param {string} outputPath - Path to output file  
   * @param {string} handBrakePath - Path to HandBrake CLI
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<boolean>} Success status
   * @private
   */
  static async retryConversion(inputPath, outputPath, handBrakePath, retryCount = 0) {
    const maxRetries = 2;
    const fallbackPresets = ["Fast 1080p30", "Fast 720p30", "Fast 480p30"];

    if (retryCount >= maxRetries) {
      Logger.error("Maximum retry attempts reached for HandBrake conversion");
      return false;
    }

    try {
      // Use fallback preset for retries
      const originalPreset = AppConfig.handbrake.preset;
      const fallbackPreset = fallbackPresets[retryCount] || fallbackPresets[0];

      Logger.info(`Retry attempt ${retryCount + 1} with preset: ${fallbackPreset}`);

      // Temporarily override preset
      const tempConfig = { ...AppConfig.handbrake };
      tempConfig.preset = fallbackPreset;
      const tempOriginal = AppConfig.handbrake;
      AppConfig.handbrake = tempConfig;

      const command = this.buildCommand(handBrakePath, inputPath, outputPath);

      const { stdout, stderr } = await execAsync(command, {
        timeout: HANDBRAKE_CONSTANTS.MIN_TIMEOUT_HOURS * 60 * 60 * 1000, // Shorter timeout for retries
        maxBuffer: 1024 * 1024 * 10
      });

      // Restore original config
      AppConfig.handbrake = tempOriginal;

      this.parseHandBrakeOutput(stdout, stderr);
      await this.validateOutput(outputPath);

      Logger.info(`Retry successful with preset: ${fallbackPreset}`);
      return true;

    } catch (error) {
      Logger.warn(`Retry ${retryCount + 1} failed:`, error.message);

      // Try again with next fallback preset
      return await this.retryConversion(inputPath, outputPath, handBrakePath, retryCount + 1);
    }
  }
  /**
   * Validates HandBrake installation and configuration
   * @param {Object} configOverride - Optional config override for testing
   * @returns {Promise<void>}
   * @throws {HandBrakeError} If HandBrake is not properly configured or installed
   */
  static async validate(configOverride = null) {
    const config = configOverride || AppConfig.handbrake;

    if (!config?.enabled) {
      Logger.info("HandBrake post-processing is disabled");
      return;
    }

    Logger.info("Validating HandBrake setup...");

    // Validate configuration first
    this.validateConfig(configOverride);

    // Then validate HandBrake installation
    try {
      await this.getHandBrakePath(configOverride);
      Logger.info("HandBrake validation successful");
    } catch (error) {
      throw new HandBrakeError(
        "HandBrake validation failed - please check your installation",
        error.message
      );
    }
  }

  /**
   * Validates HandBrake configuration
   * @param {Object} configOverride - Optional config override for testing
   * @throws {HandBrakeError} If configuration is invalid
   * @private
   */
  static validateConfig(configOverride = null) {
    const config = configOverride || AppConfig.handbrake;

    if (!config) {
      throw new HandBrakeError("HandBrake configuration is missing");
    }

    // Validate output format
    if (!HANDBRAKE_CONSTANTS.SUPPORTED_FORMATS.includes(config.output_format?.toLowerCase())) {
      throw new HandBrakeError(`Invalid output format '${config.output_format}'. Must be one of: ${HANDBRAKE_CONSTANTS.SUPPORTED_FORMATS.join(', ')}`);
    }

    // Validate preset
    if (!config.preset || config.preset.trim() === '') {
      throw new HandBrakeError("HandBrake preset must be specified");
    }

    // Validate additional args don't conflict with core settings
    if (config.additional_args) {
      const conflictingArgs = ['-i', '--input', '-o', '--output', '--preset'];
      const hasConflict = conflictingArgs.some(arg => config.additional_args.includes(arg));
      if (hasConflict) {
        throw new HandBrakeError(
          `Additional arguments contain conflicting options: ${conflictingArgs.join(', ')}. These are handled automatically.`
        );
      }
    }

    Logger.info("HandBrake configuration validation passed");
  }

  /**
   * Get the HandBrakeCLI path, using either configured path or attempting auto-detection
   * @param {Object} configOverride - Optional config override for testing
   * @returns {Promise<string>} The path to HandBrakeCLI executable
   * @throws {HandBrakeError} If HandBrakeCLI cannot be found
   * @private
   */
  static async getHandBrakePath(configOverride = null) {
    const config = configOverride || AppConfig.handbrake;

    if (config?.cli_path) {
      Logger.info("Using configured HandBrakeCLI path...");
      if (!fs.existsSync(config.cli_path)) {
        throw new HandBrakeError(
          "Configured HandBrakeCLI path does not exist",
          `Path: ${config.cli_path}`
        );
      }
      Logger.info(`Found HandBrakeCLI at: ${config.cli_path}`);
      return config.cli_path;
    }

    // Auto-detect based on platform
    Logger.info("Auto-detecting HandBrakeCLI installation...");
    const isWindows = process.platform === "win32";
    const defaultPaths = isWindows
      ? [
        "C:/Program Files/HandBrake/HandBrakeCLI.exe",
        "C:/Program Files (x86)/HandBrake/HandBrakeCLI.exe"
      ]
      : [
        "/usr/bin/HandBrakeCLI",
        "/usr/local/bin/HandBrakeCLI",
        "/opt/homebrew/bin/HandBrakeCLI" // For macOS Homebrew installations
      ];

    for (const path of defaultPaths) {
      Logger.info(`Checking path: ${path}`);
      if (fs.existsSync(path)) {
        Logger.info(`Found HandBrakeCLI at: ${path}`);
        return path;
      }
    }

    throw new HandBrakeError(
      "HandBrakeCLI not found. Please install HandBrake or specify the path in config.yaml",
      `Searched paths: ${defaultPaths.join(", ")}`
    );
  }

  /**
   * Builds the HandBrake command with proper arguments
   * @param {string} handBrakePath - Path to HandBrakeCLI executable
   * @param {string} inputPath - Path to input MKV file
   * @param {string} outputPath - Path to output file
   * @returns {string} Constructed command
   * @private
   */
  /**
   * Sanitize file path to prevent injection attacks
   * @param {string} filePath - The file path to sanitize
   * @returns {string} Sanitized path
   * @private
   */
  static sanitizePath(filePath) {
    // Remove any potentially dangerous characters
    return filePath.replace(/[;&|`$(){}[\]]/g, '');
  }

  /**
   * Builds the HandBrake command with proper arguments
   * @param {string} handBrakePath - Path to HandBrakeCLI executable
   * @param {string} inputPath - Path to input MKV file
   * @param {string} outputPath - Path to output file
   * @returns {string} Constructed command
   * @throws {HandBrakeError} If paths contain invalid characters
   * @private
   */
  static buildCommand(handBrakePath, inputPath, outputPath) {
    const config = AppConfig.handbrake;

    // Validate and sanitize paths
    if (!handBrakePath || !inputPath || !outputPath) {
      throw new HandBrakeError('All paths must be provided for HandBrake command');
    }

    // Sanitize paths to prevent injection
    const sanitizedHandBrakePath = this.sanitizePath(handBrakePath);
    const sanitizedInputPath = this.sanitizePath(inputPath);
    const sanitizedOutputPath = this.sanitizePath(outputPath);

    // Base arguments with proper escaping
    const args = [
      `"${sanitizedHandBrakePath}"`,
      `--input "${sanitizedInputPath}"`,
      `--output "${sanitizedOutputPath}"`,
      `--preset "${config.preset}"`,
      '--verbose=1', // Enable progress output
      '--no-dvdnav'  // Disable DVD navigation for better compatibility
    ];

    // Add format-specific optimizations
    if (config.output_format.toLowerCase() === 'mp4') {
      args.push('--optimize');
    }

    // Add custom arguments if specified (with validation)
    if (config.additional_args && config.additional_args.trim()) {
      // Validate additional args don't contain dangerous characters
      if (/[;&|`$()]/.test(config.additional_args)) {
        Logger.warning('Additional arguments contain potentially unsafe characters, skipping');
      } else {
        // Split by space but respect quoted arguments
        const customArgs = config.additional_args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        args.push(...customArgs);
      }
    }

    return args.join(' ');
  }

  /**
   * Validates the output file after conversion
   * @param {string} outputPath - Path to the output file
   * @throws {HandBrakeError} If validation fails
   * @private
   */
  static async validateOutput(outputPath) {
    Logger.info("Validating HandBrake output...");

    if (!fs.existsSync(outputPath)) {
      throw new HandBrakeError("HandBrake conversion failed - output file not created");
    }

    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / 1024 / 1024);

    Logger.info(`Output file exists, size: ${fileSizeMB.toFixed(2)} MB`);

    // Check if file is empty
    if (!stats || stats.size === 0) {
      throw new HandBrakeError("HandBrake conversion failed - output file is empty");
    }

    // Check if file is suspiciously small (likely corruption)
    if (fileSizeMB < HANDBRAKE_CONSTANTS.MIN_FILE_SIZE_MB) {
      Logger.warn(`Output file is very small (${fileSizeMB.toFixed(2)} MB) - possible conversion issue`);
    }

    // Verify file can be opened (basic corruption check)
    try {
      const fd = fs.openSync(outputPath, 'r');
      const buffer = Buffer.alloc(1024);
      fs.readSync(fd, buffer, 0, 1024, 0);
      fs.closeSync(fd);

      // Check for common video file headers
      const header = buffer.toString('hex', 0, 8);
      const expectedHeader = HANDBRAKE_CONSTANTS.FILE_HEADERS[AppConfig.handbrake.output_format.toUpperCase()];
      if (!header.includes(expectedHeader)) {
        Logger.warn('Output file may not be a valid video file - header mismatch');
      }
    } catch (error) {
      throw new HandBrakeError(`Output file appears to be corrupted: ${error.message}`);
    }

    Logger.info(`Output file validated successfully (${fileSizeMB.toFixed(2)} MB)`);
  }

  /**
   * Parse HandBrake output for progress information and warnings
   * @param {string} stdout - Standard output from HandBrake
   * @param {string} stderr - Standard error from HandBrake
   * @private
   */
  static parseHandBrakeOutput(stdout, stderr) {
    const allOutput = `${stdout}\n${stderr}`;
    const lines = allOutput.split('\n');

    // Look for encoding progress
    const progressLines = lines.filter(line =>
      line.includes('Encoding:') ||
      line.includes('frame') ||
      line.includes('%')
    );

    if (progressLines.length > 0) {
      const lastProgress = progressLines[progressLines.length - 1];
      Logger.info(`HandBrake progress: ${lastProgress.trim()}`);
    }

    // Check for warnings (but not errors)
    const warningLines = lines.filter(line =>
      line.toLowerCase().includes('warning') &&
      !line.toLowerCase().includes('error')
    );

    if (warningLines.length > 0) {
      Logger.warn(`HandBrake warnings detected:`);
      warningLines.forEach(warning => Logger.warn(`  ${warning.trim()}`));
    }
  }

  /**
   * Convert an MKV file using HandBrake
   * @param {string} inputPath - Path to input MKV file
   * @returns {Promise<boolean>} True if conversion was successful
   */
  static async convertFile(inputPath) {
    try {
      if (!AppConfig.handbrake?.enabled) {
        Logger.info("HandBrake post-processing is disabled, skipping...");
        return true;
      }

      Logger.info("Beginning HandBrake post-processing...");
      Logger.info(`Input file path: ${inputPath}`);

      // Validate input file
      if (!fs.existsSync(inputPath)) {
        throw new HandBrakeError(`Input file does not exist: ${inputPath}`);
      }

      const inputStats = fs.statSync(inputPath);
      const inputSizeMB = (inputStats.size / 1024 / 1024);
      Logger.info(`Input file size: ${inputSizeMB.toFixed(2)} MB`);

      if (inputStats.size === 0) {
        throw new HandBrakeError(`Input file is empty: ${inputPath}`);
      }

      Logger.info("Validating HandBrake configuration...");
      this.validateConfig();

      const handBrakePath = await this.getHandBrakePath();
      const outputPath = path.join(
        path.dirname(inputPath),
        `${path.basename(inputPath, ".mkv")}.${AppConfig.handbrake.output_format.toLowerCase()}`
      );

      Logger.info(`HandBrake configuration:`);
      Logger.info(`- CLI Path: ${handBrakePath}`);
      Logger.info(`- Preset: ${AppConfig.handbrake.preset}`);
      Logger.info(`- Output Format: ${AppConfig.handbrake.output_format}`);
      Logger.info(`- Delete Original: ${AppConfig.handbrake.delete_original}`);
      Logger.info(`Starting HandBrake conversion for: ${path.basename(inputPath)}`);
      Logger.info(`Output format: ${AppConfig.handbrake.output_format}`);
      Logger.info(`Using preset: ${AppConfig.handbrake.preset}`);
      Logger.info(`Output will be saved as: ${path.basename(outputPath)}`);
      Logger.info("This may take a while depending on the file size and preset used.");

      const command = this.buildCommand(handBrakePath, inputPath, outputPath);
      Logger.info(`Executing command: ${command}`);

      // Set timeout based on file size (rough estimate: 2 hours + 1 minute per GB)
      const fileSizeGB = inputStats.size / (1024 * 1024 * 1024);
      const timeoutMs = Math.max(
        HANDBRAKE_CONSTANTS.MIN_TIMEOUT_HOURS * 60 * 60 * 1000,
        Math.min(fileSizeGB * 60 * 1000, HANDBRAKE_CONSTANTS.MAX_TIMEOUT_HOURS * 60 * 60 * 1000)
      );

      Logger.info(`File size: ${fileSizeGB.toFixed(2)} GB, timeout: ${(timeoutMs / 1000 / 60).toFixed(0)} minutes`);

      // Start timing the conversion
      const conversionStart = Date.now();
      Logger.info("Starting HandBrake encoding process...");

      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer for long outputs
      });

      // Parse HandBrake output for progress and warnings
      this.parseHandBrakeOutput(stdout, stderr);

      await this.validateOutput(outputPath);

      // Calculate conversion metrics
      const conversionEnd = Date.now();
      const conversionTimeMs = conversionEnd - conversionStart;
      const conversionTimeMin = (conversionTimeMs / 1000 / 60).toFixed(1);

      const outputStats = fs.statSync(outputPath);
      const outputSizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
      const compressionRatio = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);
      const processingSpeed = (fileSizeGB / (conversionTimeMs / 1000 / 60 / 60)).toFixed(2); // GB/hour

      Logger.info(`HandBrake conversion completed successfully: ${path.basename(outputPath)}`);
      Logger.info(`Conversion metrics:`);
      Logger.info(`  - Duration: ${conversionTimeMin} minutes`);
      Logger.info(`  - Original size: ${inputSizeMB.toFixed(2)} MB`);
      Logger.info(`  - Compressed size: ${outputSizeMB} MB`);
      Logger.info(`  - Compression: ${compressionRatio}% reduction`);
      Logger.info(`  - Processing speed: ${processingSpeed} GB/hour`);

      if (AppConfig.handbrake.delete_original) {
        Logger.info(`Deleting original MKV file: ${path.basename(inputPath)}`);
        await FileSystemUtils.unlink(inputPath);
        Logger.info("Original MKV file deleted successfully");
      }

      return true;
    } catch (error) {
      // Cleanup partial output file on failure
      try {
        if (outputPath && fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          if (stats.size === 0 || stats.size < 1024 * 1024) { // Less than 1MB
            Logger.info("Removing incomplete output file...");
            fs.unlinkSync(outputPath);
          }
        }
      } catch (cleanupError) {
        Logger.warn("Failed to cleanup incomplete output file:", cleanupError.message);
      }

      if (error instanceof HandBrakeError) {
        Logger.error(`HandBrake Error: ${error.message}`);
        if (error.details) {
          Logger.error("HandBrake Error Details:", error.details);
        }
      } else if (error.code === 'TIMEOUT') {
        Logger.error("HandBrake conversion timed out - file may be too large or system too slow");
        Logger.error("Consider increasing timeout or using a faster preset");
      } else {
        Logger.error("HandBrake conversion failed with unexpected error:");
        Logger.error("Error Details:", {
          name: error.name,
          code: error.code,
          message: error.message,
          command: typeof command !== 'undefined' ? command : 'Command not available'
        });
      }
      return false;
    }
  }
}