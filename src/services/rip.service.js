import { exec } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { AppConfig } from "../config/index.js";
import { Logger } from "../utils/logger.js";
import { FileSystemUtils } from "../utils/filesystem.js";
import { ValidationUtils } from "../utils/validation.js";
import { DiscService } from "./disc.service.js";
import { DriveService } from "./drive.service.js";
import { HandBrakeService } from "./handbrake.service.js";
import {
  RecoveryService,
  RecoveryProgressTracker,
  STALL_NOTICE_SEC,
} from "./recovery.service.js";
import { formatDuration } from "../utils/format.js";
import { ProgressHeartbeat } from "../utils/heartbeat.js";
import { safeExit, withSystemDate, killProcessTree } from "../utils/process.js";
import { MakeMKVMessages } from "../utils/makemkv-messages.js";

/**
 * Service for handling DVD/Blu-ray ripping operations
 */
export class RipService {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.exitOnCriticalError=true] - Exit the process on a
   *   critical failure (CLI behaviour) instead of rethrowing to the caller.
   * @param {boolean} [options.backgroundHandBrake=false] - Let HandBrake keep
   *   encoding after `startRipping()` resolves instead of blocking on the queue.
   *   Used by rip mode so the next disc can be ripped while the previous one is
   *   still encoding.
   */
  constructor(options = {}) {
    this.goodVideoArray = [];
    this.badVideoArray = [];
    this.goodHandBrakeArray = [];
    this.badHandBrakeArray = [];
    this.pendingHandBrakeJobs = [];
    this.activeHandBrakeJob = null;
    this.handbrakeWorkerPromise = null;
    this.handbrakeWorkerError = null;
    this.exitOnCriticalError = options.exitOnCriticalError !== false;
    this.backgroundHandBrake = options.backgroundHandBrake === true;
    this.cancelRequested = false;
    this.runCancelled = false;
    this.activeRipProcesses = new Set();
    this.abortController = new AbortController();
  }

  prepareForRun() {
    this.cancelRequested = false;
    this.runCancelled = false;

    // The HandBrake queue and worker are deliberately NOT reset here: the encode
    // queue outlives the rip cycle that filled it (see `backgroundHandBrake`),
    // and dropping the worker handle while a worker is still alive would let a
    // second worker start alongside it. A completed or cancelled run already
    // leaves the queue empty. Likewise activeRipProcesses, whose entries remove
    // themselves when their process closes.
    // A pending error only gets cleared when nobody can still be waiting on it.
    if (!this.backgroundHandBrake) {
      this.handbrakeWorkerError = null;
    }

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
      // Tree-kill: a recovery child is `bash -lc` wrapping ddrescue, and on
      // Windows a plain kill would orphan ddrescue (leaving it holding the drive).
      killProcessTree(childProcess);
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
   * Work out where MakeMKV actually wrote the titles.
   * `ripDir` (the folder we created and handed to MakeMKV) is authoritative and
   * absolute; the path parsed out of the log is only used as a fallback, and is
   * resolved because MakeMKV echoes it back relative when it was given one.
   * @param {string} stdout - MakeMKV output
   * @param {string} [ripDir] - Folder passed to MakeMKV for this rip
   * @returns {string|null}
   */
  resolveOutputFolder(stdout, ripDir) {
    if (ripDir) {
      return ripDir;
    }

    const parsed = this.extractOutputFolder(stdout);
    return parsed ? path.resolve(parsed) : null;
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

        if (this.backgroundHandBrake) {
          // Hand the encode queue off to the background worker and return: the
          // discs are already ejected, so the drive is free for the next one
          // while HandBrake keeps working.
          this.startHandBrakeWorker();
          this.displayResults({ includeHandBrake: false });
          return;
        }

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

        const makeMKVCommand = [
          makeMKVExecutable,
          ...this.getMakeMKVReadOptions(),
          "-r",
          "--progress=-same",
          `mkv disc:${commandDataItem.driveNumber}`,
          commandDataItem.fileNumber,
          `"${dir}"`,
        ].join(" ");

        let childProcess;
        let cleanupProcess = () => {};
        const ripStartedAtMs = Date.now();

        // A long disc can emit more than exec's default 1 MB of output, and
        // exceeding maxBuffer kills makemkvcon mid-rip - hence the generous cap.
        childProcess = exec(makeMKVCommand, { maxBuffer: 1024 * 1024 * 64 }, async (err, stdout, stderr) => {
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
            // A hard MakeMKV failure may still be a recoverable read-error disc,
            // so try recovery on the captured output before giving up - the disc
            // is in its worst shape exactly here. attemptReadErrorRecovery does
            // its own gating (enabled, damaged rather than removed, tooling
            // present) and reports whether it actually produced a title.
            const combined = `${stdout || ""}${stderr || ""}`;
            let recovered = false;
            try {
              recovered = await this.attemptReadErrorRecovery(
                combined,
                commandDataItem,
                dir,
                Date.now() - ripStartedAtMs
              );
            } catch (recoveryError) {
              Logger.error(
                `Recovery after MakeMKV error failed for ${commandDataItem.title}`,
                recoveryError
              );
            }

            if (recovered) {
              await this.ejectCompletedDisc(commandDataItem);
              resolve(commandDataItem.title);
              return;
            }

            Logger.error(
              `Critical Error Ripping ${commandDataItem.title}`,
              err || stderr
            );
            reject(err || stderr);
            return;
          }

          try {
            await this.handleRipCompletion(stdout, commandDataItem, dir);
            await this.attemptReadErrorRecovery(
              stdout,
              commandDataItem,
              dir,
              Date.now() - ripStartedAtMs
            );
            await this.ejectCompletedDisc(commandDataItem);
            resolve(commandDataItem.title);
          } catch (error) {
            reject(error);
          }
        });

        cleanupProcess = this.registerRipProcess(childProcess);
        this.reportRipProgress(childProcess, commandDataItem, ripStartedAtMs);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Drop MakeMKV's PRG* progress chatter before a log is written to disk. It is
   * what drives the live progress messages, but thousands of lines of it would
   * bury the messages that make a saved log worth reading.
   * @param {string} stdout
   * @returns {string}
   */
  stripProgressLines(stdout) {
    return String(stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => !/^PRG[VCT]:/.test(line))
      .join("\n");
  }

  /**
   * Global makemkvcon options that affect read throughput.
   * @returns {string[]}
   */
  getMakeMKVReadOptions() {
    const cacheMb = AppConfig.readCacheMb;
    return cacheMb > 0 ? [`--cache=${cacheMb}`] : [];
  }

  /**
   * Report rip progress once a minute from MakeMKV's PRGV stream.
   *
   * The timer owns the reporting, not the stream: when a drive struggles it
   * stops emitting progress altogether, and "no progress for 4m" is the most
   * useful thing the log can say at that moment.
   * @param {import('child_process').ChildProcess} childProcess
   * @param {Object} commandDataItem - Disc information object
   * @param {number} startedAtMs
   * @returns {() => void} stop function
   */
  reportRipProgress(childProcess, commandDataItem, startedAtMs) {
    if (!childProcess?.stdout) {
      return () => {};
    }

    let percent = null;
    let lastAdvanceAtMs = startedAtMs;
    let tail = "";

    childProcess.stdout.on("data", (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);

      // PRGV:<current>,<total>,<max> - the second value tracks the whole job.
      const matches = [...tail.matchAll(/PRGV:(\d+),(\d+),(\d+)/g)];
      const latest = matches[matches.length - 1];
      const max = latest ? Number.parseInt(latest[3], 10) : 0;
      if (!max) {
        return;
      }

      const current = (Number.parseInt(latest[2], 10) / max) * 100;
      if (percent === null || current > percent) {
        lastAdvanceAtMs = Date.now();
      }
      percent = current;
    });

    const heartbeat = new ProgressHeartbeat({
      describe: () => {
        const nowMs = Date.now();
        const elapsed = formatDuration(Math.round((nowMs - startedAtMs) / 1000));
        const stalledSec = Math.round((nowMs - lastAdvanceAtMs) / 1000);
        const stalled =
          stalledSec >= STALL_NOTICE_SEC
            ? ` - no progress for ${formatDuration(stalledSec)} (the drive may be retrying a damaged area)`
            : "";

        if (percent === null) {
          return `Ripping ${commandDataItem.title}: ${elapsed} elapsed, no progress reported yet${stalled}`;
        }

        return `Ripping ${commandDataItem.title}: ${percent.toFixed(
          1
        )}% - ${elapsed} elapsed${stalled}`;
      },
    });

    const stop = heartbeat.start();
    childProcess.once?.("close", stop);
    childProcess.once?.("error", stop);
    return stop;
  }

  /**
   * Work out how long read-error recovery may spend imaging the disc.
   *
   * The budget is a multiple of the rip that just failed (default 1x, so a
   * recovered disc costs roughly twice a normal rip), clamped to a floor so a
   * rip that failed in the first minute still gets a usable attempt, and to the
   * configured absolute ceiling.
   * @param {number} ripDurationMs - How long the failed rip ran
   * @returns {number} seconds
   */
  getRecoveryBudgetSeconds(ripDurationMs) {
    const recovery = AppConfig.readErrorRecovery;
    const ceilingSec = RecoveryService.parseDurationToSeconds(recovery.maxRuntime);
    const floorSec = RecoveryService.parseDurationToSeconds(recovery.minRuntime);
    const ripSec = Math.max(0, Math.round((ripDurationMs || 0) / 1000));

    let budget = Math.round(ripSec * (recovery.maxRuntimeRatio ?? 1));
    budget = Math.max(budget, floorSec);

    if (ceilingSec > 0) {
      budget = Math.min(budget, ceilingSec);
    }

    return budget;
  }

  /**
   * Handle post-rip completion tasks (logging, validation)
   * @param {string} stdout - MakeMKV output
   * @param {Object} commandDataItem - Disc information object
   * @param {string} [ripDir] - Folder this disc was ripped into
   * @returns {Promise<void>}
   */
  async handleRipCompletion(stdout, commandDataItem, ripDir) {
    if (AppConfig.isFileLogEnabled) {
      const fileName = FileSystemUtils.createUniqueLogFile(
        AppConfig.logDir,
        commandDataItem.title
      );
      try {
        await FileSystemUtils.writeLogFile(
          fileName,
          this.stripProgressLines(stdout),
          commandDataItem.title
        );
      } catch (error) {
        Logger.error("Error writing log file", error);
      }
    }

    // Verbose mode only: the raw MakeMKV messages behind the completion verdict.
    stdout
      .split("\n")
      .filter((line) => line.includes("MSG:"))
      .forEach((line) => Logger.debug(`[makemkv] ${line.trim()}`));

    const success = this.checkCopyCompletion(stdout, commandDataItem);

    if (success && this.cancelRequested) {
      Logger.info("Cancellation requested, skipping HandBrake queueing for completed rip.");
      Logger.separator();
      return;
    }

    // If rip was successful and HandBrake is enabled, queue the file for the encode phase
    if (success && AppConfig.isHandBrakeEnabled) {
      try {
        const outputFolder = this.resolveOutputFolder(stdout, ripDir);

        if (!outputFolder) {
          Logger.error("Failed to parse output directory from MakeMKV log");
          Logger.error("Relevant log lines:", stdout.split('\n').filter(line =>
            line.includes('MSG:5014') || line.includes('Saving') || line.includes('directory')));
          throw new Error("Could not find output folder in MakeMKV log");
        }

        // Verify the output folder exists
        if (!fs.existsSync(outputFolder)) {
          throw new Error(`Output folder does not exist: ${outputFolder}`);
        }

        const outputEntries = await FileSystemUtils.readdir(outputFolder);
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
   * Recover title(s) that MakeMKV failed to rip due to physical disc read errors.
   * Images the disc with ddrescue (via MSYS2), skipping unreadable areas, then
   * re-rips the failed title(s) from the image and queues them for HandBrake.
   * No-op unless enabled in config, running on Windows, and a read-error failure
   * is detected. Must run before the disc is ejected.
   * @param {string} stdout - MakeMKV output from the original (disc) rip
   * @param {Object} commandDataItem - Disc information object
   * @param {string} [knownOutputDir] - Fallback output dir from the disc rip,
   *   used when MakeMKV aborted before logging a "Saving into directory" line.
   * @param {number} [ripDurationMs] - How long the failed rip ran, used to
   *   budget how long recovery may spend imaging the disc.
   * @returns {Promise<boolean>} whether recovery produced at least one title,
   *   so a caller handling a failed rip knows if the disc was salvaged
   */
  async attemptReadErrorRecovery(
    stdout,
    commandDataItem,
    knownOutputDir,
    ripDurationMs = 0
  ) {
    if (!AppConfig.isReadErrorRecoveryEnabled) {
      return false;
    }

    if (RecoveryService.isMediumAbsentFailure(stdout)) {
      // The disc was pulled or the tray opened mid-rip. MakeMKV reports that as
      // a read error, but there is nothing to image and nothing to recover.
      Logger.warning(
        `${commandDataItem.title}: the drive reported no disc during the rip ` +
          "(tray opened or disc removed). Skipping read-error recovery - re-insert the disc and rip it again."
      );
      return false;
    }

    if (!RecoveryService.isReadErrorFailure(stdout)) {
      return false;
    }

    const failedIds = RecoveryService.getFailedTitleIds(stdout);
    Logger.warning(
      `Disc read error detected while ripping ${commandDataItem.title}: ` +
        `${
          failedIds.length
            ? `title(s) ${failedIds.join(", ")}`
            : "one or more titles"
        } failed to save.`
    );

    if (process.platform !== "win32") {
      Logger.warning(
        "Read-error recovery (ddrescue/MSYS2) is only supported on Windows. Skipping recovery."
      );
      return false;
    }

    if (this.cancelRequested) {
      return false;
    }

    if (!(await RecoveryService.isAvailable())) {
      Logger.warning(
        "Read-error recovery is enabled but MSYS2/ddrescue is unavailable. Skipping recovery."
      );
      return false;
    }

    // Prefer the dir we created for the rip: a whole-disc abort may never log a
    // "Saving into directory" line to parse.
    const outputFolder = this.resolveOutputFolder(stdout, knownOutputDir);
    if (!outputFolder || !fs.existsSync(outputFolder)) {
      Logger.error(
        "Read-error recovery: could not determine the MakeMKV output folder. Skipping recovery."
      );
      return false;
    }

    const recovery = AppConfig.readErrorRecovery;

    // The disc image goes to the configured working directory, or a dedicated
    // temp dir by default so multi-GB images never pollute the media library.
    const imageDir =
      recovery.workDir ||
      path.join(os.tmpdir(), "makemkv-auto-rip-recovery");
    try {
      fs.mkdirSync(imageDir, { recursive: true });
    } catch (error) {
      Logger.error(
        `Read-error recovery: could not create working directory ${imageDir}: ${error.message}`
      );
      return false;
    }

    // Reap abandoned images from prior runs before we add another.
    RecoveryService.sweepStaleImages(imageDir, recovery.imageRetentionDays);

    const imagePath = path.join(
      imageDir,
      `${commandDataItem.title}.recovery.iso`
    );
    const mapPath = `${imagePath}.map`;

    // Refuse to run a second recovery against the same image (e.g. a second app
    // instance) - two ddrescue readers thrash one drive and cripple throughput.
    const lock = this.acquireImageLock(imagePath);
    if (!lock) {
      Logger.warning(
        `Read-error recovery for ${commandDataItem.title} is already in progress elsewhere; skipping to avoid drive contention.`
      );
      return false;
    }

    try {
      // Ensure there's room for the image before we start (a full disk mid-image
      // corrupts the partial and blocks resume).
      if (!this.hasEnoughFreeSpace(imageDir, recovery.minFreeGb)) {
        Logger.error(
          `Read-error recovery: less than ${recovery.minFreeGb} GB free in ${imageDir}; skipping to avoid filling the disk.`
        );
        return false;
      }

      // Snapshot existing MKVs (name + size + mtime) so we detect both brand-new
      // files and a same-named partial from the failed attempt being overwritten.
      const beforeFiles = await this.snapshotMkvs(outputFolder);

      if (recovery.resume && fs.existsSync(imagePath) && fs.existsSync(mapPath)) {
        Logger.info(
          `Found an existing ddrescue image and mapfile for ${commandDataItem.title}; resuming recovery instead of restarting.`
        );
      }

      const budgetSec = this.getRecoveryBudgetSeconds(ripDurationMs);
      const tracker = new RecoveryProgressTracker({ budgetSec });
      const heartbeat = new ProgressHeartbeat({
        describe: () => `[ddrescue] ${commandDataItem.title}: ${tracker.summary()}`,
      });

      let recoveryCleanup = () => {};
      let stopHeartbeat = () => {};
      try {
        Logger.info(
          `Imaging ${commandDataItem.title} with ddrescue to recover read errors. ` +
            `Budget ${formatDuration(budgetSec)} (the rip itself took ${formatDuration(
              Math.round(ripDurationMs / 1000)
            )}); progress follows every minute.`
        );
        stopHeartbeat = heartbeat.start();
        await RecoveryService.recoverDiscToImage(
          commandDataItem.driveNumber,
          imagePath,
          {
            maxRuntimeSeconds: budgetSec,
            onProgress: (line) =>
              Logger.info(`[ddrescue] ${line.replace(/^ddrescue-recover:\s*/, "")}`),
            onStatus: (status) => tracker.update(status),
            onChild: (child) => {
              recoveryCleanup = this.registerRipProcess(child);
            },
          }
        );
      } catch (error) {
        Logger.error(
          `ddrescue imaging failed for ${commandDataItem.title}: ${error.message}`
        );
        // Keep the partial image + mapfile so a later run can resume the unread
        // areas (e.g. after cleaning the disc) rather than starting from scratch.
        Logger.info(`Keeping partial recovery image for resume: ${imagePath}`);
        return false;
      } finally {
        stopHeartbeat();
        recoveryCleanup();
        const finalSummary = tracker.finish();
        if (finalSummary) {
          Logger.info(`[ddrescue] ${commandDataItem.title}: ${finalSummary}`);
        }
      }

      if (this.cancelRequested) {
        Logger.info(`Recovery cancelled; keeping image for resume: ${imagePath}`);
        return false;
      }

      // Report how much was recovered and guard against re-ripping an image that
      // holds essentially nothing (e.g. disc yanked early).
      const summary = RecoveryService.summarizeMapfile(mapPath);
      if (summary) {
        Logger.info(
          `[ddrescue] recovered ${summary.rescuedPct.toFixed(2)}% ` +
            `(${(summary.badBytes / 1048576).toFixed(2)} MB unreadable) of ${commandDataItem.title}.`
        );
        if (summary.rescuedBytes === 0) {
          Logger.warning(
            `Read-error recovery recovered no readable data for ${commandDataItem.title}; keeping image for a later resume.`
          );
          return false;
        }
      }

      // Re-rip the failed title(s) from the recovered image. The failed-title id
      // parsed from the output filename maps to the same MakeMKV title selector,
      // but if that assumption ever yields nothing we fall back to ripping every
      // title from the image so a recoverable title is never silently lost.
      const selectors = failedIds.length ? failedIds.map(String) : ["all"];
      await this.reRipSelectorsFromImage(imagePath, selectors, outputFolder);

      let recoveredFiles = await this.collectRecoveredMkvs(
        outputFolder,
        beforeFiles
      );

      if (
        recoveredFiles.length === 0 &&
        !this.cancelRequested &&
        !selectors.includes("all")
      ) {
        Logger.warning(
          `Per-title re-rip produced no new titles for ${commandDataItem.title}; falling back to ripping all titles from the recovered image.`
        );
        await this.reRipSelectorsFromImage(imagePath, ["all"], outputFolder);
        recoveredFiles = await this.collectRecoveredMkvs(
          outputFolder,
          beforeFiles
        );
      }

      if (recoveredFiles.length > 0) {
        Logger.info(
          `Recovered ${recoveredFiles.length} title(s) from damaged disc ${commandDataItem.title}: ${recoveredFiles.join(", ")}`
        );

        if (AppConfig.isHandBrakeEnabled && !this.cancelRequested) {
          for (const file of recoveredFiles) {
            this.pendingHandBrakeJobs.push({
              file,
              fullPath: path.join(outputFolder, file),
            });
            Logger.info(
              `Queued recovered MKV file for HandBrake processing: ${file}`
            );
          }
          this.startHandBrakeWorker();
        }
      } else {
        Logger.warning(
          `Read-error recovery did not produce any new titles for ${commandDataItem.title}.`
        );
      }

      this.cleanupRecoveryArtifacts(imagePath, mapPath, {
        keepImage: recovery.keepImage,
        producedFiles: recoveredFiles.length > 0,
        hasBadSectors: Boolean(summary && summary.badBytes > 0),
      });

      return recoveredFiles.length > 0;
    } finally {
      this.releaseImageLock(lock);
    }
  }

  /**
   * Decide what to keep after a recovery attempt. We keep the (multi-GB) image
   * only when it can still help: explicit keep_image, or a failed-but-resumable
   * attempt (no usable title produced AND bad sectors remain) so the user can
   * clean the disc and resume. A successful recovery is always cleaned up.
   * @param {string} imagePath
   * @param {string} mapPath
   * @param {{keepImage: boolean, producedFiles: boolean, hasBadSectors: boolean}} outcome
   */
  cleanupRecoveryArtifacts(imagePath, mapPath, outcome) {
    if (outcome.keepImage) {
      Logger.info(`Keeping ddrescue disc image (keep_image): ${imagePath}`);
      return;
    }

    if (!outcome.producedFiles && outcome.hasBadSectors) {
      Logger.info(
        `Recovery incomplete; keeping image + mapfile so you can clean the disc and resume: ${imagePath}`
      );
      return;
    }

    this.safeUnlink(imagePath);
    this.safeUnlink(mapPath);
    this.safeUnlink(`${imagePath}.size`);
  }

  /**
   * Snapshot .mkv files in a directory as name -> {size, mtimeMs}.
   * @param {string} dir
   * @returns {Promise<Map<string, {size: number, mtimeMs: number}>>}
   */
  async snapshotMkvs(dir) {
    const map = new Map();
    for (const name of await FileSystemUtils.readdir(dir)) {
      if (!name.toLowerCase().endsWith(".mkv")) {
        continue;
      }
      map.set(name, this.statMkv(path.join(dir, name)));
    }
    return map;
  }

  /**
   * Find .mkv files that are new or changed (size/mtime) versus a snapshot.
   * Catches both freshly created titles and a same-named partial from the
   * failed attempt being overwritten by the recovered re-rip.
   * @param {string} dir
   * @param {Map<string, {size: number, mtimeMs: number}>} beforeFiles
   * @returns {Promise<string[]>}
   */
  async collectRecoveredMkvs(dir, beforeFiles) {
    const recovered = [];
    for (const name of await FileSystemUtils.readdir(dir)) {
      if (!name.toLowerCase().endsWith(".mkv")) {
        continue;
      }
      const prev = beforeFiles.get(name);
      const cur = this.statMkv(path.join(dir, name));
      if (!prev || cur.size !== prev.size || cur.mtimeMs > prev.mtimeMs) {
        recovered.push(name);
      }
    }
    return recovered;
  }

  /**
   * Stat a file, returning a sentinel instead of throwing if it is missing.
   * @param {string} filePath
   * @returns {{size: number, mtimeMs: number}}
   */
  statMkv(filePath) {
    try {
      const s = fs.statSync(filePath);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { size: -1, mtimeMs: 0 };
    }
  }

  /**
   * Check that a directory's filesystem has at least minFreeGb available.
   * Returns true (don't block) when free space can't be determined.
   * @param {string} dir
   * @param {number} minFreeGb
   * @returns {boolean}
   */
  hasEnoughFreeSpace(dir, minFreeGb) {
    if (!minFreeGb || minFreeGb <= 0 || typeof fs.statfsSync !== "function") {
      return true;
    }
    try {
      const { bavail, bsize } = fs.statfsSync(dir);
      const freeGb = (bavail * bsize) / 1024 ** 3;
      return freeGb >= minFreeGb;
    } catch {
      return true;
    }
  }

  /**
   * Acquire an advisory lock for an image path so two recoveries can't target
   * the same disc concurrently. A lock whose owner PID is dead is treated as
   * stale and reclaimed. Returns the lock path, or null if held by a live owner.
   * @param {string} imagePath
   * @returns {string|null}
   */
  acquireImageLock(imagePath) {
    const lockPath = `${imagePath}.lock`;
    // Exclusive create ("wx") is atomic, so two instances racing here cannot both
    // win. On EEXIST we inspect the owner: reclaim a dead one, yield to a live one.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return lockPath;
      } catch (error) {
        if (error && error.code !== "EEXIST") {
          // Can't create a lock for some other reason; proceed unlocked rather
          // than block recovery entirely.
          return lockPath;
        }
        let pid = NaN;
        try {
          pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        } catch {
          // Unreadable lock - treat as stale below.
        }
        if (Number.isInteger(pid) && this.isPidAlive(pid)) {
          return null; // held by a live owner
        }
        this.safeUnlink(lockPath); // stale lock from a dead run - reclaim and retry
      }
    }
    return lockPath;
  }

  /**
   * Release a previously acquired image lock.
   * @param {string|null} lockPath
   */
  releaseImageLock(lockPath) {
    if (lockPath) {
      this.safeUnlink(lockPath);
    }
  }

  /**
   * @param {number} pid
   * @returns {boolean} whether the process is currently alive
   */
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  }

  /**
   * Re-rip the given MakeMKV title selectors from a recovered image, stopping
   * early if cancellation is requested. Errors are logged, not thrown.
   * @param {string} imagePath - Path to the ddrescue disc image (.iso)
   * @param {string[]} selectors - MakeMKV title selectors (ids or "all")
   * @param {string} outputFolder - Destination directory
   * @returns {Promise<void>}
   */
  async reRipSelectorsFromImage(imagePath, selectors, outputFolder) {
    for (const selector of selectors) {
      if (this.cancelRequested) {
        break;
      }
      try {
        await this.ripTitleFromImage(imagePath, selector, outputFolder);
      } catch (error) {
        if (this.isCancellationError(error)) {
          break;
        }
        Logger.error(
          `Re-rip from recovered image failed (title ${selector}): ${error.message}`
        );
      }
    }
  }

  /**
   * Re-rip a single title (or "all") from a recovered disc image using MakeMKV.
   * @param {string} imagePath - Path to the ddrescue disc image (.iso)
   * @param {string} selector - MakeMKV title selector (id or "all")
   * @param {string} outputFolder - Destination directory
   * @returns {Promise<string>} - MakeMKV output
   */
  ripTitleFromImage(imagePath, selector, outputFolder) {
    return new Promise(async (resolve, reject) => {
      const makeMKVExecutable = await AppConfig.getMakeMKVExecutable();
      if (!makeMKVExecutable) {
        reject(
          new Error(
            "MakeMKV executable not found. Please ensure MakeMKV is installed."
          )
        );
        return;
      }

      const command = `${makeMKVExecutable} -r mkv iso:"${imagePath}" ${selector} "${outputFolder}"`;
      Logger.info(`Re-ripping title ${selector} from recovered image...`);

      let cleanupProcess = () => {};
      const childProcess = exec(
        command,
        { maxBuffer: 1024 * 1024 * 64 },
        (err, stdout) => {
          cleanupProcess();

          if (this.cancelRequested) {
            reject(this.createCancellationError("Recovery re-rip cancelled"));
            return;
          }

          if (err) {
            reject(err);
            return;
          }

          resolve(stdout);
        }
      );

      cleanupProcess = this.registerRipProcess(childProcess);
    });
  }

  /**
   * Delete a file if it exists, logging but not throwing on failure.
   * @param {string} filePath
   */
  safeUnlink(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      Logger.warning(`Could not delete ${filePath}: ${error.message}`);
    }
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
      this.activeHandBrakeJob = job;

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
      } finally {
        this.activeHandBrakeJob = null;
      }
    }
  }

  /**
   * Snapshot of the encode pipeline, for status reporting while ripping
   * continues in parallel.
   * @returns {{active: string|null, pending: number, total: number}}
   */
  getHandBrakeStatus() {
    const active = this.activeHandBrakeJob?.file ?? null;
    const pending = this.pendingHandBrakeJobs.length;

    return { active, pending, total: pending + (active ? 1 : 0) };
  }

  /**
   * Wait for background HandBrake work to drain, without starting a worker or
   * reporting an empty queue. A worker error is rethrown once, then cleared.
   * @returns {Promise<void>}
   */
  async waitForHandBrakeQueue() {
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
    await this.waitForHandBrakeQueue();
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
   * @param {Object} [options]
   * @param {boolean} [options.includeHandBrake=true] - Report and reset the
   *   HandBrake results too. Off while encoding runs in the background, where
   *   those results are not in yet and must survive into the next rip cycle.
   */
  displayResults({ includeHandBrake = true } = {}) {
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

    // Reset arrays for next run
    this.goodVideoArray = [];
    this.badVideoArray = [];

    if (!includeHandBrake) {
      return;
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
