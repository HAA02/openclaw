// Consilium plugin — multi-model debate and goal-driven dev loop, native to OpenClaw.
// No external server needed: calls Ollama directly via fetch().
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODELS = ["llama3.2"];
const DEFAULT_MAX_ITERATIONS = 10;

type Runtime = typeof import("./src/consilium.runtime.js");
let _rt: Promise<Runtime> | undefined;
const rt = (): Promise<Runtime> => (_rt ??= import("./src/consilium.runtime.js"));

type Cfg = { ollamaUrl?: string; defaultModels?: string[]; maxIterations?: number };
function cfg(c: Cfg) {
  return {
    ollamaUrl: c.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    models: c.defaultModels ?? DEFAULT_MODELS,
    maxIterations: c.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
}

export default defineToolPlugin({
  id: "consilium",
  name: "Consilium",
  description:
    "로컬 Ollama 모델을 사용한 멀티모델 토론, goal 기반 코드 생성 루프. 별도 서버 불필요.",
  configSchema: Type.Object(
    {
      ollamaUrl: Type.Optional(
        Type.String({
          description: "Ollama API URL (기본값: http://127.0.0.1:11434)",
        }),
      ),
      defaultModels: Type.Optional(
        Type.Array(Type.String(), {
          description: '기본 모델 목록 (예: ["llama3.2", "qwen2.5-coder"])',
        }),
      ),
      maxIterations: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "goal 루프 기본 최대 반복 횟수" }),
      ),
    },
    { additionalProperties: false },
  ),

  tools: (tool) => [
    // ── Health ──────────────────────────────────────────────────────────────
    tool({
      name: "consilium_health",
      label: "Consilium 상태",
      description: "Ollama 연결 확인 및 사용 가능한 모델 목록 조회.",
      optional: true,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_p, config, { signal }) => {
        const { ollamaUrl } = cfg(config);
        const { listModels } = await rt();
        const models = await listModels(ollamaUrl, signal);
        if (models.length === 0) {
          return { ok: false, ollamaUrl, error: "Ollama에 연결할 수 없거나 모델이 없습니다." };
        }
        return { ok: true, ollamaUrl, models: models.map((m) => m.name) };
      },
    }),

    // ── Debate ──────────────────────────────────────────────────────────────
    tool({
      name: "consilium_debate",
      label: "Consilium 토론",
      description:
        "여러 Ollama 모델이 주제를 라운드별로 토론합니다. 합의 감지 시 조기 종료. 요약과 전체 발언 기록을 반환합니다.",
      optional: true,
      parameters: Type.Object(
        {
          topic: Type.String({ description: "토론 주제 또는 질문." }),
          models: Type.Optional(
            Type.Array(Type.String(), {
              description: "사용할 Ollama 모델 이름 목록. 미지정 시 플러그인 기본값 사용.",
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
      execute: async (params, config, { signal, onUpdate }) => {
        const c = cfg(config);
        const { runDebate } = await rt();

        const result = await runDebate(
          c.ollamaUrl,
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
              description: "사용할 Ollama 모델 목록. 라운드마다 순환 사용됩니다.",
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
      execute: async (params, config, { signal, onUpdate }) => {
        const c = cfg(config);
        const { runGoalLoop } = await rt();

        const result = await runGoalLoop(
          c.ollamaUrl,
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
