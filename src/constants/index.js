/**
 * Application constants
 */

export const APP_INFO = Object.freeze({
  name: "MakeMKV Auto Rip",
  version: "1.0.0",
  author: "Zac Ingoglia (Poisonite)",
  copyright: "- Created By: Zac Ingoglia (Poisonite)",
});

export const MEDIA_TYPES = Object.freeze({
  DVD: "dvd",
  BLU_RAY: "blu-ray",
});

export const LOG_LEVELS = Object.freeze({
  INFO: "info",
  ERROR: "error",
  WARNING: "warning",
});

export const VALIDATION_CONSTANTS = {
  DRIVE_FILTER: "DRV:",
  MEDIA_PRESENT: 2,
  TITLE_LENGTH_CODE: 9,
  COPY_COMPLETE_MSG: "MSG:5036",
  MINIMUM_TITLE_LENGTH: 120, // seconds
};

export const HANDBRAKE_CONSTANTS = {
  SUPPORTED_FORMATS: ["mp4", "m4v"],
  DEFAULT_PRESET: "Fast 1080p30",
  MIN_FILE_SIZE_MB: 10, // Minimum reasonable output size
  MAX_TIMEOUT_HOURS: 12, // Maximum conversion timeout
  MIN_TIMEOUT_HOURS: 2, // Minimum conversion timeout
  PROGRESS_CHECK_INTERVAL: 30000, // 30 seconds
  COMMON_PRESETS: [
    "Fast 1080p30",
    "HQ 1080p30 Surround",
    "Super HQ 1080p30 Surround",
    "Fast 720p30",
    "Fast 480p30"
  ],
  FILE_HEADERS: {
    MP4: "66747970", // 'ftyp' in hex
    M4V: "66747970"  // Same as MP4
  }
};

export const MENU_OPTIONS = Object.freeze({
  RIP: "1",
  EXIT: "2",
});

/**
 * MakeMKV message codes related to program version for output parsing
 */
export const MAKEMKV_VERSION_MESSAGES = Object.freeze({
  VERSION_INFO: "MSG:1005",
  VERSION_TOO_OLD: "MSG:5021",
  UPDATE_AVAILABLE: "MSG:5075",
});

/**
 * Default MakeMKV installation paths by platform.
 * These are the most common installation locations for each platform
 */
export const PLATFORM_DEFAULTS = Object.freeze({
  MAKEMKV_PATHS: {
    win32: ["C:/Program Files/MakeMKV", "C:/Program Files (x86)/MakeMKV"],
    linux: ["/usr/bin", "/usr/local/bin", "/opt/makemkv/bin"],
    darwin: [
      "/Applications/MakeMKV.app/Contents/MacOS",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
  },
});
