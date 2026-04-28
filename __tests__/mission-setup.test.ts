/**
 * Unit tests for mission auto-setup logic.
 *
 * Strategy:
 * - Set process.env.HOME to a temp dir per test → os.homedir() returns it
 * - vi.stubGlobal("fetch", mockFn) intercepts all HTTP calls
 * - Test exported functions directly: no test harness, no subprocess
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must be imported AFTER we set HOME so homedir() picks up the right path.
// Vitest re-evaluates modules fresh per file, so top-level homedir() calls
// in index.ts happen after our env is ready.
import {
  loadMissionCache,
  saveMissionCache,
  isCacheStale,
  setupBankMission,
  runMissionAutoSetup,
  GLOBAL_TTL_SECONDS,
  PROJECT_TTL_SECONDS,
  GLOBAL_RETAIN_MISSION,
  GLOBAL_OBSERVATIONS_MISSION,
  PROJECT_RETAIN_MISSION,
  PROJECT_OBSERVATIONS_MISSION,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  api_url: "http://localhost:9999",
  api_key: "test-key",
  global_bank: "sil",
  project_bank_id: "project-test",
};

let tempDir = "";
let originalHome: string | undefined;

function setupTempHome() {
  tempDir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
  mkdirSync(join(tempDir, ".hindsight"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tempDir;
}

function teardownTempHome() {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(tempDir, { recursive: true, force: true });
}

function cachePath() {
  return join(tempDir, ".hindsight", "mission-cache.json");
}

/**
 * Builds a fetch mock that handles:
 *   GET  /banks/{bank}/config  → { config: bankCfg }
 *   PATCH /banks/{bank}/config → ok/fail based on patchOk
 *   GET  /health               → ok
 */
function makeFetchMock(
  bankCfg: object = { retain_mission: null, observations_mission: null },
  patchOk = true,
) {
  return vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    if ((url as string).endsWith("/health")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: bankCfg }),
      };
    }
    if (method === "PATCH") {
      return {
        ok: patchOk,
        status: patchOk ? 200 : 500,
        json: async () => ({}),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

// ---------------------------------------------------------------------------
// loadMissionCache
// ---------------------------------------------------------------------------

describe("loadMissionCache", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns empty cache when file does not exist", () => {
    expect(loadMissionCache()).toEqual({ global: {}, project: {} });
  });

  it("returns parsed cache from existing file", () => {
    const data = {
      global: { sil: 1700000000 },
      project: { "project-test": 1700000001 },
    };
    writeFileSync(cachePath(), JSON.stringify(data));
    expect(loadMissionCache()).toEqual(data);
  });

  it("returns empty cache on malformed JSON", () => {
    writeFileSync(cachePath(), "{ invalid json");
    expect(loadMissionCache()).toEqual({ global: {}, project: {} });
  });
});

// ---------------------------------------------------------------------------
// saveMissionCache
// ---------------------------------------------------------------------------

