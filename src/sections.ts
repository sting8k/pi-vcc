export interface SectionData {
  filesAndChanges: string[];
  commits: string[];
  userMessages: string[];
  /** Populated only when settings.trackCommands is non-empty -- see
   * core/settings.ts. Empty array otherwise, same as any other section
   * with nothing to report. */
  trackedCommands: string[];
  briefTranscript: string;
}
