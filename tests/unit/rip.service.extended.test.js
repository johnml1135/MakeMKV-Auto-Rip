import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { RipService } from "../../src/services/rip.service.js";

// Mock all dependencies
vi.mock("child_process");
vi.mock("fs");
vi.mock("../../src/config/index.js", () => ({
  AppConfig: {
    isLoadDrivesEnabled: false,
    isEjectDrivesEnabled: false,
    isHandBrakeEnabled: false,
    isFileLogEnabled: false,
    rippingMode: "async",
    movieRipsDir: "/test/output",
    logDir: "/test/logs",
    makeMKVFakeDate: null,
    getMakeMKVExecutable: vi.fn().mockResolvedValue("/usr/bin/makemkvcon"),
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  Logger: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    separator: vi.fn(),
  },
}));

vi.mock("../../src/utils/filesystem.js", () => ({
  FileSystemUtils: {
    createUniqueFolder: vi.fn(),
    createUniqueLogFile: vi.fn(),
    writeLogFile: vi.fn(),
    readdir: vi.fn(),
  },
}));

vi.mock("../../src/utils/validation.js", () => ({
  ValidationUtils: {
    isCopyComplete: vi.fn(),
  },
}));

vi.mock("../../src/services/disc.service.js", () => ({
  DiscService: {
    getAvailableDiscs: vi.fn(),
  },
}));

vi.mock("../../src/services/drive.service.js", () => ({
  DriveService: {
    loadDrivesWithWait: vi.fn(),
    ejectAllDrives: vi.fn(),
  },
}));

vi.mock("../../src/services/handbrake.service.js", () => ({
  HandBrakeService: {
    convertFile: vi.fn(),
  },
}));

vi.mock("../../src/utils/process.js", () => ({
  safeExit: vi.fn(),
  withSystemDate: vi.fn((date, callback) => callback()),
}));

vi.mock("../../src/utils/makemkv-messages.js", () => ({
  MakeMKVMessages: {
    checkOutput: vi.fn().mockReturnValue(true),
  },
}));

import { exec } from "child_process";
import fs from "fs";
import { AppConfig } from "../../src/config/index.js";
import { Logger } from "../../src/utils/logger.js";
import { FileSystemUtils } from "../../src/utils/filesystem.js";
import { ValidationUtils } from "../../src/utils/validation.js";
import { DiscService } from "../../src/services/disc.service.js";
import { DriveService } from "../../src/services/drive.service.js";
import { HandBrakeService } from "../../src/services/handbrake.service.js";
import { safeExit } from "../../src/utils/process.js";
import { MakeMKVMessages } from "../../src/utils/makemkv-messages.js";

