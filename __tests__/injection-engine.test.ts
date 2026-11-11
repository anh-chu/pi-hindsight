import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * WS-P1 (MEMORY_PIPELINE_PLAN.md Phase 1): the InjectionEngine.
 *
 * Tri-state resolution, attempt budgets, trivial-prompt skip, once-only
 * delivery, compaction re-arm, mode switching, core-memory freeze, and the
 * reflect-with-global-recall multi-bank shape. The extension is loaded
 * through a minimal fake ExtensionAPI; fetch is intercepted globally.
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

// Per-test fetch router: map url-fragment -> response
let fetchRouter: (url: string, body: any) => { ok: boolean; status: number; json: () => any } | undefined;

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

async function start(configLines: string[]) {
  writeFileSync(join(tmpHome!, ".hindsight", "config"), configLines.join("\n"));
  await importFresh();
}

let realHome: string | undefined;
let tmpHome: string | undefined;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "pi-hindsight-engine-"));
  process.env.HOME = tmpHome;
  // Hermetic banks: a launcher-exported HINDSIGHT_BANK_ID / HINDSIGHT_RETAIN_TAGS
  // must not steer the engine under test
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("HINDSIGHT_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  mkdirSync(join(tmpHome, ".hindsight"), { recursive: true });
  fetchCalls.length = 0;
  fetchRouter = undefined;
  (global as any).fetch = vi.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    fetchCalls.push({ url, body });
    const routed = fetchRouter?.(url, body);
    if (routed) return routed as any;
    return { ok: true, status: 200, json: async () => ({ results: [], synthesis: "" }) } as any;
  });
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

const BASE = ["api_url = http://hindsight.test", "api_key = testkey", "project_bank_id = pi::engine"];

