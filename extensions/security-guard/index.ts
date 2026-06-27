// Security Guard plugin — input threat scanner ported from DisBot.
// Detects prompt injection, shell injection, path traversal, and encoding bypass.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";

type Runtime = typeof import("./src/scanner.runtime.js");
let _rt: Promise<Runtime> | undefined;
const rt = (): Promise<Runtime> => (_rt ??= import("./src/scanner.runtime.js"));

export default defineToolPlugin({
  id: "security-guard",
  name: "Security Guard",
  description: "입력 텍스트의 프롬프트 인젝션, 쉘 인젝션, 경로 탐색 위협을 감지합니다.",
  configSchema: Type.Object(
    {
      strict: Type.Optional(
        Type.Boolean({
          description: "true(기본값): critical+high 차단. false: critical만 차단.",
        }),
      ),
    },
    { additionalProperties: false },
  ),

  tools: (tool) => [
    tool({
      name: "security_check",
      label: "보안 검사",
      description:
        "텍스트에서 LLM 인젝션, 쉘 명령 삽입, 경로 탐색 시도를 감지합니다. " +
        "안전하면 { safe: true }를, 위협 감지 시 { safe: false, threats: [...] }를 반환합니다.",
      optional: true,
      parameters: Type.Object(
        {
          text: Type.String({ description: "검사할 텍스트." }),
          strict: Type.Optional(
            Type.Boolean({
              description: "플러그인 기본값 override. true=high까지 차단, false=critical만 차단.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params, config, _ctx) => {
        const { scanText } = await rt();
        const strict = params.strict ?? config.strict ?? true;
        return scanText(params.text, strict);
      },
    }),
  ],
});
