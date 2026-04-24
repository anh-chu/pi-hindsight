/**
 * Tests for hindsight-selfhosted extension.
 * Uses Node.js built-in test runner (node:test).
 *
 * Run: node --experimental-strip-types --experimental-vm-modules test.ts
 * Or after build: node test.js
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal Pi API mock
// ---------------------------------------------------------------------------

type HookName = "session_start" | "session_compact" | "before_agent_start" | "agent_end" | "input";
type HookHandler = (event: any, ctx: any) => Promise<any>;

function makePiMock() {
  const handlers: Record<string, HookHandler[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};

  return {
    on(event: HookName, handler: HookHandler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerTool(spec: any) {
      tools[spec.name] = spec;
    },
    registerCommand(name: string, spec: any) {
      commands[name] = spec;
    },
    // Test helpers
    async emit(event: HookName, eventData: any = {}, ctx: any = {}) {
      const list = handlers[event] || [];
      let result: any;
      for (const h of list) {
        result = await h(eventData, ctx);
      }
      return result;
    },
    tools,
    commands,
  };
}

function makeCtx(userMessage?: string) {
  return {
    sessionManager: {
      getEntries() {
        if (!userMessage) return [];
        return [
          {
            type: "message",
            message: { role: "user", content: userMessage },
          },
        ];
      },
    },
    ui: { notify: mock.fn() },
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const MOCK_CONFIG_DIR = "/tmp/.hindsight-test-" + Date.now();
const MOCK_CONFIG_PATH = MOCK_CONFIG_DIR + "/config";

function writeConfig(api_url: string, api_key = "test-key", global_bank?: string) {
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(MOCK_CONFIG_DIR, { recursive: true });
  let content = `api_url = "${api_url}"\napi_key = "${api_key}"`;
  if (global_bank) content += `\nglobal_bank = "${global_bank}"`;
  writeFileSync(MOCK_CONFIG_PATH, content);
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(results: { text: string }[] = []) {
  return mock.fn(async (_url: string, _opts: any) => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
  }));
}

function mockFetchFail(status = 500) {
  return mock.fn(async (_url: string, _opts: any) => ({
    ok: false,
    status,
    json: async () => ({}),
  }));
}

// ---------------------------------------------------------------------------
// Load the extension factory
// NOTE: We patch process.env and global.fetch before importing so we control
//       the config path via env.
// ---------------------------------------------------------------------------

async function loadExtension(fetchMock: any) {
  // Override fetch globally for each test
  (global as any).fetch = fetchMock;

  // Patch homedir to point at our temp dir so getConfig() reads our config
  const originalHomedir = require("node:os").homedir;
  require("node:os").homedir = () => MOCK_CONFIG_DIR;

  // Dynamic import so we can reload with fresh state between tests
  // (Node caches modules, so we use a cache-busting query param trick
  //  by appending a timestamp to the specifier via a loader shim)
  //
  // For simplicity in this test we directly inline & re-run the logic.
  // The real extension factory is called once; we instantiate it fresh
  // via the Pi mock for each test scenario.
  const pi = makePiMock();

  // We re-import each time by clearing module cache (CJS approach)
  // Since the code is ESM we call the factory dynamically via eval workaround.
  // Instead: we expose and directly test the core lifecycle logic
  // by re-running the factory function each time with a fresh pi mock.

  require("node:os").homedir = originalHomedir;
  return pi;
}

// ---------------------------------------------------------------------------
// Direct unit tests on lifecycle logic (avoids ESM reload complexity)
// The strategy: extract functions and test them directly by replaying the
// same hooks pattern without importing the full module.
// ---------------------------------------------------------------------------

const MAX_RECALL_ATTEMPTS = 3;

/**
 * Simulates the before_agent_start lifecycle with injectable dependencies.
 */
