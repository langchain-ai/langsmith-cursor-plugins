import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createCaptureStore,
  type CaptureStore,
  type JsonValue,
} from "@langchain/plugins-base/storage/capture";
import {
  CURSOR_INTEGRATION,
  CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX,
  CURSOR_NATIVE_TURN_ROUTE_VERSION,
  CURSOR_NATIVE_TURN_SOURCE_VERSION,
  CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH,
  CURSOR_NATIVE_SOURCE_ERRORS,
  CURSOR_TURN_ROUTE_DIRECTORY,
  CURSOR_TURN_ROUTE_EVENT_KIND,
  CURSOR_TURN_SOURCE_DIRECTORY,
  CURSOR_TURN_SOURCE_EVENT_KIND,
  CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS,
} from "./constants.js";
import { toJsonValue } from "./utils/serialization/json.js";
import { isRecord } from "./utils/validation/record.js";
import type {
  CursorNativeTurnSource,
  CursorNativeTurnSourceInput,
  CursorNativeTurnSourceResult,
  CursorNativeTurnRoute,
} from "./models/native-turn-source.js";
import type { TurnBuffer } from "./types.js";
import { skillNameFromTool } from "./metadata.js";
import { isValidBoundedText } from "./utils/validation/text.js";

export function cursorTurnSourceRef(
  sessionId: string,
  conversationId: string,
  turnId: string,
  accountFingerprint: string,
  sourceEventId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CURSOR_INTEGRATION,
        sessionId,
        conversationId,
        turnId,
        accountFingerprint,
        sourceEventId,
        "native-source",
      ]),
    )
    .digest("hex");
}

export async function captureCursorNativeTurnSource(
  input: CursorNativeTurnSourceInput,
): Promise<CursorNativeTurnSourceResult> {
  if (input.buffer.tracingMode === "off") {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.offTurn);
  }
  if (!isValidBoundedText(input.sourceEventId, CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.invalidEventId);
  }
  if (!isValidBoundedText(input.cwd, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.cwd)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.invalidCwd);
  }
  const sourceRef = cursorTurnSourceRef(
    input.sessionId,
    input.conversationId,
    input.buffer.generation_id,
    input.accountFingerprint,
    input.sourceEventId,
  );
  const source: CursorNativeTurnSource = {
    version: CURSOR_NATIVE_TURN_SOURCE_VERSION,
    sourceEventId: input.sourceEventId,
    conversationId: input.conversationId,
    turnNum: input.turnNum,
    buffer: sourceBuffer(input.buffer),
  };
  const route: CursorNativeTurnRoute = {
    version: CURSOR_NATIVE_TURN_ROUTE_VERSION,
    cwd: input.cwd,
  };
  const base = {
    integration: CURSOR_INTEGRATION,
    sessionId: input.sessionId,
    turnId: input.buffer.generation_id,
    eventId: sourceRef,
    runId: sourceRef,
    destinationFingerprint: input.accountFingerprint,
    turnEvidence: { childRunIds: [], closureState: "open" },
    metadataProvenance: {},
    sourceAgeStartedAtMs: input.buffer.startMs,
  };
  const routes = routeStore(input.storageRoot, input.accountFingerprint);
  const routeResult = await routes.capture({
    ...base,
    eventKind: CURSOR_TURN_ROUTE_EVENT_KIND,
    normalizedPayload: toJsonValue(route, "Cursor turn source is not serializable"),
  });
  let storedRoute: CursorNativeTurnRoute;
  if (routeResult.status === "published" || routeResult.status === "duplicate") {
    storedRoute = parseRouteRecord(routeResult.record, input, sourceRef);
  } else if (routeResult.status === "conflict") {
    storedRoute = parseRouteRecord(
      await routes.read({
        integration: CURSOR_INTEGRATION,
        sessionId: input.sessionId,
        turnId: input.buffer.generation_id,
        eventId: sourceRef,
      }),
      input,
      sourceRef,
    );
  } else {
    throw new Error(`${CURSOR_NATIVE_SOURCE_ERRORS.routeWriteFailure}${routeResult.status}`);
  }

  const sources = sourceStore(input.storageRoot, input.accountFingerprint);
  const scope = {
    integration: CURSOR_INTEGRATION,
    sessionId: input.sessionId,
    turnId: input.buffer.generation_id,
    eventId: sourceRef,
  };
  const existing = await sources.read(scope);
  if (existing) {
    return {
      sourceRef,
      source: parseSourceRecord(existing, input, sourceRef),
      route: storedRoute,
    };
  }

  const sourceResult = await sources.capture({
    ...base,
    eventKind: CURSOR_TURN_SOURCE_EVENT_KIND,
    normalizedPayload: toJsonValue(source, "Cursor turn source is not serializable"),
  });
  if (sourceResult.status === "published" || sourceResult.status === "duplicate") {
    return {
      sourceRef,
      source: parseSourceRecord(sourceResult.record, input, sourceRef),
      route: storedRoute,
    };
  }
  if (sourceResult.status === "conflict") {
    const winner = await sources.read(scope);
    if (winner) {
      return {
        sourceRef,
        source: parseSourceRecord(winner, input, sourceRef),
        route: storedRoute,
      };
    }
  }
  throw new Error(`${CURSOR_NATIVE_SOURCE_ERRORS.sourceWriteFailure}${sourceResult.status}`);
}

