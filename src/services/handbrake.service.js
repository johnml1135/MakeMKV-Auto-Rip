import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import fs from "fs";
import { open, stat } from "fs/promises";
import { AppConfig } from "../config/index.js";
import { Logger } from "../utils/logger.js";
import { FileSystemUtils } from "../utils/filesystem.js";
import { ValidationUtils } from "../utils/validation.js";
import { HANDBRAKE_CONSTANTS } from "../constants/index.js";
import { validateHandBrakeConfig } from "../utils/handbrake-config.js";

const execAsync = promisify(exec);

const TEXT_SUBTITLE_HINTS = [
  'srt',
  'subrip',
  'ssa',
  'ass',
  'tx3g',
  'text'
];

const BITMAP_SUBTITLE_HINTS = [
  'pgs',
  'vobsub',
  'dvd',
  'bitmap',
  'hdmv'
];

/**
 * Error class for HandBrake-specific errors
 * @extends Error
 */
export class HandBrakeError extends Error {
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
  static extractJsonObjects(text) {
    const objects = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        if (depth > 0) depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          try {
            objects.push(JSON.parse(candidate));
          } catch {
            // ignore parse failures; output often includes non-JSON log text
          }
          start = -1;
        }
      }
    }

    return objects;
  }

  static normalizeIso639_2(value) {
    if (!value) return null;
    const s = String(value).trim().toLowerCase();
    if (s.length === 3) return s;
    // Common language names we care about
    if (s.startsWith('english')) return 'eng';
    if (s.startsWith('spanish')) return 'spa';
    if (s.startsWith('french')) return 'fre';
    if (s.startsWith('german')) return 'ger';
    return null;
  }

  static parseLangList(langList) {
    const raw = (langList || '').trim();
    if (!raw) return ['eng', 'any'];
    return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  static subtitleIsText(track) {
    const blob = JSON.stringify(track || {}).toLowerCase();
    return TEXT_SUBTITLE_HINTS.some(h => blob.includes(h));
  }

  static subtitleIsBitmap(track) {
    const blob = JSON.stringify(track || {}).toLowerCase();
    return BITMAP_SUBTITLE_HINTS.some(h => blob.includes(h));
  }

  static subtitleTrackLang(track) {
    // HandBrake JSON tends to include one of these, depending on build
    const candidate = track?.Language || track?.Lang || track?.language || track?.lang || track?.LanguageCode;
    return this.normalizeIso639_2(candidate);
  }

  static trackMatchesLang(trackLang, allowed) {
    if (!allowed || allowed.length === 0) return true;
    if (allowed.includes('any')) return true;
    if (!trackLang) return false;
    return allowed.includes(trackLang);
  }

  /**
   * Decide whether to burn subtitles when subtitles.burned is set to "auto".
   * Text subtitles are preferred (soft subs). Bitmap-only sources fall back to burning.
   * @private
   */
  static async decideAutoBurn(handBrakePath, inputPath) {
    try {
      const config = AppConfig.handbrake;
      const subtitles = config.subtitles || {};
      const langList = this.parseLangList(subtitles.lang_list);

      // Scan input and request JSON output.
      const cmd = [
        `"${this.sanitizePath(handBrakePath)}"`,
        `--input "${this.sanitizePath(inputPath)}"`,
        '--title 1',
        '--scan',
        '--json'
      ].join(' ');

      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 5 * 60 * 1000,
        maxBuffer: 1024 * 1024 * 10
      });

      const jsonObjects = this.extractJsonObjects(`${stdout}\n${stderr}`);
      // Find any object with a TitleList (most common)
      const hb = jsonObjects.find(o => o && (o.TitleList || o?.titleList || o?.Titles)) || jsonObjects[0];
      const titleList = hb?.TitleList || hb?.titleList || hb?.Titles || [];
      const title = Array.isArray(titleList) ? titleList[0] : null;
      const subtitleList = title?.Subtitles || title?.subtitles || [];

      if (!Array.isArray(subtitleList) || subtitleList.length === 0) {
        return { burn: false, reason: 'no_subtitles_detected' };
      }

      const matching = subtitleList.filter(track => this.trackMatchesLang(this.subtitleTrackLang(track), langList));
      const matchingText = matching.filter(t => this.subtitleIsText(t));
      const matchingBitmap = matching.filter(t => this.subtitleIsBitmap(t));

      if (matchingText.length > 0) {
        return { burn: false, reason: 'text_subtitles_available' };
      }

      if (matchingBitmap.length > 0) {
        return { burn: true, reason: 'bitmap_only_fallback' };
      }

      // Unknown type: do not burn by default.
      return { burn: false, reason: 'unknown_subtitle_type' };
    } catch (error) {
      Logger.warning(`Subtitle scan failed, defaulting to no-burn: ${error.message}`);
      return { burn: false, reason: 'scan_failed' };
    }
  }
  /**
   * Retry a conversion with fallback preset on failure
   * @param {string} inputPath - Path to input file
   * @param {string} outputPath - Path to output file  
   * @param {string} handBrakePath - Path to HandBrake CLI
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<boolean>} Success status
   * @private
   */
  static async retryConversion(inputPath, outputPath, handBrakePath, retryCount = 0, subtitleOverride = null) {
    const { MAX_ATTEMPTS, FALLBACK_PRESETS } = HANDBRAKE_CONSTANTS.RETRY;

    if (retryCount >= MAX_ATTEMPTS) {
      Logger.error("Maximum retry attempts reached for HandBrake conversion");
      return false;
    }

    try {
      // Use fallback preset for retries (pass as parameter instead of mutating config)
      const fallbackPreset = FALLBACK_PRESETS[retryCount] || FALLBACK_PRESETS[0];

      Logger.info(`Retry attempt ${retryCount + 1} with preset: ${fallbackPreset}`);

      // Build command with override preset - no config mutation
      const command = this.buildCommand(handBrakePath, inputPath, outputPath, fallbackPreset, subtitleOverride);

      const { stdout, stderr } = await execAsync(command, {
        timeout: HANDBRAKE_CONSTANTS.MIN_TIMEOUT_HOURS * HANDBRAKE_CONSTANTS.TIMEOUT.MS_PER_HOUR,
        maxBuffer: 1024 * 1024 * 10
      });

      this.parseHandBrakeOutput(stdout, stderr);
      await this.validateOutput(outputPath);

      Logger.info(`Retry successful with preset: ${fallbackPreset}`);
      return true;

    } catch (error) {
      Logger.warning(`Retry ${retryCount + 1} failed: ${error.message}`);

      // Try again with next fallback preset
      return await this.retryConversion(inputPath, outputPath, handBrakePath, retryCount + 1, subtitleOverride);
    }
  }
  /**
   * Validates HandBrake installation and configuration
   * @param {Object} configOverride - Optional config override for testing
   * @returns {Promise<void>}
   * @throws {HandBrakeError} If HandBrake is not properly configured or installed
   */
  static async validate(configOverride) {
    const config = arguments.length > 0 ? configOverride : AppConfig.handbrake;

    if (!config?.enabled) {
      Logger.info("HandBrake post-processing is disabled");
      return;
    }

    Logger.info("Validating HandBrake setup...");

    // Validate configuration first
    if (arguments.length > 0) {
      this.validateConfig(configOverride);
    } else {
      this.validateConfig();
    }

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
  static validateConfig(configOverride) {
    // If called with an explicit argument (even if null/undefined), use it
    // Otherwise use AppConfig.handbrake
    const config = arguments.length > 0 ? configOverride : AppConfig.handbrake;

    // Use utility function for schema validation
    const validation = validateHandBrakeConfig(config);
    if (!validation.isValid) {
      // Include specific errors in the main message for better debugging
      const errorMessage = validation.errors.length === 1 && validation.errors[0] === 'HandBrake configuration is missing or invalid'
        ? validation.errors[0]
        : `HandBrake configuration is invalid: ${validation.errors.join("; ")}`;

      throw new HandBrakeError(
        errorMessage,
        validation.errors.join("; ")
      );
    }

    // Additional validation for conflicting arguments
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
      Logger.debug("Using configured HandBrakeCLI path...");
      if (!fs.existsSync(config.cli_path)) {
        throw new HandBrakeError(
          "Configured HandBrakeCLI path does not exist",
          `Path: ${config.cli_path}`
        );
      }
      Logger.debug(`Found HandBrakeCLI at: ${config.cli_path}`);
      return config.cli_path;
    }

    // Auto-detect based on platform
    Logger.debug("Auto-detecting HandBrakeCLI installation...");
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
      Logger.debug(`Checking path: ${path}`);
      if (fs.existsSync(path)) {
        Logger.debug(`Found HandBrakeCLI at: ${path}`);
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
   * @throws {HandBrakeError} If path contains dangerous patterns
   * @private
   */
  static sanitizePath(filePath) {
    // Remove null bytes and control characters
    let sanitized = filePath.replace(/[\x00-\x1F\x7F]/g, '');

    // Detect path traversal attempts BEFORE normalizing
    if (sanitized.includes('..')) {
      throw new HandBrakeError("Path traversal detected in path", filePath);
    }

    // Don't normalize path separators - HandBrake accepts forward slashes on all platforms
    // This keeps tests consistent and avoids platform-specific issues

    // Escape shell-sensitive characters for safe shell execution
    return sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Builds the HandBrake command with proper arguments
   * @param {string} handBrakePath - Path to HandBrakeCLI executable
   * @param {string} inputPath - Path to input MKV file
   * @param {string} outputPath - Path to output file
   * @param {string|null} presetOverride - Optional preset override (for retries)
   * @returns {string} Constructed command
   * @throws {HandBrakeError} If paths contain invalid characters
   * @private
   */
  static buildCommand(handBrakePath, inputPath, outputPath, presetOverride = null, subtitleOverride = null) {
    const config = AppConfig.handbrake;
    const preset = presetOverride || config.preset;

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
      `--preset "${preset}"`,
      '--verbose=1', // Enable progress output
      '--no-dvdnav'  // Disable DVD navigation for better compatibility
    ];

    // Add format-specific optimizations
    if (config.output_format.toLowerCase() === 'mp4') {
      args.push('--optimize');
    }

    // Subtitles: include all by default, prefer English via language list ordering.
    // If the user supplies explicit subtitle-related flags in additional_args, do not auto-add.
    const additionalArgsRaw = (config.additional_args || '').trim();
    const hasSubtitleOverrides = /\B--(?:all-subtitles|first-subtitle|subtitle(?:-lang-list)?|subtitle-default|subtitle-burned|subtitle-forced|native-language)\b/i.test(additionalArgsRaw);
    const subtitlesConfig = config.subtitles || {};
    const subtitlesEnabled = subtitlesConfig.enabled !== false;

    if (subtitlesEnabled && !hasSubtitleOverrides) {
      const langList = typeof subtitlesConfig.lang_list === 'string' && subtitlesConfig.lang_list.trim() !== ''
        ? subtitlesConfig.lang_list.trim()
        : 'eng,any';

      args.push(`--subtitle-lang-list ${langList}`);

      const overrideBurned = subtitleOverride?.burned !== undefined ? String(subtitleOverride.burned).trim() : null;
      const isBurning = overrideBurned && overrideBurned !== '' && overrideBurned !== 'none' && overrideBurned !== 'auto';

      // If burning is enabled, only one subtitle track can be burned. Pick the first matching track.
      if (isBurning) {
        args.push('--first-subtitle');
      } else if (subtitlesConfig.all !== false) {
        args.push('--all-subtitles');
      } else {
        args.push('--first-subtitle');
      }

      const subtitleDefault = subtitlesConfig.default !== undefined ? String(subtitlesConfig.default).trim() : '1';
      if (subtitleDefault !== '') {
        args.push(`--subtitle-default=${subtitleDefault}`);
      }

      const subtitleBurned = overrideBurned !== null
        ? overrideBurned
        : (subtitlesConfig.burned !== undefined ? String(subtitlesConfig.burned).trim() : 'none');
      // "auto" is handled in convertFile via a scan; buildCommand treats it as "none".
      if (subtitleBurned !== '' && subtitleBurned !== 'none' && subtitleBurned !== 'auto') {
        args.push(`--subtitle-burned=${subtitleBurned}`);
      }
    }

    // Add custom arguments if specified (with validation)
    if (additionalArgsRaw) {
      // Validate additional args don't contain dangerous characters
      if (/[;&|`$()<>\n\r]/.test(additionalArgsRaw)) {
        throw new HandBrakeError(
          'Additional arguments contain unsafe shell characters',
          `Invalid characters detected in: ${additionalArgsRaw}`
        );
      }
      // Split by space but respect quoted arguments
      const customArgs = additionalArgsRaw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      args.push(...customArgs);
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
    Logger.debug("Validating HandBrake output...");

    // Check if file exists using async stat
    let stats;
    try {
      stats = await stat(outputPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new HandBrakeError("HandBrake conversion failed - output file not created");
      }
      throw new HandBrakeError(`Failed to access output file: ${error.message}`);
    }

    const fileSizeMB = (stats.size / 1024 / 1024);

    Logger.debug(`Output file exists, size: ${fileSizeMB.toFixed(2)} MB`);

    // Check if file is empty
    if (!stats || stats.size === 0) {
      throw new HandBrakeError("HandBrake conversion failed - output file is empty");
    }

    // Check if file is suspiciously small (likely corruption)
    if (fileSizeMB < HANDBRAKE_CONSTANTS.MIN_FILE_SIZE_MB) {
      Logger.warning(`Output file is very small (${fileSizeMB.toFixed(2)} MB) - possible conversion issue`);
    }

    // Verify file can be opened (basic corruption check)
    let fileHandle;
    try {
      fileHandle = await open(outputPath, 'r');
      const buffer = Buffer.alloc(1024);
      await fileHandle.read(buffer, 0, 1024, 0);

      // Check for common video file headers
      const header = buffer.toString('hex', 0, 8);
      const expectedHeader = HANDBRAKE_CONSTANTS.FILE_HEADERS[AppConfig.handbrake.output_format.toUpperCase()];
      if (!header.includes(expectedHeader)) {
        Logger.warning('Output file may not be a valid video file - header mismatch');
      }
    } catch (error) {
      throw new HandBrakeError(`Output file appears to be corrupted: ${error.message}`);
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }

    Logger.debug(`Output file validated successfully (${fileSizeMB.toFixed(2)} MB)`);
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
      Logger.debug(`HandBrake progress: ${lastProgress.trim()}`);
    }

    // Check for warnings (but not errors)
    const warningLines = lines.filter(line =>
      line.toLowerCase().includes('warning') &&
      !line.toLowerCase().includes('error')
    );

    if (warningLines.length > 0) {
      Logger.warning(`HandBrake warnings detected:`);
      warningLines.forEach(warning => Logger.warning(`  ${warning.trim()}`));
    }
  }

  /**
   * Convert an MKV file using HandBrake
   * @param {string} inputPath - Path to input MKV file
   * @returns {Promise<boolean>} True if conversion was successful
   */
  static async convertFile(inputPath) {
    let outputPath; // Declare here to be accessible in catch block
    let command; // Declare here to be accessible in catch block
    let subtitleOverride = null;
    try {
      if (!AppConfig.handbrake?.enabled) {
        Logger.info("HandBrake post-processing is disabled, skipping...");
        return true;
      }

      Logger.info("Beginning HandBrake post-processing...");
      Logger.debug(`Input file path: ${inputPath}`);

      // Validate input file
      if (!fs.existsSync(inputPath)) {
        throw new HandBrakeError(`Input file does not exist: ${inputPath}`);
      }

      const inputStats = fs.statSync(inputPath);
      const inputSizeMB = (inputStats.size / 1024 / 1024);
      Logger.debug(`Input file size: ${inputSizeMB.toFixed(2)} MB`);

      if (inputStats.size === 0) {
        throw new HandBrakeError(`Input file is empty: ${inputPath}`);
      }

      Logger.debug("Validating HandBrake configuration...");
      this.validateConfig();

      const handBrakePath = await this.getHandBrakePath();
      outputPath = path.join(
        path.dirname(inputPath),
        `${path.basename(inputPath, ".mkv")}.${AppConfig.handbrake.output_format.toLowerCase()}`
      );

      Logger.debug(`HandBrake configuration:`);
      Logger.debug(`- CLI Path: ${handBrakePath}`);
      Logger.debug(`- Preset: ${AppConfig.handbrake.preset}`);
      Logger.debug(`- Output Format: ${AppConfig.handbrake.output_format}`);
      Logger.debug(`- Delete Original: ${AppConfig.handbrake.delete_original}`);
      Logger.info(`Starting HandBrake conversion for: ${path.basename(inputPath)}`);
      Logger.debug(`Output format: ${AppConfig.handbrake.output_format}`);
      Logger.debug(`Using preset: ${AppConfig.handbrake.preset}`);
      Logger.debug(`Output will be saved as: ${path.basename(outputPath)}`);
      Logger.debug("This may take a while depending on the file size and preset used.");

      // Text-first subtitle behavior: if configured for "auto", scan the source.
      if (AppConfig.handbrake?.subtitles?.enabled !== false) {
        const burnedMode = String(AppConfig.handbrake.subtitles?.burned ?? 'none').trim();
        if (burnedMode === 'auto') {
          const subtitleAutoDecision = await this.decideAutoBurn(handBrakePath, inputPath);
          if (subtitleAutoDecision?.burn) {
            Logger.info('Bitmap subtitles detected (no text subs). Falling back to burning subtitles into the video.');
            subtitleOverride = { burned: '1' };
          }
        }
      }

      command = this.buildCommand(handBrakePath, inputPath, outputPath, null, subtitleOverride);
      Logger.debug(`Executing command: ${command}`);

      // Set timeout based on file size (rough estimate: 2 hours + 1 minute per GB)
      const fileSizeGB = inputStats.size / (1024 * 1024 * 1024);
      const timeoutMs = Math.max(
        HANDBRAKE_CONSTANTS.MIN_TIMEOUT_HOURS * 60 * 60 * 1000,
        Math.min(fileSizeGB * 60 * 1000, HANDBRAKE_CONSTANTS.MAX_TIMEOUT_HOURS * 60 * 60 * 1000)
      );

      Logger.debug(`File size: ${fileSizeGB.toFixed(2)} GB, timeout: ${(timeoutMs / 1000 / 60).toFixed(0)} minutes`);

      // Start timing the conversion
      const conversionStart = Date.now();
      Logger.debug("Starting HandBrake encoding process...");

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

      Logger.info(`HandBrake conversion completed successfully: ${path.basename(outputPath)}`);      Logger.debug(`Conversion metrics:`);
      Logger.debug(`  - Duration: ${conversionTimeMin} minutes`);
      Logger.debug(`  - Original size: ${inputSizeMB.toFixed(2)} MB`);
      Logger.debug(`  - Compressed size: ${outputSizeMB} MB`);
      Logger.debug(`  - Compression: ${compressionRatio}% reduction`);
      Logger.debug(`  - Processing speed: ${processingSpeed} GB/hour`);

      if (AppConfig.handbrake.delete_original) {
        Logger.debug(`Deleting original MKV file: ${path.basename(inputPath)}`);
        await FileSystemUtils.unlink(inputPath);
        Logger.debug("Original MKV file deleted successfully");
      }

      return true;
    } catch (error) {
      // Attempt retry with fallback presets
      Logger.warning(`Initial conversion failed: ${error.message}`);
      Logger.debug("Attempting retry with fallback preset...");

      try {
        const handBrakePath = await this.getHandBrakePath();
        const retrySuccess = await this.retryConversion(inputPath, outputPath, handBrakePath, 0, subtitleOverride);

        if (retrySuccess) {
          // Successful retry - check if we should delete original
          if (AppConfig.handbrake.delete_original) {
            Logger.debug(`Deleting original MKV file: ${path.basename(inputPath)}`);
            await FileSystemUtils.unlink(inputPath);
            Logger.debug("Original MKV file deleted successfully");
          }
          return true;
        }
      } catch (retryError) {
        Logger.error(`Retry also failed: ${retryError.message}`);
      }

      // Cleanup partial output file on failure
      try {
        if (outputPath && fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          if (stats.size === 0 || stats.size < HANDBRAKE_CONSTANTS.VALIDATION.MIN_OUTPUT_SIZE_BYTES) {
            Logger.debug("Removing incomplete output file...");
            fs.unlinkSync(outputPath);
          }
        }
      } catch (cleanupError) {
        Logger.warning(`Failed to cleanup incomplete output file: ${cleanupError.message}`);
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
        Logger.error(`Error Details: ${error.message || 'Unknown error'}`);
        Logger.error(`Error Name: ${error.name || 'Unknown'}`);
        Logger.error(`Error Code: ${error.code || 'Unknown'}`);
        if (command) {
          Logger.error(`Command: ${command}`);
        }
      }
      return false;
    }
  }
}