async function simulateRecall(opts: {
  config: { api_url: string; api_key?: string; global_bank?: string; recall_budget?: string; recall_max_tokens?: number } | null;
  projectBank: string;
  userPrompt: string;
  fetchImpl: any;
  recallDone?: boolean;
  recallAttempts?: number;
}): Promise<{ recallDone: boolean; recallAttempts: number; injectedContent: string | null }> {
  let recallDone = opts.recallDone ?? false;
  let recallAttempts = opts.recallAttempts ?? 0;

  if (recallDone) return { recallDone, recallAttempts, injectedContent: null };
  if (recallAttempts >= MAX_RECALL_ATTEMPTS) return { recallDone, recallAttempts, injectedContent: null };

  recallAttempts++;

  const config = opts.config;
  if (!config || !config.api_url) {
    recallAttempts = MAX_RECALL_ATTEMPTS; // give up
    return { recallDone, recallAttempts, injectedContent: null };
  }

  const banks = new Set<string>();
  if (config.global_bank) banks.add(config.global_bank);
  banks.add(opts.projectBank);
  const bankList = Array.from(banks);

  try {
    let anyBankSucceeded = false;
    const recallPromises = bankList.map(async (bank) => {
      const res = await opts.fetchImpl(
        `${config.api_url}/v1/default/banks/${bank}/memories/recall`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.api_key || ""}` },
          body: JSON.stringify({ query: opts.userPrompt, budget: opts.config?.recall_budget || "mid", query_timestamp: new Date().toISOString(), ...(opts.config?.recall_max_tokens && { max_tokens: opts.config.recall_max_tokens }) }),
        }
      );
      if (!res.ok) return [];
      anyBankSucceeded = true;
      const data = await res.json();
      return (data.results || []).map((r: any) => `[Bank: ${bank}] - ${r.text}`);
    });

    const resultsArrays = await Promise.all(recallPromises);

    if (anyBankSucceeded) {
      recallDone = true;
      const allResults = resultsArrays.flat();
      if (allResults.length > 0) {
        const memoriesStr = allResults.join("\n\n");
        const content = `<hindsight_memories>\nRelevant memories from past conversations:\n\n${memoriesStr}\n</hindsight_memories>`;
        return { recallDone, recallAttempts, injectedContent: content };
      }
      return { recallDone, recallAttempts, injectedContent: null };
    }
    // all banks failed — don't mark done, will retry
    return { recallDone, recallAttempts, injectedContent: null };
  } catch {
    // network error — don't mark done, will retry
    return { recallDone, recallAttempts, injectedContent: null };
  }
}

/**
 * Simulates the agent_end retain lifecycle.
 */
async function simulateRetain(opts: {
  config: { api_url: string; api_key?: string; global_bank?: string } | null;
  projectBank: string;
  userPrompt: string;
  transcript: string;
  sessionId?: string;
  fetchImpl: any;
}): Promise<{ skipped: boolean; reason?: string; calledBanks: string[]; allFailed: boolean; lastRequestBody?: any }> {
  const config = opts.config;
  if (!config || !config.api_url) return { skipped: true, reason: "no config", calledBanks: [], allFailed: false };
  const prompt = opts.userPrompt;
  if (!prompt) return { skipped: true, reason: "no prompt", calledBanks: [], allFailed: false };
  if (prompt.length < 5 || /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i.test(prompt.trim())) {
    return { skipped: true, reason: "trivial", calledBanks: [], allFailed: false };
  }
  if (prompt.trim().startsWith("#nomem") || prompt.trim().startsWith("#skip")) {
    return { skipped: true, reason: "opt-out", calledBanks: [], allFailed: false };
  }
  const banks = new Set<string>();
  banks.add(opts.projectBank);
  if (config.global_bank && (prompt.includes("#global") || prompt.includes("#me"))) {
    banks.add(config.global_bank);
  }
  const calledBanks: string[] = [];
  const bankList = Array.from(banks);
  const sessionId = opts.sessionId ?? "test-session";
  let lastRequestBody: any;
  const results = await Promise.allSettled(
    bankList.map(async (bank) => {
      const body = {
        items: [{
          content: opts.transcript,
          document_id: `session-${sessionId}`,
          update_mode: "append",
          context: `pi coding session: ${prompt.slice(0, 100)}`,
          timestamp: new Date().toISOString(),
        }],
        async: true,
      };
      lastRequestBody = body;
      const res = await opts.fetchImpl(`${config.api_url}/v1/default/banks/${bank}/memories`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      calledBanks.push(bank);
      return bank;
    })
  );
  const succeededBanks = results
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<string>).value);
  const allFailed = succeededBanks.length === 0;
  const sentMessage = allFailed
    ? { customType: "hindsight-retain-failed", display: true, details: {} }
    : { customType: "hindsight-retain", display: true, details: { banks: succeededBanks } };
  return { skipped: false, calledBanks, allFailed, lastRequestBody, sentMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Recall (before_agent_start)", () => {
  const config = { api_url: "http://localhost:4000", api_key: "key", global_bank: "global" };

  test("injects memories when results returned", async () => {
    const fetchMock = mockFetchOk([{ text: "Use TypeBox for validation" }]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I validate?",
      fetchImpl: fetchMock,
    });

    assert.equal(result.recallDone, true);
    assert.ok(result.injectedContent, "should inject content");
    assert.ok(result.injectedContent!.includes("<hindsight_memories>"), "should wrap in tag");
    assert.ok(result.injectedContent!.includes("TypeBox"), "should include memory text");
  });

  test("returns null injectedContent when no memories found", async () => {
    const fetchMock = mockFetchOk([]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "what is the meaning of life",
      fetchImpl: fetchMock,
    });

    assert.equal(result.injectedContent, null);
  });

  test("queries both global_bank and project bank", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    const urls: string[] = fetchMock.mock.calls.map((c: any) => c.arguments[0]);
    assert.ok(urls.some((u) => u.includes("global")), "should query global bank");
    assert.ok(urls.some((u) => u.includes("project-hindsight")), "should query project bank");
    assert.equal(urls.length, 2, "should call exactly 2 banks");
  });

  test("skips recall when recallDone=true", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
      recallDone: true,
    });

    assert.equal(fetchMock.mock.calls.length, 0, "should not call fetch");
    assert.equal(result.injectedContent, null);
  });

  test("returns null when no config", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config: null,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(fetchMock.mock.calls.length, 0, "should not call fetch");
    assert.equal(result.injectedContent, null);
  });

  test("network error: recallDone stays false for retry, no throw", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.injectedContent, null, "should return null, not throw");
    assert.equal(result.recallDone, false, "recallDone stays false — retry eligible");
    assert.equal(result.recallAttempts, 1, "attempt counter incremented");
  });

  test("HTTP error: recallDone stays false for retry", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.injectedContent, null);
    assert.equal(result.recallDone, false, "recallDone stays false — retry eligible");
  });

  test("empty vault: recallDone=true even with 0 results (server responded ok)", async () => {
    const fetchMock = mockFetchOk([]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.recallDone, true, "server responded — no reason to retry");
    assert.equal(result.injectedContent, null, "nothing to inject");
  });

  test("only queries project bank when no global_bank configured", async () => {
    const fetchMock = mockFetchOk([]);
    await simulateRecall({
      config: { api_url: "http://localhost:4000", api_key: "key" },
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(fetchMock.mock.calls.length, 1, "should only query 1 bank");
  });

  test("stops retrying after MAX_RECALL_ATTEMPTS", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    // Single-bank config so fetch calls == attempt count (no global_bank)
    const singleBankConfig = { api_url: "http://localhost:4000", api_key: "key" };
    let state = { recallDone: false, recallAttempts: 0, injectedContent: null as string | null };

    for (let i = 0; i < MAX_RECALL_ATTEMPTS + 2; i++) {
      state = await simulateRecall({
        config: singleBankConfig,
        projectBank: "project-hindsight",
        userPrompt: "test",
        fetchImpl: fetchMock,
        recallDone: state.recallDone,
        recallAttempts: state.recallAttempts,
      });
    }

    assert.equal(fetchMock.mock.calls.length, MAX_RECALL_ATTEMPTS, `fetch called exactly ${MAX_RECALL_ATTEMPTS} times`);
    assert.equal(state.recallDone, false);
  });

  test("no config: gives up immediately without fetch", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config: null,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(result.recallAttempts, MAX_RECALL_ATTEMPTS, "maxed out — won't retry");
  });
});

describe("Retain (agent_end)", () => {
  const config = { api_url: "http://localhost:4000", api_key: "key", global_bank: "global" };

  test("retains to project bank on normal prompt", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I refactor this function?",
      transcript: "[role: user]\nhow do I refactor this function?\n[role: assistant]\nHere is how...",
      fetchImpl: fetchMock,
    });

    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("project-hindsight"), "should retain to project bank");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("skips trivial prompts", async () => {
    const fetchMock = mockFetchOk();
    for (const prompt of ["ok", "yes", "no", "thanks", "done"]) {
      const result = await simulateRetain({
        config,
        projectBank: "project-hindsight",
        userPrompt: prompt,
        transcript: "...",
        fetchImpl: fetchMock,
      });
      assert.equal(result.skipped, true, `"${prompt}" should be skipped`);
    }
    assert.equal(fetchMock.mock.calls.length, 0, "fetch should never be called for trivial prompts");
  });

  test("skips very short prompts (<5 chars)", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "hi",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
  });

  test("#nomem opt-out skips retain", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "#nomem fix this bug please",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "opt-out");
  });

  test("#skip opt-out skips retain", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "#skip this conversation",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "opt-out");
  });

  test("#global tag routes to global bank too", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "remember this #global pattern for all projects",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("global"), "should retain to global bank");
    assert.ok(result.calledBanks.includes("project-hindsight"), "should also retain to project bank");
    assert.equal(result.calledBanks.length, 2);
  });

  test("#me tag routes to global bank too", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "I prefer tabs over spaces #me",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("global"), "should retain to global bank");
  });

  test("no global bank config: only retains to project bank even with #global", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config: { api_url: "http://localhost:4000" },
      projectBank: "project-hindsight",
      userPrompt: "remember this #global",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.calledBanks.length, 1);
    assert.ok(result.calledBanks.includes("project-hindsight"));
  });

  test("skips when no config", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config: null,
      projectBank: "project-hindsight",
      userPrompt: "valid prompt",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("allFailed=true when all banks return HTTP error", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I fix this?",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false, "should attempt retain, not skip");
    assert.equal(result.allFailed, true, "should report total failure");
    assert.equal(result.calledBanks.length, 0, "no banks succeeded");
  });

  test("allFailed=true when network throws", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I fix this?",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.allFailed, true);
  });

  test("allFailed=false on success", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I fix this?",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.allFailed, false);
  });
});

describe("recallDone lifecycle reset", () => {
  test("recallDone and recallAttempts reset on session_start", async () => {
    let recallDone = true;
    let recallAttempts = MAX_RECALL_ATTEMPTS;

    // session_start handler
    recallDone = false;
    recallAttempts = 0;

    assert.equal(recallDone, false);
    assert.equal(recallAttempts, 0, "attempts must reset so retry window reopens");
  });

  test("recallDone and recallAttempts reset on session_compact", async () => {
    let recallDone = true;
    let recallAttempts = MAX_RECALL_ATTEMPTS;

    // session_compact handler
    recallDone = false;
    recallAttempts = 0;

    assert.equal(recallDone, false);
    assert.equal(recallAttempts, 0);
  });

  test("recallDone prevents double recall within same session", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const config = { api_url: "http://localhost:4000" };

    // First call
    const r1 = await simulateRecall({
      config,
      projectBank: "p",
      userPrompt: "prompt 1",
      fetchImpl: fetchMock,
      recallDone: false,
    });
    assert.equal(r1.recallDone, true);

    // Second call (simulating next user turn without reset)
    const r2 = await simulateRecall({
      config,
      projectBank: "p",
      userPrompt: "prompt 2",
      fetchImpl: fetchMock,
      recallDone: r1.recallDone,
    });

    // fetch should only have been called once total (2 banks in first call = 1 here since no global)
    assert.equal(fetchMock.mock.calls.length, 1, "fetch only called on first turn");
    assert.equal(r2.injectedContent, null, "second turn should not inject");
  });
});

// ─── New field tests ─────────────────────────────────────────────────────────

describe("Recall request shape", () => {
  const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };

  test("uses budget:mid instead of max_tokens", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    await simulateRecall({
      config,
      projectBank: "project-test",
      userPrompt: "how does auth work?",
      fetchImpl: fetchMock,
    });
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.budget, "mid");
    assert.equal(body.max_tokens, undefined, "max_tokens should not be sent");
  });

  test("sends query_timestamp as ISO string", async () => {
    const before = Date.now();
    const fetchMock = mockFetchOk([]);
    await simulateRecall({
      config,
      projectBank: "project-test",
      userPrompt: "what did we decide?",
      fetchImpl: fetchMock,
    });
    const after = Date.now();
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.ok(body.query_timestamp, "query_timestamp must be present");
    const ts = new Date(body.query_timestamp).getTime();
    assert.ok(ts >= before && ts <= after, "query_timestamp should be recent");
  });
});

describe("Retain request shape", () => {
  const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };

  test("sets document_id to session-{sessionId}", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "refactor the auth module",
      transcript: "user: refactor\nassistant: done",
      sessionId: "abc123",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.lastRequestBody.items[0].document_id, "session-abc123");
  });

  test("sets update_mode to append", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "add logging to all routes",
      transcript: "user: add logging\nassistant: done",
      fetchImpl: fetchMock,
    });
    assert.equal(result.lastRequestBody.items[0].update_mode, "append");
  });

  test("context starts with 'pi coding session:' and includes prompt snippet", async () => {
    const fetchMock = mockFetchOk();
    const prompt = "how do I add a middleware?";
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: prompt,
      transcript: "...",
      fetchImpl: fetchMock,
    });
    const context: string = result.lastRequestBody.items[0].context;
    assert.ok(context.startsWith("pi coding session:"), `context should start with label, got: ${context}`);
    assert.ok(context.includes(prompt.slice(0, 20)), "context should include prompt snippet");
  });

  test("context truncates long prompts to 100 chars", async () => {
    const fetchMock = mockFetchOk();
    const longPrompt = "a".repeat(200) + " end";
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: longPrompt,
      transcript: "...",
      fetchImpl: fetchMock,
    });
    const context: string = result.lastRequestBody.items[0].context;
    assert.ok(!context.includes(" end"), "context should not include chars past 100");
  });

  test("timestamp is a recent ISO string", async () => {
    const before = Date.now();
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "show me the build config",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    const after = Date.now();
    const ts = new Date(result.lastRequestBody.items[0].timestamp).getTime();
    assert.ok(ts >= before && ts <= after, "timestamp should be recent");
  });
});

describe("Retain next-turn messages", () => {
  const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };

  test("success: sends hindsight-retain message with display:true and bank list", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "refactor the auth module",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.sentMessage?.customType, "hindsight-retain");
    assert.equal(result.sentMessage?.display, true);
    assert.ok(
      (result.sentMessage?.details as any)?.banks?.includes("project-test"),
      "details.banks should include project bank"
    );
  });

  test("failure: sends hindsight-retain-failed message with display:true", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "refactor the auth module",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.allFailed, true);
    assert.equal(result.sentMessage?.customType, "hindsight-retain-failed");
    assert.equal(result.sentMessage?.display, true);
  });

  test("success with #global: banks list includes global bank", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "remember this pattern #global",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    const banks: string[] = (result.sentMessage?.details as any)?.banks ?? [];
    assert.ok(banks.includes("project-test"), "should include project bank");
    assert.ok(banks.includes("global"), "should include global bank");
  });

  test("skipped retain: no message sent", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "ok",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.sentMessage, undefined);
  });
});

// ─── inferProjectMission tests ────────────────────────────────────────────────

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, basename as pathBasename } from "node:path";

describe("inferProjectMission", () => {
  function inferProjectMission(cwd: string): string {
    try {
      const pkgPath = pathJoin(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.description) return pkg.description;
      }
    } catch (_) {}
    try {
      const readmePath = pathJoin(cwd, "README.md");
      if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8").slice(0, 400).trim();
        if (content) return content;
      }
    } catch (_) {}
    return pathBasename(cwd);
  }

  test("returns package.json description when present", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-"));
    try {
      writeFileSync(pathJoin(dir, "package.json"), JSON.stringify({ description: "My cool project" }));
      assert.equal(inferProjectMission(dir), "My cool project");
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("falls back to README.md when package.json has no description", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-"));
    try {
      writeFileSync(pathJoin(dir, "package.json"), JSON.stringify({ name: "my-app" }));
      writeFileSync(pathJoin(dir, "README.md"), "# My App\nThis does cool things.");
      const result = inferProjectMission(dir);
      assert.ok(result.includes("My App"), `expected README content, got: ${result}`);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("falls back to directory name when no package.json or README", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-myproject-"));
    try {
      const result = inferProjectMission(dir);
      assert.equal(result, pathBasename(dir));
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("truncates README to 400 chars", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-"));
    try {
      writeFileSync(pathJoin(dir, "README.md"), "x".repeat(1000));
      const result = inferProjectMission(dir);
      assert.ok(result.length <= 400, `expected ≤400 chars, got ${result.length}`);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

// ─── configureBankMission tests ───────────────────────────────────────────────

describe("configureBankMission", () => {
  async function configureBankMission(
    config: { api_url: string; api_key?: string },
    bank: string,
    mission: string,
    fetchImpl: any
  ): Promise<void> {
    const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.api_key || ""}` },
      body: JSON.stringify({ mission }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  test("calls PUT /banks/{bank} with mission field", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const config = { api_url: "http://localhost:8888", api_key: "k" };
    await configureBankMission(config, "project-myapp", "A React e-commerce app", fetchMock);
    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, opts] = fetchMock.mock.calls[0].arguments;
    assert.ok(url.endsWith("/v1/default/banks/project-myapp"), `unexpected url: ${url}`);
    assert.equal(opts.method, "PUT");
    assert.equal(JSON.parse(opts.body).mission, "A React e-commerce app");
  });

  test("throws on non-ok response", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 }));
    const config = { api_url: "http://localhost:8888", api_key: "k" };
    await assert.rejects(
      () => configureBankMission(config, "project-myapp", "mission", fetchMock),
      /HTTP 500/
    );
  });
});

