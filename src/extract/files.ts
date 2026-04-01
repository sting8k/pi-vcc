import type { NormalizedBlock } from "../types";

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "tilth", "View",
]);

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const FILE_CREATE_TOOLS = new Set([
  "Write", "write", "write_file",
]);

const extractPath = (args: Record<string, unknown>): string | null => {
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
};

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: { readFiles?: string[]; modifiedFiles?: string[] },
): FileActivity => {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(),
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;

    if (FILE_READ_TOOLS.has(b.name)) act.read.add(p);
    if (FILE_WRITE_TOOLS.has(b.name)) act.modified.add(p);
    if (FILE_CREATE_TOOLS.has(b.name)) act.created.add(p);
  }

  return act;
};


