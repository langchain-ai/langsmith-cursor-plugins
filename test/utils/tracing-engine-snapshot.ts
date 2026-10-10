import type { SnapshotDependencyRecord } from "../models/tracing-engine-snapshot.js";

export function hasDependencyPath(
  records: readonly SnapshotDependencyRecord[],
  fromEventId: string,
  targetEventId: string,
): boolean {
  const recordsById = new Map(records.map((record) => [record.eventId, record]));
  const visited = new Set<string>();
  const visit = (eventId: string): boolean => {
    if (eventId === targetEventId) return true;
    if (visited.has(eventId)) return false;
    visited.add(eventId);
    return (recordsById.get(eventId)?.dependencies ?? []).some((dependency) =>
      visit(dependency.eventId),
    );
  };
  return visit(fromEventId);
}
