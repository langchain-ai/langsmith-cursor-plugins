import {
  LOGIN_NOTICE_KIND,
  readLoginNotice,
  refusedLoginReplicas,
  sdkSetting,
  type UploadCredential,
} from "@langchain/plugins-base/auth";
import { NOTICE_KINDS } from "./constants.js";
import type { Config } from "./models/config.js";
import type { PromptNotice, UploadStatus } from "./models/types.js";
import { storageRootFor, uploadCredential, uploadProblem } from "./writer-options.js";

export function promptNotice(
  config: Config,
  credential: UploadCredential,
  problem: string | undefined,
): PromptNotice | undefined {
  if (config.managedConfigProblem !== undefined)
    return { kind: NOTICE_KINDS.managed, text: config.managedConfigProblem };
  if (!config.enabled) return undefined;
  const keyedReplicasOnly =
    !!config.replicas?.length && config.replicas.every((replica) => sdkSetting(replica.apiKey));
  const loginNotice =
    credential.kind === "none" || keyedReplicasOnly
      ? undefined
      : readLoginNotice(
          storageRootFor(config),
          process.env,
          credential.kind === "api-key"
            ? { apiKey: credential.apiKey, apiUrl: credential.apiUrl }
            : undefined,
          config.profile,
        );
  if (loginNotice !== undefined) return { kind: LOGIN_NOTICE_KIND, text: loginNotice };
  const replicaReason =
    credential.kind === "login"
      ? refusedLoginReplicas(config.replicas, credential.apiUrl)
      : undefined;
  if (replicaReason !== undefined) return { kind: NOTICE_KINDS.replica, text: replicaReason };
  return problem === undefined ? undefined : { kind: NOTICE_KINDS.credential, text: problem };
}

export function uploadStatus(config: Config): UploadStatus {
  const credential = uploadCredential(config);
  const problem = uploadProblem(config, credential);
  const notice = promptNotice(config, credential, problem);
  const untraced =
    notice?.kind === LOGIN_NOTICE_KIND ||
    (notice?.kind !== NOTICE_KINDS.managed && problem !== undefined);
  return { credential, problem, notice, untraced };
}
