// Input threat scanner — ported from DisBot/security.py.
// Categories: prompt_injection (critical), shell_injection (high), path_traversal (high).

export type ThreatLevel = "critical" | "high";
export type ThreatCategory =
  | "prompt_injection"
  | "shell_injection"
  | "path_traversal"
  | "encoding_bypass";

export type ThreatDetection = {
  level: ThreatLevel;
  category: ThreatCategory;
  matchedText: string;
};

export type ScanResult = {
  safe: boolean;
  threats: ThreatDetection[];
};

type PatternEntry = { re: RegExp; level: ThreatLevel; category: ThreatCategory };

// ── Prompt injection — critical ─────────────────────────────────────────────
const PROMPT_INJECTION: PatternEntry[] = [
  /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i,
  /ignore\s+above/i,
  /disregard\s+(all\s+)?prior/i,
  /forget\s+(everything|all|your)\s+(instructions|rules|constraints)/i,
  /you\s+are\s+now\s+(a\s+)?new\s+(ai|assistant|system)/i,
  /new\s+system\s+prompt/i,
  /override\s+(system|safety|security)/i,
  /act\s+as\s+(if\s+)?you\s+have\s+no\s+(restrictions|limits)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /developer\s+mode\s+(enabled|on|activate)/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<\/SYS>>/i,
  /###\s*(Human|System|Assistant)\s*:/i,
  /<system>/i,
  /(change|modify|update|set)\s+(the\s+)?(config|configuration|settings|permissions)/i,
  /exec\.approvals.*off/i,
  /dangerously.skip.permissions/i,
  /sandbox.*disable/i,
  /tool.*policy.*allow\s*all/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /roleplay\s+as/i,
  /simulate\s+being/i,
  /hypothetically\s+(speaking|if)\s+you\s+(had\s+no|were\s+not)/i,
  /what\s+would\s+happen\s+if\s+you\s+(ignored|forgot)/i,
  /for\s+(research|educational)\s+purposes\s+only/i,
  /output\s+your\s+(system\s+)?prompt/i,
  /reveal\s+your\s+(instructions|system\s+prompt|configuration)/i,
  /what\s+are\s+your\s+(instructions|rules|constraints)/i,
  /sudo\s+mode/i,
  /admin\s+mode\s+(enabled|on)/i,
  /god\s+mode/i,
  /unlimited\s+power\s+mode/i,
  /unrestricted\s+mode/i,
  /you\s+must\s+comply/i,
  /comply\s+or\s+else/i,
  /I\s+order\s+you\s+to/i,
  /as\s+your\s+(creator|owner|master)/i,
  /training\s+data\s+(inject|poison)/i,
  /prompt\s+leak/i,
  /context\s+window\s+exploit/i,
].map((re) => ({
  re,
  level: "critical" as ThreatLevel,
  category: "prompt_injection" as ThreatCategory,
}));

// ── Shell injection — high ──────────────────────────────────────────────────
const SHELL_INJECTION: PatternEntry[] = [
  /;\s*(rm|del|format|shutdown|reboot|taskkill|net\s+user)/i,
  /\|\s*(curl|wget|nc|ncat|netcat|powershell|cmd)\b/i,
  /\$\([^)]+\)/,
  /`[^`]+`/,
  />\s*\/dev\//,
  /\|\|.*&&/,
  /\\x[0-9a-fA-F]{2}/,
  /eval\s*\(/i,
].map((re) => ({
  re,
  level: "high" as ThreatLevel,
  category: "shell_injection" as ThreatCategory,
}));

// ── Path traversal — high ───────────────────────────────────────────────────
const PATH_TRAVERSAL: PatternEntry[] = [
  /\.\.[/\\]/,
  /~[/\\]/,
  /[A-Z]:\\(Windows|Program Files)/i,
  /\/etc\/(passwd|shadow|hosts)/i,
  /\\\\[^\\]+\\/,
  /%[A-Z0-9]{2}/i,
].map((re) => ({ re, level: "high" as ThreatLevel, category: "path_traversal" as ThreatCategory }));

const ALL_PATTERNS = [...PROMPT_INJECTION, ...SHELL_INJECTION, ...PATH_TRAVERSAL];

// ── Base64 decode and re-scan ───────────────────────────────────────────────
function decodeBase64Segments(text: string): string[] {
  const results: string[] = [];
  // Match base64-looking tokens (min 20 chars, valid chars, length multiple of 4 approx)
  const re = /[A-Za-z0-9+/]{20,}={0,2}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[0], "base64").toString("utf8");
      // Only keep if decoded is printable ASCII/UTF-8
      if (/[\x20-\x7E]/.test(decoded)) results.push(decoded);
    } catch {
      // ignore
    }
  }
  return results;
}

function matchPatterns(text: string, patterns: PatternEntry[]): ThreatDetection[] {
  const threats: ThreatDetection[] = [];
  for (const { re, level, category } of patterns) {
    const m = re.exec(text);
    if (m) {
      threats.push({ level, category, matchedText: m[0].slice(0, 100) });
    }
  }
  return threats;
}

/**
 * Scan text for injection threats.
 * @param text  Input to scan.
 * @param strict  true (default) = block critical+high; false = block critical only.
 */
export function scanText(text: string, strict = true): ScanResult {
  const allThreats: ThreatDetection[] = matchPatterns(text, ALL_PATTERNS);

  // Check base64-encoded payloads
  for (const decoded of decodeBase64Segments(text)) {
    const encodedThreats = matchPatterns(decoded, ALL_PATTERNS);
    for (const t of encodedThreats) {
      allThreats.push({ ...t, category: "encoding_bypass" });
    }
  }

  const relevant = strict ? allThreats : allThreats.filter((t) => t.level === "critical");

  return { safe: relevant.length === 0, threats: relevant };
}
