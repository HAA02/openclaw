// Goal-driven development loop. Port of Consilium's goal_dev_loop.py.
// Multi-model roundtable → parse ### FILE: blocks → apply → verify → iterate.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CompleteFn } from "./llm.runtime.js";

export type GoalResult = {
  status: "done" | "failed";
  goal: string;
  iterations: number;
  summary: string;
  diff?: string;
  error?: string;
};

// Parse ### FILE: <path>\n```lang\n...\n``` blocks from model output.
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

function runCmd(
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

async function gitDiff(repoPath: string): Promise<string> {
  const result = await runCmd("git diff HEAD --stat 2>/dev/null || git diff --stat", repoPath);
  return result.out;
}

// Build system prompt with ### FILE: protocol instructions.
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

// Multi-model roundtable: each model proposes, first model is used as primary.
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
        { role: "user", content: `Implement the goal now.` },
      ],
      temperature: 0.5,
      signal,
    });
  }

  // Multiple models: each proposes independently, then primary synthesizes
  const proposals = await Promise.all(
    models.map((m) =>
      complete({
        model: m,
        messages: [
          { role: "system", content: goalSystemPrompt(goal, feedback) },
          { role: "user", content: `Implement the goal now.` },
        ],
        temperature: 0.5,
        signal,
      }).catch((err) => `[${m} failed: ${err instanceof Error ? err.message : String(err)}]`),
    ),
  );

  // Primary model synthesizes: pick the proposal with the most file blocks (best signal)
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

export async function runGoalLoop(
  complete: CompleteFn,
  params: {
    goal: string;
    models: string[];
    maxIterations: number;
    verifyCmd?: string;
    repoPath?: string;
  },
  onProgress: (status: string) => void,
  signal?: AbortSignal,
): Promise<GoalResult> {
  const { goal, models, verifyCmd, repoPath } = params;
  const maxIter = Math.min(params.maxIterations, 50);
  let feedback = "";

  for (let i = 0; i < maxIter; i++) {
    if (signal?.aborted) throw new Error("Aborted");
    onProgress(`iteration:${i + 1}/${maxIter}`);

    // Generate files via roundtable
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
        const result = await runCmd(verifyCmd, repoPath, signal);
        if (result.ok) {
          return {
            status: "done",
            goal,
            iterations: i + 1,
            summary: `${i + 1}번 반복 후 완료. ${files.size}개 파일 적용.`,
            diff: await gitDiff(repoPath),
          };
        }
        feedback = result.out;
        onProgress(`verify-failed:${feedback.slice(0, 80)}`);
      } else {
        return {
          status: "done",
          goal,
          iterations: i + 1,
          summary: `${files.size}개 파일을 ${repoPath}에 적용.`,
          diff: await gitDiff(repoPath),
        };
      }
    } else {
      // No repo — return generated content as summary
      const listing = Array.from(files.keys()).join(", ");
      return {
        status: "done",
        goal,
        iterations: i + 1,
        summary: response,
        diff: `생성된 파일: ${listing}`,
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