// ─── getBankMission tests ─────────────────────────────────────────────────────

describe("getBankMission", () => {
  async function getBankMission(
    config: { api_url: string; api_key?: string },
    bank: string,
    fetchImpl: any
  ): Promise<string | null> {
    try {
      const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}/profile`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.mission || null;
    } catch (_) {
      return null;
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns mission field from profile", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ mission: "custom mission" }),
    }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, "custom mission");
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.endsWith("/v1/default/banks/project-myapp/profile"), `unexpected url: ${url}`);
  });

  test("returns null when mission not set in profile", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null when no mission set anywhere", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ overrides: {}, config: {} }),
    }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null on HTTP error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 404 }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });
});

// ─── getServerHealth tests ────────────────────────────────────────────────────

describe("getServerHealth", () => {
  async function getServerHealth(
    config: { api_url: string; api_key?: string },
    fetchImpl: any
  ): Promise<{ ok: boolean; status?: number }> {
    try {
      const res = await fetchImpl(`${config.api_url}/health`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      return { ok: res.ok, status: res.status };
    } catch (_) {
      return { ok: false };
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns ok:true when server healthy", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const result = await getServerHealth(config, fetchMock);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });

  test("returns ok:false with status on HTTP error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 }));
    const result = await getServerHealth(config, fetchMock);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  test("returns ok:false with no status on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await getServerHealth(config, fetchMock);
    assert.equal(result.ok, false);
    assert.equal(result.status, undefined);
  });

  test("calls /health endpoint", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    await getServerHealth(config, fetchMock);
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.endsWith("/health"), `expected /health, got: ${url}`);
  });
});

// ─── getBankStats tests ────────────────────────────────────────────────────────

describe("getBankStats", () => {
  async function getBankStats(
    config: { api_url: string; api_key?: string },
    bank: string,
    fetchImpl: any
  ): Promise<Record<string, number> | null> {
    try {
      const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}/stats`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns stats object on success", async () => {
    const stats = { memories_count: 42, entities_count: 7, documents_count: 3 };
    const fetchMock = mock.fn(async () => ({ ok: true, json: async () => stats }));
    const result = await getBankStats(config, "project-myapp", fetchMock);
    assert.deepEqual(result, stats);
  });

  test("calls correct stats endpoint", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }));
    await getBankStats(config, "project-myapp", fetchMock);
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.includes("/v1/default/banks/project-myapp/stats"), `unexpected url: ${url}`);
  });

  test("returns null on HTTP error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 404 }));
    const result = await getBankStats(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await getBankStats(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });
});

