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
  constructor(options = {}) {
    this.goodVideoArray = [];
    this.badVideoArray = [];
    this.goodHandBrakeArray = [];
    this.badHandBrakeArray = [];
    this.pendingHandBrakeJobs = [];
    this.handbrakeWorkerPromise = null;
    this.handbrakeWorkerError = null;
    this.exitOnCriticalError = options.exitOnCriticalError !== false;
    this.cancelRequested = false;
    this.runCancelled = false;
    this.activeRipProcesses = new Set();
    this.abortController = new AbortController();
  }

  prepareForRun() {
    this.cancelRequested = false;
    this.runCancelled = false;
    this.pendingHandBrakeJobs = [];
    this.handbrakeWorkerPromise = null;
    this.handbrakeWorkerError = null;
    this.activeRipProcesses = new Set();

    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
  }

  createCancellationError(message = "Operation cancelled") {
    const error = new Error(message);
    error.name = "OperationCancelledError";
    error.isCancelled = true;
    return error;
  }

  isCancellationError(error) {
    return Boolean(
      error?.isCancelled === true ||
      (this.cancelRequested &&
        (error?.name === "AbortError" ||
          error?.code === "ABORT_ERR" ||
          error?.signal === "SIGTERM" ||
          error?.killed === true))
    );
  }

  throwIfCancelled(message = "Operation cancelled") {
    if (this.cancelRequested) {
      throw this.createCancellationError(message);
    }
  }

  isCancellationRequested() {
    return this.cancelRequested;
  }

  wasCancelled() {
    return this.runCancelled;
  }

  requestCancel() {
    if (this.cancelRequested) {
      return false;
    }

    this.cancelRequested = true;
    this.runCancelled = true;
    this.pendingHandBrakeJobs = [];

    if (!this.abortController.signal.aborted) {
      this.abortController.abort(this.createCancellationError());
    }

    for (const childProcess of this.activeRipProcesses) {
      try {
        childProcess.kill("SIGTERM");
      } catch {
        // Best-effort cancellation for child processes.
      }
    }

    return true;
  }

  registerRipProcess(childProcess) {
    if (!childProcess || typeof childProcess.kill !== "function") {
      return () => {};
    }

    this.activeRipProcesses.add(childProcess);

    const cleanup = () => {
      this.activeRipProcesses.delete(childProcess);
    };

    childProcess.once?.("close", cleanup);
    childProcess.once?.("error", cleanup);

    return cleanup;
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
    this.prepareForRun();

    try {
      // Load drives first if loading is enabled
      if (AppConfig.isLoadDrivesEnabled) {
        Logger.info("Loading drives before ripping...");
        await DriveService.loadDrivesWithWait();
      }

      // Get fake date from config and execute entire ripping operation with temporary system date
      const fakeDate = AppConfig.makeMKVFakeDate;

      await withSystemDate(fakeDate, async () => {
        this.throwIfCancelled("Ripping cancelled");
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
        this.throwIfCancelled("Ripping cancelled");
        await this.handlePostRipActions();
        this.throwIfCancelled("Ripping cancelled");
        await this.processHandBrakeQueue();
        this.throwIfCancelled("Ripping cancelled");
        this.displayResults();
      });
    } catch (error) {
      if (this.isCancellationError(error)) {
        this.runCancelled = true;
        Logger.warning("Ripping operation cancelled.");

        if (this.exitOnCriticalError) {
          return;
        }

        throw error;
      }

      Logger.error("Critical error during ripping process", error);
      await this.ejectDiscs();
      if (this.exitOnCriticalError) {
        safeExit(1, "Critical error during ripping process");
        return;
      }

      throw error;
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
        this.throwIfCancelled("Ripping cancelled");

        try {
          await this.ripSingleDisc(item, AppConfig.movieRipsDir);
        } catch (error) {
          if (this.isCancellationError(error)) {
            throw error;
          }

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
            if (this.isCancellationError(error)) {
              throw error;
            }

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
      try {
        this.throwIfCancelled("Ripping cancelled");

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
        let childProcess;
        let cleanupProcess = () => {};

        childProcess = exec(makeMKVCommand, async (err, stdout, stderr) => {
          cleanupProcess();

          if (this.cancelRequested) {
            reject(this.createCancellationError("Ripping cancelled"));
            return;
          }

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
            await this.ejectCompletedDisc(commandDataItem);
            resolve(commandDataItem.title);
          } catch (error) {
            reject(error);
          }
        });

        cleanupProcess = this.registerRipProcess(childProcess);
      } catch (error) {
        reject(error);
      }
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

    if (success && this.cancelRequested) {
      Logger.info("Cancellation requested, skipping HandBrake queueing for completed rip.");
      Logger.separator();
      return;
    }

    // If rip was successful and HandBrake is enabled, queue the file for the encode phase
    Logger.info(`HandBrake enabled status: ${AppConfig.isHandBrakeEnabled ? 'enabled' : 'disabled'}`);
    if (success && AppConfig.isHandBrakeEnabled) {
      try {
        Logger.info("Queueing HandBrake post-processing workflow for after ripping...");
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

        for (const file of mkvFiles) {
          const fullPath = path.join(outputFolder, file);
          this.pendingHandBrakeJobs.push({ file, fullPath });
          Logger.info(`Queued MKV file for HandBrake processing: ${file}`);
        }

        this.startHandBrakeWorker();
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
   * Eject a completed disc so the drive can be reused while HandBrake continues
   * @param {Object} commandDataItem - Disc information object
   * @returns {Promise<void>}
   */
  async ejectCompletedDisc(commandDataItem) {
    if (!AppConfig.isEjectDrivesEnabled) {
      return;
    }

    const ejected = await DriveService.ejectDriveByNumber(
      commandDataItem.driveNumber
    );

    if (!ejected) {
      Logger.warning(
        `Unable to automatically eject drive ${commandDataItem.driveNumber} after ripping ${commandDataItem.title}.`
      );
    }
  }

  /**
   * Start the background HandBrake worker if work is queued and no worker is active
   */
  startHandBrakeWorker() {
    if (
      this.cancelRequested ||
      !AppConfig.isHandBrakeEnabled ||
      this.handbrakeWorkerPromise ||
      this.pendingHandBrakeJobs.length === 0
    ) {
      return;
    }

    Logger.info(
      `Starting HandBrake pipeline worker for ${this.pendingHandBrakeJobs.length} queued file(s)...`
    );

    this.handbrakeWorkerPromise = this.runHandBrakeQueue()
      .catch((error) => {
        this.handbrakeWorkerError = error;
      })
      .finally(() => {
        this.handbrakeWorkerPromise = null;

        if (!this.cancelRequested && this.pendingHandBrakeJobs.length > 0) {
          this.startHandBrakeWorker();
        }
      });
  }

  /**
   * Run queued HandBrake work sequentially while ripping can continue elsewhere
   * @returns {Promise<void>}
   */
  async runHandBrakeQueue() {
    while (this.pendingHandBrakeJobs.length > 0) {
      this.throwIfCancelled("HandBrake processing cancelled");
      const job = this.pendingHandBrakeJobs.shift();

      try {
        Logger.info(`Processing queued MKV file with HandBrake: ${job.file}`);
        const success = await HandBrakeService.convertFile(job.fullPath, {
          signal: this.abortController.signal,
        });

        this.throwIfCancelled("HandBrake processing cancelled");

        if (success) {
          this.goodHandBrakeArray.push(job.file);
          Logger.info(`HandBrake processing succeeded for: ${job.file}`);
        } else {
          this.badHandBrakeArray.push(job.file);
          Logger.error(`HandBrake processing failed for: ${job.file}`);
        }
      } catch (error) {
        if (this.isCancellationError(error)) {
          throw error;
        }

        this.badHandBrakeArray.push(job.file);
        Logger.error("HandBrake post-processing error:", error.message);
        if (error.details) {
          Logger.error("Error details:", error.details);
        }
      }
    }
  }

  /**
   * Process queued HandBrake jobs after all ripping has completed
   * @returns {Promise<void>}
   */
  async processHandBrakeQueue() {
    if (!AppConfig.isHandBrakeEnabled) {
      return;
    }

    this.throwIfCancelled("HandBrake processing cancelled");

    if (!this.handbrakeWorkerPromise && this.pendingHandBrakeJobs.length === 0) {
      Logger.info("No HandBrake jobs queued for processing.");
      return;
    }

    this.startHandBrakeWorker();

    while (this.handbrakeWorkerPromise) {
      await this.handbrakeWorkerPromise;
    }

    if (this.handbrakeWorkerError) {
      const error = this.handbrakeWorkerError;
      this.handbrakeWorkerError = null;
      throw error;
    }
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
    this.pendingHandBrakeJobs = [];
    this.handbrakeWorkerPromise = null;
    this.handbrakeWorkerError = null;
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
