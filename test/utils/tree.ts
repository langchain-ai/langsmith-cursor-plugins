import { Client, type Run } from "langsmith";

/**
 * Reconstruct the posted run tree from captured fetch calls. Returns stable
 * "name:index" node ids, parent→child edges, and per-node data.
 */
export async function getAssumedTreeFromCalls(
  calls: unknown[][],
  client: Client,
): Promise<{
  nodes: string[];
  edges: Array<[string, string]>;
  data: Record<string, Run>;
}> {
  await client.awaitPendingTraceBatches();

  const edges: Array<[string, string]> = [];
  const nodeMap: Record<string, Run> = {};
  const idMap: string[] = [];

  function upsertId(id: string) {
    const idx = idMap.indexOf(id);
    if (idx < 0) {
      idMap.push(id);
      return idMap.length - 1;
    }
    return idx;
  }

  function getId(id: string) {
    const stableId = upsertId(id);
    return [nodeMap[id].name, stableId].join(":");
  }

  for (const call of calls) {
    const [url, fetchArgs] = call.slice(-2) as [
      string,
      { method: string; body: string | Uint8Array },
    ];
    const req = `${fetchArgs.method} ${new URL(url as string).pathname}`;
    let body: Run | undefined;
    if (typeof fetchArgs.body === "string") {
      body = JSON.parse(fetchArgs.body);
    } else if (fetchArgs.body) {
      const decoded = new TextDecoder().decode(fetchArgs.body);
      if (decoded.trim().startsWith("{")) body = JSON.parse(decoded);
    }
    if (!body) continue;

    if (req === "POST /runs" || req === "POST /api/v1/runs") {
      const id = body.id;
      upsertId(id);
      nodeMap[id] = { ...nodeMap[id], ...body };
      if (nodeMap[id].parent_run_id) {
        edges.push([nodeMap[id].parent_run_id!, nodeMap[id].id]);
      }
    } else if (req.startsWith("PATCH /runs/") || req.startsWith("PATCH /api/v1/runs/")) {
      const prefix = req.startsWith("PATCH /api/v1/runs/")
        ? "PATCH /api/v1/runs/".length
        : "PATCH /runs/".length;
      const id = req.substring(prefix);
      upsertId(id);
      nodeMap[id] = { ...nodeMap[id], ...body };
    }
  }

  return {
    nodes: idMap.map(getId),
    edges: edges.map(([source, target]) => [getId(source), getId(target)] as [string, string]),
    data: Object.fromEntries(Object.entries(nodeMap).map(([id, v]) => [getId(id), v] as const)),
  };
}
