// Multi-model debate engine. Models take turns per round; consensus triggers early stop.
// Transport is injected (CompleteFn) so the engine is provider-agnostic and testable.

import type { CompleteFn, LlmMsg } from "./llm.runtime.js";

export type DebateMode = "debate" | "expert" | "code" | "prd";

export type DebateTurn = { model: string; round: number; content: string };

// Structured judge verdict — replaces the old substring/keyword consensus heuristic.
export type ConsensusVerdict = { agreed: boolean; confidence: number; reason: string };

export type DebateResult = {
  status: "done" | "failed";
  topic: string;
  turns: DebateTurn[];
  summary: string;
  rounds_completed: number;
  consensus?: ConsensusVerdict;
  error?: string;
};

// Minimum judge confidence to early-stop a debate on agreement.
const CONSENSUS_CONFIDENCE_THRESHOLD = 0.6;

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

// Judge prompt: a neutral model decides whether the round reached substantive consensus.
function buildJudgeMessages(topic: string, roundTurns: DebateTurn[]): LlmMsg[] {
  return [
    {
      role: "system",
      content:
        "You are a neutral debate judge. Decide whether the participants reached substantive consensus. " +
        "Respond with ONLY a JSON object, no prose, no markdown fences: " +
        '{"agreed": boolean, "confidence": number between 0 and 1, "reason": short string}.',
    },
    {
      role: "user",
      content: `Topic: "${topic}"\n\nLatest round:\n${roundTurns
        .map((t) => `[${t.model}]: ${t.content}`)
        .join("\n\n")}`,
    },
  ];
}

// Extract the first JSON object from judge output (models often wrap it in prose/fences).
function parseVerdict(text: string): ConsensusVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { agreed?: unknown; confidence?: unknown; reason?: unknown };
    if (typeof o.agreed !== "boolean") return null;
    const confidence =
      typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0;
    return { agreed: o.agreed, confidence, reason: String(o.reason ?? "") };
  } catch {
    return null;
  }
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
  let consensus: ConsensusVerdict | undefined;

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

    // Judge the round (skip round 0 — no prior positions to converge on yet).
    if (r >= 1) {
      onToken(`R${r + 1} 합의 판정 중…`);
      try {
        const judgeText = await complete({
          model: models[0],
          messages: buildJudgeMessages(
            topic,
            turns.filter((t) => t.round === r),
          ),
          temperature: 0,
          signal,
        });
        consensus = parseVerdict(judgeText) ?? consensus;
      } catch {
        // Judge failure is non-fatal — keep debating.
      }
      if (consensus?.agreed && consensus.confidence >= CONSENSUS_CONFIDENCE_THRESHOLD) {
        onToken(`R${r + 1} 합의 (신뢰도 ${consensus.confidence.toFixed(2)}) — 조기 종료`);
        break;
      }
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
  return { status: "done", topic, turns, summary, rounds_completed: completedRounds, consensus };
}
