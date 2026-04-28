/**
 * Integration test: verify session_start hook triggers mission auto-setup.
 * Uses @marcfargas/pi-test-harness to load the real extension and fire real hooks.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION = path.resolve(__dirname, "../index.ts");

describe("session_start hook fires mission auto-setup", () => {
  let t: TestSession;
  let tmpHome: string;
  let fetchCalls: { url: string; method: string; body?: any }[];
  let originalFetch: typeof globalThis.fetch;
  let originalHome: string;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    originalHome = process.env.HOME!;

    // Temp HOME so cache + config don't touch real files
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mission-hook-test-"));
    process.env.HOME = tmpHome;

    // Create hindsight config so extension loads
    const hindsightDir = path.join(tmpHome, ".hindsight");
    fs.mkdirSync(hindsightDir, { recursive: true });
    fs.writeFileSync(
      path.join(hindsightDir, "config"),
      [
        'api_url = "http://localhost:19876"',
        'api_key = "test-key"',
        'global_bank = "test-global"',
      ].join("\n"),
    );

    // Mock fetch — intercept all calls to our fake API
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";
      let body: any;
      if (init?.body) {
        try { body = JSON.parse(init.body as string); } catch { body = init.body; }
      }
      fetchCalls.push({ url, method, body });

      // GET /config → return null missions
      if (method === "GET" && url.includes("/config")) {
        return new Response(JSON.stringify({
          config: {
            retain_mission: null,
            observations_mission: null,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // PATCH /config → success
      if (method === "PATCH" && url.includes("/config")) {
        return new Response(JSON.stringify({
          config: {
            retain_mission: body?.updates?.retain_mission || null,
            observations_mission: body?.updates?.observations_mission || null,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Warm-up ping and recall — return ok
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      }
      if (url.includes("/recall")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }

      // Default 404
      return new Response("Not Found", { status: 404 });
    }) as any;
  });

  afterEach(() => {
    t?.dispose();
    globalThis.fetch = originalFetch;
    process.env.HOME = originalHome;
    if (fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("fires runMissionAutoSetup on session creation", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: {
        bash: "ok",
        read: "ok",
        write: "ok",
        edit: "ok",
      },
    });

    // Give async fire-and-forget time to complete
    await new Promise((r) => setTimeout(r, 500));

    // Should have GET + PATCH for the global bank
    const configGets = fetchCalls.filter(
      (c) => c.method === "GET" && c.url.includes("/banks/test-global/config"),
    );
    const configPatches = fetchCalls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/banks/test-global/config"),
    );

    expect(configGets.length).toBeGreaterThanOrEqual(1);
    expect(configPatches.length).toBeGreaterThanOrEqual(1);

    // Verify PATCH sent correct global templates
    const patchBody = configPatches[0].body;
    expect(patchBody.updates.retain_mission).toContain("communication style");
    expect(patchBody.updates.observations_mission).toContain("durable user preferences");
    // Global template should NOT mention "project context"
    expect(patchBody.updates.observations_mission).not.toContain("project context");
  });

  it("writes cache file after successful setup", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    await new Promise((r) => setTimeout(r, 500));

    const cachePath = path.join(tmpHome, ".hindsight", "mission-cache.json");
    expect(fs.existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(cache.global["test-global"]).toBeTypeOf("number");
    expect(cache.global["test-global"]).toBeGreaterThan(0);
  });

  it("skips setup when cache is fresh", async () => {
    // Pre-populate fresh cache
    const hindsightDir = path.join(tmpHome, ".hindsight");
    fs.writeFileSync(
      path.join(hindsightDir, "mission-cache.json"),
      JSON.stringify({
        global: { "test-global": Math.floor(Date.now() / 1000) },
        project: {},
      }),
    );

    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    await new Promise((r) => setTimeout(r, 500));

    // No config GET or PATCH for global bank — cache was fresh
    const globalConfigCalls = fetchCalls.filter(
      (c) => c.url.includes("/banks/test-global/config"),
    );
    expect(globalConfigCalls.length).toBe(0);
  });
});
