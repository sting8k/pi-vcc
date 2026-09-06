import { closeSync, openSync, readSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages => {
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  let messageIndex = 0;

  const processLine = (line: Buffer) => {
    if (line.length === 0) return;
    let entry: any;
    try { entry = JSON.parse(line.toString("utf8")); } catch { return; }
    if (entry.type !== "message" || !entry.message) return;

    const allowed = !allowedEntryIds || allowedEntryIds.has(entry.id);
    if (allowed) {
      rendered.push(renderMessage(entry.message, messageIndex, full));
      rawMessages.push(entry.message);
    }
    messageIndex++;
  };

  // Avoid materializing the entire JSONL file as one string. Large sessions can
  // exceed V8's maximum string length before parsing even starts.
  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch (err) {
    // Pi does not create a new session's JSONL until its first persisted entry.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { rendered, rawMessages };
    throw err;
  }

  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending: Buffer[] = [];
  let pendingLength = 0;

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] !== 0x0a) continue;

        const segment = chunk.subarray(start, i);
        if (pendingLength > 0) {
          pending.push(segment);
          processLine(Buffer.concat(pending, pendingLength + segment.length));
          pending = [];
          pendingLength = 0;
        } else {
          processLine(segment);
        }
        start = i + 1;
      }

      if (start < bytesRead) {
        const remainder = Buffer.from(chunk.subarray(start, bytesRead));
        pending.push(remainder);
        pendingLength += remainder.length;
      }
    }

    // JSONL files normally end with a newline, but preserve a final partial line.
    if (pendingLength > 0) processLine(Buffer.concat(pending, pendingLength));
  } finally {
    closeSync(fd);
  }

  return { rendered, rawMessages };
};
