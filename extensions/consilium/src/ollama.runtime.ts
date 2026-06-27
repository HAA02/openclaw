// Direct Ollama API client — fetch only, no Node.js built-ins.

export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatResponse = { message: { content: string }; done: boolean };
type TagsResponse = { models: Array<{ name: string; size?: number }> };

function base(url: string): string {
  return url.replace(/\/$/, "");
}

export async function ollamaChat(
  ollamaUrl: string,
  model: string,
  messages: OllamaMessage[],
  opts?: { temperature?: number },
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${base(ollamaUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: opts?.temperature ?? 0.7 },
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Ollama ${model} error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as ChatResponse;
  return data.message.content;
}

export async function listModels(
  ollamaUrl: string,
  signal?: AbortSignal,
): Promise<Array<{ name: string; size?: number }>> {
  try {
    const res = await fetch(`${base(ollamaUrl)}/api/tags`, { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as TagsResponse;
    return data.models ?? [];
  } catch {
    return [];
  }
}
