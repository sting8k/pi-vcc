import type { Message } from "@mariozechner/pi-ai";

export type NormalizedBlock =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; name: string; args: Record<string, unknown> }
  | { kind: "tool_result"; name: string; text: string; isError: boolean }
  | { kind: "thinking"; text: string; redacted: boolean };
