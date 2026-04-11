import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { AppConfig } from "../config/index.js";
import { Logger } from "../utils/logger.js";
import { FileSystemUtils } from "../utils/filesystem.js";
import { ValidationUtils } from "../utils/validation.js";
import { DiscService } from "./disc.service.js";
import { DriveService } from "./drive.service.js";
import { HandBrakeService } from "./handbrake.service.js";
import { safeExit, withSystemDate } from "../utils/process.js";
import { MakeMKVMessages } from "../utils/makemkv-messages.js";

/**
 * Service for handling DVD/Blu-ray ripping operations
 */
export class RipService {
  constructor() {
    this.goodVideoArray = [];
    this.badVideoArray = [];
    this.goodHandBrakeArray = [];
    this.badHandBrakeArray = [];
  }

  extractOutputFolder(stdout) {
    const candidateLines = stdout.split(/\r?\n/).filter(line =>
      line.includes('MSG:5014') || line.includes('Saving')
    );

    for (const line of candidateLines) {
      const quotedValues = Array.from(line.matchAll(/"([^"]*)"/g), match => match[1]);
      const directPath = [...quotedValues].reverse().find(value => value.startsWith('file://'));
      if (directPath) {
        return this.normalizeOutputFolder(directPath);
      }

      const messageWithPath = quotedValues.find(value => value.includes('Saving') && value.includes('directory '));
      if (messageWithPath) {
        const messageMatch = messageWithPath.match(/Saving \d+ titles into directory (.+)$/);
        if (messageMatch) {
          return this.normalizeOutputFolder(messageMatch[1]);
        }
      }

      const looseMatch = line.match(/Saving \d+ titles into directory (.+)$/);
      if (looseMatch) {
        return this.normalizeOutputFolder(looseMatch[1].replace(/"+$/g, '').trim());
      }
    }

    return null;
  }

  normalizeOutputFolder(outputFolder) {
    return outputFolder
      .replace(/^file:\/\//, '')
      .replace(/[\\/]/g, path.sep);
  }

  /**
   * Start the ripping process for all available discs
   * @returns {Promise<void>}
   */
  async startRipping() {
    try {
      // Load drives first if loading is enabled
      if (AppConfig.isLoadDrivesEnabled) {
        Logger.info("Loading drives before ripping...");
        await DriveService.loadDrivesWithWait();
      }

      // Get fake date from config and execute entire ripping operation with temporary system date
      const fakeDate = AppConfig.makeMKVFakeDate;

      await withSystemDate(fakeDate, async () => {
        Logger.info("Beginning AutoRip... Please Wait.");
        const commandDataItems = await DiscService.getAvailableDiscs();

        // Check if any discs were found
        if (commandDataItems.length === 0) {
          Logger.info(
            "No discs found to rip. No ripping operations will be performed."
          );
          Logger.separator();
          await this.handlePostRipActions();
          return;
        }

        Logger.info(
          `Found ${commandDataItems.length} disc(s) ready for ripping.`
        );
        await this.processRippingQueue(commandDataItems);
        this.displayResults();
        await this.handlePostRipActions();
      });
    } catch (error) {
      Logger.error("Critical error during ripping process", error);
      await this.ejectDiscs();
      safeExit(1, "Critical error during ripping process");
    }
  }

  /**
   * Process the queue of discs to rip
   * @param {Array} commandDataItems - Array of disc information objects
   * @returns {Promise<void>}
   */
  async processRippingQueue(commandDataItems) {
    if (AppConfig.rippingMode === "sync") {
      // Process discs one at a time (synchronously)
      Logger.info("Ripping discs synchronously (one at a time)...");
      for (const item of commandDataItems) {
        try {
          await this.ripSingleDisc(item, AppConfig.movieRipsDir);
        } catch (error) {
          Logger.error(`Error ripping ${item.title}`, error);
          this.badVideoArray.push(item.title);
        }
      }
    } else {
      // Process discs in parallel (asynchronously) - default behavior
      Logger.info("Ripping discs asynchronously (parallel processing)...");
      const promises = [];

      for (const item of commandDataItems) {
        const promise = this.ripSingleDisc(item, AppConfig.movieRipsDir)
          .then((result) => result)
          .catch((error) => {
            Logger.error(`Error ripping ${item.title}`, error);
            this.badVideoArray.push(item.title);
          });
        promises.push(promise);
      }

      try {
        await Promise.all(promises);
      } catch (error) {
        Logger.error("Uncorrectable Error Ripping One or More DVDs.", error);
        throw error;
      }
    }
  }

  /**
   * Rip a single disc
   * @param {Object} commandDataItem - Disc information object
   * @param {string} outputPath - Output directory path
   * @returns {Promise<string>} - Title of the ripped disc
   */
  async ripSingleDisc(commandDataItem, outputPath) {
    return new Promise(async (resolve, reject) => {
      const dir = FileSystemUtils.createUniqueFolder(
        outputPath,
        commandDataItem.title
      );

      Logger.info(`Ripping Title ${commandDataItem.title} to ${dir}...`);

      // Get MakeMKV executable path with cross-platform detection
      const makeMKVExecutable = await AppConfig.getMakeMKVExecutable();
      if (!makeMKVExecutable) {
        reject(
          new Error(
            "MakeMKV executable not found. Please ensure MakeMKV is installed."
          )
        );
        return;
      }

      const makeMKVCommand = `${makeMKVExecutable} -r mkv disc:${commandDataItem.driveNumber} ${commandDataItem.fileNumber} "${dir}"`;

      exec(makeMKVCommand, async (err, stdout, stderr) => {
        // Check for critical MakeMKV messages (not first call, so only check for errors)
        const shouldContinue = MakeMKVMessages.checkOutput(
          stdout + (stderr || ""),
          false
        );

        if (!shouldContinue) {
          Logger.error(
            "MakeMKV version is too old, please update to the latest version"
          );
          reject(
            new Error(
              "MakeMKV version is too old, please update to the latest version"
            )
          );
          return;
        }

        if (err || stderr) {
          Logger.error(
            `Critical Error Ripping ${commandDataItem.title}`,
            err || stderr
          );
          reject(err || stderr);
          return;
        }

        try {
          await this.handleRipCompletion(stdout, commandDataItem);
          resolve(commandDataItem.title);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Handle post-rip completion tasks (logging, validation)
   * @param {string} stdout - MakeMKV output
   * @param {Object} commandDataItem - Disc information object
   * @returns {Promise<void>}
   */
  async handleRipCompletion(stdout, commandDataItem) {
    if (AppConfig.isFileLogEnabled) {
      const fileName = FileSystemUtils.createUniqueLogFile(
        AppConfig.logDir,
        commandDataItem.title
      );
      try {
        await FileSystemUtils.writeLogFile(
          fileName,
          stdout,
          commandDataItem.title
        );
      } catch (error) {
        Logger.error("Error writing log file", error);
      }
    }

    // Debug: Log MakeMKV output lines containing MSG: or completion-related terms
    Logger.info("Analyzing MakeMKV output for completion status...");
    const relevantLines = stdout.split('\n')
      .filter(line => line.includes('MSG:') ||
        line.toLowerCase().includes('copy') ||
        line.toLowerCase().includes('complete') ||
        line.toLowerCase().includes('progress'))
      .map(line => line.trim());

    if (relevantLines.length > 0) {
      Logger.info("Found relevant MakeMKV output lines:");
      relevantLines.forEach(line => Logger.info(`- ${line}`));
    }

    const success = this.checkCopyCompletion(stdout, commandDataItem);
    Logger.info(`Rip completion check result: ${success ? 'successful' : 'failed'}`);

    // If rip was successful and HandBrake is enabled, process the file
    Logger.info(`HandBrake enabled status: ${AppConfig.isHandBrakeEnabled ? 'enabled' : 'disabled'}`);
    if (success && AppConfig.isHandBrakeEnabled) {
      try {
        Logger.info("Starting HandBrake post-processing workflow...");
        const outputFolder = this.extractOutputFolder(stdout);

        if (!outputFolder) {
          Logger.error("Failed to parse output directory from MakeMKV log");
          Logger.error("Relevant log lines:", stdout.split('\n').filter(line =>
            line.includes('MSG:5014') || line.includes('Saving') || line.includes('directory')));
          throw new Error("Could not find output folder in MakeMKV log");
        }

        Logger.info(`Scanning for MKV files in: ${outputFolder}`);

        // Verify the output folder exists
        if (!fs.existsSync(outputFolder)) {
          throw new Error(`Output folder does not exist: ${outputFolder}`);
        }

        const outputEntries = await FileSystemUtils.readdir(outputFolder);
        Logger.info(`Found ${outputEntries.length} files in output folder`);

        const mkvFiles = outputEntries.filter(file => file.toLowerCase().endsWith(".mkv"));
        if (mkvFiles.length === 0) {
          Logger.warning(`No MKV files found in output folder: ${outputFolder}`);
          Logger.separator();
          return;
        }

        // Process each MKV file from this rip
        for (const file of mkvFiles) {
          Logger.info(`Found MKV file: ${file}`);

          const fullPath = path.join(outputFolder, file);
          Logger.info(`Found MKV file for processing: ${file}`);
          const success = await HandBrakeService.convertFile(fullPath);

          if (success) {
            this.goodHandBrakeArray.push(file);
            Logger.info(`HandBrake processing succeeded for: ${file}`);
          } else {
            this.badHandBrakeArray.push(file);
            Logger.error(`HandBrake processing failed for: ${file}`);
          }
        }
      } catch (error) {
        Logger.error("HandBrake post-processing error:", error.message);
        if (error.details) {
          Logger.error("Error details:", error.details);
        }
      }
    } else if (success) {
      Logger.info("HandBrake post-processing is disabled, skipping compression step");
    }

    Logger.separator();
  }

  /**
   * Check if the copy completed successfully and update results arrays
   * @param {string} data - MakeMKV output
   * @param {Object} commandDataItem - Disc information object
   */
  checkCopyCompletion(data, commandDataItem) {
    const titleName = commandDataItem.title;
    const success = ValidationUtils.isCopyComplete(data);

    if (success) {
      Logger.info(`Done Ripping ${titleName}`);
      this.goodVideoArray.push(titleName);
    } else {
      Logger.info(`Unable to rip ${titleName}. Try ripping with MakeMKV GUI.`);
      this.badVideoArray.push(titleName);
    }

    return success;
  }

  /**
   * Display the results of the ripping process
   */
  displayResults() {
    if (this.goodVideoArray.length > 0) {
      Logger.info(
        "The following DVD/Blu-ray titles have been successfully ripped: ",
        this.goodVideoArray.join(", ")
      );
    }

    if (this.badVideoArray.length > 0) {
      Logger.info(
        "The following DVD/Blu-ray titles failed to rip: ",
        this.badVideoArray.join(", ")
      );
    }

    // Display HandBrake results if HandBrake was enabled
    if (AppConfig.isHandBrakeEnabled) {
      if (this.goodHandBrakeArray.length > 0) {
        Logger.info(
          "The following files were successfully converted with HandBrake: ",
          this.goodHandBrakeArray.join(", ")
        );
      }

      if (this.badHandBrakeArray.length > 0) {
        Logger.info(
          "The following files failed HandBrake conversion: ",
          this.badHandBrakeArray.join(", ")
        );
      }
    }

    // Reset arrays for next run
    this.goodVideoArray = [];
    this.badVideoArray = [];
    this.goodHandBrakeArray = [];
    this.badHandBrakeArray = [];
  }

  /**
   * Handle post-ripping actions (ejection, etc.)
   * @returns {Promise<void>}
   */
  async handlePostRipActions() {
    await this.ejectDiscs();
  }

  /**
   * Eject all DVDs if configured to do so
   * @returns {Promise<void>}
   */
  async ejectDiscs() {
    if (AppConfig.isEjectDrivesEnabled) {
      await DriveService.ejectAllDrives();
    }
  }
}
