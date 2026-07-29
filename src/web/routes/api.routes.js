/**
 * MakeMKV Auto Rip - Web API Routes
 * Handles all API endpoints for the web interface
 */

import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { AppConfig } from "../../config/index.js";
import { prepareRipRuntime } from "../../app.js";
import { DiscService } from "../../services/disc.service.js";
import { DriveService } from "../../services/drive.service.js";
import { RipService } from "../../services/rip.service.js";
import { Logger } from "../../utils/logger.js";
import {
  broadcastStatusUpdate,
  broadcastLogMessage,
} from "../middleware/websocket.middleware.js";

const router = Router();

// Status tracking
let currentOperation = null;
let operationStatus = "idle"; // idle, loading, ejecting, ripping
let currentOperationPromise = null;
let currentStopRequested = false;
let activeWebLoggerSinkCleanup = null;
// One RipService for the whole rip-mode session, so its HandBrake queue can
// keep encoding across disc changes instead of being thrown away each cycle.
let ripSession = null;
let ripModeEnabled = false;
let ripModeLoop = null;

function getCanStop() {
  return currentOperationPromise !== null || (operationStatus === "ripping" && ripModeEnabled);
}

function broadcastCurrentStatus() {
  broadcastStatusUpdate(operationStatus, currentOperation, {
    canStop: getCanStop(),
  });
}

function setOperationState(status, operation = null) {
  operationStatus = status;
  currentOperation = operation;
  broadcastCurrentStatus();
}

function resetOperationState() {
  operationStatus = "idle";
  currentOperation = null;
  currentOperationPromise = null;
  currentStopRequested = false;
  broadcastCurrentStatus();
}

function formatLogMessage(message, title = null) {
  return [message, title]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value))
    .join(" ")
    .trim();
}

function attachWebLoggerSink() {
  if (activeWebLoggerSinkCleanup) {
    return activeWebLoggerSinkCleanup;
  }

  activeWebLoggerSinkCleanup = Logger.addSink(
    ({ level, message, title, details }) => {
      if (level === "debug") {
        return;
      }

      const formattedMessage = formatLogMessage(message, title);
      if (formattedMessage) {
        broadcastLogMessage(level, formattedMessage);
      }

      if (details !== null && details !== undefined && details !== "") {
        broadcastLogMessage(level, String(details));
      }
    }
  );

  return activeWebLoggerSinkCleanup;
}

function detachWebLoggerSink() {
  if (activeWebLoggerSinkCleanup) {
    activeWebLoggerSinkCleanup();
    activeWebLoggerSinkCleanup = null;
  }
}

async function runTrackedOperation(operation) {
  currentOperationPromise = Promise.resolve().then(operation);
  broadcastCurrentStatus();

  try {
    return await currentOperationPromise;
  } finally {
    currentOperationPromise = null;
    currentStopRequested = false;
    broadcastCurrentStatus();
  }
}

function ensureRipSession() {
  if (!ripSession) {
    ripSession = new RipService({
      exitOnCriticalError: false,
      // Encode in the background: the disc is ejected as soon as it is ripped,
      // so waiting for HandBrake here would leave the drive idle (and the loop
      // blind to disc changes) for the length of an encode.
      backgroundHandBrake: true,
    });
  }

  return ripSession;
}

