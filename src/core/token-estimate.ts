export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_CHARS_PER_TOKEN = 2;
export const MAX_CHARS_PER_TOKEN = 6;

export type TokenEstimateMode = "heuristic" | "calibrated";

export interface TokenEstimateCalibration {
  mode: TokenEstimateMode;
  charsPerToken: number;
  sourceChars?: number;
  sourceTokens?: number;
  rawCharsPerToken?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const calibrateCharsPerToken = (
  sourceChars: number,
  sourceTokens: number | undefined,
): TokenEstimateCalibration => {
  if (!sourceTokens || sourceTokens <= 0 || sourceChars <= 0) {
    return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }

  const rawCharsPerToken = sourceChars / sourceTokens;
  if (!Number.isFinite(rawCharsPerToken) || rawCharsPerToken <= 0) {
    return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }

  return {
    mode: "calibrated",
    charsPerToken: clamp(rawCharsPerToken, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN),
    sourceChars,
    sourceTokens,
    rawCharsPerToken,
  };
};

export const estimateTokensFromChars = (
  chars: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => Math.ceil(chars / charsPerToken);

/**
 * Chars attributed to one image part, mirroring pi-agent-core's own
 * estimateTokens heuristic (4800 chars ≈ 1200 tokens at 4 chars/token).
 */
export const IMAGE_CONTENT_CHARS = 4800;

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? "") ?? "";
  } catch {
    return "";
  }
};

/**
 * Estimate the char length of a message's content (string or content-parts
 * array). Counts every token-bearing part that pi-agent-core's harness
 * estimateTokens counts, so the calibrated chars/token ratio is not deflated:
 *  - text       → text.length
 *  - thinking   → thinking.length   (opus emits large reasoning blocks)
 *  - toolCall   → name + arguments  (Pi uses `arguments`; `input` kept for compat)
 *  - image      → IMAGE_CONTENT_CHARS
 *  - toolResult → nested content    (legacy part shape)
 */
export const estimateMessageContentChars = (content: unknown): number => {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part: any) => {
    if (!part || typeof part !== "object") return sum;
    switch (part.type) {
      case "text":
        return sum + (typeof part.text === "string" ? part.text.length : 0);
      case "thinking":
        return sum + (typeof part.thinking === "string" ? part.thinking.length : 0);
      case "toolCall": {
        const args = part.arguments ?? part.input;
        const argLength = typeof args === "string" ? args.length : safeJsonStringify(args).length;
        return sum + (part.name?.length ?? 0) + argLength;
      }
      case "toolResult": {
        const c = part.content;
        return sum + (typeof c === "string" ? c.length : safeJsonStringify(c).length);
      }
      case "image":
        return sum + IMAGE_CONTENT_CHARS;
      default:
        // Unknown part: fall back to any text field so we never undercount.
        return sum + (typeof part.text === "string" ? part.text.length : 0);
    }
  }, 0);
};

export const estimateMessageContentTokens = (
  content: unknown,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => estimateTokensFromChars(estimateMessageContentChars(content), charsPerToken);

/**
 * Char length of a full context message, including text a non-`content` role
 * carries. pi-core's own estimateTokens walks these shapes, so estimating over
 * a session projection needs them to stay on the same scale:
 *  - system            → content + prompt sections + added tool schemas
 *  - compactionSummary → the injected previous summary
 *  - branchSummary     → the branch summary text
 *  - bashExecution     → command + output
 *  - everything else   → estimateMessageContentChars(content)
 */
export const estimateMessageChars = (message: unknown): number => {
  if (!message || typeof message !== "object") return 0;
  const m = message as Record<string, any>;

  if (m.role === "system") {
    let chars = typeof m.content === "string" ? m.content.length : estimateMessageContentChars(m.content);
    if (m.sections && typeof m.sections === "object") {
      for (const value of Object.values(m.sections)) {
        if (typeof value === "string") chars += value.length;
      }
    }
    if (m.toolsAdded !== undefined) chars += safeJsonStringify(m.toolsAdded).length;
    return chars;
  }

  if (m.role === "compactionSummary" || m.role === "branchSummary") {
    return typeof m.summary === "string" ? m.summary.length : 0;
  }

  if (m.role === "bashExecution") {
    return (typeof m.command === "string" ? m.command.length : 0)
      + (typeof m.output === "string" ? m.output.length : 0);
  }

  return estimateMessageContentChars(m.content);
};

const projectedTokens = (messages: readonly unknown[]): number =>
  messages.reduce<number>((sum, m) => sum + estimateTokensFromChars(estimateMessageChars(m)), 0);

/**
 * Estimated token size of the context **after** a compaction.
 *
 * No runtime can know the next provider measurement, so pi's chars/token
 * heuristic is applied to the projection with the summarized messages swapped
 * for the new summary, then rescaled by the ratio between the provider-measured
 * pre-compaction size (`tokensBefore`) and pi's estimate of that same
 * projection. The rescale is what makes the figure comparable to the context
 * numbers the user already sees, rather than a raw heuristic.
 *
 * Returns undefined when there is nothing to calibrate against, so callers omit
 * the figure instead of printing a misleading one.
 */
export const estimatePostCompactionTokens = (args: {
  /** Full context projection before the compaction. */
  projection: readonly unknown[];
  /** Messages this compaction replaces with the summary. */
  removed: readonly unknown[];
  summaryChars: number;
  tokensBefore: number | undefined;
}): number | undefined => {
  const { projection, removed, summaryChars, tokensBefore } = args;
  if (!tokensBefore || tokensBefore <= 0 || projection.length === 0) return undefined;

  const preEstimate = projectedTokens(projection);
  if (preEstimate <= 0) return undefined;

  const scale = tokensBefore / preEstimate;
  const afterEstimate = preEstimate - projectedTokens(removed) + estimateTokensFromChars(summaryChars);
  if (!Number.isFinite(scale) || afterEstimate < 0) return undefined;

  return Math.max(0, Math.round(scale * afterEstimate));
};
