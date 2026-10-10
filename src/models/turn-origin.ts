import type { Config } from "../config.js";
import type { TurnOrigin } from "../types.js";

export interface ResolvedTurnOriginRoute {
  config: Config;
  cwd: string;
  sessionId: string;
  storageRoot: string;
  destinationFingerprint: string;
  origin: TurnOrigin;
}
