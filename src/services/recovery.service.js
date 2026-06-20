import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { AppConfig } from "../config/index.js";
import { Logger } from "../utils/logger.js";
import { ValidationUtils } from "../utils/validation.js";
import { MAKEMKV_READ_ERROR_MESSAGES } from "../constants/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled ddrescue helper script. */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/ddrescue-recover.sh");

/**
 * Quote a value for safe inclusion inside a single-quoted bash string.
 * @param {string|number} value
 * @returns {string}
 */
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Service for recovering titles from damaged/scratched discs using GNU ddrescue
 * via MSYS2. ddrescue images the disc while skipping unreadable areas, allowing
 * MakeMKV to re-rip the failed title(s) from the resulting image. Windows-only.
 */
export class RecoveryService {
  /**
   * Detect whether MakeMKV output indicates a title failed due to disc read errors.
   * @param {string} stdout - Raw MakeMKV output
   * @returns {boolean}
   */
  static isReadErrorFailure(stdout) {
    if (!stdout || typeof stdout !== "string") {
      return false;
    }

    const hasReadError =
      stdout.includes(MAKEMKV_READ_ERROR_MESSAGES.READ_ERROR) ||
      stdout.includes(MAKEMKV_READ_ERROR_MESSAGES.READ_ERROR_SUMMARY);

    // A read error is the necessary signal: without one this was not a damaged
    // disc and ddrescue cannot help, so never trigger recovery.
    if (!hasReadError) {
      return false;
    }

    const hasTitleFailure = stdout.includes(
      MAKEMKV_READ_ERROR_MESSAGES.TITLE_SAVE_FAILED
    );

    // Trigger when a specific title failed to save, OR when the disc had read
    // errors and the rip never reported a successful completion at all (a
    // whole-disc abort, where the per-title MSG:5003 lines may be absent).
    return hasTitleFailure || !ValidationUtils.isCopyComplete(stdout);
  }

