/**
 * LangSmith client construction. Separate from langsmith.ts so the old-Node
 * reporter can build a client without importing that file, which reaches
 * node:sqlite through conversation-steps.ts.
 */

import { Client } from "langsmith";
import { createSecretAnonymizer } from "langsmith/anonymizer";
import type { StringNodeRule } from "langsmith/anonymizer";

export function createTracingClient(
  apiKey?: string,
  apiUrl?: string,
  redact: boolean = true,
  extraRedactionRules?: StringNodeRule[],
): Client {
  const anonymizer = redact
    ? createSecretAnonymizer(extraRedactionRules ? { extraRules: extraRedactionRules } : undefined)
    : undefined;

  // Always retain the configured endpoint, including keyless, unredacted replica-only tracing.
  return new Client({ apiKey: apiKey || undefined, apiUrl, anonymizer });
}
