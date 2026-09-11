/**
 * Reports an unusable Node version to LangSmith as one error run, so the
 * failure shows up in the user's project and not only in the local log.
 * Nothing imported here may reach node:sqlite: this runs on the Node that
 * could not load it.
 */

import { initHook } from "../utils/hook-init.js";
import { createTracingClient } from "../client.js";
import { createRunTree } from "../privacy.js";
import { DEFAULT_TAGS } from "../constants.js";
import {
  LS_AGENT_PURPOSE,
  LS_AGENT_RUNTIME,
  LS_INTEGRATION,
  LS_TRACE_SCHEMA_VERSION,
} from "../metadata.js";
import { LS_INTEGRATION_VERSION } from "../config.js";

const RUN_NAME = "Cursor Tracing Unavailable";

/** Well inside the 15s beforeSubmitPrompt timeout (hooks.json), which also pays for config load. */
const REPORT_TIMEOUT_MS = 5_000;

export interface OldNodeReport {
  message: string;
  version: string;
  execPath: string;
}

/** The guard swallows anything that goes wrong here. */
export async function reportOldNode(
  report: OldNodeReport,
  budgetMs = REPORT_TIMEOUT_MS,
): Promise<void> {
  const config = initHook();
  if (!config) return;

  const client = createTracingClient(
    config.apiKey,
    config.apiUrl,
    config.redact,
    config.redactExtraRules,
  );
  const now = Date.now();
  const run = createRunTree({
    client,
    replicas: config.replicas,
    name: RUN_NAME,
    run_type: "chain",
    project_name: config.project,
    tags: DEFAULT_TAGS,
    error: report.message,
    start_time: now,
    end_time: now,
    extra: {
      // No thread_id: the run belongs to no conversation. The rest of the
      // coding-agent-v1 identity block still applies.
      metadata: {
        ls_agent_purpose: LS_AGENT_PURPOSE,
        ls_agent_type: "root",
        ls_integration: LS_INTEGRATION,
        ls_agent_runtime: LS_AGENT_RUNTIME,
        ls_trace_schema_version: LS_TRACE_SCHEMA_VERSION,
        ...(LS_INTEGRATION_VERSION ? { ls_integration_version: LS_INTEGRATION_VERSION } : {}),
        node_version: report.version,
        node_exec_path: report.execPath,
      },
    },
  });

  // unref so a timer that outlives the upload cannot keep the hook alive.
  const budget = new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref());
  await Promise.race([run.postRun().then(() => client.awaitPendingTraceBatches()), budget]);
}