  /**
   * Extract the failed source title id(s) from MakeMKV output. The MSG:5003
   * "Failed to save title" lines reference the output filename (e.g. ..._t00.mkv)
   * whose number maps directly to the MakeMKV title selector.
   * @param {string} stdout - Raw MakeMKV output
   * @returns {number[]} - Unique, ascending title ids
   */
  static getFailedTitleIds(stdout) {
    if (!stdout || typeof stdout !== "string") {
      return [];
    }

    const ids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(MAKEMKV_READ_ERROR_MESSAGES.TITLE_SAVE_FAILED)) {
        continue;
      }
      const match = line.match(/_t(\d+)\.mkv/i);
      if (match) {
        ids.add(Number.parseInt(match[1], 10));
      }
    }

    return [...ids].sort((a, b) => a - b);
  }

  /**
   * Resolve the path to the MSYS2 bash executable.
   * @returns {string}
   */
  static getBashPath() {
    const dir = AppConfig.readErrorRecovery.msys2Dir;
    return path.win32.join(dir, "usr", "bin", "bash.exe");
  }

  /**
   * Map a MakeMKV drive number to the corresponding MSYS2 optical device node.
   * Honors an explicit full-path override (device_path) when configured.
   * @param {string|number} driveNumber
   * @returns {string}
   */
  static mapDriveToDevice(driveNumber) {
    const { devicePath, devicePrefix } = AppConfig.readErrorRecovery;
    if (devicePath) {
      return devicePath;
    }
    return `${devicePrefix}${driveNumber}`;
  }

  /**
   * Check whether MSYS2 bash, the helper script, and ddrescue are all available.
   * @returns {Promise<boolean>}
   */
  static async isAvailable() {
    if (process.platform !== "win32") {
      return false;
    }

    const bash = this.getBashPath();
    if (!fs.existsSync(bash)) {
      Logger.warning(`Read-error recovery: MSYS2 bash not found at ${bash}`);
      return false;
    }

    if (!fs.existsSync(SCRIPT_PATH)) {
      Logger.warning(`Read-error recovery: helper script not found at ${SCRIPT_PATH}`);
      return false;
    }

    const hasDdrescue = await this.#hasDdrescue(bash);
    if (!hasDdrescue) {
      Logger.warning(
        "Read-error recovery: ddrescue is not available in MSYS2. Build it from source (see scripts/ddrescue-recover.sh header)."
      );
    }
    return hasDdrescue;
  }

  /**
   * Verify ddrescue is callable inside the MSYS2 login shell.
   * @param {string} bash - Path to bash.exe
   * @returns {Promise<boolean>}
   */
  static #hasDdrescue(bash) {
    return new Promise((resolve) => {
      const child = spawn(
        bash,
        ["-lc", "command -v ddrescue >/dev/null 2>&1 && echo OK || echo MISSING"],
        { windowsHide: true }
      );
      let out = "";
      child.stdout.on("data", (data) => {
        out += data.toString();
      });
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(out.includes("OK")));
    });
  }

  /**
   * Image a disc with ddrescue, skipping unreadable areas.
   * @param {string|number} driveNumber - MakeMKV drive number
   * @param {string} imagePath - Destination image path (Windows path)
   * @param {Object} [options]
   * @param {(line: string) => void} [options.onProgress] - Progress line callback
   * @param {(child: import('child_process').ChildProcess) => void} [options.onChild] - Receives the spawned process
   * @returns {Promise<{imagePath: string}>}
   */
  static recoverDiscToImage(driveNumber, imagePath, options = {}) {
    const { onProgress, onChild } = options;

    return new Promise((resolve, reject) => {
      const bash = this.getBashPath();
      const device = this.mapDriveToDevice(driveNumber);
      const { passes, retries, timeout, maxRuntime, reversePass, direct, resume } =
        AppConfig.readErrorRecovery;

      // Tuning is passed through the environment so the positional command stays
      // simple. The script reads DDR_* with sane defaults if any are missing.
      const env = {
        ...process.env,
        DDR_PASSES: String(passes),
        DDR_RETRIES: String(retries),
        DDR_TIMEOUT: timeout || "",
        DDR_MAX_RUNTIME: String(this.parseDurationToSeconds(maxRuntime)),
        DDR_REVERSE: reversePass ? "1" : "0",
        DDR_DIRECT: direct ? "1" : "0",
        DDR_RESUME: resume ? "1" : "0",
      };

      // Resolve the helper script to an MSYS path and strip any CR characters so
      // the script runs regardless of the checked-out line endings.
      const command =
        `script=$(cygpath -u ${shQuote(SCRIPT_PATH)}); ` +
        `bash <(tr -d '\\r' < "$script") ${shQuote(device)} ${shQuote(
          imagePath
        )}`;

      const child = spawn(bash, ["-lc", command], {
        windowsHide: true,
        env,
        // stdin is ignored so that if ddrescue ever prompts interactively (e.g.
        // on a mapfile write error) it receives EOF and aborts the pass instead
        // of blocking the rip forever waiting on input that can never arrive.
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (typeof onChild === "function") {
        onChild(child);
      }

      let stderrTail = "";
      const handleData = (buffer, isError) => {
        const text = buffer.toString();
        if (isError) {
          stderrTail = (stderrTail + text).slice(-2000);
        }
        if (typeof onProgress === "function") {
          // ddrescue rewrites its status line with a bare carriage return, so
          // split on CR as well as LF to stream live progress instead of one blob.
          for (const line of text.split(/[\r\n]+/)) {
            const trimmed = line.trim();
            if (trimmed) {
              onProgress(trimmed);
            }
          }
        }
      };

      child.stdout.on("data", (data) => handleData(data, false));
      child.stderr.on("data", (data) => handleData(data, true));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ imagePath });
          return;
        }

        let hint = "";
        if (code === 4) {
          // Could not read the raw device: usually no Administrator rights, no
          // media in the drive, or a disc too damaged to read even sector 0.
          hint = ` Could not read ${device} (need Administrator rights, an inserted disc, or the disc is unreadable). On Windows, run the app elevated or set ripping.recovery.device_path.`;
        } else if (code === 5) {
          hint = " ddrescue recovered no data from the disc.";
        } else if (code === 143) {
          hint = " Recovery was stopped (cancelled or max-runtime reached); the partial image was kept for resume.";
        }
        reject(
          new Error(
            `ddrescue recovery exited with code ${code}.${hint} ${stderrTail.trim()}`.trim()
          )
        );
      });
    });
  }

  /**
   * Parse a human duration ("90m", "1h", "45s", "300") into whole seconds.
   * Returns 0 for empty/invalid input (meaning "no limit").
   * @param {string} value
   * @returns {number}
   */
  static parseDurationToSeconds(value) {
    if (typeof value !== "string") {
      return 0;
    }
    const match = value.trim().match(/^(\d+)\s*([smh]?)$/i);
    if (!match) {
      return 0;
    }
    const n = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === "h") return n * 3600;
    if (unit === "m") return n * 60;
    return n; // "s" or bare number
  }

  /**
   * Summarize a ddrescue mapfile into rescued/bad/total bytes and percentages.
   * Returns null if the mapfile is missing or unparseable.
   * @param {string} mapPath
   * @returns {{rescuedBytes: number, badBytes: number, totalBytes: number, rescuedPct: number, badPct: number}|null}
   */
  static summarizeMapfile(mapPath) {
    let text;
    try {
      text = fs.readFileSync(mapPath, "utf8");
    } catch {
      return null;
    }

    let rescued = 0;
    let bad = 0;
    let total = 0;
    let sawData = false;

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      // Block lines look like: 0x<pos> 0x<size> <status>
      if (parts.length < 3 || !/^0x/i.test(parts[1])) {
        continue;
      }
      const size = Number.parseInt(parts[1], 16);
      if (!Number.isFinite(size)) {
        continue;
      }
      sawData = true;
      total += size;
      if (parts[2] === "+") {
        rescued += size;
      } else if (parts[2] === "-") {
        bad += size;
      }
    }

    if (!sawData || total === 0) {
      return null;
    }

    return {
      rescuedBytes: rescued,
      badBytes: bad,
      totalBytes: total,
      rescuedPct: (rescued / total) * 100,
      badPct: (bad / total) * 100,
    };
  }

  /**
   * Delete abandoned recovery artifacts (*.recovery.iso/.map/.size and a stray
   * .map.bad) older than maxAgeDays in the given directory. No-op when
   * maxAgeDays <= 0 or the directory is missing. Best-effort; never throws.
   * @param {string} dir
   * @param {number} maxAgeDays
   * @param {number} [nowMs] - injectable clock for testing
   * @returns {string[]} - names of files that were deleted
   */
  static sweepStaleImages(dir, maxAgeDays, nowMs = Date.now()) {
    if (!maxAgeDays || maxAgeDays <= 0) {
      return [];
    }

    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const isArtifact = (name) =>
      /\.recovery\.iso(\.map(\.bad)?|\.size)?$/i.test(name);
    const deleted = [];

    for (const name of entries) {
      if (!isArtifact(name)) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (nowMs - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(full);
          deleted.push(name);
        }
      } catch {
        // Ignore files that vanish or can't be stat'd/removed.
      }
    }

    if (deleted.length > 0) {
      Logger.info(
        `Read-error recovery: swept ${deleted.length} stale recovery file(s) from ${dir}.`
      );
    }
    return deleted;
  }
}
