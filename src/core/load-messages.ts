import { readFileSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
}

/**
 * Read the session transcript, treating "file not written yet" as empty history.
 *
 * Pi only creates the session JSONL once it persists the first entry, so a
 * brand-new session has no file on disk. That is an empty current-session
 * history, not a failure. Every other error (permissions, I/O, a path that is
 * not a file) still propagates — silently reporting corruption as "no history"
 * would hide a real problem.
 */
const readSessionFile = (sessionFile: string): string => {
  try {
    return readFileSync(sessionFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw err;
  }
};

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages => {
  const content = readSessionFile(sessionFile);
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];

  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      rendered.push(renderMessage(e.message, messageIndex, full));
      rawMessages.push(e.message);
    }
    messageIndex++;
  }

  return { rendered, rawMessages };
};
