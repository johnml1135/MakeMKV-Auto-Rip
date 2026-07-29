/**
 * Unit tests for RipService read-error recovery orchestration:
 * fallback-to-all, resume-aware retention, concurrency lock, free-space gate,
 * and size/mtime-aware new-file detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const recoveryConfig = {
  msys2Dir: "C:/msys64",
  devicePrefix: "/dev/sr",
  devicePath: "",
  workDir: "C:/work",
  keepImage: false,
  retries: 3,
  timeout: "30m",
  maxRuntime: "90m",
  reversePass: true,
  direct: false,
  resume: true,
  imageRetentionDays: 7,
  minFreeGb: 10,
};

const mockAppConfig = {
  AppConfig: {
    isReadErrorRecoveryEnabled: true,
    isHandBrakeEnabled: false,
    isEjectDrivesEnabled: false,
    movieRipsDir: "./media",
    readErrorRecovery: recoveryConfig,
    getMakeMKVExecutable: vi.fn().mockResolvedValue("makemkvcon"),
  },
};
vi.mock("../../src/config/index.js", () => mockAppConfig);

vi.mock("../../src/utils/logger.js", () => ({
  Logger: { info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn(), separator: vi.fn() },
}));

// FileSystemUtils.readdir returns staged listings (one per call).
const readdirResults = [];
vi.mock("../../src/utils/filesystem.js", () => ({
  FileSystemUtils: {
    readdir: vi.fn(() => Promise.resolve(readdirResults.shift() ?? [])),
    createUniqueFolder: vi.fn((p, t) => `${p}/${t}`),
    createUniqueLogFile: vi.fn(),
    writeLogFile: vi.fn(),
  },
}));

vi.mock("../../src/services/disc.service.js", () => ({ DiscService: {} }));
vi.mock("../../src/services/drive.service.js", () => ({ DriveService: {} }));
vi.mock("../../src/services/handbrake.service.js", () => ({
  HandBrakeService: { convertFile: vi.fn() },
}));
vi.mock("../../src/utils/validation.js", () => ({
  ValidationUtils: { isCopyComplete: vi.fn(() => false) },
}));
vi.mock("../../src/utils/process.js", () => ({
  safeExit: vi.fn(),
  withSystemDate: vi.fn(),
  killProcessTree: vi.fn(),
}));
vi.mock("../../src/utils/makemkv-messages.js", () => ({
  MakeMKVMessages: { checkOutput: vi.fn(() => true) },
}));

const recoveryMock = {
  isReadErrorFailure: vi.fn(() => true),
  getFailedTitleIds: vi.fn(() => [0]),
  isAvailable: vi.fn(() => Promise.resolve(true)),
  recoverDiscToImage: vi.fn(() => Promise.resolve({ imagePath: "img" })),
  summarizeMapfile: vi.fn(() => ({
    rescuedBytes: 7_000_000_000,
    badBytes: 400_000,
    totalBytes: 7_000_400_000,
    rescuedPct: 99.99,
    badPct: 0.01,
  })),
  sweepStaleImages: vi.fn(() => []),
};
vi.mock("../../src/services/recovery.service.js", () => ({
  RecoveryService: recoveryMock,
}));

// fs stub. Defaults: paths exist, no lock present, plenty of free space.
const fsState = { lockContent: null, statByName: {} };
const fsMock = {
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn((p) => {
    if (String(p).endsWith(".lock")) fsState.lockContent = null;
  }),
  // Atomic lock primitives: openSync("wx") throws EEXIST when a lock is present.
  openSync: vi.fn((p, flags) => {
    if (String(p).endsWith(".lock") && flags === "wx") {
      if (fsState.lockContent !== null) {
        const e = new Error("EEXIST");
        e.code = "EEXIST";
        throw e;
      }
      fsState.lockContent = "";
    }
    return 99;
  }),
  writeSync: vi.fn((fd, data) => {
    fsState.lockContent = String(data);
  }),
  closeSync: vi.fn(),
  writeFileSync: vi.fn((p, v) => {
    if (String(p).endsWith(".lock")) fsState.lockContent = String(v);
  }),
  readFileSync: vi.fn((p) => {
    if (String(p).endsWith(".lock")) {
      if (fsState.lockContent === null) {
        const e = new Error("ENOENT");
        throw e;
      }
      return fsState.lockContent;
    }
    return "";
  }),
  statSync: vi.fn((p) => {
    const name = String(p).split(/[\\/]/).pop();
    return fsState.statByName[name] ?? { size: 100, mtimeMs: 1000 };
  }),
  statfsSync: vi.fn(() => ({ bavail: 100_000_000, bsize: 4096 })), // ~381 GB free
};
vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

const { RipService } = await import("../../src/services/rip.service.js");

const READ_ERROR_STDOUT = [
  'MSG:5014,131072,2,"Saving 1 titles into directory file://media/Movie","Saving","1","file://media/Movie"',
  'MSG:5003,0,2,"Failed to save title 0 to file media/Movie/Movie_t00.mkv","x","0","Movie_t00.mkv"',
].join("\n");

const item = { title: "Movie", driveNumber: "0" };

describe("RipService read-error recovery orchestration", () => {
  let rip;

  beforeEach(() => {
    vi.clearAllMocks();
    readdirResults.length = 0;
    fsState.lockContent = null;
    fsState.statByName = {};
    Object.assign(recoveryConfig, {
      workDir: "C:/work",
      keepImage: false,
      resume: true,
      imageRetentionDays: 7,
      minFreeGb: 10,
    });
    recoveryMock.isReadErrorFailure.mockReturnValue(true);
    recoveryMock.getFailedTitleIds.mockReturnValue([0]);
    recoveryMock.isAvailable.mockResolvedValue(true);
    recoveryMock.recoverDiscToImage.mockResolvedValue({ imagePath: "img" });
    recoveryMock.sweepStaleImages.mockReturnValue([]);
    mockAppConfig.AppConfig.isReadErrorRecoveryEnabled = true;
    mockAppConfig.AppConfig.isHandBrakeEnabled = false;
    rip = new RipService({ exitOnCriticalError: false });
    rip.prepareForRun();
    vi.spyOn(rip, "ripTitleFromImage").mockResolvedValue("ok");
  });

  afterEach(() => vi.restoreAllMocks());

  it("falls back to ripping all titles when per-title re-rip yields nothing", async () => {
    readdirResults.push([], [], ["Movie_t00.mkv"]); // snapshot, post-pertitle, post-fallback
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    const selectors = rip.ripTitleFromImage.mock.calls.map((c) => c[1]);
    expect(selectors).toEqual(["0", "all"]);
  });

  it("does not fall back when the per-title re-rip already produced a file", async () => {
    readdirResults.push([], ["Movie_t00.mkv"]);
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    const selectors = rip.ripTitleFromImage.mock.calls.map((c) => c[1]);
    expect(selectors).toEqual(["0"]);
  });

  it("keeps the image (does not unlink it) when imaging fails", async () => {
    recoveryMock.recoverDiscToImage.mockRejectedValue(new Error("read fail"));
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    expect(rip.ripTitleFromImage).not.toHaveBeenCalled();
    const unlinked = fsMock.unlinkSync.mock.calls.map((c) => String(c[0]));
    expect(unlinked.some((p) => p.endsWith(".recovery.iso"))).toBe(false);
  });

  it("skips entirely when another recovery holds the lock for this image", async () => {
    fsState.lockContent = String(process.pid); // a live PID owns the lock
    readdirResults.push([], []);
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    expect(recoveryMock.recoverDiscToImage).not.toHaveBeenCalled();
  });

  it("reclaims a stale lock whose owner process is dead", async () => {
    fsState.lockContent = "999999999"; // almost certainly not a live PID
    readdirResults.push([], ["Movie_t00.mkv"]);
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    expect(recoveryMock.recoverDiscToImage).toHaveBeenCalledOnce();
  });

  it("skips recovery when free space is below the configured minimum", async () => {
    fsMock.statfsSync.mockReturnValueOnce({ bavail: 1, bsize: 4096 }); // ~4 KB free
    readdirResults.push([], []);
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    expect(recoveryMock.recoverDiscToImage).not.toHaveBeenCalled();
  });

  it("sweeps stale images before starting", async () => {
    readdirResults.push([], ["Movie_t00.mkv"]);
    await rip.attemptReadErrorRecovery(READ_ERROR_STDOUT, item);
    expect(recoveryMock.sweepStaleImages).toHaveBeenCalledWith("C:/work", 7);
  });

  describe("collectRecoveredMkvs", () => {
    it("treats a same-named MKV whose size/mtime changed as recovered", async () => {
      fsState.statByName["Movie_t00.mkv"] = { size: 100, mtimeMs: 1000 };
      readdirResults.push(["Movie_t00.mkv"]); // snapshot
      const before = await rip.snapshotMkvs("dir");
      // The failed partial is overwritten by a larger, newer recovered file.
      fsState.statByName["Movie_t00.mkv"] = { size: 999, mtimeMs: 5000 };
      readdirResults.push(["Movie_t00.mkv"]);
      const recovered = await rip.collectRecoveredMkvs("dir", before);
      expect(recovered).toEqual(["Movie_t00.mkv"]);
    });

    it("ignores an unchanged file", async () => {
      fsState.statByName["keep.mkv"] = { size: 100, mtimeMs: 1000 };
      readdirResults.push(["keep.mkv"]);
      const before = await rip.snapshotMkvs("dir");
      readdirResults.push(["keep.mkv"]);
      const recovered = await rip.collectRecoveredMkvs("dir", before);
      expect(recovered).toEqual([]);
    });
  });

  describe("cleanupRecoveryArtifacts", () => {
    it("deletes image+map on a clean success", () => {
      rip.cleanupRecoveryArtifacts("a.iso", "a.iso.map", {
        keepImage: false,
        producedFiles: true,
        hasBadSectors: false,
      });
      const unlinked = fsMock.unlinkSync.mock.calls.map((c) => String(c[0]));
      expect(unlinked).toContain("a.iso");
      expect(unlinked).toContain("a.iso.map");
    });

    it("keeps image+map when nothing was produced but bad sectors remain", () => {
      rip.cleanupRecoveryArtifacts("a.iso", "a.iso.map", {
        keepImage: false,
        producedFiles: false,
        hasBadSectors: true,
      });
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it("keeps image when keep_image is set", () => {
      rip.cleanupRecoveryArtifacts("a.iso", "a.iso.map", {
        keepImage: true,
        producedFiles: true,
        hasBadSectors: false,
      });
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
