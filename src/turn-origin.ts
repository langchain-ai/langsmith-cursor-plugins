import { loadConfig, type Config } from "./config.js";
import { createCursorTracingSession } from "./tracing-engine.js";
import { CURSOR_TURN_ORIGIN_ERRORS } from "./constants.js";
import type { ResolvedTurnOriginRoute } from "./models/turn-origin.js";
import type { HookInputBase, TurnOrigin } from "./types.js";

export function originFromConfig(config: Config, input: HookInputBase): TurnOrigin {
  const sessionId = input.session_id ?? input.conversation_id;
  const cwd =
    input.workspace_roots?.[0] ??
    (typeof config.customMetadata?.cwd === "string" ? config.customMetadata.cwd : undefined);
  const tracingSession = createCursorTracingSession(config, sessionId, cwd);
  return {
    project: config.project,
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    ...(tracingSession === undefined
      ? {}
      : { destinationFingerprint: tracingSession.destinationFingerprint }),
    userEmail: input.user_email,
    runtimeVersion: input.cursor_version,
    customMetadata: config.customMetadata,
  };
}

export function resolveTurnOriginRoute(
  origin: TurnOrigin | undefined,
  fallbackSessionId: string,
): ResolvedTurnOriginRoute {
  if (!origin) throw new Error(CURSOR_TURN_ORIGIN_ERRORS.unavailable);
  const metadataCwd =
    typeof origin.customMetadata?.cwd === "string" ? origin.customMetadata.cwd : undefined;
  const cwd = origin.cwd ?? metadataCwd;
  if (!cwd) throw new Error(CURSOR_TURN_ORIGIN_ERRORS.cwdUnavailable);
  if (!origin.destinationFingerprint) {
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationUnavailable);
  }
  const routedConfig = loadConfig({ cwd, includeGitMetadata: false });
  const sessionId = origin.sessionId ?? fallbackSessionId;
  const tracingSession = createCursorTracingSession(
    routedConfig,
    sessionId,
    cwd,
    undefined,
    origin.project,
  );
  if (!tracingSession) {
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationChanged);
  }
  if (origin.destinationFingerprint !== tracingSession.destinationFingerprint) {
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationChanged);
  }
  return { config: routedConfig, cwd, sessionId, tracingSession, origin };
}