describe("saveMissionCache", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("creates .hindsight dir if missing and writes cache", () => {
    rmSync(join(tempDir, ".hindsight"), { recursive: true, force: true });
    const cache = { global: { sil: 1700000000 }, project: {} };
    saveMissionCache(cache);
    expect(existsSync(cachePath())).toBe(true);
    expect(JSON.parse(readFileSync(cachePath(), "utf-8"))).toEqual(cache);
  });

  it("overwrites existing cache file", () => {
    writeFileSync(cachePath(), JSON.stringify({ global: {}, project: {} }));
    const updated = { global: { sil: 9999 }, project: { "project-x": 8888 } };
    saveMissionCache(updated);
    expect(JSON.parse(readFileSync(cachePath(), "utf-8"))).toEqual(updated);
  });

  it("round-trips through loadMissionCache", () => {
    const cache = { global: { sil: 42 }, project: { "project-a": 99 } };
    saveMissionCache(cache);
    expect(loadMissionCache()).toEqual(cache);
  });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe("isCacheStale", () => {
  it("TTL constants: global=7d, project=24h", () => {
    expect(GLOBAL_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(PROJECT_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("returns true for zero timestamp", () => {
    expect(isCacheStale(0, true)).toBe(true);
    expect(isCacheStale(0, false)).toBe(true);
  });

  it("returns false for fresh global entry (within 7 days)", () => {
    const recent = Math.floor(Date.now() / 1000) - (GLOBAL_TTL_SECONDS - 3600);
    expect(isCacheStale(recent, true)).toBe(false);
  });

  it("returns true for stale global entry (older than 7 days)", () => {
    const stale = Math.floor(Date.now() / 1000) - (GLOBAL_TTL_SECONDS + 3600);
    expect(isCacheStale(stale, true)).toBe(true);
  });

  it("returns false for fresh project entry (within 24h)", () => {
    const recent = Math.floor(Date.now() / 1000) - (PROJECT_TTL_SECONDS - 600);
    expect(isCacheStale(recent, false)).toBe(false);
  });

  it("returns true for stale project entry (older than 24h)", () => {
    const stale = Math.floor(Date.now() / 1000) - (PROJECT_TTL_SECONDS + 600);
    expect(isCacheStale(stale, false)).toBe(true);
  });

  it("project TTL does not accept global TTL as fresh", () => {
    // 4 days ago: fresh for global (7d), stale for project (24h)
    const fourDaysAgo = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
    expect(isCacheStale(fourDaysAgo, false)).toBe(true);
    expect(isCacheStale(fourDaysAgo, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setupBankMission — skip logic
// ---------------------------------------------------------------------------

describe("setupBankMission — skips correctly", () => {
  beforeEach(setupTempHome);
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("no PATCH when both missions already set", async () => {
    const fetchMock = makeFetchMock({ retain_mission: "x", observations_mission: "y" });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "sil", true);
    // Only 1 call: GET config. No PATCH.
    const methods = fetchMock.mock.calls.map((c) => (c[1] as RequestInit)?.method ?? "GET");
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(0);
  });

  it("no PATCH when GET returns error status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await setupBankMission(BASE_CONFIG, "sil", true);
    // Only the GET was attempted (which failed), no PATCH
    // No throw expected
  });

  it("does not throw on GET network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(setupBankMission(BASE_CONFIG, "sil", true)).resolves.toBeUndefined();
  });

  it("does not throw on PATCH network error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ config: { retain_mission: null, observations_mission: null } }),
      })
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(setupBankMission(BASE_CONFIG, "sil", true)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setupBankMission — patch body and templates
// ---------------------------------------------------------------------------

describe("setupBankMission — patches with correct templates", () => {
  beforeEach(setupTempHome);
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("sets global templates for global bank (isGlobal=true)", async () => {
    const fetchMock = makeFetchMock({ retain_mission: null, observations_mission: null });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "sil", true);
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.updates.retain_mission).toBe(GLOBAL_RETAIN_MISSION);
    expect(body.updates.observations_mission).toBe(GLOBAL_OBSERVATIONS_MISSION);
  });

  it("sets project templates for project bank (isGlobal=false)", async () => {
    const fetchMock = makeFetchMock({ retain_mission: null, observations_mission: null });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "project-test", false);
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    );
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.updates.retain_mission).toBe(PROJECT_RETAIN_MISSION);
    expect(body.updates.observations_mission).toBe(PROJECT_OBSERVATIONS_MISSION);
    // Ensure global templates are NOT used for project bank
    expect(body.updates.retain_mission).not.toBe(GLOBAL_RETAIN_MISSION);
    expect(body.updates.observations_mission).not.toBe(GLOBAL_OBSERVATIONS_MISSION);
  });

  it("only patches observations_mission when retain_mission already set", async () => {
    const fetchMock = makeFetchMock({ retain_mission: "existing", observations_mission: null });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "sil", true);
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.updates.retain_mission).toBeUndefined();
    expect(body.updates.observations_mission).toBe(GLOBAL_OBSERVATIONS_MISSION);
  });

  it("only patches retain_mission when observations_mission already set", async () => {
    const fetchMock = makeFetchMock({ retain_mission: null, observations_mission: "existing" });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "sil", true);
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.updates.retain_mission).toBe(GLOBAL_RETAIN_MISSION);
    expect(body.updates.observations_mission).toBeUndefined();
  });

  it("PATCH goes to correct URL: /v1/default/banks/{bank}/config", async () => {
    const fetchMock = makeFetchMock({ retain_mission: null, observations_mission: null });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "sil", true);
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCall![0]).toBe("http://localhost:9999/v1/default/banks/sil/config");
  });

  it("PATCH uses Content-Type: application/json with updates wrapper", async () => {
    const fetchMock = makeFetchMock({ retain_mission: null, observations_mission: null });
    vi.stubGlobal("fetch", fetchMock);
    await setupBankMission(BASE_CONFIG, "sil", true);
    const patchOpts = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    )![1] as RequestInit;
    const headers = patchOpts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(patchOpts.body as string);
    expect(body).toHaveProperty("updates");
    expect(typeof body.updates).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// setupBankMission — cache writes
// ---------------------------------------------------------------------------

describe("setupBankMission — cache behaviour", () => {
  beforeEach(setupTempHome);
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("writes cache for global bank after successful PATCH", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ retain_mission: null, observations_mission: null }, true));
    const before = Math.floor(Date.now() / 1000);
    await setupBankMission(BASE_CONFIG, "sil", true);
    const after = Math.floor(Date.now() / 1000);
    const cache = loadMissionCache();
    expect(cache.global["sil"]).toBeGreaterThanOrEqual(before);
    expect(cache.global["sil"]).toBeLessThanOrEqual(after);
    expect(cache.project["sil"]).toBeUndefined();
  });

  it("writes cache for project bank after successful PATCH", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ retain_mission: null, observations_mission: null }, true));
    await setupBankMission(BASE_CONFIG, "project-test", false);
    const cache = loadMissionCache();
    expect(cache.project["project-test"]).toBeGreaterThan(0);
    expect(cache.global["project-test"]).toBeUndefined();
  });

  it("does NOT write cache when PATCH fails (non-ok status)", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ retain_mission: null, observations_mission: null }, false));
    await setupBankMission(BASE_CONFIG, "sil", true);
    expect(loadMissionCache()).toEqual({ global: {}, project: {} });
  });

  it("does NOT write cache when both missions were already set (no PATCH)", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ retain_mission: "x", observations_mission: "y" }));
    await setupBankMission(BASE_CONFIG, "sil", true);
    expect(loadMissionCache()).toEqual({ global: {}, project: {} });
  });
});