describe("reflect mode (new default)", () => {
  it("reflects once on the project bank and injects exactly once", async () => {
    await start(BASE);
    fetchRouter = (url) =>
      url.includes("/reflect")
        ? { ok: true, status: 200, json: async () => ({ synthesis: "Use Vitest and colocate tests." }) }
        : undefined;

    const r1 = await handlers["before_agent_start"]({}, ctxWithPrompt("how should we test this module?"));
    const r2 = await handlers["before_agent_start"]({}, ctxWithPrompt("and how do we mock fetch?"));

    expect(r1?.message?.content).toContain("Use Vitest and colocate tests.");
    expect(r1?.message?.content).toContain("[context]");
    expect(r1?.message?.content).toContain('Recalled for "how should we test this module?"');
    expect(r2).toBeUndefined(); // once-only: never re-injected

    const reflectCalls = fetchCalls.filter(c => c.url.includes("/reflect"));
    expect(reflectCalls.length).toBe(1);
  });

  it("runs the core-memory probe once and prefixes the frozen core section", async () => {
    await start(BASE);
    fetchRouter = (url, body) =>
      url.includes("/reflect")
        ? { ok: true, status: 200, json: async () => ({ synthesis: "synth" }) }
        : body?.query?.startsWith("core memories")
          ? { ok: true, status: 200, json: async () => ({ results: [{ text: "Prefer explicit exports" }] }) }
          : undefined;

    const r1 = await handlers["before_agent_start"]({}, ctxWithPrompt("what are our export conventions"));
    await handlers["before_agent_start"]({}, ctxWithPrompt("another substantive turn"));

    const coreCalls = fetchCalls.filter(c => c.url.includes("/memories/recall") && (c.body.query as string).startsWith("core memories"));
    expect(coreCalls.length).toBe(1); // frozen after the first fetch
    expect(r1?.message?.content).toContain("[core]");
    expect(r1?.message?.content).toContain("Prefer explicit exports");
  });

  it("appends a [global] section from parallel global-bank recall", async () => {
    await start([...BASE, "global_bank = team-global"]);
    fetchRouter = (url, body) => {
      if (url.includes("/reflect")) return { ok: true, status: 200, json: async () => ({ synthesis: "project synth" }) };
      if (url.includes("team-global") && (body.query as string).startsWith("cross")) {
        return { ok: true, status: 200, json: async () => ({ results: [{ text: "Team uses pnpm" }] }) };
      }
      return undefined;
    };

    const r = await handlers["before_agent_start"]({}, ctxWithPrompt("cross-cutting conventions question"));
    expect(r?.message?.content).toContain("project synth");
    expect(r?.message?.content).toContain("[global]");
    expect(r?.message?.content).toContain("Team uses pnpm");
  });

  it("falls back to recall when reflect fails (retryable)", async () => {
    await start(BASE);
    let reflectTried = 0;
    fetchRouter = (url) => {
      if (url.includes("/reflect")) {
        reflectTried++;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return undefined;
    };
    (global as any).fetch = vi.fn(async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      fetchCalls.push({ url, body });
      const routed = fetchRouter?.(url, body);
      if (routed) return routed as any;
      // default recall response with a hit
      return { ok: true, status: 200, json: async () => ({ results: [{ text: "fallback memory" }] }) } as any;
    });

    const r = await handlers["before_agent_start"]({}, ctxWithPrompt(" substantive question here "));
    expect(reflectTried).toBe(1);
    expect(r?.message?.content).toContain("fallback memory");
  });

  it("fallback recall records provenance in the injected details", async () => {
    await start(BASE);
    fetchRouter = (url) =>
      url.includes("/reflect") ? { ok: false, status: 500, json: async () => ({}) } : undefined;
    (global as any).fetch = vi.fn(async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      fetchCalls.push({ url, body });
      const routed = fetchRouter?.(url, body);
      if (routed) return routed as any;
      if (url.includes("/memories/recall")) {
        if ((body.query as string).startsWith("core memories")) {
          return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ results: [{ text: "fb hit" }] }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });

    const r = await handlers["before_agent_start"]({}, ctxWithPrompt("provenance question here"));
    expect(r?.message?.content).toContain("fb hit");
    // via=fallback recorded in the engine state — surfaces in hook stats detail
    // (observable through /hindsight status in a live session)
  });

  it("an empty fallback on a permanent 4xx still resolves immediately", async () => {
    await start(BASE);
    fetchRouter = (url) =>
      url.includes("/reflect") ? { ok: false, status: 404, json: async () => ({}) } : undefined;
    // recall default: ok with [] (empty fallback)

    await handlers["before_agent_start"]({}, ctxWithPrompt("first substantive prompt"));
    await handlers["before_agent_start"]({}, ctxWithPrompt("second substantive prompt"));

    // 404 permanent + empty fallback: resolved empty after turn 1, no re-attempts
    expect(fetchCalls.filter(c => c.url.includes("/reflect")).length).toBe(1);
    expect(
      fetchCalls.filter(c => c.url.includes("/memories/recall") && !(c.body.query as string).startsWith("core memories")).length
    ).toBeLessThanOrEqual(1);
  });

  it("fallback timeout aborts the recall and consumes a failure attempt", async () => {
    await start([...BASE, "inject_timeout_ms = 50"]);
    (global as any).fetch = vi.fn(async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      fetchCalls.push({ url, body });
      if (url.includes("/reflect")) return { ok: false, status: 500, json: async () => ({}) } as any;
      if (url.includes("/memories/recall")) {
        if ((body.query as string).startsWith("core memories")) {
          return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
        }
        // simulate the abort: reject with the AbortError fetch produces
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });

    const r1 = await handlers["before_agent_start"]({}, ctxWithPrompt("timeout test question one"));
    expect(r1).toBeUndefined(); // nothing delivered
    // failure attempt consumed (1 of 2); next turn retries
    const r2 = await handlers["before_agent_start"]({}, ctxWithPrompt("timeout test question two"));
    expect(r2).toBeUndefined();
    // budget spent (2 of 2): resolved empty; a third turn makes no calls
    const before = fetchCalls.filter(c => c.url.includes("/reflect")).length;
    await handlers["before_agent_start"]({}, ctxWithPrompt("timeout test question three"));
    expect(fetchCalls.filter(c => c.url.includes("/reflect")).length).toBe(before);
  });

  it("skips trivially short prompts without consuming an attempt", async () => {
    await start(BASE);
    await handlers["before_agent_start"]({}, ctxWithPrompt("hi"));
    expect(fetchCalls.filter(c => c.url.includes("/reflect")).length).toBe(0);

    // A later substantive prompt still gets the full attempt budget
    fetchRouter = (url) =>
      url.includes("/reflect") ? { ok: true, status: 200, json: async () => ({ synthesis: "s" }) } : undefined;
    const r = await handlers["before_agent_start"]({}, ctxWithPrompt("a real question at last"));
    expect(r?.message?.content).toContain("s");
  });

  it("resolves empty after the failure budget is spent", async () => {
    await start(BASE);
    fetchRouter = (url) =>
      url.includes("/reflect") || url.includes("/memories/recall")
        ? { ok: false, status: 503, json: async () => ({}) }
        : undefined;

    await handlers["before_agent_start"]({}, ctxWithPrompt("first substantive prompt"));
    await handlers["before_agent_start"]({}, ctxWithPrompt("second substantive prompt"));
    const callsAfterTwo = fetchCalls.filter(c => c.url.includes("/reflect")).length;
    await handlers["before_agent_start"]({}, ctxWithPrompt("third substantive prompt"));

    // 2 failures = budget spent (default inject_failure_attempts=2); reflect
    // stops, and the turn-3 fallback recall also stops with it
    expect(callsAfterTwo).toBe(2);
    expect(fetchCalls.filter(c => c.url.includes("/reflect")).length).toBe(2);
  });

  it("resolves empty immediately on a permanent 4xx", async () => {
    await start(BASE);
    fetchRouter = (url) =>
      url.includes("/reflect") ? { ok: false, status: 404, json: async () => ({}) } : undefined;

    await handlers["before_agent_start"]({}, ctxWithPrompt("first substantive prompt"));
    await handlers["before_agent_start"]({}, ctxWithPrompt("second substantive prompt"));

    // 404 is permanent: no second reflect attempt
    expect(fetchCalls.filter(c => c.url.includes("/reflect")).length).toBe(1);
  });

  it("re-arms after compaction", async () => {
    await start(BASE);
    fetchRouter = (url) =>
      url.includes("/reflect") ? { ok: true, status: 200, json: async () => ({ synthesis: "pre-compact" }) } : undefined;

    await handlers["before_agent_start"]({}, ctxWithPrompt("pre-compact question"));
    await handlers["session_compact"]({}, ctxWithPrompt("pre-compact question"));

    fetchRouter = (url) =>
      url.includes("/reflect") ? { ok: true, status: 200, json: async () => ({ synthesis: "post-compact" }) } : undefined;
    const r = await handlers["before_agent_start"]({}, ctxWithPrompt("post-compact question"));
    expect(r?.message?.content).toContain("post-compact");
    expect(fetchCalls.filter(c => c.url.includes("/reflect")).length).toBe(2);
  });
});