export async function readCursorNativeTurnSource(
  storageRoot: string,
  sessionId: string,
  turnId: string,
  accountFingerprint: string,
  sourceRef: string,
): Promise<CursorNativeTurnSourceResult> {
  const sourceRecord = await sourceStore(storageRoot, accountFingerprint).read({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: sourceRef,
  });
  if (
    !sourceRecord ||
    sourceRecord.destinationFingerprint !== accountFingerprint ||
    sourceRecord.eventKind !== CURSOR_TURN_SOURCE_EVENT_KIND
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceUnavailable);
  }
  const source = parseSource(sourceRecord.normalizedPayload);
  if (
    sourceRef !==
    cursorTurnSourceRef(
      sessionId,
      source.conversationId,
      turnId,
      accountFingerprint,
      source.sourceEventId,
    )
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceRefInvalid);
  }

  const routeRecord = await routeStore(storageRoot, accountFingerprint).read({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: sourceRef,
  });
  if (
    !routeRecord ||
    routeRecord.integration !== CURSOR_INTEGRATION ||
    routeRecord.sessionId !== sessionId ||
    routeRecord.turnId !== turnId ||
    routeRecord.eventId !== sourceRef ||
    routeRecord.runId !== sourceRef ||
    routeRecord.destinationFingerprint !== accountFingerprint ||
    routeRecord.eventKind !== CURSOR_TURN_ROUTE_EVENT_KIND
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.routeUnavailable);
  }
  const route = parseRoute(routeRecord.normalizedPayload);
  return { sourceRef, source, route };
}

export async function readCursorEarlyNativeTurnSources(
  storageRoot: string,
  sessionId: string,
  turnId: string,
  conversationId: string,
  accountFingerprint: string,
): Promise<CursorNativeTurnSource[]> {
  const captures = await sourceStore(storageRoot, accountFingerprint).enumerateTurn(
    CURSOR_INTEGRATION,
    sessionId,
    turnId,
  );
  return captures.flatMap(({ record }) => {
    if (
      record.destinationFingerprint !== accountFingerprint ||
      record.eventKind !== CURSOR_TURN_SOURCE_EVENT_KIND
    ) {
      return [];
    }
    const source = parseSource(record.normalizedPayload);
    if (
      source.conversationId !== conversationId ||
      !source.sourceEventId.startsWith(CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX) ||
      record.eventId !==
        cursorTurnSourceRef(
          sessionId,
          source.conversationId,
          turnId,
          accountFingerprint,
          source.sourceEventId,
        )
    ) {
      return [];
    }
    return [source];
  });
}

export function mergeCursorEarlyToolSources(
  finalSource: CursorNativeTurnSource,
  earlySources: readonly CursorNativeTurnSource[],
): CursorNativeTurnSource {
  return {
    ...finalSource,
    buffer: mergeCursorEarlyToolBuffer(
      finalSource.conversationId,
      finalSource.buffer,
      earlySources,
    ),
  };
}

export function mergeCursorEarlyToolBuffer(
  conversationId: string,
  buffer: TurnBuffer,
  earlySources: readonly CursorNativeTurnSource[],
): TurnBuffer {
  const tools = new Map(buffer.tools.map((tool) => [tool.tool_use_id, tool]));
  for (const source of earlySources) {
    if (
      source.conversationId !== conversationId ||
      source.buffer.generation_id !== buffer.generation_id ||
      source.buffer.tracingMode !== buffer.tracingMode
    ) {
      continue;
    }
    for (const tool of source.buffer.tools) {
      if (!tools.has(tool.tool_use_id)) tools.set(tool.tool_use_id, tool);
    }
  }
  return {
    ...buffer,
    tools: [...tools.values()].sort(
      (left, right) =>
        left.endMs - right.endMs || left.tool_use_id.localeCompare(right.tool_use_id),
    ),
  };
}

function parseSourceRecord(
  record: Awaited<ReturnType<CaptureStore["read"]>>,
  input: CursorNativeTurnSourceInput,
  sourceRef: string,
): CursorNativeTurnSource {
  if (
    !record ||
    record.integration !== CURSOR_INTEGRATION ||
    record.sessionId !== input.sessionId ||
    record.turnId !== input.buffer.generation_id ||
    record.eventId !== sourceRef ||
    record.runId !== sourceRef ||
    record.destinationFingerprint !== input.accountFingerprint ||
    record.eventKind !== CURSOR_TURN_SOURCE_EVENT_KIND
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceUnavailable);
  }
  const source = parseSource(record.normalizedPayload);
  if (
    source.conversationId !== input.conversationId ||
    source.buffer.generation_id !== record.turnId
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceTurnMismatch);
  }
  return source;
}

