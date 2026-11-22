import type { NormalizedBlock } from "../types";
import { clip } from "../core/content";
import { SKILL_BLOCK_RE } from "../core/skill-collapse";

/** Each user message becomes one item, clipped to this many characters. */
const USER_MESSAGE_CHARS = 300;
/** [User Messages] keeps this many of the newest messages. */
const USER_MESSAGES_KEPT = 15;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words in any script: Intl.Segmenter splits CJK and Thai too. */
const wordCount = (text: string): number => {
  let n = 0;
  for (const seg of segmenter.segment(text)) if (/[\p{L}\p{N}]/u.test(seg.segment)) n++;
  return n;
};

/**
 * The user's own words in a message, on one line. An expanded skill alone
 * is not the user's words: a skill with text keeps the text behind a
 * `[skill: name]` tag. Text that opens with a tag (`<peer_message …>`,
 * `<local-command-stdout>`) was put there by a tool, and one-word replies
 * ("ok", "好的") say little: both are dropped.
 */
const userLine = (text: string): string => {
  const skills: string[] = [];
  const rest = text
    .replace(SKILL_BLOCK_RE, (_, name: string) => {
      skills.push(name);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  if (rest.startsWith("<") || wordCount(rest) < 2) return "";
  return clip(skills.length > 0 ? `[skill: ${skills.join(", ")}] ${rest}` : rest, USER_MESSAGE_CHARS);
};

/** The newest `USER_MESSAGES_KEPT` lines, oldest first. A repeated line
 * counts as new: it moves to the end. */
export const keepNewestUserMessages = (lines: string[]): string[] => {
  const seq: string[] = [];
  for (const l of lines) {
    const at = seq.indexOf(l);
    if (at >= 0) seq.splice(at, 1);
    seq.push(l);
  }
  return seq.slice(-USER_MESSAGES_KEPT);
};

/**
 * What the user wrote, oldest first, verbatim and clipped. Messages the
 * user did not write (`injected`) are left out. No wording is interpreted, so this works
 * the same in every language.
 */
export const extractUserMessages = (blocks: NormalizedBlock[]): string[] => {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "user" || b.injected) continue;
    const line = userLine(b.text);
    if (line) lines.push(line);
  }
  return lines;
};
