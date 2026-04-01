import type { Message } from "@mariozechner/pi-ai";
import { normalize } from "./normalize";
import { buildSections } from "./build-sections";
import { formatSummary } from "./format";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
  customInstructions?: string;
}

const mergePrevious = (prev: string, fresh: string): string => {
  return `${prev}\n\n---\n[Delta Since Last Compaction]\n\n${fresh}`;
};

export const compile = (input: CompileInput): string => {
  const blocks = normalize(input.messages);
  const data = buildSections({ blocks, fileOps: input.fileOps });
  const fresh = formatSummary(data);

  if (input.previousSummary) {
    return mergePrevious(input.previousSummary, fresh);
  }
  return fresh;
};

