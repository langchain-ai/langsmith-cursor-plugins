import {
  LOGIN_NOTICE_KIND,
  readLoginNotice,
  refusedLoginReplicas,
  type UploadCredential,
} from "@langchain/plugins-base/auth";
import { NOTICE_KINDS } from "./constants.js";
import type { Config } from "./models/config.js";
import type { PromptNotice } from "./models/types.js";
import { storageRootFor } from "./writer-options.js";

export function promptNotice(
  config: Config,
  credential: UploadCredential,
  problem: string | undefined,
): PromptNotice | undefined {
  if (config.managedConfigProblem !== undefined)
    return { kind: NOTICE_KINDS.managed, text: config.managedConfigProblem };
  if (!config.enabled) return undefined;
  const loginNotice =
    credential.kind === "none"
      ? undefined
      : readLoginNotice(
          storageRootFor(config),
          process.env,
          credential.kind === "api-key"
            ? { apiKey: credential.apiKey, apiUrl: credential.apiUrl }
            : undefined,
        );
  if (loginNotice !== undefined) return { kind: LOGIN_NOTICE_KIND, text: loginNotice };
  const replicaReason =
    credential.kind === "login"
      ? refusedLoginReplicas(config.replicas, credential.apiUrl)
      : undefined;
  if (replicaReason !== undefined) return { kind: NOTICE_KINDS.replica, text: replicaReason };
  return problem === undefined ? undefined : { kind: NOTICE_KINDS.credential, text: problem };
}
