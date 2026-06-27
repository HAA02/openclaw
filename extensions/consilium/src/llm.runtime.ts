// Transport-agnostic completion seam. index.ts wires this to api.runtime.llm.complete
// so debate/goal stay decoupled from any provider and remain unit-testable.
// Model is a bare model id (e.g. "qwen3:8b"); index maps it to an "ollama/<id>" ref.

export type LlmMsg = { role: "system" | "user" | "assistant"; content: string };

export type CompleteFn = (req: {
  model: string;
  messages: LlmMsg[];
  temperature?: number;
  signal?: AbortSignal;
}) => Promise<string>;
