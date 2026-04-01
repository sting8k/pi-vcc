import type { RenderedEntry } from "./render-entries";

export const formatRecallOutput = (
  entries: RenderedEntry[],
  query?: string,
): string => {
  if (entries.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }

  const header = query
    ? `Found ${entries.length} matches for "${query}":`
    : `Session history (${entries.length} entries):`;

  const lines = entries.map((e) => {
    const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
    return `#${e.index} [${e.role}]${fileSuffix} ${e.summary}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};
