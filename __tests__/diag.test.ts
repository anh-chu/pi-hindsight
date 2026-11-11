import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, writeFileSync as wfs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diag, diagFilePath, diagPreview } from "../index.ts";

/**
 * WS-P5: JSONL diagnostics — rotation, off-switch, field sanitization.
 * Never throws, never blocks the caller, every event lands as one
 * parseable JSON line.
 */

let realHome: string | undefined;
let tmpHome: string;
let diagFile: string;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "pi-hindsight-diag-"));
  process.env.HOME = tmpHome;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("HINDSIGHT_")) delete process.env[k];
  }
  mkdirSync(join(tmpHome, ".hindsight"), { recursive: true });
  diagFile = join(tmpHome, "diag.log");
  process.env.HINDSIGHT_DIAG_FILE = diagFile;
});

afterEach(() => {
  delete process.env.HINDSIGHT_DIAG_FILE;
  delete process.env.HINDSIGHT_DIAG;
  if (realHome !== undefined) process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("diag", () => {
  it("writes one parseable JSON line per event", () => {
    diag("inject_ok", { chars: 1180, via: "reflect" });
    diag("retain_ok", { turns: 2 });
    const lines = readFileSync(diagFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const [a, b] = lines.map(l => JSON.parse(l));
    expect(a.event).toBe("inject_ok");
    expect(a.chars).toBe(1180);
    expect(a.via).toBe("reflect");
    expect(typeof a.t).toBe("string");
    expect(Date.parse(a.t)).not.toBeNaN();
    expect(b.event).toBe("retain_ok");
  });

  it("respects the HINDSIGHT_DIAG=0 off-switch", () => {
    process.env.HINDSIGHT_DIAG = "0";
    diag("inject_ok", {});
    expect(existsSync(diagFile)).toBe(false);
  });

  it("defaults to ~/.hindsight/diagnostics.log when env unset", () => {
    delete process.env.HINDSIGHT_DIAG_FILE;
    expect(diagFilePath()).toBe(join(tmpHome, ".hindsight", "diagnostics.log"));
  });

  it("clips oversized string fields and previews compact whitespace", () => {
    diag("reflect_ok", { answer: "x".repeat(5000) });
    const [a] = readFileSync(diagFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect((a.answer as string).length).toBeLessThanOrEqual(2001);
    expect(a.answer.endsWith("…")).toBe(true);

    expect(diagPreview("line1\nline2   with   spaces")).toBe("line1 line2 with spaces");
    expect(diagPreview("x".repeat(200), 80).length).toBe(81); // 80 + ellipsis
  });

  it("stringifies Error objects safely", () => {
    diag("inject_failed", { error: new Error("boom") });
    const [a] = readFileSync(diagFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(a.error).toContain("Error: boom");
  });

  it("never throws on an unwritable path", () => {
    process.env.HINDSIGHT_DIAG_FILE = join(tmpHome, "no-such-dir-root", "..", "..", "..", "proc", "1", "diag.log");
    expect(() => diag("inject_ok", {})).not.toThrow();
  });
});
