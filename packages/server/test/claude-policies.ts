import { analysisPolicy, chatPolicy } from "../src/agent/claude-code/permissions.js";
import { ANALYSIS_CLI_SUBCOMMANDS } from "../src/analysis.js";
import { CHAT_CLI_SUBCOMMANDS } from "../src/chat.js";
import { cliCommand } from "../src/skill-paths.js";

/** The Claude tool policy the analysis task translates to, as the harness builds it. */
export function analysisToolFlags(scratchDir: string, opts: { transcriptDir?: string } = {}) {
  return analysisPolicy({ scratchDir, reviewerCommands: ANALYSIS_CLI_SUBCOMMANDS }, cliCommand(), opts);
}

/** The Claude tool policy the chat task translates to, as the harness builds it. */
export function chatToolFlags() {
  return chatPolicy({ reviewerCommands: CHAT_CLI_SUBCOMMANDS }, cliCommand());
}
