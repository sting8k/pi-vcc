import type { Message } from "@earendil-works/pi-ai";
import { clip, textOf } from "./content";
import { summarizeToolArgs } from "./tool-args";
import { extractPath } from "./tool-args";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

const toolCalls = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
    .join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
  if (!content || typeof content === "string") return [];
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => extractPath(c.arguments))
    .filter((p): p is string => p !== null);
};

const clipCap = (maxChars: number | undefined, dflt: number): number =>
  maxChars !== undefined ? Math.min(maxChars, dflt) : dflt;

export const renderMessage = (msg: Message, index: number, full = false, maxChars?: number): RenderedEntry => {
  if (msg.role === "user") {
    return { index, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), clipCap(maxChars, 300)) };
  }
  if (msg.role === "toolResult") {
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), clipCap(maxChars, 200));
    return {
      index, role: "tool_result",
      summary: `[${msg.toolName}] ${text}`,
    };
  }
  // bashExecution has command+output instead of content
  if ((msg as any).role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, clipCap(maxChars, 300));
    return { index, role: "bash", summary: text };
  }
  const text = full ? textOf(msg.content) : clip(textOf(msg.content), clipCap(maxChars, 300));
  const tools = toolCalls(msg.content);
  const files = extractFilesFromContent(msg.content);
  const combined = tools ? `${tools}\n${text}` : text;
  // When a maxChars cap is in effect, bound the whole summary (tool args
  // included) so tool-heavy ranges actually stay lean.
  const summary = !full && maxChars !== undefined ? clip(combined, Math.min(maxChars, 300)) : combined;
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};


