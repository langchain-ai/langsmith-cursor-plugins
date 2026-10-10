import type { Config } from "../config.js";
import type { TurnOrigin } from "../types.js";
import type { CursorTracingSessionContext } from "./tracing-engine.js";

export interface ResolvedTurnOriginRoute {
  config: Config;
  cwd: string;
  sessionId: string;
  tracingSession: CursorTracingSessionContext;
  origin: TurnOrigin;
}