describe("RipService - Extended Coverage", () => {
  let ripService;

  beforeEach(() => {
    vi.clearAllMocks();
    ripService = new RipService();

    // Setup default mocks
    FileSystemUtils.createUniqueFolder.mockReturnValue("/test/output/Movie");
    ValidationUtils.isCopyComplete.mockReturnValue(true);
    fs.existsSync = vi.fn().mockReturnValue(true);
    FileSystemUtils.readdir.mockResolvedValue(["movie.mkv"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("startRipping - no discs found", () => {
    it("should handle case with no discs gracefully", async () => {
      DiscService.getAvailableDiscs.mockResolvedValue([]);

      await ripService.startRipping();

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("No discs found to rip")
      );
      expect(Logger.separator).toHaveBeenCalled();
    });

    it("should load drives when enabled before checking discs", async () => {
      AppConfig.isLoadDrivesEnabled = true;
      DiscService.getAvailableDiscs.mockResolvedValue([]);

      await ripService.startRipping();

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Loading drives")
      );
      expect(DriveService.loadDrivesWithWait).toHaveBeenCalled();
    });

    it("should not load drives when disabled", async () => {
      AppConfig.isLoadDrivesEnabled = false;
      DiscService.getAvailableDiscs.mockResolvedValue([]);

      await ripService.startRipping();

      expect(DriveService.loadDrivesWithWait).not.toHaveBeenCalled();
    });
  });

  describe("processRippingQueue - sync mode", () => {
    it("should process discs synchronously in sync mode", async () => {
      AppConfig.rippingMode = "sync";

      const mockDiscs = [
        { title: "Movie1", driveNumber: 0, fileNumber: 0 },
        { title: "Movie2", driveNumber: 1, fileNumber: 0 },
      ];

      // Spy on ripSingleDisc and resolve successfully
      vi.spyOn(ripService, "ripSingleDisc").mockResolvedValue("Movie1");

      await ripService.processRippingQueue(mockDiscs);

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("synchronously")
      );
      // ripSingleDisc should be called twice (once for each disc)
      expect(ripService.ripSingleDisc).toHaveBeenCalledTimes(2);
    });

    it("should continue processing after single disc error in sync mode", async () => {
      AppConfig.rippingMode = "sync";

      const mockDiscs = [
        { title: "Movie1", driveNumber: 0, fileNumber: 0 },
        { title: "Movie2", driveNumber: 1, fileNumber: 0 },
      ];

      // Mock first call to fail, second to succeed
      vi.spyOn(ripService, "ripSingleDisc")
        .mockRejectedValueOnce(new Error("Rip failed"))
        .mockResolvedValueOnce("Movie2");

      await ripService.processRippingQueue(mockDiscs);

      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Movie1"),
        expect.anything()
      );
      expect(ripService.badVideoArray).toContain("Movie1");
      // ripSingleDisc should still be called twice
      expect(ripService.ripSingleDisc).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleRipCompletion - HandBrake integration", () => {
    beforeEach(() => {
      AppConfig.isHandBrakeEnabled = true;
      AppConfig.isFileLogEnabled = false;
    });

    it("should process MKV files with HandBrake when enabled and rip successful", async () => {
      const mockStdout = 'MSG:5014,0,0,0,0,"Saving 1 titles into directory file:///test/output/Movie"\nMSG:5036,0,1,"Copy complete."';
      const mockDisc = { title: "TestMovie" };

      HandBrakeService.convertFile.mockResolvedValue(true);
      FileSystemUtils.readdir.mockResolvedValue(["movie.mkv", "info.txt"]);

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("HandBrake post-processing workflow")
      );
      expect(HandBrakeService.convertFile).toHaveBeenCalledWith(
        expect.stringContaining("movie.mkv")
      );
      expect(ripService.goodHandBrakeArray).toContain("movie.mkv");
    });

    it("should warn when no MKV files are present", async () => {
      const mockStdout = 'MSG:5014,0,0,0,0,"Saving 1 titles into directory file:///test/output/Movie"\nMSG:5036,0,1,"Copy complete."';
      const mockDisc = { title: "TestMovie" };

      FileSystemUtils.readdir.mockResolvedValue(["movie.txt", "info.log"]);

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(Logger.warning).toHaveBeenCalledWith(
        expect.stringContaining("No MKV files found in output folder")
      );
      expect(HandBrakeService.convertFile).not.toHaveBeenCalled();
    });

    it("should parse Windows-style output paths with spaces from MakeMKV logs", async () => {
      const mockStdout = 'MSG:5014,131072,2,"Saving 1 titles into directory file://G:\\movies\\Narnia Volume 3","Saving %1 titles into directory %2","1","file://G:\\movies\\Narnia Volume 3"\nMSG:5036,0,1,"Copy complete."';
      const mockDisc = { title: "TestMovie" };

      FileSystemUtils.readdir.mockResolvedValue(["movie.mkv"]);

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(HandBrakeService.convertFile).toHaveBeenCalledWith(
        expect.stringContaining(`Narnia Volume 3${path.sep}movie.mkv`)
      );
    });

    it("should track failed HandBrake conversions", async () => {
      const mockStdout = 'MSG:5014,0,0,0,0,"Saving 1 titles into directory file:///test/output/Movie"\nMSG:5036,0,1,"Copy complete."';
      const mockDisc = { title: "TestMovie" };

      HandBrakeService.convertFile.mockResolvedValue(false);
      FileSystemUtils.readdir.mockResolvedValue(["movie.mkv"]);

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(ripService.badHandBrakeArray).toContain("movie.mkv");
      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining("HandBrake processing failed")
      );
    });

    it("should handle HandBrake errors gracefully", async () => {
      const mockStdout = 'MSG:5014,0,0,0,0,"Saving 1 titles into directory file:///test/output/Movie"\nMSG:5036,0,1,"Copy complete."';
      const mockDisc = { title: "TestMovie" };

      const hbError = new Error("HandBrake crashed");
      hbError.details = "Out of memory";
      HandBrakeService.convertFile.mockRejectedValue(hbError);
      FileSystemUtils.readdir.mockResolvedValue(["movie.mkv"]);

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(Logger.error).toHaveBeenCalledWith(
        "HandBrake post-processing error:",
        "HandBrake crashed"
      );
      expect(Logger.error).toHaveBeenCalledWith(
        "Error details:",
        "Out of memory"
      );
    });

    it("should skip HandBrake when rip failed", async () => {
      ValidationUtils.isCopyComplete.mockReturnValue(false);
      const mockStdout = "No success message";
      const mockDisc = { title: "FailedMovie" };

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      // HandBrake should not be called when rip failed
      expect(HandBrakeService.convertFile).not.toHaveBeenCalled();
      expect(ripService.badVideoArray).toContain("FailedMovie");
    });

    it("should log when HandBrake is disabled", async () => {
      AppConfig.isHandBrakeEnabled = false;
      const mockStdout = "MSG:5036,0,1,\"Copy complete.\"";
      const mockDisc = { title: "Movie" };

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("HandBrake post-processing is disabled")
      );
    });

    it("should handle missing output folder in MakeMKV log", async () => {
      AppConfig.isHandBrakeEnabled = true;
      const mockStdout = "MSG:5036,0,1,\"Copy complete.\""; // No MSG:5014
      const mockDisc = { title: "Movie" };

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse output directory")
      );
    });

    it("should handle non-existent output folder", async () => {
      AppConfig.isHandBrakeEnabled = true;
      const mockStdout = 'MSG:5014,0,0,0,0,"Saving 1 titles into directory file:///nonexistent"\nMSG:5036,0,1,"Copy complete."';
      const mockDisc = { title: "Movie" };

      fs.existsSync.mockReturnValue(false);

      await ripService.handleRipCompletion(mockStdout, mockDisc);

      expect(Logger.error).toHaveBeenCalledWith(
        "HandBrake post-processing error:",
        expect.stringContaining("does not exist")
      );
    });
  });

  describe("displayResults", () => {
    it("should display HandBrake results when enabled", () => {
      AppConfig.isHandBrakeEnabled = true;
      ripService.goodVideoArray = ["Movie1"];
      ripService.goodHandBrakeArray = ["movie1.mkv"];
      ripService.badHandBrakeArray = [];

      ripService.displayResults();

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("successfully converted with HandBrake"),
        "movie1.mkv"
      );
    });

    it("should display failed HandBrake conversions", () => {
      AppConfig.isHandBrakeEnabled = true;
      ripService.goodVideoArray = ["Movie1"];
      ripService.badHandBrakeArray = ["movie1.mkv"];

      ripService.displayResults();

      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("failed HandBrake conversion"),
        "movie1.mkv"
      );
    });

    it("should reset arrays after displaying", () => {
      ripService.goodVideoArray = ["Movie1"];
      ripService.badVideoArray = ["Movie2"];
      ripService.goodHandBrakeArray = ["movie1.mkv"];
      ripService.badHandBrakeArray = ["movie2.mkv"];

      ripService.displayResults();

      expect(ripService.goodVideoArray).toHaveLength(0);
      expect(ripService.badVideoArray).toHaveLength(0);
      expect(ripService.goodHandBrakeArray).toHaveLength(0);
      expect(ripService.badHandBrakeArray).toHaveLength(0);
    });

    it("should not display HandBrake results when disabled", () => {
      AppConfig.isHandBrakeEnabled = false;
      ripService.goodVideoArray = ["Movie1"];
      ripService.goodHandBrakeArray = ["movie1.mkv"];

      ripService.displayResults();

      expect(Logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("HandBrake"),
        expect.anything()
      );
    });
  });

  describe("checkCopyCompletion", () => {
    it("should update good array on successful rip", () => {
      ValidationUtils.isCopyComplete.mockReturnValue(true);
      const mockDisc = { title: "SuccessMovie" };

      ripService.checkCopyCompletion("Success output", mockDisc);

      expect(ripService.goodVideoArray).toContain("SuccessMovie");
      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Done Ripping SuccessMovie")
      );
    });

    it("should update bad array on failed rip", () => {
      ValidationUtils.isCopyComplete.mockReturnValue(false);
      const mockDisc = { title: "FailedMovie" };

      ripService.checkCopyCompletion("Failed output", mockDisc);

      expect(ripService.badVideoArray).toContain("FailedMovie");
      expect(Logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Unable to rip FailedMovie")
      );
    });
  });

  describe("handlePostRipActions", () => {
    it("should eject discs when enabled", async () => {
      AppConfig.isEjectDrivesEnabled = true;

      await ripService.handlePostRipActions();

      expect(DriveService.ejectAllDrives).toHaveBeenCalled();
    });

    it("should not eject discs when disabled", async () => {
      AppConfig.isEjectDrivesEnabled = false;

      await ripService.handlePostRipActions();

      expect(DriveService.ejectAllDrives).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should handle critical errors and exit", async () => {
      DiscService.getAvailableDiscs.mockRejectedValue(
        new Error("Critical disc service error")
      );

      await ripService.startRipping();

      expect(Logger.error).toHaveBeenCalledWith(
        "Critical error during ripping process",
        expect.anything()
      );
      expect(safeExit).toHaveBeenCalledWith(
        1,
        "Critical error during ripping process"
      );
    });
  });
});
