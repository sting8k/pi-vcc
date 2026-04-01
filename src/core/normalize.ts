import type { Message } from "@mariozechner/pi-ai";
import type { NormalizedBlock } from "../types";

const extractText = (content: Message["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
};

const normalizeOne = (msg: Message): NormalizedBlock[] => {
  if (msg.role === "user") {
    return [{ kind: "user", text: extractText(msg.content) }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      name: msg.toolName,
      text: extractText(msg.content),
      isError: msg.isError,
    }];
  }

  // assistant message - split into blocks by content type
  const blocks: NormalizedBlock[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      blocks.push({ kind: "assistant", text: part.text });
    } else if (part.type === "thinking") {
      blocks.push({
        kind: "thinking",
        text: part.thinking,
        redacted: part.redacted ?? false,
      });
    } else if (part.type === "toolCall") {
      blocks.push({
        kind: "tool_call",
        name: part.name,
        args: part.arguments,
      });
    }
  }
  return blocks;
};

export const normalize = (messages: Message[]): NormalizedBlock[] =>
  messages.flatMap(normalizeOne);


