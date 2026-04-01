import type { Message } from "@mariozechner/pi-ai";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
}

const textOf = (content: Message["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
};

const toolCalls = (content: Message["content"]): string => {
  if (typeof content === "string") return "";
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => {
      const tc = c as { name: string; arguments: Record<string, unknown> };
      const path = tc.arguments?.path ?? tc.arguments?.command ?? "";
      return `${tc.name}(${path})`;
    })
    .join(", ");
};

export const renderMessage = (msg: Message, index: number): RenderedEntry => {
  if (msg.role === "user") {
    return { index, role: "user", summary: textOf(msg.content).slice(0, 300) };
  }
  if (msg.role === "toolResult") {
    const prefix = msg.isError ? "ERROR " : "";
    return {
      index, role: "tool_result",
      summary: `${prefix}[${msg.toolName}] ${textOf(msg.content).slice(0, 200)}`,
    };
  }
  // assistant
  const text = textOf(msg.content).slice(0, 300);
  const tools = toolCalls(msg.content);
  const summary = tools ? `${tools}\n${text}` : text;
  return { index, role: "assistant", summary };
};