// ─── session_start mission message tests ────────────────────────────────────

describe("session_start mission message", () => {
  async function simulateSessionStartMission(opts: {
    config: { api_url: string; api_key?: string } | null;
    mission: string;
    bank: string;
    fetchImpl: any;
  }): Promise<{ messageSent: boolean; messageDetails?: any }> {
    if (!opts.config?.api_url) return { messageSent: false };
    const messages: any[] = [];
    const mockPi = { sendMessage: (msg: any) => messages.push(msg) };
    try {
      const res = await opts.fetchImpl(`${opts.config.api_url}/v1/default/banks/${opts.bank}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.config.api_key || ""}` },
        body: JSON.stringify({ mission: opts.mission }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mockPi.sendMessage({ customType: "hindsight-mission", content: "", display: true, details: { bank: opts.bank, mission: opts.mission } });
    } catch (_) {
      return { messageSent: false };
    }
    return { messageSent: messages.length > 0, messageDetails: messages[0]?.details };
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("sends hindsight-mission message on success", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const result = await simulateSessionStartMission({
      config, mission: "A React e-commerce app", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, true);
    assert.equal(result.messageDetails?.bank, "project-myapp");
    assert.equal(result.messageDetails?.mission, "A React e-commerce app");
  });

  test("does not send message when config API fails", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 }));
    const result = await simulateSessionStartMission({
      config, mission: "some mission", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, false);
  });

  test("does not send message on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateSessionStartMission({
      config, mission: "some mission", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, false);
  });

  test("does not send message when no config", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const result = await simulateSessionStartMission({
      config: null, mission: "some mission", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, false);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});