async function executeRipCycle() {
  const ripService = ensureRipSession();

  try {
    await prepareRipRuntime();
    await runTrackedOperation(() => ripService.startRipping());

    if (ripService.wasCancelled()) {
      return { success: false, cancelled: true };
    }

    return { success: true };
  } catch (error) {
    if (ripService.isCancellationRequested() || ripService.isCancellationError(error)) {
      return { success: false, cancelled: true };
    }

    Logger.error("Rip cycle failed", error.message);
    return { success: false, error: error.message };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRipPollIntervalMs() {
  return Math.max(AppConfig.mountPollInterval * 1000, 1000);
}

/**
 * Stable identity of a detected disc: the drive holding it plus its volume
 * label. Used to tell "the disc I just ripped is still sitting there" apart
 * from "a new disc has been loaded".
 */
function discKey(disc) {
  return `${disc.driveNumber}:${disc.title}`;
}

function describeDiscs(discs) {
  return discs.map((disc) => disc.title).join(", ");
}

/**
 * Poll the drives once.
 * @returns {Promise<Array|null>} Detected discs, or null when the detection
 *   itself failed - which must not be read as "the drives are empty", or a
 *   single hiccup would make the loop re-rip the disc that is still loaded.
 */
async function detectDiscsForRipMode() {
  try {
    return await DiscService.detectAvailableDiscs();
  } catch (error) {
    Logger.error("Rip mode disc detection failed", error.message);
    return null;
  }
}

function describeBackgroundEncoding() {
  const status = ripSession?.getHandBrakeStatus();
  if (!status?.total) {
    return "";
  }

  return ` (encoding ${status.active ?? "queued files"}${
    status.pending ? ` +${status.pending} queued` : ""
  } in the background)`;
}

/**
 * Wait until a disc is loaded that we have not just ripped.
 *
 * A disc counts as new when either the drives have been seen empty since the
 * last rip (the normal eject then swap), or its identity differs from what we
 * ripped last (a swap made while we were busy ripping and not polling). Both
 * rules are needed: waiting for "empty" alone hangs forever when the user
 * swaps discs during a rip, and comparing identity alone would ignore a
 * genuinely new disc that happens to share a volume label.
 *
 * @param {Set<string>} rippedKeys - Identities from the previous cycle. Cleared
 *   in place once the drives are observed empty.
 * @returns {Promise<Array>} Discs present when one of them is new; empty when
 *   rip mode was stopped.
 */
async function waitForNextDiscs(rippedKeys) {
  let lastAnnounced = null;

  const announce = (message) => {
    if (message !== lastAnnounced) {
      lastAnnounced = message;
      broadcastLogMessage("info", message);
    }

    setOperationState("ripping", `${message}${describeBackgroundEncoding()}`);
  };

  while (ripModeEnabled) {
    const detectedDiscs = await detectDiscsForRipMode();

    if (!ripModeEnabled) {
      break;
    }

    if (detectedDiscs === null) {
      announce("Disc detection failed. Retrying...");
    } else if (detectedDiscs.length === 0) {
      // Drives are empty, so whatever is loaded next is a new disc.
      rippedKeys.clear();
      announce("Waiting for disc insertion...");
    } else if (detectedDiscs.some((disc) => !rippedKeys.has(discKey(disc)))) {
      return detectedDiscs;
    } else {
      announce(
        `${describeDiscs(detectedDiscs)} was already ripped. Waiting for the disc to be removed or swapped...`
      );
    }

    await wait(getRipPollIntervalMs());
  }

  return [];
}

async function runRipModeLoop() {
  // Identities of the discs ripped by the previous cycle.
  const rippedKeys = new Set();

  broadcastLogMessage(
    "info",
    "Rip mode enabled. Waiting for inserted discs..."
  );

  while (ripModeEnabled) {
    const detectedDiscs = await waitForNextDiscs(rippedKeys);

    if (!ripModeEnabled || detectedDiscs.length === 0) {
      break;
    }

    setOperationState(
      "ripping",
      `Detected ${detectedDiscs.length} disc(s): ${describeDiscs(detectedDiscs)}. Starting rip process...`
    );

    // Record the discs before ripping: they are ejected partway through the
    // cycle, so this is the last point at which they can be identified.
    rippedKeys.clear();
    for (const disc of detectedDiscs) {
      rippedKeys.add(discKey(disc));
    }

    const result = await executeRipCycle();

    if (!ripModeEnabled) {
      break;
    }

    if (result.success) {
      broadcastLogMessage(
        "success",
        "Rip cycle completed successfully. Insert the next disc and close the drive to keep ripping."
      );
    } else {
      broadcastLogMessage(
        "error",
        `Rip cycle failed${result.error ? `: ${result.error}` : ""}`
      );
    }
  }
}

function ensureRipModeLoop() {
  if (ripModeLoop) {
    return ripModeLoop;
  }

  ripModeLoop = (async () => {
    attachWebLoggerSink();

    try {
      await runRipModeLoop();
    } catch (error) {
      Logger.error("Rip mode loop failed", error.message);
      broadcastLogMessage("error", `Rip mode failed: ${error.message}`);
    } finally {
      ripModeLoop = null;

      // Background encoding belongs to the session, so it ends with it.
      const finishedSession = ripSession;
      ripSession = null;
      if (finishedSession) {
        finishedSession.requestCancel();
        await finishedSession.waitForHandBrakeQueue().catch(() => {});
      }

      detachWebLoggerSink();

      if (!ripModeEnabled) {
        resetOperationState();
      }
    }
  })();

  return ripModeLoop;
}

function stopCurrentOperation(message) {
  ripModeEnabled = false;
  currentStopRequested = true;

  // Cancels the in-flight rip and any background encode. Safe to call while the
  // loop is only waiting for a disc: it just marks the session cancelled.
  const encoding = ripSession?.getHandBrakeStatus();
  ripSession?.requestCancel();

  if (currentOperationPromise) {
    setOperationState(operationStatus, "Cancelling current operation...");
  } else {
    detachWebLoggerSink();
    resetOperationState();
  }

  broadcastLogMessage("warn", message);

  if (encoding?.total) {
    broadcastLogMessage(
      "warn",
      `Cancelled ${encoding.total} in-progress/queued HandBrake encode(s). The ripped MKV files were kept.`
    );
  }
}

/**
 * Get current system status
 */
router.get("/status", async (req, res) => {
  try {
    res.json({
      operation: currentOperation,
      status: operationStatus,
      canStop: getCanStop(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error("Failed to get status", error.message);
    res.status(500).json({ error: "Failed to get status" });
  }
});

/**
 * Get application info (name, version)
 */
router.get("/info", async (req, res) => {
  try {
    const packagePath = path.join(process.cwd(), "package.json");
    const packageContent = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(packageContent);
    res.json({ name: pkg.name, version: pkg.version });
  } catch (error) {
    Logger.error("Failed to read package.json for app info", error.message);
    res.status(500).json({ error: "Failed to get application info" });
  }
});

/**
 * Stop current operation
 */
router.post("/stop", async (req, res) => {
  try {
    if (getCanStop()) {
      stopCurrentOperation("Operation stopped by user");
      res.json({ success: true, message: "Operation stopped" });
    } else {
      res.status(400).json({ error: "No operation is currently running" });
    }
  } catch (error) {
    Logger.error("Failed to stop operation", error.message);
    res
      .status(500)
      .json({ error: "Failed to stop operation: " + error.message });
  }
});

/**
 * Load all drives using the same in-process service path as the CLI
 */
router.post("/drives/load", async (req, res) => {
  try {
    if (operationStatus !== "idle") {
      return res
        .status(409)
        .json({ error: "Another operation is in progress" });
    }

    setOperationState("loading", "Loading drives...");
    attachWebLoggerSink();

    await AppConfig.validate();
    await runTrackedOperation(() => DriveService.loadDrivesWithWait());

    resetOperationState();
    detachWebLoggerSink();

    {
      res.json({ success: true, message: "Drives loaded successfully" });
    }
  } catch (error) {
    resetOperationState();
    detachWebLoggerSink();
    Logger.error("Failed to load drives", error.message);
    res.status(500).json({ error: "Failed to load drives: " + error.message });
  }
});

/**
 * Eject all drives using the same in-process service path as the CLI
 */
router.post("/drives/eject", async (req, res) => {
  try {
    if (operationStatus !== "idle") {
      return res
        .status(409)
        .json({ error: "Another operation is in progress" });
    }

    setOperationState("ejecting", "Ejecting drives...");
    attachWebLoggerSink();

    await AppConfig.validate();
    await runTrackedOperation(() => DriveService.ejectAllDrives());

    resetOperationState();
    detachWebLoggerSink();

    {
      res.json({ success: true, message: "Drives ejected successfully" });
    }
  } catch (error) {
    resetOperationState();
    detachWebLoggerSink();
    Logger.error("Failed to eject drives", error.message);
    res.status(500).json({ error: "Failed to eject drives: " + error.message });
  }
});

/**
 * Get current configuration
 */
router.get("/config", async (req, res) => {
  try {
    const configPath = path.join(process.cwd(), "config.yaml");
    const configContent = await fs.readFile(configPath, "utf8");
    res.json({ config: configContent });
  } catch (error) {
    Logger.error("Failed to read config", error.message);
    res.status(500).json({ error: "Failed to read configuration file" });
  }
});

/**
 * Update configuration
 */
router.post("/config", async (req, res) => {
  try {
    const { config } = req.body;
    if (!config) {
      return res
        .status(400)
        .json({ error: "Configuration content is required" });
    }

    const configPath = path.join(process.cwd(), "config.yaml");
    await fs.writeFile(configPath, config, "utf8");

    res.json({ success: true, message: "Configuration updated successfully" });
  } catch (error) {
    Logger.error("Failed to update config", error.message);
    res
      .status(500)
      .json({ error: "Failed to update configuration: " + error.message });
  }
});

/**
 * Get current configuration as structured object
 */
router.get("/config/structured", async (req, res) => {
  try {
    const configPath = path.join(process.cwd(), "config.yaml");
    const configContent = await fs.readFile(configPath, "utf8");
    const config = yamlParse(configContent);
    res.json({ config });
  } catch (error) {
    Logger.error("Failed to read structured config", error.message);
    res.status(500).json({ error: "Failed to read configuration file" });
  }
});

/**
 * Update configuration with structured object
 */
router.post("/config/structured", async (req, res) => {
  try {
    const { config } = req.body;
    if (!config || typeof config !== "object") {
      return res
        .status(400)
        .json({ error: "Configuration object is required" });
    }

    // Validate required fields
    if (!config.paths?.movie_rips_dir) {
      return res
        .status(400)
        .json({ error: "Movie rips directory is required" });
    }

    if (config.paths?.logging?.enabled && !config.paths?.logging?.dir) {
      return res
        .status(400)
        .json({ error: "Log directory is required when logging is enabled" });
    }

    // Track if we need to kill a process
    const wasRunning = operationStatus !== "idle";

    // If not idle, kill the current process before saving config
    if (wasRunning) {
      Logger.info("Stopping current operation to save configuration...");

      try {
        stopCurrentOperation("Operation stopped to save configuration");
      } catch (killError) {
        Logger.error("Failed to stop current process", killError.message);
        // Continue with config save even if kill failed
      }
    }

    const configPath = path.join(process.cwd(), "config.yaml");

    // Read existing YAML content
    const existingContent = await fs.readFile(configPath, "utf8");

    // Update only specific values while preserving all comments and structure
    const updatedContent = updateYamlValues(existingContent, config);

    await fs.writeFile(configPath, updatedContent, "utf8");

    Logger.info("Configuration updated successfully");
    res.json({
      success: true,
      message: "Configuration updated successfully",
      processKilled: wasRunning, // Let frontend know if we killed a process
    });
  } catch (error) {
    Logger.error("Failed to update structured config", error.message);
    res
      .status(500)
      .json({ error: "Failed to update configuration: " + error.message });
  }
});

/**
 * Update YAML values while preserving all comments and formatting
 */
function updateYamlValues(yamlContent, config) {
  let updatedContent = yamlContent;

  // Helper function to properly format YAML values
  function formatYamlValue(value) {
    if (typeof value === "string") {
      // Always quote strings
      return `"${value}"`;
    } else if (typeof value === "boolean") {
      return value.toString();
    } else if (typeof value === "number") {
      return value.toString();
    }
    return value;
  }

  // Helper function to update a specific key-value pair
  function updateKeyValue(content, keyPath, value) {
    const keys = keyPath.split(".");
    let currentContent = content;

    if (keys.length === 1) {
      // Top-level key (e.g., "interface:")
      const regex = new RegExp(`^(\\s*${keys[0]}\\s*:)\\s*(.*)$`, "m");
      const match = currentContent.match(regex);
      if (match) {
        currentContent = currentContent.replace(
          regex,
          `$1 ${formatYamlValue(value)}`
        );
      }
    } else {
      // Nested key (e.g., "paths.movie_rips_dir")
      const parentKey = keys[0];
      const childKey = keys[keys.length - 1];

      // Find the parent section
      const parentRegex = new RegExp(`^(\\s*${parentKey}\\s*:)`, "m");
      const parentMatch = currentContent.match(parentRegex);

      if (parentMatch) {
        // First try to find an active (uncommented) child key
        const childRegex = new RegExp(`^(\\s+${childKey}\\s*:)\\s*(.*)$`, "m");
        const childMatch = currentContent.match(childRegex);

        if (childMatch) {
          // Found active key, update it
          currentContent = currentContent.replace(
            childRegex,
            `$1 ${formatYamlValue(value)}`
          );
        } else {
          // Look for commented version of the key to uncomment and update
          const commentedRegex = new RegExp(
            `^(\\s*)#\\s*(${childKey}\\s*:)\\s*(.*)$`,
            "m"
          );
          const commentedMatch = currentContent.match(commentedRegex);

          if (commentedMatch) {
            // Uncomment and update the value
            currentContent = currentContent.replace(
              commentedRegex,
              `$1$2 ${formatYamlValue(value)}`
            );
          } else {
            // Key doesn't exist, add it after the parent section header
            const parentIndex = currentContent.search(parentRegex);
            if (parentIndex !== -1) {
              const lines = currentContent.split("\n");
              let insertIndex = -1;

              // Find the line with the parent key
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(parentRegex)) {
                  insertIndex = i + 1;
                  break;
                }
              }

              if (insertIndex !== -1) {
                // Insert the new key after the parent
                const indent = "  "; // Use 2 spaces for indentation
                const newLine = `${indent}${childKey}: ${formatYamlValue(
                  value
                )}`;
                lines.splice(insertIndex, 0, newLine);
                currentContent = lines.join("\n");
              }
            }
          }
        }
      }
    }

    return currentContent;
  }

  // Function to handle deletion of optional keys
  function deleteKeyValue(content, keyPath) {
    const keys = keyPath.split(".");

    if (keys.length === 1) {
      // Top-level key deletion
      const regex = new RegExp(`^\\s*${keys[0]}\\s*:.*$`, "m");
      return content.replace(regex, "");
    } else {
      // Nested key deletion
      const childKey = keys[keys.length - 1];
      const regex = new RegExp(`^\\s+${childKey}\\s*:.*$`, "m");
      return content.replace(regex, "");
    }
  }

  // Recursively process the config object
  function processConfigObject(obj, prefix = "") {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        // Recursively process nested objects
        processConfigObject(value, fullKey);
      } else if (value !== undefined) {
        // Update the value
        updatedContent = updateKeyValue(updatedContent, fullKey, value);
      }
    }
  }

  // Handle makemkv_dir deletion if it was removed from config
  if (config.paths && !config.paths.hasOwnProperty("makemkv_dir")) {
    // Comment out the makemkv_dir line if it exists and is not already commented
    const makemkvRegex = /^(\s+)(makemkv_dir\s*:.*$)/m;
    const match = updatedContent.match(makemkvRegex);
    if (match) {
      updatedContent = updatedContent.replace(makemkvRegex, "$1# $2");
    }
  }

  // Process all the config updates
  processConfigObject(config);

  return updatedContent;
}

/**
 * Deep merge utility function for configuration objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Start the main ripping process using CLI command
 */
router.post("/rip/start", async (req, res) => {
  try {
    if (operationStatus !== "idle") {
      return res
        .status(409)
        .json({ error: "Another operation is in progress" });
    }

    // The status goes idle the moment a stop is requested, but the loop needs a
    // poll interval to unwind. Starting again before then would hand the new
    // session to the old loop as it shuts down.
    if (ripModeLoop) {
      return res
        .status(409)
        .json({ error: "Rip mode is still stopping, please try again" });
    }

    ripModeEnabled = true;
    setOperationState("ripping", "Starting rip mode...");

    // Keep rip mode running in the background until the user stops it.
    void ensureRipModeLoop();

    res.json({ success: true, message: "Rip mode enabled" });
  } catch (error) {
    ripModeEnabled = false;
    resetOperationState();
    Logger.error("Failed to start ripping", error.message);
    res
      .status(500)
      .json({ error: "Failed to start ripping: " + error.message });
  }
});

export { router as apiRoutes };
