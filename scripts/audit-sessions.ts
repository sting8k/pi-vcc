import { basename, dirname } from "node:path";
import { compile } from "../src/core/summarize";
import { normalize } from "../src/core/normalize";
import { filterNoise } from "../src/core/filter-noise";
import { renderMessage } from "../src/core/render-entries";
import { prepareSessionSamples } from "../tests/support/real-sessions";
import { loadSessionMessages } from "../tests/support/load-session";

const SEP = "=".repeat(80);
const samples = await prepareSessionSamples(10);

for (const sample of samples) {
  const loaded = loadSessionMessages(sample.copy);
  const { messages } = loaded;

  const rawBlocks = normalize(messages);
  const filteredBlocks = filterNoise(rawBlocks);
  const afterText = compile({ messages });

  const rendered = messages.map((m, i) => renderMessage(m, i));
  const beforeChars = rendered.reduce((s, e) => s + e.summary.length, 0);

  const project = dirname(sample.source).split("--").filter(Boolean).pop() ?? "unknown";

  const goalSection = afterText.match(/\[Session Goal\]\n([\s\S]*?)(?=\n\n\[|$)/)?.[1] ?? "(empty)";
  const stateSection = afterText.match(/\[Current State\]\n([\s\S]*?)(?=\n\n\[|$)/)?.[1] ?? "(empty)";
  const doneSection = afterText.match(/\[What Was Done\]\n([\s\S]*?)(?=\n\n\[|$)/)?.[1] ?? "(empty)";
  const problemsSection = afterText.match(/\[Open Problems\]\n([\s\S]*?)(?=\n\n\[|$)/)?.[1] ?? "(empty)";
  const nextSection = afterText.match(/\[Next Best Steps\]\n([\s\S]*?)(?=\n\n\[|$)/)?.[1] ?? "(empty)";

  const doneLines = doneSection.split("\n").filter(l => l.trim());
  const problemLines = problemsSection.split("\n").filter(l => l.trim());

  // Detect issues
  const issues: string[] = [];

  // 1. Goal quality
  const goalLines = goalSection.split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  if (goalLines[0] && goalLines[0].length < 5) issues.push(`GOAL_TOO_SHORT: "${goalLines[0]}"`);
  if (goalLines.length === 0) issues.push("GOAL_EMPTY");

  // 2. Sensitive data in What Was Done
  if (/sshpass|password|secret|token=|api[_-]?key/i.test(doneSection)) {
    issues.push("SENSITIVE_DATA_IN_DONE");
  }

  // 3. Raw code/minified JS in summary
  if (/\{[a-zA-Z$_]+:[a-zA-Z$_]+,[a-zA-Z$_]+:/.test(afterText) || /var [a-zA-Z]+=/.test(afterText)) {
    issues.push("RAW_CODE_LEAK");
  }

  // 4. Open problems count
  if (problemLines.length > 10) issues.push(`PROBLEMS_OVERCOUNT: ${problemLines.length}`);

  // 5. Next steps empty
  if (nextSection === "(empty)") issues.push("NEXT_STEPS_EMPTY");

  // 6. What Was Done too verbose
  if (doneLines.length > 15) issues.push(`DONE_TOO_VERBOSE: ${doneLines.length} lines`);

  // 7. Summary too large (>10K chars)
  if (afterText.length > 10000) issues.push(`SUMMARY_TOO_LARGE: ${afterText.length} chars`);

  console.log(SEP);
  console.log(`PROJECT: ${project}`);
  console.log(`FILE: ${basename(sample.source)}`);
  console.log(`Size: ${(sample.size / 1024).toFixed(0)}KB | Msgs: ${messages.length} | Blocks raw: ${rawBlocks.length} -> filtered: ${filteredBlocks.length}`);
  console.log(`Before: ${beforeChars} chars | After: ${afterText.length} chars | Ratio: ${(beforeChars / afterText.length).toFixed(1)}x`);
  console.log(`Issues: ${issues.length === 0 ? "NONE" : issues.join(", ")}`);
  console.log("");
  console.log("--- GOAL ---");
  console.log(goalSection.slice(0, 300));
  console.log("");
  console.log("--- CURRENT STATE (first 300c) ---");
  console.log(stateSection.slice(0, 300));
  console.log("");
  console.log("--- WHAT WAS DONE (first 5 lines) ---");
  console.log(doneLines.slice(0, 5).join("\n"));
  console.log(`... (${doneLines.length} total lines)`);
  console.log("");
  console.log("--- OPEN PROBLEMS (first 5 lines) ---");
  console.log(problemLines.slice(0, 5).join("\n"));
  console.log(`... (${problemLines.length} total lines)`);
  console.log("");
  console.log("--- NEXT STEPS ---");
  console.log(nextSection.slice(0, 300));
  console.log("");
}
