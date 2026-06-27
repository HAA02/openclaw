// Audit log for consilium goal/debate runs.
// Appends JSONL entries to a user-configured path.
// TODO: migrate to openclaw SQLite (state/openclaw.sqlite) after Kysely helper is stable.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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

export async function appendAuditLog(logPath: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
}
