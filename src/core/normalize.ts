import type { Message } from "@mariozechner/pi-ai";
import type { NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

const normalizeOne = (msg: Message): NormalizedBlock[] => {
  if (msg.role === "user") {
    return [{ kind: "user", text: sanitize(textOf(msg.content)) }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      name: msg.toolName,
      text: sanitize(textOf(msg.content)),
      isError: msg.isError,
    }];
  }

  if (typeof msg.content === "string") {
    return [{ kind: "assistant", text: sanitize(msg.content) }];
  }

  const blocks: NormalizedBlock[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      blocks.push({ kind: "assistant", text: sanitize(part.text) });
    } else if (part.type === "thinking") {
      blocks.push({
        kind: "thinking",
        text: sanitize(part.thinking),
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


