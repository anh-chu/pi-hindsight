import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * WS-P3 (MEMORY_PIPELINE_PLAN.md Phase 0): prompt hygiene + byte-aware query
 * bounding. Pure-function tests for stripInjectedMemory / boundQueryTokens,
 * plus wiring tests proving the auto-recall path and the hindsight_recall /
 * hindsight_reflect tools actually send bounded, wrapper-free queries.
 */

import {
  stripInjectedMemory,
  boundQueryTokens,
} from "../index.ts";

// --- fake pi extension API (shared with gated-retain.test.ts pattern) --------

type Handler = (event: any, ctx: any) => any;
const handlers: Record<string, Handler> = {};
const tools: Record<string, any> = {};

const pi = {
  on: (name: string, h: Handler) => { handlers[name] = h; },
  registerTool: (spec: any) => { tools[spec.name] = spec; },
  registerCommand: vi.fn(),
  registerMessageRenderer: vi.fn(),
  sendMessage: () => {},
};

const fetchCalls: { url: string; body: any }[] = [];

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
  const mod = await import("../index.ts");
  mod.default(pi);
  return mod;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("stripInjectedMemory", () => {
  it("removes <system-reminder> wrapper blocks", () => {
    const input = "<system-reminder>paste of AGENTS.md rules</system-reminder>\n\nFix the login bug";
    expect(stripInjectedMemory(input)).toBe("Fix the login bug");
  });

  it("removes <context key=...> instruction blocks", () => {
    const input = '<context key="docs">read the docs first</context>What changed in v2?';
    expect(stripInjectedMemory(input)).toBe("What changed in v2?");
  });

  it("removes hindsight/relevant memory blocks and the legacy preamble", () => {
    expect(stripInjectedMemory("<hindsight_memories>x</hindsight_memories>keep me")).toBe("keep me");
    expect(stripInjectedMemory("<relevant_memories>y</relevant_memories>keep me")).toBe("keep me");
    expect(stripInjectedMemory("Relevant context from memory: old block\n\nkeep me")).toBe("keep me");
  });

  it("handles attributes and multiline content in wrappers", () => {
    const input = '<system-reminder type="ambient">\nline1\nline2\n</system-reminder>real ask';
    expect(stripInjectedMemory(input)).toBe("real ask");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripInjectedMemory("Port the injection engine from opencode")).toBe(
      "Port the injection engine from opencode"
    );
  });
});

describe("boundQueryTokens", () => {
  it("passes short ASCII text through unchanged", () => {
    expect(boundQueryTokens("short query", 500)).toBe("short query");
  });

  it("cuts ASCII text at ~2 chars per token (0.5 token/char)", () => {
    // 500-token budget => 1000 ASCII chars max
    const text = "a".repeat(2000);
    const bounded = boundQueryTokens(text, 500);
    expect(bounded.length).toBe(1000);
    expect(bounded).toBe("a".repeat(1000));
  });

  it("charges CJK characters by UTF-8 byte length (3 bytes => 3 tokens)", () => {
    // Each CJK char costs 3 tokens; a 500-token budget fits 166 chars.
    const text = "漢".repeat(300);
    const bounded = boundQueryTokens(text, 500);
    expect(bounded.length).toBe(166); // 166 * 3 = 498 <= 500
  });

  it("charges emoji (astral plane) at 4 tokens each", () => {
    const text = "😀".repeat(200);
    const bounded = boundQueryTokens(text, 500);
    expect([...bounded].length).toBe(125); // 125 * 4 = 500
  });

  it("preserves the head of the query where the user's ask lives", () => {
    const text = "How do we migrate the auth module? " + "padding ".repeat(500);
    const bounded = boundQueryTokens(text, 500);
    expect(bounded.startsWith("How do we migrate the auth module?")).toBe(true);
  });

  it("returns empty string for a zero/negative budget", () => {
    expect(boundQueryTokens("anything", 0)).toBe("");
    expect(boundQueryTokens("anything", -1)).toBe("");
  });

  it("never cuts mid-surrogate-pair", () => {
    const text = "😀😀😀";
    const bounded = boundQueryTokens(text, 5); // fits 1 emoji (4) but not 2 (8)
    expect(bounded).toBe("😀");
  });
});

// ---------------------------------------------------------------------------
// Wiring: the query paths actually send bounded, wrapper-free queries
// ---------------------------------------------------------------------------

