import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprintTurn } from "../index.ts";

/**
 * WS-P4 (MEMORY_PIPELINE_PLAN.md Phase 3): write-back growth fingerprint.
 * agent_end can re-fire for one logical turn (retried run, queued-message
 * continuation); the duplicate signal must not double-buffer/double-retain.
 */

type Handler = (event: any, ctx: any) => any;
const handlers: Record<string, Handler> = {};

const pi = {
  on: (name: string, h: Handler) => { handlers[name] = h; },
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  registerMessageRenderer: vi.fn(),
  sendMessage: () => {},
};

const fetchCalls: { url: string; body: any }[] = [];

function ctxWithPrompt(prompt?: string) {
  return {
    cwd: process.cwd(),
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () =>
        prompt === undefined ? [] : [{ type: "message", message: { role: "user", content: prompt } }],
    },
  };
}

async function importFresh() {
  const mod = await import("../index.ts");
  mod.default(pi);
  return mod;
}

let realHome: string | undefined;
let tmpHome: string | undefined;

beforeEach(async () => {
  realHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "pi-hindsight-wsp4-"));
  process.env.HOME = tmpHome;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("HINDSIGHT_")) delete process.env[k];
  }
  mkdirSync(join(tmpHome, ".hindsight"), { recursive: true });
  writeFileSync(join(tmpHome, ".hindsight", "config"), [
    "api_url = http://hindsight.test",
    "api_key = testkey",
    "project_bank_id = pi::wsp4",
  ].join("\n"));

  fetchCalls.length = 0;
  (global as any).fetch = vi.fn(async (url: string, init: any) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
  });
  await importFresh();
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe("fingerprintTurn", () => {
  it("is stable for identical inputs and differs otherwise", () => {
    const a = fingerprintTurn("prompt", "transcript");
    expect(fingerprintTurn("prompt", "transcript")).toBe(a);
    expect(fingerprintTurn("prompt2", "transcript")).not.toBe(a);
    expect(fingerprintTurn("prompt", "transcript2")).not.toBe(a);
  });
});

describe("agent_end growth gate", () => {
  it("buffers a retried run's identical turn exactly once", async () => {
    const ev = { messages: [{ role: "assistant", content: "the same answer" }] };
    // Turn 1: buffered
    await handlers["agent_end"](ev, ctxWithPrompt("first substantive prompt"));
    // Retried run re-fires agent_end with the identical prompt + content
    await handlers["agent_end"](ev, ctxWithPrompt("first substantive prompt"));
    await handlers["session_shutdown"]({}, ctxWithPrompt("first substantive prompt"));

    const retains = fetchCalls.filter(c => c.url.endsWith("/memories"));
    expect(retains.length).toBe(1);
    const content = retains[0].body.items[0].content as string;
    expect(content.match(/the same answer/g)?.length).toBe(1);
  });

  it("buffers a genuine second turn (same prompt, new content)", async () => {
    const ev1 = { messages: [{ role: "assistant", content: "answer one" }] };
    await handlers["agent_end"](ev1, ctxWithPrompt("regenerate this please"));
    const ev2 = { messages: [{ role: "assistant", content: "answer one, better" }] };
    await handlers["agent_end"](ev2, ctxWithPrompt("regenerate this please"));
    await handlers["session_shutdown"]({}, ctxWithPrompt("regenerate this please"));

    // gate=1: each genuine turn is its own append call (same document_id)
    const retains = fetchCalls.filter(c => c.url.endsWith("/memories"));
    expect(retains.length).toBe(2);
    expect((retains[0].body.items[0].content as string)).toContain("answer one");
    expect((retains[1].body.items[0].content as string)).toContain("answer one, better");
    expect(retains[0].body.items[0].document_id).toBe("session-test-session");
    expect(retains[1].body.items[0].document_id).toBe("session-test-session");
  });

  it("fingerprint resets on compaction (same turn re-eligible post-compact)", async () => {
    const ev = { messages: [{ role: "assistant", content: "pre-compact answer" }] };
    await handlers["agent_end"](ev, ctxWithPrompt("pre-compact prompt"));
    await handlers["session_compact"]({}, ctxWithPrompt("pre-compact prompt"));
    // A post-compact run with identical content is a NEW logical turn
    await handlers["agent_end"](ev, ctxWithPrompt("pre-compact prompt"));
    await handlers["session_shutdown"]({}, ctxWithPrompt("pre-compact prompt"));

    const retains = fetchCalls.filter(c => c.url.endsWith("/memories"));
    expect(retains.length).toBe(2);
  });

  it("does not break the N-turn gate (dedupe interacts with gate counting)", async () => {
    writeFileSync(join(tmpHome!, ".hindsight", "config"), [
      "api_url = http://hindsight.test",
      "api_key = testkey",
      "project_bank_id = pi::wsp4",
      "retain_every_n_turns = 2",
    ].join("\n"));

    // Turn 1 (buffered) + its duplicate (skipped)
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "a1" }] }, ctxWithPrompt("turn one prompt"));
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "a1" }] }, ctxWithPrompt("turn one prompt"));
    // Turn 2: gate (2) fires → one retain with both distinct turns
    await handlers["agent_end"]({ messages: [{ role: "assistant", content: "a2" }] }, ctxWithPrompt("turn two prompt"));
    await handlers["session_shutdown"]({}, ctxWithPrompt("turn two prompt"));

    const retains = fetchCalls.filter(c => c.url.endsWith("/memories"));
    expect(retains.length).toBe(1);
    const content = retains[0].body.items[0].content as string;
    expect(content).toContain("a1");
    expect(content).toContain("a2");
  });
});
