/**
 * Hindsight Self-Hosted Extension for Pi
 * Fully autonomous memory via lifecycle hooks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
}

function getConfig(): HindsightConfig | null {
  try {
    const cfgPath = join(homedir(), ".hindsight", "config");
    if (!existsSync(cfgPath)) return null;
    
    const content = readFileSync(cfgPath, "utf-8");
    const config: Record<string, string> = {};
    
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/);
      if (match) config[match[1]] = match[2];
    }
    
    // Support legacy bank_id as global_bank
    return {
      api_url: config.api_url,
      api_key: config.api_key,
      global_bank: config.global_bank || config.bank_id
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

  pi.on("session_start", async () => {
    recallDone = false;
    recallAttempts = 0;
    log("session_start: state reset");
  });

  pi.on("session_compact", async () => {
    recallDone = false;
    recallAttempts = 0;
    log("session_compact: state reset");
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
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.api_key || ""}`
            },
            body: JSON.stringify({ query, max_tokens: 1024 })
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
          body: JSON.stringify({ items: [{ content }], async: false })
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
      return;
    }

    const lastUserPrompt = getLastUserMessage(ctx, currentPrompt) || "Provide context for current project";
    const banks = getRecallBanks(config);
    log(`before_agent_start: querying banks=${banks.join(",")} prompt="${lastUserPrompt.slice(0, 80)}"`);

    try {
      let anyBankSucceeded = false;
      const recallPromises = banks.map(async (bank) => {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key || ""}`
          },
          body: JSON.stringify({ query: lastUserPrompt, max_tokens: 1024 })
        });

        if (!res.ok) {
          log(`before_agent_start: bank=${bank} HTTP ${res.status}`);
          return [];
        }
        anyBankSucceeded = true;
        const data = await res.json();
        const results = (data.results || []).map((r: any) => `[Bank: ${bank}] - ${r.text}`);
        log(`before_agent_start: bank=${bank} got ${results.length} results`);
        return results;
      });

      const resultsArrays = await Promise.all(recallPromises);

      if (anyBankSucceeded) {
        // Server responded — mark done regardless of result count
        recallDone = true;
        const allResults = resultsArrays.flat();

        if (allResults.length > 0) {
          log(`before_agent_start: injecting ${allResults.length} memories into context`);
          const memoriesStr = allResults.join("\n\n");
          const content = `<hindsight_memories>\nRelevant memories from past conversations:\n\n${memoriesStr}\n</hindsight_memories>`;
          return {
            message: {
              customType: "hindsight-recall",
              content,
              display: false
            }
          };
        } else {
          log("before_agent_start: no memories found (empty vault)");
        }
      } else {
        log(`before_agent_start: all banks failed, will retry (attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS})`);
      }
    } catch (e) {
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

      const allFailed = results.every(r => r.status === "rejected");
      if (allFailed) {
        log("agent_end: all banks failed — sending next-turn notification");
        (pi as any).sendMessage(
          {
            customType: "hindsight-retain-failed",
            content: "**Hindsight:** Auto-retain failed (server unreachable). Use `hindsight_retain` to save manually if this conversation has important insights.",
            display: false,
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
    description: "Show Hindsight configuration status",
    handler: async (_args, ctx) => {
      const config = getConfig();
      if (!config) {
        ctx.ui.notify("Hindsight config not found. Create ~/.hindsight/config", "error");
        return;
      }
      
      const status = [
        `URL: ${config.api_url || "Not set"}`,
        `Global Bank: ${config.global_bank || "Not set"}`,
        `Project Bank (Recall & Default Retain): ${getProjectBank()}`,
        `Active Recall Banks: ${getRecallBanks(config).join(", ")}`,
        `Tip: Use #global or #me in your prompt to save learnings to your global bank`
      ].join("\n");
      
      ctx.ui.notify(status, "info");
    },
  });
}
