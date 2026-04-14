import { EventEmitter } from "events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const detectAvailableDiscsMock = vi.fn();
const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
};
const broadcastStatusUpdateMock = vi.fn();
const broadcastLogMessageMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

vi.mock("../../src/config/index.js", () => ({
  AppConfig: {
    mountPollInterval: 1,
  },
}));

vi.mock("../../src/services/disc.service.js", () => ({
  DiscService: {
    detectAvailableDiscs: (...args) => detectAvailableDiscsMock(...args),
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  Logger: logger,
}));

vi.mock("../../src/web/middleware/websocket.middleware.js", () => ({
  broadcastStatusUpdate: (...args) => broadcastStatusUpdateMock(...args),
  broadcastLogMessage: (...args) => broadcastLogMessageMock(...args),
}));

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }

  return layer.route.stack[0].handle;
}

function createMockChildProcess() {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  childProcess.killed = false;
  childProcess.kill = vi.fn((signal) => {
    childProcess.killed = true;
    childProcess.emit("close", signal === "SIGKILL" ? 137 : 0);
  });
  return childProcess;
}

describe("api routes rip mode", () => {
  let startRipHandler;
  let stopHandler;
  let statusHandler;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();

    const { apiRoutes } = await import("../../src/web/routes/api.routes.js");

    startRipHandler = getRouteHandler(apiRoutes, "post", "/rip/start");
    stopHandler = getRouteHandler(apiRoutes, "post", "/stop");
    statusHandler = getRouteHandler(apiRoutes, "get", "/status");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays in rip mode after a rip cycle completes", async () => {
    const childProcess = createMockChildProcess();
    spawnMock.mockReturnValue(childProcess);
    detectAvailableDiscsMock
      .mockResolvedValueOnce([{ title: "Movie", driveNumber: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const startRes = createResponse();
    await startRipHandler({}, startRes);

    expect(startRes.statusCode).toBe(200);
    expect(startRes.payload).toEqual({
      success: true,
      message: "Rip mode enabled",
    });

    await vi.runAllTicks();
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledTimes(1);

    childProcess.emit("close", 0);
    await Promise.resolve();
    await Promise.resolve();

    const statusRes = createResponse();
    await statusHandler({}, statusRes);

    expect(statusRes.payload.status).toBe("ripping");
    expect(statusRes.payload.canStop).toBe(true);
    expect(statusRes.payload.operation).toMatch(
      /Waiting for (current disc to be removed|disc insertion)\.\.\./
    );
    expect(broadcastLogMessageMock).toHaveBeenCalledWith(
      "success",
      "Rip cycle completed successfully. Waiting for the next disc..."
    );
  });

  it("can stop rip mode while waiting for a new disc", async () => {
    detectAvailableDiscsMock.mockResolvedValue([]);

    const startRes = createResponse();
    await startRipHandler({}, startRes);

    await vi.runAllTicks();
    await Promise.resolve();

    const waitingStatusRes = createResponse();
    await statusHandler({}, waitingStatusRes);

    expect(waitingStatusRes.payload.status).toBe("ripping");
    expect(waitingStatusRes.payload.canStop).toBe(true);
    expect(waitingStatusRes.payload.operation).toBe("Waiting for disc insertion...");

    const stopRes = createResponse();
    await stopHandler({}, stopRes);

    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.payload).toEqual({ success: true, message: "Operation stopped" });

    const stoppedStatusRes = createResponse();
    await statusHandler({}, stoppedStatusRes);

    expect(stoppedStatusRes.payload.status).toBe("idle");
    expect(stoppedStatusRes.payload.canStop).toBe(false);
    expect(stoppedStatusRes.payload.operation).toBeNull();
  });
});