function parseRouteRecord(
  record: Awaited<ReturnType<CaptureStore["read"]>>,
  input: CursorNativeTurnSourceInput,
  sourceRef: string,
): CursorNativeTurnRoute {
  if (
    !record ||
    record.integration !== CURSOR_INTEGRATION ||
    record.sessionId !== input.sessionId ||
    record.turnId !== input.buffer.generation_id ||
    record.eventId !== sourceRef ||
    record.runId !== sourceRef ||
    record.destinationFingerprint !== input.accountFingerprint ||
    record.eventKind !== CURSOR_TURN_ROUTE_EVENT_KIND
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.routeUnavailable);
  }
  return parseRoute(record.normalizedPayload);
}

function sourceStore(storageRoot: string, accountFingerprint: string): CaptureStore {
  return createCaptureStore(
    join(storageRoot, CURSOR_TURN_SOURCE_DIRECTORY, accountHash(accountFingerprint)),
  );
}

function routeStore(storageRoot: string, accountFingerprint: string): CaptureStore {
  return createCaptureStore(
    join(storageRoot, CURSOR_TURN_ROUTE_DIRECTORY, accountHash(accountFingerprint)),
  );
}

function accountHash(accountFingerprint: string): string {
  return createHash("sha256").update(accountFingerprint).digest("hex");
}

function sourceBuffer(buffer: TurnBuffer): TurnBuffer {
  if (buffer.tracingMode === "full") {
    return {
      ...structuredClone(buffer),
      subagents: buffer.subagents
        .filter((subagent) => subagent.tracingMode !== "off")
        .map((subagent) => sourceSubagent(subagent, true)),
    };
  }
  if (buffer.tracingMode === "off") {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.offTurn);
  }
  const origin = buffer.origin;
  return {
    ...buffer,
    tracingMode: "metadata",
    prompt: undefined,
    finalText: undefined,
    thoughts: [],
    origin: origin
      ? {
          project: origin.project,
          ...(origin.userEmail === undefined ? {} : { userEmail: origin.userEmail }),
          ...(origin.runtimeVersion === undefined ? {} : { runtimeVersion: origin.runtimeVersion }),
        }
      : undefined,
    tools: buffer.tools.map(metadataTool),
    subagents: buffer.subagents
      .filter((subagent) => subagent.tracingMode !== "off")
      .map((subagent) => sourceSubagent(subagent, false)),
  };
}

function sourceSubagent(
  subagent: TurnBuffer["subagents"][number],
  allowFull: boolean,
): TurnBuffer["subagents"][number] {
  if (allowFull && subagent.tracingMode === "full") return structuredClone(subagent);
  return {
    ...subagent,
    tracingMode: "metadata",
    task: "",
    description: undefined,
    resultText: undefined,
    systemPrompt: undefined,
    tools: subagent.tools?.map(metadataTool),
  };
}

function metadataTool(tool: TurnBuffer["tools"][number]): TurnBuffer["tools"][number] {
  const skillName = skillNameFromTool(tool.name, tool.input);
  return {
    ...tool,
    input: skillName ? { path: `skills/${skillName}/SKILL.md` } : {},
    output: undefined,
    error: tool.error === undefined ? undefined : "error",
  };
}

function parseSource(value: JsonValue): CursorNativeTurnSource {
  if (
    !isRecord(value) ||
    value.version !== CURSOR_NATIVE_TURN_SOURCE_VERSION ||
    typeof value.sourceEventId !== "string" ||
    !isValidBoundedText(value.sourceEventId, CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH) ||
    typeof value.conversationId !== "string"
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceInvalid);
  }
  const turnNum = value.turnNum;
  const buffer = value.buffer;
  if (typeof turnNum !== "number" || !Number.isSafeInteger(turnNum) || !isTurnBuffer(buffer)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.bufferInvalid);
  }
  return {
    version: CURSOR_NATIVE_TURN_SOURCE_VERSION,
    sourceEventId: value.sourceEventId,
    conversationId: value.conversationId,
    turnNum,
    buffer,
  };
}

function parseRoute(value: JsonValue): CursorNativeTurnRoute {
  if (
    !isRecord(value) ||
    value.version !== CURSOR_NATIVE_TURN_ROUTE_VERSION ||
    typeof value.cwd !== "string" ||
    !isValidBoundedText(value.cwd, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.cwd)
  ) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.routeInvalid);
  }
  return { version: CURSOR_NATIVE_TURN_ROUTE_VERSION, cwd: value.cwd };
}

function isTurnBuffer(value: unknown): value is TurnBuffer {
  if (!isRecord(value)) return false;
  return (
    typeof value.generation_id === "string" &&
    Number.isSafeInteger(value.startMs) &&
    Array.isArray(value.tools) &&
    Array.isArray(value.thoughts) &&
    Array.isArray(value.subagents)
  );
}
