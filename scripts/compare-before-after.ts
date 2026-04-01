import { basename } from "node:path";
import { compile } from "../src/core/summarize";
import { renderMessage } from "../src/core/render-entries";
import { clip } from "../src/core/content";
import { prepareSessionSamples } from "../tests/support/real-sessions";
import { loadSessionMessages } from "../tests/support/load-session";

const SEP = "=".repeat(80);
const samples = await prepareSessionSamples(2);

for (const sample of samples) {
  const loaded = loadSessionMessages(sample.copy);
  const { messages } = loaded;

  const rendered = messages.map((m, i) => renderMessage(m, i));
  const beforeLines = rendered.map(
    (e) => `#${e.index} [${e.role}] ${clip(e.summary, 300)}`,
  );
  const beforeText = beforeLines.join("\n");
  const afterText = compile({ messages });

  console.log(SEP);
  console.log(`FILE: ${basename(sample.source)}`);
  console.log(`Messages: ${messages.length} | Before chars: ${beforeText.length} | After chars: ${afterText.length}`);
  console.log(`Compression: ${(beforeText.length / afterText.length).toFixed(1)}x`);
  console.log(SEP);

  console.log("\n--- BEFORE (raw context, first 40 + last 20 entries) ---\n");
  for (const line of beforeLines.slice(0, 40)) console.log(line);
  if (beforeLines.length > 60) console.log(`\n... (${beforeLines.length - 60} entries omitted) ...\n`);
  for (const line of beforeLines.slice(-20)) console.log(line);

  console.log("\n--- AFTER (pi-vcc compiled summary) ---\n");
  console.log(afterText);
  console.log("\n");
}
