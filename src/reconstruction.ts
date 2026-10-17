import type { Reconstruct } from "./models/tracing-engine.js";

/** Cursor saves finished runs, never source records to rebuild later, so there is nothing to rebuild. */
export const noReconstruction: Reconstruct = async () => ({ status: "ready", outputs: [] });
