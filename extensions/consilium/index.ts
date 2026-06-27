// Consilium plugin — multi-model debate and goal-driven dev loop, native to OpenClaw.
// Inference routes through the host provider stack (api.runtime.llm.complete), so any
// provider works; for local models, configure the bundled `ollama` provider.
//
// Multi-model fan-out passes an explicit model ref per call, which the host treats as a
// model override. That is gated per-plugin, so operators must allow it in openclaw.json:
//   plugins.entries.consilium.llm = { allowModelOverride: true, allowedModels: ["*"] }
// (or an explicit ref list). Without it, the host refuses the override.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import type { AuditEntry } from "./src/audit.runtime.js";
import type { CompleteFn } from "./src/llm.runtime.js";

const DEFAULT_MODELS = ["llama3.2"];
const DEFAULT_MAX_ITERATIONS = 10;
const AUDIT_NS = "consilium-audit";
const AUDIT_MAX_ENTRIES = 1000;

type Runtime = typeof import("./src/consilium.runtime.js");
let _rt: Promise<Runtime> | undefined;
const rt = (): Promise<Runtime> => (_rt ??= import("./src/consilium.runtime.js"));

type Cfg = {
  defaultModels?: string[];
  maxIterations?: number;
};
function cfg(c: Cfg) {
  return {
    models: c.defaultModels ?? DEFAULT_MODELS,
    maxIterations: c.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
}

// Append one audit row to the host SQLite plugin-state store (best-effort).
async function audit(
  state: {
    openKeyedStore: <T>(o: { namespace: string; maxEntries: number }) => {
      register(key: string, value: T): Promise<void>;
    };
  },
  key: string,
  entry: AuditEntry,
): Promise<void> {
  const { recordAudit } = await rt();
  const store = state.openKeyedStore<AuditEntry>({
    namespace: AUDIT_NS,
    maxEntries: AUDIT_MAX_ENTRIES,
  });
  await recordAudit(store, key, entry);
}

// Adapt the host LLM seam into the transport-agnostic CompleteFn the runtimes consume.
// model is a bare id (e.g. "qwen3:8b") mapped to an "ollama/<id>" host model ref.
function buildComplete(
  llm: { complete: (p: never) => Promise<{ text: string }> },
  purpose: string,
): CompleteFn {
  return async ({ model, messages, temperature, signal }) => {
    const res = await llm.complete({
      model: `ollama/${model}`,
      messages,
      temperature,
      signal,
      purpose,
    } as never);
    return res.text;
  };
}

export default defineToolPlugin({
  id: "consilium",
  name: "Consilium",
  description:
    "여러 로컬 모델이 토론하고, goal 기반으로 코드를 생성·검증하는 루프. 호스트 프로바이더 스택을 통해 추론합니다.",
  configSchema: Type.Object(
    {
      defaultModels: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '기본 모델 이름 목록 (예: ["qwen3:8b", "qwen2.5-coder"]). ollama/ 접두사는 자동 부여.',
        }),
      ),
      maxIterations: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "goal 루프 기본 최대 반복 횟수" }),
      ),
    },
    { additionalProperties: false },
  ),

  tools: (tool) => [
    // ── Debate ──────────────────────────────────────────────────────────────
    tool({
      name: "consilium_debate",
      label: "Consilium 토론",
      description:
        "여러 모델이 주제를 라운드별로 토론합니다. 합의 감지 시 조기 종료. 요약과 전체 발언 기록을 반환합니다.",
      optional: true,
      parameters: Type.Object(
        {
          topic: Type.String({ description: "토론 주제 또는 질문." }),
          models: Type.Optional(
            Type.Array(Type.String(), {
              description: "사용할 모델 이름 목록. 미지정 시 플러그인 기본값 사용.",
            }),
          ),
          rounds: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 10,
              description: "최대 토론 라운드 수 (1–10, 기본값: 3).",
            }),
          ),
          mode: Type.Optional(
            Type.String({
              enum: ["debate", "expert", "code", "prd"],
              description:
                "토론 모드: debate(찬반), expert(전문가), code(코드리뷰), prd(제품기획). 기본값: debate.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params, config, { signal, onUpdate, api, toolCallId }) => {
        const c = cfg(config);
        const { runDebate } = await rt();
        const complete = buildComplete(api.runtime.llm, "consilium-debate");

        const result = await runDebate(
          complete,
          {
            topic: params.topic,
            models: params.models ?? c.models,
            rounds: params.rounds ?? 3,
            mode: (params.mode as "debate" | "expert" | "code" | "prd") ?? "debate",
          },
          (text) =>
            onUpdate?.({
              content: [],
              details: undefined,
              progress: { text, visibility: "channel", privacy: "public" },
            }),
          signal,
        );

        await audit(api.runtime.state, toolCallId, {
          ts: new Date().toISOString(),
          tool: "debate",
          models: params.models ?? c.models,
          input: params.topic.slice(0, 200),
          status: result.status,
          rounds_completed: result.rounds_completed,
        });

        if (result.status === "failed") throw new Error(result.error ?? "토론 실패");
        return result;
      },
    }),

    // ── Goal Loop ────────────────────────────────────────────────────────────
    tool({
      name: "consilium_goal",
      label: "Consilium Goal 루프",
      description:
        "멀티모델 라운드테이블로 목표를 달성하는 코드를 생성하고 반복 검증합니다. " +
        "### FILE: 프로토콜로 파일을 생성하며, verify_cmd 성공 시 종료합니다. " +
        "diff를 반환하므로 사용자가 직접 검토 후 커밋하세요. 자동 머지 없음.",
      optional: true,
      parameters: Type.Object(
        {
          goal: Type.String({ description: "달성할 개발 목표 (예: '로그인 입력 검증 추가')." }),
          max_iterations: Type.Integer({
            minimum: 1,
            maximum: 50,
            description: "최대 루프 반복 횟수. 필수. 최대 50.",
          }),
          models: Type.Optional(
            Type.Array(Type.String(), {
              description: "사용할 모델 목록. 라운드마다 순환 사용됩니다.",
            }),
          ),
          verify_cmd: Type.Optional(
            Type.String({
              description: "검증 명령 (예: 'pnpm test', 'pytest -q'). 미지정 시 파일 생성만 수행.",
            }),
          ),
          repo_path: Type.Optional(
            Type.String({
              description: "파일을 적용할 레포지터리 절대 경로. 미지정 시 생성 내용만 반환.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params, config, { signal, onUpdate, api, toolCallId }) => {
        const c = cfg(config);
        const { runGoalLoop } = await rt();
        const complete = buildComplete(api.runtime.llm, "consilium-goal");

        const result = await runGoalLoop(
          complete,
          {
            goal: params.goal,
            models: params.models ?? c.models,
            maxIterations: params.max_iterations,
            verifyCmd: params.verify_cmd,
            repoPath: params.repo_path,
          },
          (status) =>
            onUpdate?.({
              content: [],
              details: undefined,
              progress: { text: status, visibility: "channel", privacy: "public" },
            }),
          signal,
        );

        await audit(api.runtime.state, toolCallId, {
          ts: new Date().toISOString(),
          tool: "goal",
          models: params.models ?? c.models,
          input: params.goal.slice(0, 200),
          status: result.status,
          iterations: result.iterations,
          error: result.error,
        });

        if (result.status === "failed") {
          return {
            success: false,
            goal: result.goal,
            iterations: result.iterations,
            error: result.error,
          };
        }
        return {
          success: true,
          goal: result.goal,
          iterations: result.iterations,
          summary: result.summary,
          diff: result.diff,
          note: "diff를 검토한 후 직접 git commit 하세요. 자동 적용되지 않습니다.",
        };
      },
    }),
  ],
});
