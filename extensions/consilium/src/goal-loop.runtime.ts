// Goal-driven development loop.
// Native path: injected RunAgentFn (tool-calling model, e.g. gpt-oss:20b) edits files;
// verifyCmd or LLM judge gates completion.
// Fallback (no runAgent): ### FILE: protocol via CompleteFn — unit tests only.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CompleteFn, LlmMsg } from "./llm.runtime.js";

export type GoalResult = {
  status: "done" | "failed";
  goal: string;
  iterations: number;
  summary: string;
  diff?: string;
  error?: string;
};

// Injected dep — production: wraps api.runtime.agent.runEmbeddedAgent.
// model must be tool-calling capable (e.g. "gpt-oss:20b") so the agent can read/edit/bash.
export type RunAgentFn = (req: {
  goal: string;
  feedback: string;
  workspaceDir: string;
  model: string;
  signal?: AbortSignal;
}) => Promise<{ output: string }>;

// Injected dep — production: wraps api.runtime.system.runCommandWithTimeout.
export type RunCmdFn = (
  cmd: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; out: string }>;

// ── Fallback helpers (### FILE: protocol — unit tests only) ──────────────

function parseFileBlocks(text: string): Map<string, string> {
  const files = new Map<string, string>();
  const re = /###\s*FILE:\s*([^\n]+)\n```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim();
    if (path) files.set(path, m[2]);
  }
  return files;
}

async function applyFiles(repoPath: string, files: Map<string, string>): Promise<void> {
  for (const [relPath, content] of files) {
    const abs = join(repoPath, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

function localRunCmd(
  cmd: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    signal?.addEventListener("abort", () => {
      child.kill();
      resolve({ ok: false, out: "Aborted" });
    });
    child.on("close", (code) => resolve({ ok: code === 0, out: out.slice(-1500) }));
  });
}

// ── LLM judge (native path, no verifyCmd) ────────────────────────────────

type JudgeVerdict = { achieved: boolean; feedback: string };

function buildJudgeMessages(goal: string, agentOutput: string, diff: string): LlmMsg[] {
  return [
    {
      role: "system",
      content:
        "You are a senior code reviewer. Assess whether the agent achieved the goal. " +
        'Reply ONLY with JSON: {"achieved": boolean, "feedback": string}',
    },
    {
      role: "user",
      content:
        `Goal: ${goal}\n\nAgent output:\n${agentOutput.slice(0, 500)}\n\n` +
        `Git diff summary:\n${diff.slice(0, 800)}\n\n` +
        "Did the agent fully achieve the goal? If not, what needs to be fixed?",
    },
  ];
}

function parseJudgeVerdict(text: string): JudgeVerdict {
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const v = JSON.parse(m[0]) as Partial<JudgeVerdict>;
      if (typeof v.achieved === "boolean") {
        return { achieved: v.achieved, feedback: String(v.feedback ?? "") };
      }
    }
  } catch {
    // non-fatal
  }
  const lower = text.toLowerCase();
  return {
    achieved: lower.includes('"achieved":true') || lower.includes('"achieved": true'),
    feedback: text.slice(0, 300),
  };
}

// ── Goal prompt helpers (### FILE: fallback) ──────────────────────────────

function goalSystemPrompt(goal: string, feedback: string): string {
  const feedbackBlock = feedback
    ? `\n\nPrevious attempt failed:\n${feedback}\n\nFix the above issues.`
    : "";
  return (
    `You are a senior software engineer. Goal: "${goal}"\n\n` +
    `Output one or more files using this EXACT format:\n\n` +
    `### FILE: path/to/file.ts\n\`\`\`typescript\n// full file content\n\`\`\`\n\n` +
    `Rules:\n` +
    `- Use correct relative paths from the repo root.\n` +
    `- Write complete file contents, not diffs.\n` +
    `- Respond with ONLY file blocks, no explanation before or after.` +
    feedbackBlock
  );
}