// ---------------------------------------------------------------------------
// runMissionAutoSetup
// ---------------------------------------------------------------------------

describe("runMissionAutoSetup", () => {
  beforeEach(setupTempHome);
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("checks global bank when global_bank is configured", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    await runMissionAutoSetup(BASE_CONFIG);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/sil/config"))).toBe(true);
  });

  it("checks project bank via project_bank_id", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    await runMissionAutoSetup(BASE_CONFIG);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/project-test/config"))).toBe(true);
  });

  it("does NOT check global bank when global_bank not set", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { api_url: "http://localhost:9999", api_key: "key", project_bank_id: "project-test" };
    await runMissionAutoSetup(cfg);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => !u.includes("/sil/config"))).toBe(true);
  });

  it("skips global bank when its cache entry is fresh", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    saveMissionCache({ global: { sil: Math.floor(Date.now() / 1000) }, project: {} });
    await runMissionAutoSetup(BASE_CONFIG);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    // Global skipped; project still checked
    expect(urls.filter((u) => u.includes("/sil/config"))).toHaveLength(0);
    expect(urls.some((u) => u.includes("/project-test/config"))).toBe(true);
  });

  it("skips project bank when its cache entry is fresh", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    saveMissionCache({ global: {}, project: { "project-test": Math.floor(Date.now() / 1000) } });
    await runMissionAutoSetup(BASE_CONFIG);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.includes("/project-test/config"))).toHaveLength(0);
    expect(urls.some((u) => u.includes("/sil/config"))).toBe(true);
  });

  it("skips ALL banks when both cache entries are fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const now = Math.floor(Date.now() / 1000);
    saveMissionCache({ global: { sil: now }, project: { "project-test": now } });
    await runMissionAutoSetup(BASE_CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks stale global entry (> 7 days old)", async () => {
    const fetchMock = makeFetchMock({ retain_mission: "set", observations_mission: "set" });
    vi.stubGlobal("fetch", fetchMock);
    const stale = Math.floor(Date.now() / 1000) - (GLOBAL_TTL_SECONDS + 7200);
    saveMissionCache({ global: { sil: stale }, project: {} });
    await runMissionAutoSetup(BASE_CONFIG);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/sil/config"))).toBe(true);
  });

  it("re-checks stale project entry (> 24h old)", async () => {
    const fetchMock = makeFetchMock({ retain_mission: "set", observations_mission: "set" });
    vi.stubGlobal("fetch", fetchMock);
    const stale = Math.floor(Date.now() / 1000) - (PROJECT_TTL_SECONDS + 3600);
    saveMissionCache({ global: {}, project: { "project-test": stale } });
    await runMissionAutoSetup(BASE_CONFIG);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/project-test/config"))).toBe(true);
  });

  it("does not throw when fetch rejects (silent failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(runMissionAutoSetup(BASE_CONFIG)).resolves.toBeUndefined();
  });

  it("cache written after successful setup prevents re-check", async () => {
    // First run: missions null → PATCH → cache written
    vi.stubGlobal("fetch", makeFetchMock({ retain_mission: null, observations_mission: null }, true));
    await runMissionAutoSetup(BASE_CONFIG);

    // Second run: fresh cache → no fetch calls
    const fetchMock2 = vi.fn();
    vi.stubGlobal("fetch", fetchMock2);
    await runMissionAutoSetup(BASE_CONFIG);
    const configCalls = fetchMock2.mock.calls.filter((c) =>
      (c[0] as string).includes("/project-test/config"),
    );
    expect(configCalls).toHaveLength(0);
  });
});