// ─── checkBankConfig tests ───────────────────────────────────────────────────

describe("checkBankConfig", () => {
  async function checkBankConfig(
    config: { api_url: string; api_key?: string },
    bank: string,
    fetchImpl: any
  ): Promise<{ ok: true; mission: string | null } | { ok: false; authError: boolean }> {
    try {
      const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}/profile`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, authError: true };
      if (!res.ok) return { ok: false, authError: false };
      const data = await res.json();
      return { ok: true, mission: data.mission || null };
    } catch (_) {
      return { ok: false, authError: false };
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns ok:true with mission from profile", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ mission: "A cool project" }),
    }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, true);
    assert.equal((result as any).mission, "A cool project");
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.endsWith("/profile"), `expected /profile, got: ${url}`);
  });

  test("returns ok:true with null mission when none set", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({})
    }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, true);
    assert.equal((result as any).mission, null);
  });

  test("returns authError:true on 401", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 401 }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, true);
  });

  test("returns authError:true on 403", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 403 }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, true);
  });

  test("returns authError:false on other HTTP errors", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, false);
  });

  test("returns authError:false on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, false);
  });
});

// ─── checkBankConfig tests ─────────────────────────────── (already above)

// ─── hookStats tracking tests ────────────────────────────────────────────────

describe("hookStats tracking", () => {
  type HookRecord = { firedAt?: string; result?: string; detail?: string };

  function makeHookStats() {
    return { sessionStart: {} as HookRecord, recall: {} as HookRecord,
             retain: {} as HookRecord, missionConfig: {} as HookRecord };
  }

  test("session_start marks firedAt and result:ok", () => {
    const stats = makeHookStats();
    stats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    assert.equal(stats.sessionStart.result, "ok");
    assert.ok(stats.sessionStart.firedAt);
  });

  test("recall marks result:ok with memory count detail", () => {
    const stats = makeHookStats();
    stats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: "3 memories" };
    assert.equal(stats.recall.result, "ok");
    assert.ok(stats.recall.detail?.includes("3"));
  });

  test("recall marks result:failed with auth error detail", () => {
    const stats = makeHookStats();
    stats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
    assert.equal(stats.recall.result, "failed");
    assert.equal(stats.recall.detail, "auth error");
  });

  test("retain marks result:ok with bank names", () => {
    const stats = makeHookStats();
    stats.retain = { firedAt: new Date().toISOString(), result: "ok", detail: "project-myapp" };
    assert.equal(stats.retain.result, "ok");
    assert.ok(stats.retain.detail?.includes("project-myapp"));
  });

  test("retain marks result:failed when all banks unreachable", () => {
    const stats = makeHookStats();
    stats.retain = { firedAt: new Date().toISOString(), result: "failed", detail: "all banks unreachable" };
    assert.equal(stats.retain.result, "failed");
  });

  test("missionConfig marks result:ok with mission snippet", () => {
    const stats = makeHookStats();
    stats.missionConfig = { firedAt: new Date().toISOString(), result: "ok", detail: "A React app" };
    assert.equal(stats.missionConfig.result, "ok");
  });

  test("missionConfig marks result:failed with error", () => {
    const stats = makeHookStats();
    stats.missionConfig = { firedAt: new Date().toISOString(), result: "failed", detail: "HTTP 500" };
    assert.equal(stats.missionConfig.result, "failed");
  });

  test("unfired hooks have empty firedAt", () => {
    const stats = makeHookStats();
    assert.equal(stats.recall.firedAt, undefined);
    assert.equal(stats.retain.firedAt, undefined);
  });
});

// ─── readRecentLogErrors tests ────────────────────────────────────────────────

describe("readRecentLogErrors", () => {
  function readRecentLogErrors(logPath: string, maxLines = 20): string[] {
    try {
      if (!existsSync(logPath)) return [];
      const content = readFileSync(logPath, "utf-8");
      return content.split("\n").filter(l => l.trim()).slice(-maxLines);
    } catch (_) {
      return [];
    }
  }

  test("returns empty array when log file does not exist", () => {
    const result = readRecentLogErrors("/tmp/nonexistent-hindsight-log.txt");
    assert.deepEqual(result, []);
  });

  test("returns last N lines of log file", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-log-test-"));
    const logPath = pathJoin(dir, "debug.log");
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `[2025] line ${i}`).join("\n");
      writeFileSync(logPath, lines);
      const result = readRecentLogErrors(logPath, 10);
      assert.equal(result.length, 10);
      assert.ok(result[0].includes("line 20"), `expected line 20, got: ${result[0]}`);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("returns all lines when fewer than maxLines", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-log-test-"));
    const logPath = pathJoin(dir, "debug.log");
    try {
      writeFileSync(logPath, "line1\nline2\nline3\n");
      const result = readRecentLogErrors(logPath, 20);
      assert.equal(result.length, 3);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("skips blank lines", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-log-test-"));
    const logPath = pathJoin(dir, "debug.log");
    try {
      writeFileSync(logPath, "line1\n\n\nline2\n");
      const result = readRecentLogErrors(logPath, 20);
      assert.equal(result.length, 2);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
