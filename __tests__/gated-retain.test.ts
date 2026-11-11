import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Integration-style tests for the gated retain pipeline: buffer turns in
 * agent_end, retain every N, flush the tail on session_shutdown /
 * session_compact. The extension is loaded through a minimal fake ExtensionAPI;
 * fetch calls are intercepted via global fetch mocking.
 */

// --- fake pi extension API --------------------------------------------------

type Handler = (event: any, ctx: any) => any;
const handlers: Record<string, Handler> = {};
const sentMessages: any[] = [];
const statusSet: Record<string, unknown> = {};

const pi = {
  on: (name: string, h: Handler) => { handlers[name] = h; },
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  registerMessageRenderer: vi.fn(),
  sendMessage: (m: any) => sentMessages.push(m),
};

// --- intercept the extension's fetch ----------------------------------------

const fetchCalls: { url: string; body: any }[] = [];

function makeCtx() {
  return {
    cwd: process.cwd(),
    ui: { setStatus: (k: string, v: unknown) => { statusSet[k] = v; }, notify: () => {} },
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
  };
}

function agentEndWith(userPrompt: string, assistantText: string) {
  return handlers["agent_end"](
    { messages: [{ role: "assistant", content: assistantText }] },
    { ...makeCtx(), __prompt: userPrompt }
  );
}

// Force getLastUserMessage to find our prompt: it reads ctx.sessionManager entries
function ctxWithPrompt(prompt: string) {
  return {
    cwd: process.cwd(),
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => [{ type: "message", message: { role: "user", content: prompt } }],
    },
  };
}

async function importFresh() {
  // The extension registers handlers when its factory runs; invoke it with
  // our fake pi API. vitest isolates module state per test file, which is
  // sufficient isolation for these tests.
  const mod = await import("../index.ts");
  mod.default(pi);
  return mod;
}

describe("gated retain pipeline", () => {
  let globalConfigBackup: string | undefined;

  beforeEach(() => {
    // Point the extension at a test server and enable gating via env-free config
    const cfgPath = join(homedir(), ".hindsight", "config");
    try {
      globalConfigBackup = readFileSync(cfgPath, "utf-8");
    } catch { globalConfigBackup = undefined; }
    mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
    writeFileSync(cfgPath, [
      "api_url = http://hindsight.test",
      "api_key = testkey",
      "project_bank_id = pi::test-gate",
      "retain_every_n_turns = 3",
    ].join("\n"));

    fetchCalls.length = 0;
    (global as any).fetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
    // Keep keyring lookups quiet/deterministic
    vi.mock("node:child_process", async (importOriginal) => {
      const orig: any = await importOriginal();
      return { ...orig, execFileSync: (...a: any[]) => { throw new Error("no keyring in tests"); } };
    });
  });

  it("buffers turns and retains only when the gate fires", async () => {
    await importFresh();

    // Turn 1: buffered, no fetch
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "answer one" }] }, ctxWithPrompt("first substantive prompt"));
    expect(fetchCalls.length).toBe(0);

    // Turn 2: still buffered
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "answer two" }] }, ctxWithPrompt("second substantive prompt"));
    expect(fetchCalls.length).toBe(0);

    // Turn 3: gate fires — exactly one retain call carrying all three turns
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "answer three" }] }, ctxWithPrompt("third substantive prompt"));
    expect(fetchCalls.length).toBe(1);
    const content = fetchCalls[0].body.items[0].content as string;
    expect(content).toContain("first substantive prompt");
    expect(content).toContain("second substantive prompt");
    expect(content).toContain("third substantive prompt");
    expect(fetchCalls[0].body.items[0].document_id).toBe("session-test-session");
  });

  it("flushes the partial window on session_shutdown", async () => {
    await importFresh();
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "tail work" }] }, ctxWithPrompt("uncommitted tail prompt"));
    expect(fetchCalls.length).toBe(0);

    await handlers["session_shutdown"]({}, makeCtx());
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.items[0].context).toContain("uncommitted tail prompt");
  });

  it("flushes on session_compact before resetting state", async () => {
    await importFresh();
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "pre-compact work" }] }, ctxWithPrompt("work before compaction"));
    await handlers["session_compact"]({}, makeCtx());
    expect(fetchCalls.length).toBe(1);

    // After compaction the counters reset; a shutdown immediately after must NOT re-retain
    await handlers["session_shutdown"]({}, makeCtx());
    expect(fetchCalls.length).toBe(1);
  });

  it("strips secrets and memory blocks from retained content", async () => {
    await importFresh();
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "key is Authorization: Bearer sk-secret-value-123" }] }, ctxWithPrompt("leak check prompt"));
    await handlers["session_shutdown"]({}, makeCtx());
    const content = fetchCalls[0].body.items[0].content as string;
    expect(content).toContain("[REDACTED_AUTH]");
    expect(content).not.toContain("sk-secret-value-123");
  });

  it("skips trivial acknowledgements without consuming the gate", async () => {
    await importFresh();
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "ok" }] }, ctxWithPrompt("sounds good"));
    await handlers["session_shutdown"]({}, makeCtx());
    expect(fetchCalls.length).toBe(0);
  });
});
