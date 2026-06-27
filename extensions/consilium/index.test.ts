import { describe, expect, it } from "vitest";
import type { CompleteFn } from "./src/llm.runtime.js";

describe("consilium plugin", () => {
  it("exports a default plugin with correct id", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBeDefined();
    expect((mod.default as { id?: string }).id).toBe("consilium");
  });
});

describe("debate.runtime", () => {
  it("runs rounds via injected complete and returns done with a summary", async () => {
    const { runDebate } = await import("./src/debate.runtime.js");
    const complete: CompleteFn = async () => "I agree, this is correct indeed.";
    const result = await runDebate(
      complete,
      { topic: "Test topic", models: ["m1", "m2"], rounds: 5, mode: "debate" },
      () => {},
    );
    expect(result.status).toBe("done");
    expect(result.rounds_completed).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("records the model per turn and reaches every requested round absent consensus", async () => {
    const { runDebate } = await import("./src/debate.runtime.js");
    // Neutral content never trips the consensus heuristic, so all rounds run.
    const complete: CompleteFn = async ({ model }) => `position from ${model}`;
    const result = await runDebate(
      complete,
      { topic: "T", models: ["m1", "m2"], rounds: 2, mode: "expert" },
      () => {},
    );
    expect(result.rounds_completed).toBe(2);
    expect(result.turns.filter((t) => t.model === "m1").length).toBe(2);
    expect(result.turns.filter((t) => t.model === "m2").length).toBe(2);
  });

  it("early-stops when the judge verdict reports consensus", async () => {
    const { runDebate } = await import("./src/debate.runtime.js");
    const complete: CompleteFn = async ({ messages }) =>
      messages[0]?.content.includes("judge")
        ? '{"agreed": true, "confidence": 0.9, "reason": "aligned"}'
        : "my position";
    const result = await runDebate(
      complete,
      { topic: "T", models: ["m1", "m2"], rounds: 5, mode: "debate" },
      () => {},
    );
    expect(result.consensus?.agreed).toBe(true);
    expect(result.rounds_completed).toBeLessThan(5);
  });

  it("runs all rounds when the judge reports no consensus", async () => {
    const { runDebate } = await import("./src/debate.runtime.js");
    const complete: CompleteFn = async ({ messages }) =>
      messages[0]?.content.includes("judge")
        ? '{"agreed": false, "confidence": 0.2, "reason": "diverge"}'
        : "my position";
    const result = await runDebate(
      complete,
      { topic: "T", models: ["m1", "m2"], rounds: 3, mode: "debate" },
      () => {},
    );
    expect(result.rounds_completed).toBe(3);
    expect(result.consensus?.agreed).toBe(false);
  });
});

describe("goal-loop.runtime (unit)", () => {
  it("returns generated ### FILE: content when no repoPath is given", async () => {
    const { runGoalLoop } = await import("./src/goal-loop.runtime.js");
    const complete: CompleteFn = async () =>
      "### FILE: src/hello.ts\n```typescript\nexport const x = 1;\n```\n";
    const result = await runGoalLoop(
      complete,
      { goal: "test goal", models: ["m1"], maxIterations: 1 },
      () => {},
    );
    expect(result.status).toBe("done");
    expect(result.summary).toContain("src/hello.ts");
  });

  it("caps maxIterations at 50", async () => {
    const { runGoalLoop } = await import("./src/goal-loop.runtime.js");
    const complete: CompleteFn = async () => "no file blocks here";
    const result = await runGoalLoop(
      complete,
      { goal: "test", models: ["m1"], maxIterations: 999 },
      () => {},
    );
    expect(result.status).toBe("failed");
    expect(result.iterations).toBe(50);
  });
});

describe("audit.runtime", () => {
  // In-memory stand-in for the host SQLite keyed store (structural AuditSink).
  function fakeSink() {
    const rows = new Map<string, unknown>();
    return {
      rows,
      register: async (key: string, value: unknown) => {
        rows.set(key, value);
      },
    };
  }

  it("recordAudit writes an entry keyed by the given key", async () => {
    const { recordAudit } = await import("./src/audit.runtime.js");
    const sink = fakeSink();
    await recordAudit(sink, "call-1", {
      ts: "2026-06-27T00:00:00.000Z",
      tool: "goal",
      models: ["llama3.2"],
      input: "test goal",
      status: "done",
      iterations: 2,
    });
    const entry = sink.rows.get("call-1") as { tool: string; iterations: number; status: string };
    expect(entry.tool).toBe("goal");
    expect(entry.iterations).toBe(2);
    expect(entry.status).toBe("done");
  });

  it("recordAudit swallows sink errors so it never breaks a tool call", async () => {
    const { recordAudit } = await import("./src/audit.runtime.js");
    const failing = { register: async () => Promise.reject(new Error("store down")) };
    await expect(
      recordAudit(failing, "k", {
        ts: "t",
        tool: "debate",
        models: ["m1"],
        input: "a",
        status: "done",
        rounds_completed: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
