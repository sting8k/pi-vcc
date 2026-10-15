import type { CompactionReason } from "./types";

export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason?: CompactionReason;
  willRetry?: boolean;
  /** Estimated context size after this compaction, calibrated to the
   * provider-measured pre-compaction size. Absent on older entries. */
  postTokensEst?: number;
}
