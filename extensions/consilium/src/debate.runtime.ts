// Multi-model debate engine. Models take turns per round; consensus triggers early stop.
// Transport is injected (CompleteFn) so the engine is provider-agnostic and testable.

import type { CompleteFn, LlmMsg } from "./llm.runtime.js";

export type DebateMode = "debate" | "expert" | "code" | "prd";

export type DebateTurn = { model: string; round: number; content: string };

export type DebateResult = {
  status: "done" | "failed";
  topic: string;
  turns: DebateTurn[];
  summary: string;
  rounds_completed: number;
  error?: string;
};

const SYSTEM: Record<DebateMode, (topic: string) => string> = {
  debate: (t) =>
    `You are a critical debater on "${t}". Make a clear, evidence-based argument in ≤200 words. Address previous arguments if any.`,
  expert: (t) =>
    `You are a domain expert on "${t}". Share concrete insights and data in ≤200 words. Address gaps or errors in previous arguments.`,
  code: (t) =>
    `You are a senior engineer reviewing "${t}". Critique code quality, architecture, and correctness in ≤200 words.`,
  prd: (t) =>
    `You are a product manager evaluating "${t}". Focus on user value, feasibility, and scope in ≤200 words.`,
};

function buildMessages(
  topic: string,
  mode: DebateMode,
  turns: DebateTurn[],
  round: number,
): LlmMsg[] {
  const msgs: LlmMsg[] = [{ role: "system", content: SYSTEM[mode](topic) }];
  for (const t of turns) {
    msgs.push({ role: "user", content: `[${t.model} · R${t.round + 1}]: ${t.content}` });
  }
  msgs.push({
    role: "user",
    content:
      round === 0
        ? `Topic: "${topic}" — share your initial position.`
        : `Round ${round + 1} — respond to the arguments above. Agree, disagree, or add a new dimension.`,
  });
  return msgs;
}

// Agreement/dissent heuristic — port of Consilium's consensus.py free/expert mode
function hasConsensus(turns: DebateTurn[], round: number, numModels: number): boolean {
  if (round < 1) return false;
  const roundTurns = turns.filter((t) => t.round === round);
  if (roundTurns.length < numModels) return false;

  const agree = ["agree", "concur", "correct", "exactly", "동의", "맞습니다", "같습니다", "indeed"];
  const dissent = ["disagree", "however", "but", "contrary", "반면", "하지만", "그러나", "wrong"];

  let totalAgree = 0;
  let totalDissent = 0;
  for (const t of roundTurns) {
    const text = t.content.toLowerCase();
    totalAgree += agree.filter((k) => text.includes(k)).length;
    totalDissent += dissent.filter((k) => text.includes(k)).length;
  }
  return totalAgree / numModels >= 2.0 && totalDissent / numModels <= 1.5;
}

export async function runDebate(
  complete: CompleteFn,
  params: {
    topic: string;
    models: string[];
    rounds: number;
    mode: DebateMode;
  },
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<DebateResult> {
  const { topic, models, rounds, mode } = params;
  const turns: DebateTurn[] = [];

  for (let r = 0; r < rounds; r++) {
    for (const model of models) {
      if (signal?.aborted) throw new Error("Aborted");
      onToken(`[${model}] R${r + 1} 생성 중…`);

      let content: string;
      try {
        content = await complete({
          model,
          messages: buildMessages(topic, mode, turns, r),
          temperature: 0.75,
          signal,
        });
      } catch (err) {
        content = `[오류: ${err instanceof Error ? err.message : String(err)}]`;
      }

      turns.push({ model, round: r, content });
      onToken(`[${model}] ${content.slice(0, 90).replace(/\n/g, " ")}…`);
    }

    if (hasConsensus(turns, r, models.length)) {
      onToken(`R${r + 1}에서 합의 감지 — 조기 종료`);
      break;
    }
  }

  // Summary by the first model
  onToken("요약 생성 중…");
  const summaryMsgs: LlmMsg[] = [
    {
      role: "system",
      content:
        "Summarize the debate below in 3–5 bullet points: key agreements, disagreements, and final conclusion. Be concise.",
    },
    {
      role: "user",
      content: turns.map((t) => `[${t.model} R${t.round + 1}]: ${t.content}`).join("\n\n"),
    },
  ];

  let summary: string;
  try {
    summary = await complete({ model: models[0], messages: summaryMsgs, temperature: 0.2, signal });
  } catch {
    summary = turns.map((t) => `• ${t.model}: ${t.content.slice(0, 80)}`).join("\n");
  }

  const completedRounds = turns.length > 0 ? turns[turns.length - 1].round + 1 : 0;
  return { status: "done", topic, turns, summary, rounds_completed: completedRounds };
}
