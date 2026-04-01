import type { NormalizedBlock } from "../types";

const ERROR_PATTERNS = [
  /error[:\s]/i,
  /fail(ed|ure|ing)?[:\s]/i,
  /exception[:\s]/i,
  /bug[:\s]/i,
  /root cause/i,
  /found that/i,
  /discovered/i,
  /confirmed/i,
  /test(s)?\s+(pass|fail)/i,
  /lint\s+(pass|fail|error)/i,
];

export const extractFindings = (blocks: NormalizedBlock[]): string[] => {
  const findings: string[] = [];

  for (const b of blocks) {
    if (b.kind === "tool_result" && b.isError) {
      const short = b.text.split("\n")[0]?.slice(0, 200);
      if (short) findings.push(`[${b.name}] Error: ${short}`);
      continue;
    }
    if (b.kind !== "assistant") continue;
    for (const line of b.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 10) continue;
      if (ERROR_PATTERNS.some((p) => p.test(trimmed))) {
        findings.push(trimmed.slice(0, 200));
      }
    }
  }

  return [...new Set(findings)].slice(0, 15);
};

