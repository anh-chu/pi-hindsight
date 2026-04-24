/**
 * Hindsight Self-Hosted Extension for Pi
 * Fully autonomous memory via lifecycle hooks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Debug Logging
// ---------------------------------------------------------------------------

const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
const LOG_PATH = join(homedir(), ".hindsight", "debug.log");

function log(msg: string) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
    appendFileSync(LOG_PATH, line);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Config & Helpers
// ---------------------------------------------------------------------------

interface HindsightConfig {
  api_url?: string;
  api_key?: string;
  global_bank?: string;
  recall_types?: string[];
  recall_budget?: string;
  recall_max_tokens?: number;
}

function parseConfigFile(filePath: string): Record<string, string> {
  const raw = readFileSync(filePath, "utf-8");
  const config: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/);
    if (match) config[match[1]] = match[2];
  }
  return config;
}
function getConfig(): HindsightConfig | null {
  try {
    const globalCfgPath = join(homedir(), ".hindsight", "config");
    if (!existsSync(globalCfgPath)) return null;

    const global = parseConfigFile(globalCfgPath);

    // Project-level override: .hindsight/config in CWD
    const localCfgPath = join(process.cwd(), ".hindsight", "config");
    const local = existsSync(localCfgPath) ? parseConfigFile(localCfgPath) : {};

    const merged = { ...global, ...local };

    const recallTypesRaw = merged.recall_types;
    const recall_types = recallTypesRaw
      ? recallTypesRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : ["observation"];
    const recall_budget = merged.recall_budget || "mid";
    const recall_max_tokens = merged.recall_max_tokens ? parseInt(merged.recall_max_tokens, 10) : undefined;
    return {
      api_url: merged.api_url,
      api_key: merged.api_key,
      global_bank: merged.global_bank || merged.bank_id,
      recall_types,
      recall_budget,
      recall_max_tokens,
    };
  } catch (e) {
    return null;
  }
}

function getProjectBank(): string {
  return `project-${basename(process.cwd())}`;
}

function getRecallBanks(config: HindsightConfig): string[] {
  const banks = new Set<string>();
  if (config.global_bank) banks.add(config.global_bank);
  banks.add(getProjectBank());
  return Array.from(banks);
}

function getRetainBanks(config: HindsightConfig, prompt: string): string[] {
  const banks = new Set<string>();
  banks.add(getProjectBank());
  
  // Opt-in for global bank retention
  if (config.global_bank && (prompt.includes("#global") || prompt.includes("#me"))) {
    banks.add(config.global_bank);
  }
  return Array.from(banks);
}

function getLastUserMessage(ctx: any, fallbackPrompt: string): string {
  try {
    const entries = ctx.sessionManager?.getEntries() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message?.role === "user") {
        return typeof e.message.content === "string" 
          ? e.message.content 
          : JSON.stringify(e.message.content);
      }
    }
  } catch (e) {}
  return fallbackPrompt;
}



async function getBankMission(config: HindsightConfig, bank: string): Promise<string | null> {
  try {
    const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, {
      headers: { "Authorization": `Bearer ${config.api_key || ""}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.mission || null;
  } catch (_) {
    return null;
  }
}

async function checkBankConfig(config: HindsightConfig, bank: string): Promise<
  | { ok: true; mission: string | null }
  | { ok: false; authError: boolean }
> {
  try {
    const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, {
      headers: { "Authorization": `Bearer ${config.api_key || ""}` }
    });
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true };
    if (!res.ok) return { ok: false, authError: false };
    const data = await res.json();
    return { ok: true, mission: data.mission || null };
  } catch (_) {
    return { ok: false, authError: false };
  }
}

async function getServerHealth(config: HindsightConfig): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(`${config.api_url}/health`, {
      headers: { "Authorization": `Bearer ${config.api_key || ""}` }
    });
    return { ok: res.ok, status: res.status };
  } catch (_) {
    return { ok: false };
  }
}

async function getBankStats(config: HindsightConfig, bank: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/stats`, {
      headers: { "Authorization": `Bearer ${config.api_key || ""}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

interface HookRecord {
  firedAt?: string;
  result?: "ok" | "failed" | "skipped" | "none";
  detail?: string;
}

const hookStats: {
  sessionStart: HookRecord;
  recall: HookRecord;
  retain: HookRecord;
} = {
  sessionStart: {},
  recall: {},
  retain: {},
};

function readRecentLogErrors(maxLines = 20): string[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    const content = readFileSync(LOG_PATH, "utf-8");
    return content
      .split("\n")
      .filter(l => l.trim())
      .slice(-maxLines);
  } catch (_) {
    return [];
  }
}
const OPERATIONAL_TOOLS = [
  "bash", "nu", "process", "read", "write", "edit", 
  "grep", "ast_grep_search", "ast_grep_replace", "lsp_navigation"
];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const MAX_RECALL_ATTEMPTS = 3;

export default function hindsightExtension(pi: ExtensionAPI) {
  let recallDone = false;
  let recallAttempts = 0;
  let currentPrompt = "";

  // Track user input for fallback
  pi.on("input", async (event: any) => {
    if (event.input) currentPrompt = event.input;
    else if (event.text) currentPrompt = event.text;
  });

  pi.on("session_start", async (_event, ctx) => {
    recallDone = false;
    recallAttempts = 0;
    hookStats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    hookStats.recall = {};
    hookStats.retain = {};
    ctx.ui.setStatus("hindsight", undefined);
    log("session_start: state reset");
    const config = getConfig();
  });

  pi.on("session_compact", async (_event, ctx) => {
    recallDone = false;
    recallAttempts = 0;
    ctx.ui.setStatus("hindsight", undefined);
    log("session_compact: state reset");
  });

  pi.registerMessageRenderer("hindsight-recall", (message, _options, theme) => {
    const count: number = (message.details as any)?.count ?? 0;
    const snippet: string = (message.details as any)?.snippet ?? "";
    let text = theme.fg("accent", "🧠 Hindsight");
    text += theme.fg("muted", ` recalled ${count} ${count === 1 ? "memory" : "memories"}`);
    if (snippet) {
      text += "\n" + theme.fg("dim", snippet);
    }
    return new Text(text, 0, 0);
  });


  pi.registerMessageRenderer("hindsight-retain", (message, _options, theme) => {
    const banks: string[] = (message.details as any)?.banks ?? [];
    let text = theme.fg("accent", "💾 Hindsight");
    text += theme.fg("muted", ` saved turn to memory`);
    if (banks.length > 0) {
      text += theme.fg("dim", ` → ${banks.join(", ")}`);
    }
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed", (_message, _options, theme) => {
    let text = theme.fg("error", "💾 Hindsight");
    text += theme.fg("muted", " retain failed — use ");
    text += theme.fg("accent", "hindsight_retain");
    text += theme.fg("muted", " to save manually");
    return new Text(text, 0, 0);
  });

  // -----------------------------------------------------------------------
  // Explicit Manual Tools (for when the background loop isn't enough)
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Recall relevant context, conventions, or past solutions from the team memory. Use this when the user explicitly asks you to search memory.",
    parameters: Type.Object({
      query: Type.String()
    }),
    async execute(_id, params) {
      const { query } = params as { query: string };
      const config = getConfig();
      if (!config || !config.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };

      const banks = getRecallBanks(config);
      try {
        const recallPromises = banks.map(async (bank) => {
          const reqBody: Record<string, any> = { query, budget: config.recall_budget, query_timestamp: new Date().toISOString(), types: config.recall_types };
          if (config.recall_max_tokens !== undefined) reqBody.max_tokens = config.recall_max_tokens;
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.api_key || ""}`
            },
            body: JSON.stringify(reqBody)
          });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.results || []).map((r: any) => `[Bank: ${bank}] - ${r.text}`);
        });

        const resultsArrays = await Promise.all(recallPromises);
        const allResults = resultsArrays.flat();
        if (allResults.length > 0) {
          return { content: [{ type: "text" as const, text: allResults.join("\n\n") }], details: {} };
        }
        return { content: [{ type: "text" as const, text: "No memories found." }], details: {} };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    }
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: "Force-save an explicit insight to memory. Only use when explicitly requested by the user, as normal conversation is auto-retained.",
    parameters: Type.Object({
      content: Type.String({ description: "The rich context to save" })
    }),
    async execute(_id, params) {
      const { content } = params as { content: string };
      const config = getConfig();
      if (!config || !config.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };

      const bank = getProjectBank();
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key || ""}`
          },
          body: JSON.stringify({ items: [{ content, context: "pi coding session: explicit user save", timestamp: new Date().toISOString() }], async: false })
        });
        if (res.ok) return { content: [{ type: "text" as const, text: "Memory explicitly retained." }], details: {} };
        return { content: [{ type: "text" as const, text: "Failed to retain memory." }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    }
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description: "Synthesize context from memory to answer a question.",
    parameters: Type.Object({
      query: Type.String()
    }),
    async execute(_id, params) {
      const { query } = params as { query: string };
      const config = getConfig();
      if (!config || !config.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };

      const bank = getProjectBank();
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/reflect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key || ""}`
          },
          body: JSON.stringify({ query })
        });
        if (res.ok) {
          const data = await res.json();
          return { content: [{ type: "text" as const, text: data.synthesis || JSON.stringify(data) }], details: {} };
        }
        return { content: [{ type: "text" as const, text: "Failed to reflect." }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    }
  });

  // -----------------------------------------------------------------------
  pi.on("before_agent_start", async (_event, ctx) => {
    if (recallDone) {
      log("before_agent_start: skip (recallDone=true)");
      return;
    }
    if (recallAttempts >= MAX_RECALL_ATTEMPTS) {
      log(`before_agent_start: skip (max attempts ${MAX_RECALL_ATTEMPTS} reached)`);
      return;
    }

    recallAttempts++;
    log(`before_agent_start: attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS}`);

    const config = getConfig();
    if (!config || !config.api_url) {
      log("before_agent_start: no config, giving up");
      recallAttempts = MAX_RECALL_ATTEMPTS; // don't retry — config won't change mid-session
      ctx.ui.setStatus("hindsight", "⚠ not configured");
      return;
    }

    const lastUserPrompt = getLastUserMessage(ctx, currentPrompt) || "Provide context for current project";
    const banks = getRecallBanks(config);
    log(`before_agent_start: querying banks=${banks.join(",")} prompt="${lastUserPrompt.slice(0, 80)}"`);

    try {
      let anyBankSucceeded = false;
      let authFailed = false;
      const recallPromises = banks.map(async (bank) => {
        const reqBody: Record<string, any> = { query: lastUserPrompt, budget: config.recall_budget, query_timestamp: new Date().toISOString(), types: config.recall_types };
        if (config.recall_max_tokens !== undefined) reqBody.max_tokens = config.recall_max_tokens;
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key || ""}`
          },
          body: JSON.stringify(reqBody)
        });

        if (!res.ok) {
          log(`before_agent_start: bank=${bank} HTTP ${res.status}`);
          if (res.status === 401 || res.status === 403) authFailed = true;
          return [];
        }
        anyBankSucceeded = true;
        const data = await res.json();
        const results = (data.results || []).map((r: any) => `[Bank: ${bank}] - ${r.text}`);
        log(`before_agent_start: bank=${bank} got ${results.length} results`);
        return results;
      });

      const resultsArrays = await Promise.all(recallPromises);

      if (authFailed) {
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
        recallAttempts = MAX_RECALL_ATTEMPTS; // auth won't fix itself mid-session
        ctx.ui.setStatus("hindsight", "✗ auth error — check api_key");
        log("before_agent_start: auth error, giving up");
        return;
      }

      if (anyBankSucceeded) {
        recallDone = true;
        ctx.ui.setStatus("hindsight", undefined);
        const allResults = resultsArrays.flat();
        if (allResults.length > 0) {
          hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: `${allResults.length} memories` };
          log(`before_agent_start: injecting ${allResults.length} memories into context`);
          const memoriesStr = allResults.join("\n\n");
          const content = `<hindsight_memories>\nRelevant memories from past conversations:\n\n${memoriesStr}\n</hindsight_memories>`;
          const count = allResults.length;
          const snippet = allResults
            .slice(0, 3)
            .map((r: string) => r.replace(/^\[Bank: [^\]]+\] - /, ""))
            .join(" \u00b7 ")
            .slice(0, 200);
          return {
            message: {
              customType: "hindsight-recall",
              content,
              display: true,
              details: { count, snippet }
            }
          };
        } else {
          hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: "vault empty" };
          log("before_agent_start: no memories found (empty vault)");
        }
      } else {
        const isLastAttempt = recallAttempts >= MAX_RECALL_ATTEMPTS;
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: isLastAttempt ? "unreachable" : "retrying" };
        ctx.ui.setStatus("hindsight", isLastAttempt ? "✗ recall unavailable" : "⚠ recall failed (retrying)");
        log(`before_agent_start: all banks failed, will retry (attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS})`);
      }
    } catch (e) {
      const isLastAttempt = recallAttempts >= MAX_RECALL_ATTEMPTS;
      ctx.ui.setStatus("hindsight", isLastAttempt ? "✗ recall unavailable" : "⚠ recall failed (retrying)");
      log(`before_agent_start: error ${e}, will retry (attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS})`);
    }
  });

  // -----------------------------------------------------------------------
  // Auto-Retain (agent_end)
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (event: any, ctx) => {
    log("agent_end: fired");
    const config = getConfig();
    if (!config || !config.api_url) {
      log("agent_end: no config, skipping");
      return;
    }

    const lastUserPrompt = getLastUserMessage(ctx, currentPrompt);
    const sessionId = ctx.sessionManager?.getSessionId?.() || `unknown-${Date.now()}`;
    if (!lastUserPrompt) {
      log("agent_end: no user prompt found, skipping");
      return;
    }

    // Skip trivial interactions
    if (lastUserPrompt.length < 5 || /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i.test(lastUserPrompt.trim())) {
      log(`agent_end: trivial prompt, skipping retain`);
      return;
    }

    // Opt-out mechanism
    if (lastUserPrompt.trim().startsWith("#nomem") || lastUserPrompt.trim().startsWith("#skip")) {
      log("agent_end: opt-out tag, skipping retain");
      return;
    }

    let transcript = `[role: user]\n${lastUserPrompt}\n[user:end]\n\n[role: assistant]\n`;

    const messages = event.messages || [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      const content = msg.content;
      if (typeof content === "string") {
        transcript += `${content}\n`;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            transcript += `${block.text}\n`;
          } else if (block.type === "tool_use") {
            if (!OPERATIONAL_TOOLS.includes(block.name)) {
              transcript += `[Tool Use: ${block.name}]\n`;
              if (block.input) {
                transcript += `${JSON.stringify(block.input)}\n`;
              }
            }
          }
        }
      }
    }
    
    transcript += `[assistant:end]`;
    // Extract explicit #tags from the user prompt (ignoring our reserved control tags)
    const reservedTags = new Set(["nomem", "skip", "global", "me"]);
    const extractedTags = Array.from(lastUserPrompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
      .map(match => match[1].toLowerCase())
      .filter(tag => !reservedTags.has(tag));

    // Strip memory tags to prevent feedback loop
    transcript = transcript.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "");
    transcript = transcript.trim();

    if (transcript.length < 20) return;

    // Hard-cap massive transcripts (e.g. agent printing full file out) to avoid bombing server
    if (transcript.length > 50000) {
      transcript = transcript.slice(0, 50000) + "\n...[TRUNCATED]";
    }

    try {
      const banks = getRetainBanks(config, lastUserPrompt);
      log(`agent_end: retaining to banks=${banks.join(",")} transcript_len=${transcript.length} tags=${extractedTags.join(",")}`);

      const results = await Promise.allSettled(
        banks.map(async (bank) => {
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.api_key || ""}`
            },
            body: JSON.stringify({
              items: [{
                content: transcript,
                document_id: `session-${sessionId}`,
                update_mode: "append",
                context: `pi coding session: ${lastUserPrompt.slice(0, 100)}`,
                timestamp: new Date().toISOString(),
                ...(extractedTags.length > 0 && { tags: extractedTags })
              }],
              async: true
            })
          });
          log(`agent_end: bank=${bank} retain HTTP ${res.status}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return bank;
        })
      );

      const succeededBanks = results
        .filter(r => r.status === "fulfilled")
        .map(r => (r as PromiseFulfilledResult<string>).value);
      const allFailed = succeededBanks.length === 0;
      hookStats.retain = {
        firedAt: new Date().toISOString(),
        result: allFailed ? "failed" : "ok",
        detail: allFailed ? "all banks unreachable" : succeededBanks.join(", "),
      };
      if (allFailed) {
        log("agent_end: all banks failed — sending next-turn notification");
        ctx.ui.setStatus("hindsight", "⚠ retain failed");
        pi.sendMessage(
          {
            customType: "hindsight-retain-failed",
            content: "",
            display: true,
          },
          { deliverAs: "nextTurn" }
        );
      } else {
        ctx.ui.setStatus("hindsight", undefined);
        pi.sendMessage(
          {
            customType: "hindsight-retain",
            content: "",
            display: true,
            details: { banks: succeededBanks },
          },
          { deliverAs: "nextTurn" }
        );
      }
    } catch (e) {
      log(`agent_end: error ${e}`);
    }
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------
  pi.registerCommand("hindsight", {
    description: "Show Hindsight status. Usage: /hindsight [status | stats | config]",
    handler: async (args: any, ctx) => {
      const config = getConfig();
      if (!config) {
        ctx.ui.notify("Hindsight config not found. Create ~/.hindsight/config", "error");
        return;
      }

      const argsStr = (typeof args === "string" ? args : "").trim();


      if (argsStr === "status") {
        const lines: string[] = [];
        let hasError = false;

        // Config
        lines.push(`URL:    ${config.api_url || "Not set"}`);
        if (!config.api_url) { lines.push("  ✗ api_url missing"); hasError = true; }
        if (!config.api_key) { lines.push("  ⚠ api_key not set"); }

        // Server health
        const health = await getServerHealth(config);
        lines.push(`Server: ${health.ok ? "✓ online" : `✗ unreachable${health.status ? ` (HTTP ${health.status})` : ""}`}`);
        if (!health.ok) hasError = true;

        // Project bank: auth + mission
        const bank = getProjectBank();
        lines.push(`Bank:   ${bank}`);
        const bankCheck = await checkBankConfig(config, bank);
        if (!bankCheck.ok) {
          lines.push(`  ✗ ${bankCheck.authError ? "auth invalid — check api_key" : "bank unreachable"}`);
          hasError = true;
        } else {
          lines.push(`  ✓ auth ok`);
        }

        if (config.global_bank) lines.push(`Global: ${config.global_bank}`);
        // Hook state
        lines.push("");
        lines.push("Hooks this session:");
        const hookIcon = (r?: string) => r === "ok" ? "✓" : r === "failed" ? "✗" : r === "skipped" ? "−" : "…";
        const fmtHook = (h: HookRecord) =>
          h.firedAt ? `${hookIcon(h.result)} ${h.result}${h.detail ? ` (${h.detail})` : ""}` : "not fired";
        lines.push(`  session_start:      ${fmtHook(hookStats.sessionStart)}`);
        lines.push(`  recall:             ${fmtHook(hookStats.recall)}`);
        lines.push(`  retain:             ${fmtHook(hookStats.retain)}`);

        // Debug log
        lines.push("");
        if (DEBUG) {
          const logLines = readRecentLogErrors(10);
          lines.push(`Debug log (last ${logLines.length} lines):`);
          logLines.forEach(l => lines.push(`  ${l}`));
        } else {
          lines.push("Debug log: disabled (set HINDSIGHT_DEBUG=1 to enable)");
        }
        ctx.ui.notify(lines.join("\n"), hasError ? "error" : "info");
        return;
      }

      if (argsStr === "stats") {
        const banks = getRecallBanks(config);
        const allStats = await Promise.all(
          banks.map(async (bank) => {
            const stats = await getBankStats(config, bank);
            return { bank, stats };
          })
        );
        const lines = allStats.map(({ bank, stats }) => {
          if (!stats) return `${bank}: unavailable`;
          const entries = Object.entries(stats)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n");
          return `${bank}:\n${entries}`;
        });
        ctx.ui.notify(lines.join("\n\n"), "info");
        return;
      }
      const status = [
        `URL: ${config.api_url || "Not set"}`,
        `Global Bank: ${config.global_bank || "Not set"}`,
        `Project Bank (Recall & Default Retain): ${getProjectBank()}`,
        `Active Recall Banks: ${getRecallBanks(config).join(", ")}`,
        `Commands: /hindsight status | stats | mission [text]`,
      ].join("\n");
      ctx.ui.notify(status, "info");
    },
  });
}
