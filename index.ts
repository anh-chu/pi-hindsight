/**
 * Hindsight Self-Hosted Extension for Pi
 * Fully autonomous memory via lifecycle hooks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Debug Logging
// ---------------------------------------------------------------------------

const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
const LOG_PATH = join(homedir(), ".hindsight", "debug.log");
let sessionCwd: string = process.cwd();

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
  project_bank_id?: string;
  recall_types?: string[];
  recall_budget?: string;
  recall_max_tokens?: number;
  recall_timeout?: number;
  async_retain?: boolean;
  retain_feedback?: "message" | "status" | "both" | "none";
  recall_enabled?: boolean;
  retain_enabled?: boolean;
  homedir_project?: boolean;
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
    const localCfgPath = join(sessionCwd, ".hindsight", "config");
    const local = existsSync(localCfgPath) ? parseConfigFile(localCfgPath) : {};

    const merged = applyAliases({ ...global, ...local });

    const recallTypesRaw = merged.recall_types;
    const recall_types = recallTypesRaw
      ? recallTypesRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : ["observation"];
    const recall_budget = merged.recall_budget || "mid";
    const recall_max_tokens = merged.recall_max_tokens ? parseInt(merged.recall_max_tokens, 10) : undefined;
    const recall_timeout = merged.recall_timeout ? parseInt(merged.recall_timeout, 10) : undefined;
    const async_retain = merged.async_retain === "false" ? false : true;
    const retain_feedback: "message" | "status" | "both" | "none" = (merged.retain_feedback as any) || "status";
    const recall_enabled = merged.recall_enabled === "false" ? false : true;
    const retain_enabled = merged.retain_enabled === "false" ? false : true;
    const homedir_project = merged.homedir_project === "false" ? false : true;
    return {
      api_url: merged.api_url,
      api_key: merged.api_key,
      global_bank: merged.global_bank,
      project_bank_id: merged.project_bank_id,
      recall_types,
      recall_budget,
      recall_max_tokens,
      recall_timeout,
      async_retain,
      retain_feedback,
      recall_enabled,
      retain_enabled,
      homedir_project,
    };
  } catch (e) {
    return null;
  }
}

function writeConfigValue(filePath: string, key: string, value: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  let lines: string[] = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, "utf-8").split("\n");
  }
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex(l => pattern.test(l));
  const newLine = `${key} = "${value}"`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(newLine);
  }
  writeFileSync(filePath, lines.join("\n") + "\n");
}

// Legacy key aliases: old_key → canonical_key
const CONFIG_ALIASES: Record<string, string> = {
  bank_id: "global_bank",
  max_tokens: "recall_max_tokens",
};

function applyAliases(raw: Record<string, string>): Record<string, string> {
  const result = { ...raw };
  for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
    if (result[oldKey] !== undefined && result[newKey] === undefined) {
      result[newKey] = result[oldKey];
    }
  }
  return result;
}

function detectLegacyKeys(): { file: string; key: string; canonical: string }[] {
  const issues: { file: string; key: string; canonical: string }[] = [];
  const globalCfgPath = join(homedir(), ".hindsight", "config");
  const localCfgPath = join(sessionCwd, ".hindsight", "config");
  const isHomeDir = sessionCwd === homedir();
  const files = [globalCfgPath];
  if (!isHomeDir && existsSync(localCfgPath)) files.push(localCfgPath);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = parseConfigFile(file);
    for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
      if (raw[oldKey] !== undefined && raw[newKey] === undefined) {
        issues.push({ file, key: oldKey, canonical: newKey });
      }
    }
  }
  return issues;
}

function migrateConfigFile(filePath: string): string[] {
  const migrated: string[] = [];
  if (!existsSync(filePath)) return migrated;
  let lines = readFileSync(filePath, "utf-8").split("\n");
  for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
    const pattern = new RegExp(`^(\\s*)${oldKey}(\\s*=)`);
    const idx = lines.findIndex(l => pattern.test(l));
    if (idx >= 0) {
      // Only migrate if canonical key doesn't already exist
      const hasCanonical = lines.some(l => new RegExp(`^\\s*${newKey}\\s*=`).test(l));
      if (!hasCanonical) {
        lines[idx] = lines[idx].replace(pattern, `$1${newKey}$2`);
        migrated.push(`${oldKey} → ${newKey}`);
      }
    }
  }
  if (migrated.length > 0) {
    writeFileSync(filePath, lines.join("\n"));
  }
  return migrated;
}

function getConfigWithSource(): { global: Record<string, string>; local: Record<string, string>; merged: Record<string, string>; isHomeDir: boolean } {
  const globalCfgPath = join(homedir(), ".hindsight", "config");
  const localCfgPath = join(sessionCwd, ".hindsight", "config");
  const isHomeDir = sessionCwd === homedir();
  const globalRaw = existsSync(globalCfgPath) ? parseConfigFile(globalCfgPath) : {};
  const localRaw = (!isHomeDir && existsSync(localCfgPath)) ? parseConfigFile(localCfgPath) : {};
  const global = applyAliases(globalRaw);
  const local = applyAliases(localRaw);
  return { global, local, merged: { ...global, ...local }, isHomeDir };
}

function getProjectBank(config?: HindsightConfig | null): string {
  if (config?.project_bank_id) return config.project_bank_id;
  return `project-${basename(sessionCwd)}`;
}

function isHomeDirSession(): boolean {
  return sessionCwd === homedir();
}

function getRecallBanks(config: HindsightConfig): string[] {
  const banks = new Set<string>();
  if (config.global_bank) banks.add(config.global_bank);
  // Skip project bank in homedir when homedir_project is disabled
  if (!(isHomeDirSession() && config.homedir_project === false)) {
    banks.add(getProjectBank(config));
  }
  return Array.from(banks);
}

function getRetainBanks(config: HindsightConfig, prompt: string): string[] {
  const banks = new Set<string>();
  const skipProject = isHomeDirSession() && config.homedir_project === false;
  if (!skipProject) {
    banks.add(getProjectBank(config));
  }
  // When homedir_project=false, skip auto-retain entirely — explicit hindsight_retain still works

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
// Mission Auto-Setup Cache
// ---------------------------------------------------------------------------

interface MissionCache {
  global: Record<string, number>;
  project: Record<string, number>;
}

export const GLOBAL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const PROJECT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export const GLOBAL_RETAIN_MISSION = "Focus on user preferences, communication style, workflow habits, and recurring patterns across projects. Deprioritize one-time events and project-specific implementation details.";
export const GLOBAL_OBSERVATIONS_MISSION = "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Focus on what the user consistently does or prefers — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.";

export const PROJECT_RETAIN_MISSION = "Focus on coding conventions, architecture decisions, tech stack choices, project-specific patterns, and user preferences within this codebase. Deprioritize one-time events and transient debugging steps.";
export const PROJECT_OBSERVATIONS_MISSION = "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Also capture key project context: architecture decisions, tech stack choices, known constraints, and established patterns in the codebase. Focus on what persists across sessions — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.";

export function getMissionCachePath(): string {
  return join(homedir(), ".hindsight", "mission-cache.json");
}

export function loadMissionCache(): MissionCache {
  try {
    const path = getMissionCachePath();
    if (!existsSync(path)) {
      return { global: {}, project: {} };
    }
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data);
  } catch (_) {
    return { global: {}, project: {} };
  }
}

export function saveMissionCache(cache: MissionCache): void {
  try {
    const path = getMissionCachePath();
    mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch (_) {}
}

export function isCacheStale(timestamp: number, isGlobal: boolean): boolean {
  if (!timestamp) return true;
  const ttl = isGlobal ? GLOBAL_TTL_SECONDS : PROJECT_TTL_SECONDS;
  return Date.now() / 1000 - timestamp > ttl;
}

export async function setupBankMission(
  config: HindsightConfig,
  bank: string,
  isGlobal: boolean
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const getRes = await fetch(`${config.api_url}/v1/default/banks/${bank}/config`, {
      headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!getRes.ok) return;
    const getData = await getRes.json();
    const cfg = getData.config || {};
    if (cfg.retain_mission != null && cfg.observations_mission != null) return;

    const retainMission = isGlobal ? GLOBAL_RETAIN_MISSION : PROJECT_RETAIN_MISSION;
    const observationsMission = isGlobal ? GLOBAL_OBSERVATIONS_MISSION : PROJECT_OBSERVATIONS_MISSION;
    const updates: Record<string, string> = {};
    if (cfg.retain_mission == null) updates.retain_mission = retainMission;
    if (cfg.observations_mission == null) updates.observations_mission = observationsMission;
    if (Object.keys(updates).length === 0) return;

    const patchController = new AbortController();
    const patchTimeout = setTimeout(() => patchController.abort(), 10000);
    const patchRes = await fetch(`${config.api_url}/v1/default/banks/${bank}/config`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.api_key || ""}`
      },
      body: JSON.stringify({ updates }),
      signal: patchController.signal
    });
    clearTimeout(patchTimeout);
    if (patchRes.ok) {
      const cache = loadMissionCache();
      const cacheKey = isGlobal ? "global" : "project";
      if (!cache[cacheKey]) cache[cacheKey] = {};
      cache[cacheKey][bank] = Math.floor(Date.now() / 1000);
      saveMissionCache(cache);
      log(`setupBankMission: ${bank} updated (global=${isGlobal})`);
    }
  } catch (_) {}
}

export async function runMissionAutoSetup(config: HindsightConfig): Promise<void> {
  const cache = loadMissionCache();
  const banksToCheck: { bank: string; isGlobal: boolean }[] = [];
  if (config.global_bank) {
    banksToCheck.push({ bank: config.global_bank, isGlobal: true });
  }
  const projectBank = getProjectBank(config);
  if (projectBank) {
    banksToCheck.push({ bank: projectBank, isGlobal: false });
  }
  for (const { bank, isGlobal } of banksToCheck) {
    const cacheKey = isGlobal ? "global" : "project";
    const entry = cache[cacheKey]?.[bank];
    if (!isCacheStale(entry, isGlobal)) continue;
    await setupBankMission(config, bank, isGlobal);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const MAX_RECALL_ATTEMPTS = 3;

export default function hindsightExtension(pi: ExtensionAPI) {
  let recallDone = false;
  let recallAttempts = 0;
  let retainSuccessCount = 0;
  let retainEligibleCount = 0;
  let currentPrompt = "";

  // Track user input for fallback
  pi.on("input", async (event: any) => {
    if (event.input) currentPrompt = event.input;
    else if (event.text) currentPrompt = event.text;
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd || process.cwd();
    recallDone = false;
    recallAttempts = 0;
    hookStats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    hookStats.recall = {};
    hookStats.retain = {};
    retainSuccessCount = 0;
    retainEligibleCount = 0;
    ctx.ui.setStatus("hindsight", undefined);
    log("session_start: state reset");
    const config = getConfig();
    if (config) {
      const banks = getRecallBanks(config);
      if (banks.length === 0) {
        ctx.ui.setStatus("hindsight", "⚠ no banks — /hindsight settings to configure");
        ctx.ui.notify(
          "Hindsight has no active banks. Memory recall and retain are disabled.\n" +
          "\n" +
          "Fix: run /hindsight settings and set global_bank, or set homedir_project = true.",
          "warning"
        );
        log("session_start: no active banks — global_bank not set and homedir_project=false in home dir");
      }
      const legacyIssues = detectLegacyKeys();
      if (legacyIssues.length > 0) {
        const keys = legacyIssues.map(i => `${i.key} → ${i.canonical}`).join(", ");
        ctx.ui.setStatus("hindsight", "⚠ outdated config — run /hindsight doctor");
        ctx.ui.notify(
          `Your config uses deprecated keys: ${keys}\n` +
          "Run /hindsight doctor to auto-migrate, or update manually.",
          "warning"
        );
        log(`session_start: legacy keys detected: ${keys}`);
      }

      // Fire-and-forget warm-up ping to wake server before before_agent_start
      if (config.api_url) {
        fetch(`${config.api_url}/health`, {
          headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        }).then(() => log("session_start: warm-up ping ok"))
          .catch(() => log("session_start: warm-up ping failed (server may be cold)"));
      }

      // Fire-and-forget mission auto-setup
      runMissionAutoSetup(config).catch(() => {});
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    sessionCwd = ctx.cwd || process.cwd();
    recallDone = false;
    recallAttempts = 0;
    retainSuccessCount = 0;
    retainEligibleCount = 0;
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
    text += theme.fg("muted", " retain failed - use ");
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
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), config.recall_timeout ?? 10000);
          try {
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.api_key || ""}`
              },
              body: JSON.stringify(reqBody),
              signal: controller.signal
            });
            if (!res.ok) return [];
            const data = await res.json();
            return (data.results || []).map((r: any) => `[Bank: ${bank}] - ${r.text}`);
          } catch (e: any) {
            log(`hindsight_recall: bank=${bank} error ${e}`);
            return [];
          } finally {
            clearTimeout(timeout);
          }
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

      const isHomeDirNoProject = isHomeDirSession() && config.homedir_project === false;
      const bank = isHomeDirNoProject
        ? (config.global_bank ?? null)
        : getProjectBank(config);
      if (!bank) return { content: [{ type: "text" as const, text: "Hindsight: no bank available. Set global_bank in ~/.hindsight/config." }], details: {}, isError: true };
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

      const bank = getProjectBank(config);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.recall_timeout ?? 10000);
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/reflect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key || ""}`
          },
          body: JSON.stringify({ query }),
          signal: controller.signal
        });
        clearTimeout(timeout);
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
      recallAttempts = MAX_RECALL_ATTEMPTS; // don't retry - config won't change mid-session
      ctx.ui.setStatus("hindsight", "⚠ not configured");
      return;
    }

    if (config.recall_enabled === false) {
      log("before_agent_start: recall disabled by config");
      recallDone = true;
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
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
          log(`before_agent_start: bank=${bank} timed out`);
        }, config.recall_timeout ?? 10000);
        try {
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.api_key || ""}`
            },
            body: JSON.stringify(reqBody),
            signal: controller.signal
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
        } catch (e: any) {
          log(`before_agent_start: bank=${bank} error ${e}`);
          return [];
        } finally {
          clearTimeout(timeout);
        }
      });

      const resultsArrays = await Promise.all(recallPromises);

      if (authFailed) {
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
        recallAttempts = MAX_RECALL_ATTEMPTS; // auth won't fix itself mid-session
        ctx.ui.setStatus("hindsight", "✗ auth error - check api_key");
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

    if (config.retain_enabled === false) {
      log("agent_end: retain disabled by config");
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

    const banks = getRetainBanks(config, lastUserPrompt);

    // Count this attempt (before the retain APIs)
    retainEligibleCount++;

    // Async retain: fire and forget, don't block
    if (config.async_retain !== false) {
      log("agent_end: async retain fired (not awaiting)");
      const retainPromise = Promise.allSettled(
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
      retainPromise.then((results) => {
        const succeededBanks = results
          .filter(r => r.status === "fulfilled")
          .map(r => (r as PromiseFulfilledResult<string>).value);
        const allFailed = succeededBanks.length === 0;
        hookStats.retain = {
          firedAt: new Date().toISOString(),
          result: allFailed ? "failed" : "ok",
          detail: allFailed ? "all banks unreachable" : succeededBanks.join(", "),
        };
        if (!allFailed) retainSuccessCount++;
        const showMessage = config.retain_feedback === "message" || config.retain_feedback === "both";
        const showStatus = config.retain_feedback === "status" || config.retain_feedback === "both" || !config.retain_feedback;
        if (allFailed) {
          log("agent_end: async retain - all banks failed");
          pi.sendMessage(
            { customType: "hindsight-retain-failed", content: "", display: true },
            { deliverAs: "nextTurn" }
          );
          if (showStatus) {
            ctx.ui.setStatus("hindsight", `Memorized: ${retainSuccessCount}/${retainEligibleCount}`);
          }
        } else {
          log(`agent_end: async retain - succeeded banks=${succeededBanks.join(",")}`);
          if (showStatus) {
            ctx.ui.setStatus("hindsight", `Memorized: ${retainSuccessCount}/${retainEligibleCount}`);
          }
          if (showMessage) {
            pi.sendMessage(
              { customType: "hindsight-retain", content: "", display: true, details: { banks: succeededBanks } },
              { deliverAs: "nextTurn" }
            );
          }
        }
      });
      return;
    }

    // Sync retain (original behavior)
    try {
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
      if (!allFailed) retainSuccessCount++;
      const showMessage = config.retain_feedback === "message" || config.retain_feedback === "both";
      const showStatus = config.retain_feedback === "status" || config.retain_feedback === "both" || !config.retain_feedback;
      if (allFailed) {
        log("agent_end: all banks failed - sending next-turn notification");
        if (showStatus) {
          ctx.ui.setStatus("hindsight", `Memorized: ${retainSuccessCount}/${retainEligibleCount}`);
        }
        pi.sendMessage(
          {
            customType: "hindsight-retain-failed",
            content: "",
            display: true,
          },
          { deliverAs: "nextTurn" }
        );
      } else {
        if (showStatus) {
          ctx.ui.setStatus("hindsight", `Memorized: ${retainSuccessCount}/${retainEligibleCount}`);
        } else {
          ctx.ui.setStatus("hindsight", undefined);
        }
        if (showMessage) {
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
      }
    } catch (e) {
      log(`agent_end: error ${e}`);
    }
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------
  pi.registerCommand("hindsight", {
    description: "Hindsight memory. Usage: /hindsight [status | stats | settings | doctor]",
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
        const bank = getProjectBank(config);
        lines.push(`Bank:   ${bank}`);
        const bankCheck = await checkBankConfig(config, bank);
        if (!bankCheck.ok) {
          lines.push(`  ✗ ${bankCheck.authError ? "auth invalid - check api_key" : "bank unreachable"}`);
          hasError = true;
        } else {
          lines.push(`  ✓ auth ok`);
        }

        if (config.global_bank) lines.push(`Global: ${config.global_bank}`);
        // Hook state
        lines.push("");
        lines.push("Hooks this session:");
        const hookIcon = (r?: string) => r === "ok" ? "✓" : r === "failed" ? "✗" : r === "skipped" ? "-" : "...";
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

      if (argsStr === "settings") {
        const globalCfgPath = join(homedir(), ".hindsight", "config");
        const localCfgPath = join(sessionCwd, ".hindsight", "config");
        let cfg = getConfigWithSource();
        const isHomeDir = cfg.isHomeDir;

        const settingsMeta = [
          { key: "api_url", label: "API URL", isBool: false, default: "(required)" },
          { key: "api_key", label: "API Key", isBool: false, default: "(required)" },
          { key: "global_bank", label: "Global Bank", isBool: false, default: "(not set)" },
          { key: "project_bank_id", label: "Project Bank Override", isBool: false, default: "(auto)" },
          { key: "recall_enabled", label: "Auto-Recall", isBool: true, default: "true" },
          { key: "retain_enabled", label: "Auto-Retain", isBool: true, default: "true" },
          { key: "async_retain", label: "Async Retain", isBool: true, default: "true" },
          { key: "retain_feedback", label: "Retain Feedback", isBool: false, default: "status" },
          { key: "homedir_project", label: "Home Dir as Project", isBool: true, default: "true" },
          { key: "recall_types", label: "Recall Types", isBool: false, default: "observation" },
          { key: "recall_budget", label: "Recall Budget", isBool: false, default: "mid" },
          { key: "recall_max_tokens", label: "Max Tokens", isBool: false, default: "(default)" },
        ];

        const DONE_LABEL = "← Done";

        const buildOptions = () => {
          const options: string[] = [];
          if (isHomeDir) options.push("⚠ CWD is home dir - all saves go to global config");
          for (const s of settingsMeta) {
            const val = cfg.merged[s.key] ?? s.default;
            const src = cfg.local[s.key] !== undefined ? "project" : cfg.global[s.key] !== undefined ? "global" : "default";
            options.push(`${s.label}: ${s.key === "api_key" && val !== s.default ? "****" : val} [${src}]`);
          }
          options.push(DONE_LABEL);
          return options;
        };

        while (true) {
          const options = buildOptions();
          const choice = await ctx.ui.select("Hindsight Settings", options);
          if (!choice || choice === DONE_LABEL || choice.startsWith("⚠")) {
            if (choice?.startsWith("⚠")) continue;
            break;
          }

          // Find which setting was picked
          const selected = settingsMeta.find(s => choice.startsWith(s.label + ":"));
          if (!selected) continue;

          const currentVal = cfg.merged[selected.key];
          let newValue: string | undefined;

          if (selected.isBool) {
            // Toggle boolean
            const curBool = currentVal !== "false";
            const toggleChoice = await ctx.ui.select(
              `${selected.label} (currently ${curBool ? "on" : "off"})`,
              ["On", "Off", "← Cancel"]
            );
            if (!toggleChoice || toggleChoice === "← Cancel") continue;
            newValue = toggleChoice === "On" ? "true" : "false";
          } else {
            // Text input
            const inputVal = await ctx.ui.input(
              `${selected.label}:`,
              currentVal || ""
            );
            if (inputVal === undefined || inputVal === "") continue;
            newValue = inputVal;
          }

          // Determine save target
          let saveGlobal = true;
          let saveLocal = false;
          if (!isHomeDir) {
            const target = await ctx.ui.select(
              `Save ${selected.label} to:`,
              ["Project (.hindsight/config)", "Global (~/.hindsight/config)", "← Cancel"]
            );
            if (!target || target === "← Cancel") continue;
            saveGlobal = target.startsWith("Global");
            saveLocal = target.startsWith("Project");
          }

          if (saveGlobal) writeConfigValue(globalCfgPath, selected.key, newValue);
          if (saveLocal) writeConfigValue(localCfgPath, selected.key, newValue);

          // Refresh merged view
          cfg = getConfigWithSource();
          ctx.ui.notify(`${selected.label} → ${selected.key === "api_key" ? "****" : newValue}`, "info");
        }
        return;
      }

      if (argsStr === "doctor") {
        const issues = detectLegacyKeys();
        if (issues.length === 0) {
          ctx.ui.notify("No issues found. Config is up to date.", "info");
          return;
        }

        const summary = issues.map(i => `  ${i.key} \u2192 ${i.canonical} in ${i.file}`).join("\n");
        ctx.ui.notify(`Legacy config keys found:\n${summary}`, "warning");

        const ok = await ctx.ui.confirm(
          "Migrate config?",
          `This will rename legacy keys in your config file(s). The old values are preserved, only the key names change.`
        );
        if (!ok) {
          ctx.ui.notify("Migration skipped. You can edit config files manually.", "info");
          return;
        }

        const migrated: string[] = [];
        const seen = new Set<string>();
        for (const issue of issues) {
          if (seen.has(issue.file)) continue;
          seen.add(issue.file);
          const result = migrateConfigFile(issue.file);
          migrated.push(...result.map(r => `${r} in ${issue.file}`));
        }

        if (migrated.length > 0) {
          ctx.ui.setStatus("hindsight", undefined);
          ctx.ui.notify(`Migrated:\n  ${migrated.join("\n  ")}`, "info");
        } else {
          ctx.ui.notify("Nothing to migrate.", "info");
        }
        return;
      }

      const status = [
        `URL: ${config.api_url || "Not set"}`,
        `Global Bank: ${config.global_bank || "Not set"}`,
        `Project Bank (Recall & Default Retain): ${getProjectBank(config)}`,
        `Active Recall Banks: ${getRecallBanks(config).join(", ")}`,
        `Commands: /hindsight status | stats | settings | doctor`,
      ].join("\n");
      ctx.ui.notify(status, "info");
    },
  });
}
