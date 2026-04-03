import type { Message } from "@mariozechner/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, snippet } from "./content";

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
}

/** Build full searchable text for a message. */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  return textOf(msg.content);
};

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
): SearchHit[] => {
  if (!query?.trim()) return entries;
  const terms = query.toLowerCase().split(/\s+/);

  const hits: SearchHit[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg) : e.summary;
    const filePart = e.files?.join(" ") ?? "";
    const hay = `${e.role} ${text} ${filePart}`.toLowerCase();

    if (terms.every((t) => hay.includes(t))) {
      // Find snippet around the first matching term in the raw text
      let snip: string | undefined;
      for (const t of terms) {
        const s = snippet(text, t);
        if (s) { snip = s; break; }
      }
      hits.push({ ...e, snippet: snip });
    }
  }
  return hits;
};
