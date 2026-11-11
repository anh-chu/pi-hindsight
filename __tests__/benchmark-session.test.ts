import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * WS-P5 (MEMORY_PIPELINE_PLAN.md Phase 4): the structural benchmark.
 *
 * Drives a simulated 20-turn session through the real extension against a
 * fake Hindsight server and asserts the two structural invariants that make
 * the pipeline token-efficient:
 *   1. Bounded API work: reflect default = at most a handful of calls for the
 *      whole session (core probe + 1 reflect + optional global recall), not
 *      one recall per turn.
 *   2. Exactly one injected message for the whole session, and the handler
 *      NEVER returns a systemPrompt (prefix-cache safety).
 * Also snapshots the JSONL diagnostics the session produced.
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
      getSessionId: () => "bench-session",
      getEntries: () =>
        prompt === undefined ? [] : [{ type: "message", message: { role: "user", content: prompt } }],
    },
  };
}

let realHome: string | undefined;
let tmpHome: string | undefined;
let diagFile: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "pi-hindsight-bench-"));
  process.env.HOME = tmpHome;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("HINDSIGHT_")) delete process.env[k];
  }
  diagFile = join(tmpHome, "diag.log");
  process.env.HINDSIGHT_DIAG_FILE = diagFile;
  mkdirSync(join(tmpHome, ".hindsight"), { recursive: true });
  fetchCalls.length = 0;
  (global as any).fetch = vi.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    fetchCalls.push({ url, body });
    if (url.includes("/reflect")) {
      return { ok: true, status: 200, json: async () => ({ synthesis: "Synthesized project context." }) } as any;
    }
    if (url.includes("/memories/recall")) {
      // Recall hits for every non-core query so per_message/recall modes inject
      return { ok: true, status: 200, json: async () => ({ results: [{ text: "A relevant project memory" }] }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
});

afterEach(() => {
  delete process.env.HINDSIGHT_DIAG_FILE;
  if (realHome !== undefined) process.env.HOME = realHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

async function runSession(configLines: string[], turns: number) {
  writeFileSync(join(tmpHome!, ".hindsight", "config"), configLines.join("\n"));
  const mod = await import("../index.ts");
  mod.default(pi);

  await handlers["session_start"]({}, ctxWithPrompt());
  let injections = 0;
  const handlerReturns: any[] = [];
  for (let i = 0; i < turns; i++) {
    const prompt = `question number ${i} about the ingestion pipeline refactoring`;
    const r = await handlers["before_agent_start"]({}, ctxWithPrompt(prompt));
    handlerReturns.push(r);
    if (r?.message) injections++;
    await handlers["agent_end"](
      { messages: [{ role: "assistant", content: `answer ${i} with plenty of substantive content` }] },
      ctxWithPrompt(prompt),
    );
  }
  await handlers["session_shutdown"]({}, ctxWithPrompt());
  return { injections, handlerReturns };
}

describe("20-turn structural benchmark", () => {
  it("reflect default: ≤ 3 memory API calls, exactly 1 injection, never systemPrompt", async () => {
    const { injections, handlerReturns } = await runSession(
      ["api_url = http://hindsight.test", "api_key = testkey", "project_bank_id = pi::bench"],
      20,
    );

    // Memory-pipeline calls only (mission setup + health pings excluded)
    const memoryCalls = fetchCalls.filter(
      c => c.url.includes("/memories/recall") || c.url.includes("/reflect") || c.url.endsWith("/memories"),
    );
    // 20 retains (gate=1, one append per turn) + core probe + 1 reflect ≤ 23…
    // but the *injection-side* budget is what the plan bounds:
    const injectSideCalls = memoryCalls.filter(c => !c.url.endsWith("/memories") || (c.body.items === undefined));
    expect(injectSideCalls.length).toBeLessThanOrEqual(3); // core probe + reflect (+ nothing else)

    // Structural invariants
    expect(injections).toBe(1);
    for (const r of handlerReturns) {
      expect(r?.systemPrompt).toBeUndefined();
      expect(r?.message?.customType ?? "none").not.toBe("system-reminder");
    }

    // Diagnostics recorded the session
    expect(existsSync(diagFile)).toBe(true);
    const events = readFileSync(diagFile!, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const names = events.map((e: any) => e.event);
    expect(names).toContain("inject_ok");
    expect(names.filter((n: string) => n === "inject_ok").length).toBe(1);
    expect(names).toContain("retain_ok");
  });

  it("per_message mode preserves the old call shape (one recall per turn)", async () => {
    const { injections } = await runSession(
      ["api_url = http://hindsight.test", "api_key = testkey", "project_bank_id = pi::bench", "auto_inject = per_message"],
      20,
    );

    const recalls = fetchCalls.filter(c => c.url.includes("/memories/recall"));
    expect(recalls.length).toBe(20); // escape hatch: per-turn recall
    expect(injections).toBe(20);
  });

  it("recall mode: bounded calls, 1 injection", async () => {
    const { injections } = await runSession(
      ["api_url = http://hindsight.test", "api_key = testkey", "project_bank_id = pi::bench", "auto_inject = recall"],
      20,
    );

    // 1 bank (no global configured): 1 source run + 1 core probe = 2 recalls total
    const recalls = fetchCalls.filter(c => c.url.includes("/memories/recall"));
    expect(recalls.length).toBe(2);
    expect(injections).toBe(1);
  });
});