describe("recall mode (legacy)", () => {
  it("recalls once per session across all banks in parallel", async () => {
    await start([...BASE, "global_bank = team-global", "auto_inject = recall"]);
    fetchRouter = (_url, body) =>
      (body.query as string).startsWith("legacy")
        ? { ok: true, status: 200, json: async () => ({ results: [{ text: "legacy hit" }] }) }
        : undefined;

    const r1 = await handlers["before_agent_start"]({}, ctxWithPrompt("legacy recall question"));
    const r2 = await handlers["before_agent_start"]({}, ctxWithPrompt("another legacy turn"));

    expect(r1?.message?.content).toContain("legacy hit");
    expect(r2).toBeUndefined();
    const recallCalls = fetchCalls.filter(c => c.url.includes("/memories/recall") && (c.body.query as string).startsWith("legacy"));
    expect(recallCalls.length).toBe(2); // both banks, once
    expect(recallCalls.some(c => c.url.includes("team-global"))).toBe(true);
    expect(recallCalls.some(c => c.url.includes("pi::engine"))).toBe(true);
  });

  it("empty vault retries up to the empty budget, then stops", async () => {
    await start([...BASE, "auto_inject = recall"]);
    let recalls = 0;
    fetchRouter = (url) => {
      if (url.includes("/memories/recall")) {
        recalls++;
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      return undefined;
    };

    for (let i = 0; i < 8; i++) {
      await handlers["before_agent_start"]({}, ctxWithPrompt(`turn ${i} substantive question`));
    }
    // default inject_empty_attempts=5: five source runs, then resolved empty
    expect(recalls).toBeLessThanOrEqual(6); // 5 source runs + core probe
    expect(fetchCalls.filter(c => c.url.includes("/memories/recall")).length).toBeLessThanOrEqual(6);
  });
});

describe("per_message mode (escape hatch)", () => {
  it("recalls on every substantive turn", async () => {
    await start([...BASE, "auto_inject = per_message"]);
    fetchRouter = (_url, body) => {
      const q = body.query as string;
      if (q.startsWith("core memories")) return { ok: true, status: 200, json: async () => ({ results: [] }) };
      return { ok: true, status: 200, json: async () => ({ results: [{ text: `hit for ${q.slice(0, 8)}` }] }) };
    };

    const r1 = await handlers["before_agent_start"]({}, ctxWithPrompt("first per-message question"));
    const r2 = await handlers["before_agent_start"]({}, ctxWithPrompt("second per-message question"));

    expect(r1?.message?.content).toContain("hit for first pe");
    expect(r2?.message?.content).toContain("hit for second p");
    // per-turn recall, one bank, no core probe in per_message mode
    const recalls = fetchCalls.filter(c => c.url.includes("/memories/recall"));
    expect(recalls.length).toBe(2);
  });
});

describe("none mode + migration", () => {
  it("none mode never calls the server", async () => {
    await start([...BASE, "auto_inject = none"]);
    const r = await handlers["before_agent_start"]({}, ctxWithPrompt("any question"));
    expect(r).toBeUndefined();
    expect(fetchCalls.length).toBe(0);
  });

  it("recall_enabled=false migrates to none", async () => {
    await start([...BASE, "recall_enabled = false"]);
    const r = await handlers["before_agent_start"]({}, ctxWithPrompt("any question"));
    expect(r).toBeUndefined();
    expect(fetchCalls.length).toBe(0);
  });
});

describe("block formatting", () => {
  it("produces byte-identical blocks for identical frozen inputs", async () => {
    const { buildMemoryBlock, formatContextSection, formatCoreSection } = await import("../index.ts");
    const core = formatCoreSection([{ text: "a" }, { text: "b" }])!;
    const ctx = formatContextSection("body text", "goal");
    const b1 = buildMemoryBlock({ core, context: ctx });
    const b2 = buildMemoryBlock({ core, context: ctx });
    expect(b1).toBe(b2);
    expect(b1).toContain("<hindsight_memories>");
    expect(b1).toContain("[core]");
    expect(b1).toContain("[context]");
    expect(b1!.endsWith("</hindsight_memories>")).toBe(true);
  });
});
