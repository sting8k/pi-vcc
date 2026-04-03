import type { Message } from "@mariozechner/pi-ai";

export const clip = (text: string, max = 200): string =>
  text.slice(0, max);

export const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

export const firstLine = (text: string, max = 200): string =>
  clip(text.split("\n")[0] ?? "", max);

export const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");
