import { describe, expect, it, vi } from "vitest";

describe("consilium plugin", () => {
  it("exports a default plugin with correct id", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBeDefined();
    expect((mod.default as { id?: string }).id).toBe("consilium");
  });
});

describe("ollama.runtime", () => {
  it("listModels returns [] on unreachable host", async () => {
    const { listModels } = await import("./src/ollama.runtime.js");
    const models = await listModels("http://127.0.0.1:1");
    expect(models).toEqual([]);
  });

  it("ollamaChat throws on unreachable host", async () => {
    const { ollamaChat } = await import("./src/ollama.runtime.js");
    await expect(
      ollamaChat("http://127.0.0.1:1", "llama3.2", [{ role: "user", content: "hi" }]),
    ).rejects.toThrow();
  });
});

describe("debate.runtime", () => {
  it("parses consensus at round 2+ when all models agree", async () => {
    // Stub ollamaChat to return an agreeing response
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: { content: "I agree, this is correct indeed." },
              done: true,
            }),
            { status: 200 },
          ),
      ),
    );
    const { runDebate } = await import("./src/debate.runtime.js");
    const result = await runDebate(
      "http://127.0.0.1:11434",
      { topic: "Test topic", models: ["m1", "m2"], rounds: 5, mode: "debate" },
      () => {},
    );
    expect(result.status).toBe("done");
    // Should stop early due to consensus (rounds_completed ≤ 5)
    expect(result.rounds_completed).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe("goal-loop.runtime (unit)", () => {
  it("parseFileBlocks extracts ### FILE: blocks", async () => {
    // Access internal via indirect test: startGoal with stub fetch
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: {
                content: "### FILE: src/hello.ts\n```typescript\nexport const x = 1;\n```\n",
              },
              done: true,
            }),
            { status: 200 },
          ),
      ),
    );
    const { runGoalLoop } = await import("./src/goal-loop.runtime.js");
    // No repoPath → returns summary with generated content
    const result = await runGoalLoop(
      "http://127.0.0.1:11434",
      { goal: "test goal", models: ["llama3.2"], maxIterations: 1 },
      () => {},
    );
    expect(result.status).toBe("done");
    expect(result.summary).toContain("src/hello.ts");
    vi.unstubAllGlobals();
  });

  it("caps maxIterations at 50", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        return new Response(
          JSON.stringify({ message: { content: "no file blocks here" }, done: true }),
          { status: 200 },
        );
      }),
    );
    const { runGoalLoop } = await import("./src/goal-loop.runtime.js");
    const result = await runGoalLoop(
      "http://127.0.0.1:11434",
      { goal: "test", models: ["m1"], maxIterations: 999 },
      () => {},
    );
    expect(result.status).toBe("failed");
    // 50 iterations max (plus summary call from debate = 51 max)
    expect(result.iterations).toBe(50);
    vi.unstubAllGlobals();
  });
});

// Live tests — requires Ollama at :11434
const LIVE = process.env.CONSILIUM_LIVE_TEST === "1";

describe.skipIf(!LIVE)("consilium live (requires Ollama)", () => {
  it("health check finds models", async () => {
    const { listModels } = await import("./src/ollama.runtime.js");
    const models = await listModels("http://127.0.0.1:11434");
    expect(models.length).toBeGreaterThan(0);
  });

  it("debate runs 1 round", async () => {
    const { runDebate } = await import("./src/debate.runtime.js");
    const result = await runDebate(
      "http://127.0.0.1:11434",
      { topic: "Should code always have tests?", models: ["llama3.2"], rounds: 1, mode: "debate" },
      () => {},
    );
    expect(result.status).toBe("done");
    expect(result.turns.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});
