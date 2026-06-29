import { describe, expect, it, vi } from "vitest";
import hindsightExtension, { isSubagentChildProcess } from "../index.ts";

describe("subagent child detection", () => {
  it("is enabled only for explicit pi-subagents child processes", () => {
    expect(isSubagentChildProcess({ PI_SUBAGENT_CHILD: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSubagentChildProcess({ PI_SUBAGENT_CHILD: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSubagentChildProcess({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("does not register hooks or tools inside pi-subagents child processes", () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      const pi = {
        on: vi.fn(),
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
      };

      hindsightExtension(pi as any);

      expect(pi.on).not.toHaveBeenCalled();
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect(pi.registerCommand).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });
});
