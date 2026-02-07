import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { open, stat } from "fs/promises";
import path from "path";
import { HandBrakeService, HandBrakeError } from "../../src/services/handbrake.service.js";
import { AppConfig } from "../../src/config/index.js";
import { Logger } from "../../src/utils/logger.js";
import { exec } from "child_process";

// Mock dependencies
vi.mock("fs");
vi.mock("fs/promises");
vi.mock("child_process");
vi.mock("../../src/utils/logger.js");
vi.mock("../../src/utils/filesystem.js");

// Mock AppConfig with a proper getter
vi.mock("../../src/config/index.js", () => ({
  AppConfig: {
    handbrake: {
      enabled: true,
      cli_path: null,
      preset: "Fast 1080p30",
      output_format: "mp4",
      delete_original: false,
      additional_args: "",
      subtitles: {
        enabled: true,
        lang_list: "eng,any",
        all: true,
        default: "1",
        burned: "auto"
      }
    }
  }
}));

describe("HandBrakeService", () => {
  let mockAppConfig;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get the mocked AppConfig
    const { AppConfig } = await import("../../src/config/index.js");
    mockAppConfig = AppConfig;

    // Reset mock config to defaults
    mockAppConfig.handbrake = {
      enabled: true,
      cli_path: null,
      preset: "Fast 1080p30",
      output_format: "mp4",
      delete_original: false,
      additional_args: "",
      subtitles: {
        enabled: true,
        lang_list: "eng,any",
        all: true,
        default: "1",
        burned: "auto"
      }
    };

    Logger.info = vi.fn();
    Logger.debug = vi.fn();
    Logger.error = vi.fn();
    Logger.warn = vi.fn();
    Logger.warning = vi.fn();
  });

  describe("validateConfig", () => {
    it("should pass validation with valid config", () => {
      expect(() => HandBrakeService.validateConfig(mockAppConfig.handbrake)).not.toThrow();
    });

    it("should throw error for invalid output format", () => {
      const invalidConfig = { ...mockAppConfig.handbrake, output_format: "avi" };
      expect(() => HandBrakeService.validateConfig(invalidConfig)).toThrow(/output_format must be one of/);
    });

    it("should throw error for empty preset", () => {
      const invalidConfig = { ...mockAppConfig.handbrake, preset: "" };
      expect(() => HandBrakeService.validateConfig(invalidConfig)).toThrow(/preset is required/);
    });

    it("should throw error for conflicting additional args", () => {
      const invalidConfig = { ...mockAppConfig.handbrake, additional_args: "--input test.mkv" };
      expect(() => HandBrakeService.validateConfig(invalidConfig)).toThrow(/conflicting options/);
    });
  });

  describe("getHandBrakePath", () => {
    it("should use configured path when available", async () => {
      const configWithPath = { ...mockAppConfig.handbrake, cli_path: "/usr/bin/HandBrakeCLI" };
      fs.existsSync.mockReturnValue(true);

      const result = await HandBrakeService.getHandBrakePath(configWithPath);
      expect(result).toBe("/usr/bin/HandBrakeCLI");
    });

    it("should auto-detect on Windows", async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      fs.existsSync.mockImplementation((path) =>
        path === "C:/Program Files/HandBrake/HandBrakeCLI.exe"
      );

      const result = await HandBrakeService.getHandBrakePath(mockAppConfig.handbrake);
      expect(result).toBe("C:/Program Files/HandBrake/HandBrakeCLI.exe");
    });

    it("should throw error when HandBrake not found", async () => {
      fs.existsSync.mockReturnValue(false);

      await expect(HandBrakeService.getHandBrakePath(mockAppConfig.handbrake)).rejects.toThrow(/HandBrakeCLI not found/);
    });
  });

  describe("buildCommand", () => {
    it("should build basic command correctly", () => {
      const cmd = HandBrakeService.buildCommand(
        "/usr/bin/HandBrakeCLI",
        "/input/test.mkv",
        "/output/test.mp4"
      );

      expect(cmd).toContain('"/usr/bin/HandBrakeCLI"');
      expect(cmd).toContain('--input "/input/test.mkv"');
      expect(cmd).toContain('--output "/output/test.mp4"');
      expect(cmd).toContain('--preset "Fast 1080p30"');
      expect(cmd).toContain('--subtitle-lang-list eng,any');
      expect(cmd).toContain('--all-subtitles');
      expect(cmd).toContain('--subtitle-default=1');
    });

    it("should include optimization for MP4 format", () => {
      mockAppConfig.handbrake.output_format = "mp4";
      const cmd = HandBrakeService.buildCommand("/bin/hb", "in.mkv", "out.mp4");
      expect(cmd).toContain('--optimize');
    });

    it("should include additional arguments", () => {
      mockAppConfig.handbrake.additional_args = "--quality 22 --encoder x264";
      const cmd = HandBrakeService.buildCommand("/bin/hb", "in.mkv", "out.mp4");
      expect(cmd).toContain('--quality 22 --encoder x264');
    });
  });

  describe("validateOutput", () => {
    it("should pass validation for valid file", async () => {
      // Mock fs/promises stat to return file info
      stat.mockResolvedValue({ size: 100 * 1024 * 1024 }); // 100MB

      // Mock fs/promises open to return a file handle
      const mockFileHandle = {
        read: vi.fn().mockImplementation((buffer) => {
          // Write valid MP4 header to buffer
          const header = Buffer.from("0000001866747970", "hex");
          header.copy(buffer);
          return Promise.resolve({ bytesRead: 1024 });
        }),
        close: vi.fn().mockResolvedValue()
      };
      open.mockResolvedValue(mockFileHandle);

      await expect(HandBrakeService.validateOutput("/test/output.mp4")).resolves.not.toThrow();
      expect(mockFileHandle.close).toHaveBeenCalled();
    });

    it("should throw error if file doesn't exist", async () => {
      // Mock fs/promises stat to throw ENOENT error
      const error = new Error("ENOENT: no such file or directory");
      error.code = "ENOENT";
      stat.mockRejectedValue(error);

      await expect(HandBrakeService.validateOutput("/test/output.mp4")).rejects.toThrow(/output file not created/);
    });

    it("should throw error for empty file", async () => {
      // Mock fs/promises stat to return 0 size
      stat.mockResolvedValue({ size: 0 });

      await expect(HandBrakeService.validateOutput("/test/output.mp4")).rejects.toThrow(/output file is empty/);
    });
  });

  describe("convertFile", () => {
    beforeEach(() => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 1024 * 1024 * 1024 }); // 1GB
    });

    it("should skip conversion when disabled", async () => {
      mockAppConfig.handbrake.enabled = false;

      const result = await HandBrakeService.convertFile("/test/input.mkv");
      expect(result).toBe(true);
      expect(Logger.info).toHaveBeenCalledWith("HandBrake post-processing is disabled, skipping...");
    });

    it("should throw error for missing input file", async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await HandBrakeService.convertFile("/test/missing.mkv");
      expect(result).toBe(false);
    });
  });
});