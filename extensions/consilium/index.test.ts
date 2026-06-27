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
  it("appendAuditLog writes JSONL entry to temp path", async () => {
    const { appendAuditLog } = await import("./src/audit.runtime.js");
    const tmpPath = `/tmp/consilium-audit-test-${Date.now()}.jsonl`;
    await appendAuditLog(tmpPath, {
      ts: "2026-06-27T00:00:00.000Z",
      tool: "goal",
      models: ["llama3.2"],
      input: "test goal",
      status: "done",
      iterations: 2,
    });
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(tmpPath, "utf8");
    const entry = JSON.parse(content.trim());
    expect(entry.tool).toBe("goal");
    expect(entry.iterations).toBe(2);
    expect(entry.status).toBe("done");
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpPath).catch(() => {});
  });

  it("appendAuditLog appends multiple entries", async () => {
    const { appendAuditLog } = await import("./src/audit.runtime.js");
    const tmpPath = `/tmp/consilium-audit-multi-${Date.now()}.jsonl`;
    await appendAuditLog(tmpPath, {
      ts: "t1",
      tool: "debate",
      models: ["m1"],
      input: "a",
      status: "done",
      rounds_completed: 1,
    });
    await appendAuditLog(tmpPath, {
      ts: "t2",
      tool: "goal",
      models: ["m1"],
      input: "b",
      status: "failed",
      iterations: 5,
    });
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(tmpPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("debate");
    expect(JSON.parse(lines[1]).status).toBe("failed");
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpPath).catch(() => {});
  });
});
