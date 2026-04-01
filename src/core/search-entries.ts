import type { RenderedEntry } from "./render-entries";

export const searchEntries = (
  entries: RenderedEntry[],
  query?: string,
): RenderedEntry[] => {
  if (!query?.trim()) return entries;
  const terms = query.toLowerCase().split(/\s+/);
  return entries.filter((e) => {
    const filePart = e.files?.join(" ") ?? "";
    const hay = `${e.role} ${e.summary} ${filePart}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
};