describe("query-path wiring", () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "pi-hindsight-wsp3-"));
    process.env.HOME = tmpHome;
    // Hermetic banks: launcher-exported HINDSIGHT_* must not steer the test
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("HINDSIGHT_")) delete process.env[k];
    }
    mkdirSync(join(tmpHome, ".hindsight"), { recursive: true });
    writeFileSync(join(tmpHome, ".hindsight", "config"), [
      "api_url = http://hindsight.test",
      "api_key = testkey",
      "project_bank_id = pi::wsp3",
    ].join("\n"));

    fetchCalls.length = 0;
    (global as any).fetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
    });
  });

  afterEach(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("auto-recall (recall mode) strips wrappers and bounds the query it sends", async () => {
    await importFresh();
    // recall mode keeps the classic recall-path behavior for hygiene assertions
    writeFileSync(join(tmpHome, ".hindsight", "config"), [
      "api_url = http://hindsight.test",
      "api_key = testkey",
      "project_bank_id = pi::wsp3",
      "auto_inject = recall",
    ].join("\n"));

    const wrapped =
      "<system-reminder>huge paste of project rules that would otherwise head the query</system-reminder>\n\n" +
      "Fix the flaky retry test in the payment client";
    const result = await handlers["before_agent_start"]({}, ctxWithPrompt(wrapped));

    const recallCall = fetchCalls.find(c =>
      c.url.includes("/memories/recall") &&
      (c.body.query as string).startsWith("Fix the flaky")
    );
    expect(recallCall).toBeDefined();
    expect(recallCall!.body.query).toBe("Fix the flaky retry test in the payment client");
    expect(result?.message?.content ?? "").not.toContain("<system-reminder>");
  });

  it("auto-inject (reflect mode) sends the stripped prompt as the reflect query", async () => {
    await importFresh();

    const wrapped =
      '<context key="rules">project conventions paste</context>' +
      "Refactor the ingestion pipeline";
    const result = await handlers["before_agent_start"]({}, ctxWithPrompt(wrapped));

    const reflectCall = fetchCalls.find(c => c.url.includes("/reflect"));
    expect(reflectCall).toBeDefined();
    expect(reflectCall!.body.query).toBe("Refactor the ingestion pipeline");
    expect(result?.message?.content ?? "").not.toContain("<context");
  });

  it("a prompt that strips to empty fires no source call (nothing to recall)", async () => {
    await importFresh();
    await handlers["before_agent_start"]({}, ctxWithPrompt("<system-reminder>only a wrapper</system-reminder>"));

    // Core probe may fire, but no reflect or prompt-keyed recall call should
    expect(fetchCalls.find(c => c.url.includes("/reflect"))).toBeUndefined();
    const recallQueries = fetchCalls.filter(c => c.url.includes("/memories/recall")).map(c => c.body.query);
    expect(recallQueries).not.toContain("Provide context for current project");
  });

  it("auto-recall bounds a very long prompt to the token ceiling", async () => {
    await importFresh();
    writeFileSync(join(tmpHome, ".hindsight", "config"), [
      "api_url = http://hindsight.test",
      "api_key = testkey",
      "project_bank_id = pi::wsp3",
      "auto_inject = recall",
    ].join("\n"));
    const long = "We need to refactor the entire ingestion pipeline. " + "detail ".repeat(2000);
    await handlers["before_agent_start"]({}, ctxWithPrompt(long));

    const queries = fetchCalls.filter(c => c.url.includes("/memories/recall")).map(c => c.body.query as string);
    const promptQuery = queries.find(q => q.startsWith("We need to refactor"));
    expect(promptQuery).toBeDefined();
    // 500 tokens * 2 chars/token = 1000 chars max on the wire
    expect(promptQuery!.length).toBeLessThanOrEqual(1000);
  });

  it("hindsight_recall tool sends a bounded, wrapper-free query", async () => {
    await importFresh();
    await tools["hindsight_recall"].execute("t1", {
      query: '<context key="x">boilerplate</context>' + "q".repeat(5000),
    });

    const recallCall = fetchCalls.find(c => c.url.includes("/memories/recall"));
    expect(recallCall).toBeDefined();
    expect(recallCall!.body.query).not.toContain("<context");
    expect(recallCall!.body.query.length).toBeLessThanOrEqual(1000);
  });

  it("hindsight_reflect tool sends a bounded, wrapper-free query", async () => {
    await importFresh();
    await tools["hindsight_reflect"].execute("t2", {
      query: "<system-reminder>noise</system-reminder>" + "reflect on this very long topic ".repeat(300),
    });

    const reflectCall = fetchCalls.find(c => c.url.includes("/reflect"));
    expect(reflectCall).toBeDefined();
    expect(reflectCall!.body.query).not.toContain("<system-reminder>");
    expect(reflectCall!.body.query.length).toBeLessThanOrEqual(1000);
  });

  it("hindsight_recall rejects a query that strips to empty", async () => {
    await importFresh();
    const res = await tools["hindsight_recall"].execute("t3", {
      query: "   <system-reminder>only wrapper</system-reminder>   ",
    });
    expect(res.isError).toBe(true);
    expect(fetchCalls.filter(c => c.url.includes("/memories/recall")).length).toBe(0);
  });

  it("retention strips wrappers from the buffered transcript", async () => {
    await importFresh();
    await handlers["agent_end"](
      {
        messages: [
          {
            role: "assistant",
            content: "<system-reminder>ambient noise from host</system-reminder>did the work",
          },
        ],
      },
      ctxWithPrompt("wire the retention hygiene"),
    );
    await handlers["session_shutdown"]({}, ctxWithPrompt("wire the retention hygiene"));

    const retainCall = fetchCalls.find(c => c.url.endsWith("/memories"));
    expect(retainCall).toBeDefined();
    const content = retainCall!.body.items[0].content as string;
    expect(content).toContain("did the work");
    expect(content).not.toContain("<system-reminder>");
  });
});