async function roundtable(
  complete: CompleteFn,
  models: string[],
  goal: string,
  feedback: string,
  onProgress: (s: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  onProgress(`roundtable:${models.join(",")}`);
  if (models.length === 1) {
    return complete({
      model: models[0],
      messages: [
        { role: "system", content: goalSystemPrompt(goal, feedback) },
        { role: "user", content: "Implement the goal now." },
      ],
      temperature: 0.5,
      signal,
    });
  }
  const proposals = await Promise.all(
    models.map((m) =>
      complete({
        model: m,
        messages: [
          { role: "system", content: goalSystemPrompt(goal, feedback) },
          { role: "user", content: "Implement the goal now." },
        ],
        temperature: 0.5,
        signal,
      }).catch((err) => `[${m} failed: ${err instanceof Error ? err.message : String(err)}]`),
    ),
  );
  let best = proposals[0];
  let bestCount = parseFileBlocks(best).size;
  for (const p of proposals.slice(1)) {
    const count = parseFileBlocks(p).size;
    if (count > bestCount) {
      best = p;
      bestCount = count;
    }
  }
  return best;
}

// ── Main exported loop ────────────────────────────────────────────────────

export async function runGoalLoop(
  complete: CompleteFn,
  params: {
    goal: string;
    models: string[];
    maxIterations: number;
    verifyCmd?: string;
    repoPath?: string;
    // Native deps (production). Absent = ### FILE: fallback (unit tests).
    runAgent?: RunAgentFn; // tool-calling embedded agent (gpt-oss:20b)
    runCmd?: RunCmdFn; // shell runner; falls back to local spawn when absent
    agentModel?: string; // model for runAgent + judge; defaults to models[0]
  },
  onProgress: (status: string) => void,
  signal?: AbortSignal,
): Promise<GoalResult> {
  const { goal, models, verifyCmd, repoPath } = params;
  const maxIter = Math.min(params.maxIterations, 50);
  const execCmd = params.runCmd ?? localRunCmd;
  const agentModel = params.agentModel ?? models[0] ?? "gpt-oss:20b";
  let feedback = "";

  for (let i = 0; i < maxIter; i++) {
    if (signal?.aborted) throw new Error("Aborted");
    onProgress(`iteration:${i + 1}/${maxIter}`);

    // ── Native embedded agent path ─────────────────────────────────────
    if (params.runAgent && repoPath) {
      onProgress(`agent:${agentModel}`);
      let agentOutput: string;
      try {
        const res = await params.runAgent({
          goal,
          feedback,
          workspaceDir: repoPath,
          model: agentModel,
          signal,
        });
        agentOutput = res.output;
      } catch (err) {
        return { status: "failed", goal, iterations: i + 1, summary: "", error: String(err) };
      }

      if (verifyCmd) {
        onProgress(`verifying:${verifyCmd}`);
        const vr = await execCmd(verifyCmd, repoPath, signal);
        if (vr.ok) {
          const dr = await execCmd("git diff HEAD --stat", repoPath, signal);
          return { status: "done", goal, iterations: i + 1, summary: agentOutput, diff: dr.out };
        }
        feedback = vr.out;
        onProgress(`verify-failed:${feedback.slice(0, 80)}`);
        continue;
      }

      // No verifyCmd: LLM judge using agentModel (gpt-oss:20b)
      onProgress("judge:assessing");
      const dr = await execCmd("git diff HEAD --stat", repoPath, signal);
      let verdict: JudgeVerdict;
      try {
        const jt = await complete({
          model: agentModel,
          messages: buildJudgeMessages(goal, agentOutput, dr.out),
          temperature: 0.1,
          signal,
        });
        verdict = parseJudgeVerdict(jt);
      } catch {
        verdict = { achieved: false, feedback: "Judge unavailable — retrying." };
      }
      if (verdict.achieved) {
        return { status: "done", goal, iterations: i + 1, summary: agentOutput, diff: dr.out };
      }
      feedback = verdict.feedback;
      onProgress(`judge-not-achieved:${feedback.slice(0, 80)}`);
      continue;
    }

    // ── ### FILE: fallback (unit tests / generate-only) ──────────────
    let response: string;
    try {
      response = await roundtable(complete, models, goal, feedback, onProgress, signal);
    } catch (err) {
      return { status: "failed", goal, iterations: i + 1, summary: "", error: String(err) };
    }

    const files = parseFileBlocks(response);
    if (files.size === 0) {
      feedback = "파일 블록이 없습니다. ### FILE: <path>\\n```lang\\n...\\n``` 형식을 사용하세요.";
      onProgress(`no-files:iteration ${i + 1}`);
      continue;
    }

    onProgress(`applying:${files.size}개 파일`);

    if (repoPath) {
      try {
        await applyFiles(repoPath, files);
      } catch (err) {
        feedback = `파일 적용 실패: ${String(err)}`;
        continue;
      }
      if (verifyCmd) {
        onProgress(`verifying:${verifyCmd}`);
        const vr = await execCmd(verifyCmd, repoPath, signal);
        if (vr.ok) {
          const dr = await execCmd("git diff HEAD --stat", repoPath, signal);
          return {
            status: "done",
            goal,
            iterations: i + 1,
            summary: `${i + 1}번 반복 후 완료. ${files.size}개 파일 적용.`,
            diff: dr.out,
          };
        }
        feedback = vr.out;
        onProgress(`verify-failed:${feedback.slice(0, 80)}`);
      } else {
        const dr = await execCmd("git diff HEAD --stat", repoPath, signal);
        return {
          status: "done",
          goal,
          iterations: i + 1,
          summary: `${files.size}개 파일을 ${repoPath}에 적용.`,
          diff: dr.out,
        };
      }
    } else {
      return {
        status: "done",
        goal,
        iterations: i + 1,
        summary: response,
        diff: `생성된 파일: ${Array.from(files.keys()).join(", ")}`,
      };
    }
  }

  return {
    status: "failed",
    goal,
    iterations: maxIter,
    summary: "",
    error: `max_iterations(${maxIter}) 도달. 마지막 피드백: ${feedback.slice(-300)}`,
  };
}
