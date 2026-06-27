// Audit log for consilium debate/goal runs. Persisted via the host SQLite plugin-state
// keyed store (api.runtime.state.openKeyedStore) — no JSON/JSONL sidecar files.
// The store is opened in index.ts and passed in as a structural sink so this stays testable.

export type AuditEntry = {
  ts: string; // ISO timestamp
  tool: "debate" | "goal";
  models: string[];
  input: string; // topic or goal (truncated to 200 chars)
  status: "done" | "failed";
  iterations?: number; // goal only
  rounds_completed?: number; // debate only
  error?: string;
};

// Minimal structural view of the host keyed store — avoids importing core state types.
export type AuditSink = { register(key: string, value: AuditEntry): Promise<void> };

// Best-effort: audit must never break a tool call.
export async function recordAudit(sink: AuditSink, key: string, entry: AuditEntry): Promise<void> {
  await sink.register(key, entry).catch(() => {});
}
