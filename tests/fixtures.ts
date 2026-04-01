import type { Message } from "@mariozechner/pi-ai";

const ts = Date.now();
const assistBase = {
  api: "messages" as any,
  provider: "anthropic" as any,
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  timestamp: ts,
};

export const userMsg = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: ts,
});

export const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...assistBase,
  stopReason: "stop",
});

export const assistantWithThinking = (
  text: string,
  thinking: string,
): Message => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking },
    { type: "text", text },
  ],
  ...assistBase,
  stopReason: "stop",
});

export const assistantWithToolCall = (
  name: string,
  args: Record<string, unknown>,
): Message => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "tc_1", name, arguments: args }],
  ...assistBase,
  stopReason: "toolUse",
});

export const toolResult = (
  name: string,
  text: string,
  isError = false,
): Message => ({
  role: "toolResult",
  toolCallId: "tc_1",
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});


