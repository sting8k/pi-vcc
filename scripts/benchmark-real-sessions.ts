import { performance } from "node:perf_hooks";
import { basename } from "node:path";
import { buildCompactReport } from "../src/core/report";
import { prepareSessionSamples } from "../tests/support/real-sessions";
import { loadSessionMessages } from "../tests/support/load-session";

const samples = await prepareSessionSamples(2);
for (const sample of samples) {
  const loaded = loadSessionMessages(sample.copy);
  const start = performance.now();
  const report = buildCompactReport({ messages: loaded.messages });
  const elapsedMs = performance.now() - start;
  console.log(JSON.stringify({
    sourceFile: basename(sample.source),
    sourceSizeBytes: sample.size,
    copiedToTemp: true,
    loadedMessages: loaded.messageCount,
    skippedMessages: loaded.skippedCount,
    compileMs: Number(elapsedMs.toFixed(2)),
    before: report.before,
    after: report.after,
    compression: report.compression,
    recall: report.recall,
  }, null, 2));
}
