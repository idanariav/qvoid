import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveCollection } from "../config.js";
import { readJsonl } from "../indexer.js";
import { clusterDuplicates, findSimilar } from "../embeddings.js";
import { filterLinks } from "../query.js";

const DESTINATION_TYPES = ["idea", "person", "date", "file", "template", "unknown"] as const;

function jsonText(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errText(msg: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export async function startMcp(): Promise<void> {
  const server = new Server(
    { name: "qvoid", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "query",
        description:
          "Filter the unresolved-link index by type, origin folder, semantic annotation, occurrence count, or free-text. " +
          "Returns an array of link records with target, classification, confidence, occurrences, and stats.",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string", description: "Collection name (omit to auto-detect)" },
            destination: {
              oneOf: [
                { type: "string", enum: [...DESTINATION_TYPES] },
                { type: "array", items: { type: "string", enum: [...DESTINATION_TYPES] } },
              ],
              description: "Filter by link type — one value or an array for OR matching",
            },
            origin: { type: "string", description: "Source path prefix, e.g. Sources/Articles" },
            semantic_type: { type: "string", description: "Inline annotation name, e.g. Supports" },
            min_occurrences: { type: "number", description: "Minimum occurrence count across the vault" },
            search: { type: "string", description: "Substring match on target name or surrounding context" },
            limit: { type: "number", description: "Cap result count" },
          },
        },
      },
      {
        name: "find_similar",
        description:
          "Find unresolved link targets that are semantically similar to a query string or an existing target name. " +
          "Requires embeddings to have been built with `qvoid embed`.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text description or existing target name" },
            collection: { type: "string", description: "Collection name (omit to auto-detect)" },
            top_k: { type: "number", description: "Maximum results to return (default 10)" },
            min_score: { type: "number", description: "Minimum cosine similarity threshold (default 0.5)" },
          },
          required: ["query"],
        },
      },
      {
        name: "cluster",
        description:
          "Return groups of unresolved link targets that are suspected near-duplicates, ranked by cluster size. " +
          "Requires embeddings to have been built with `qvoid embed`.",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string", description: "Collection name (omit to auto-detect)" },
            threshold: { type: "number", description: "Cosine-similarity threshold for grouping (default 0.82)" },
          },
        },
      },
      {
        name: "status",
        description: "Return index statistics: total targets, breakdown by type and confidence.",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string", description: "Collection name (omit to auto-detect)" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    const args = (a ?? {}) as Record<string, unknown>;

    if (name === "query") {
      try {
        const col = resolveCollection(str(args["collection"]));
        const links = readJsonl(col.jsonlPath);
        const destRaw = args["destination"];
        const destination = Array.isArray(destRaw) ? (destRaw as string[]) : str(destRaw);
        const filtered = filterLinks(links, {
          destination,
          origin: str(args["origin"]),
          semanticType: str(args["semantic_type"]),
          minOccurrences: num(args["min_occurrences"]),
          search: str(args["search"]),
          limit: num(args["limit"]),
        });
        return jsonText(filtered);
      } catch (e) {
        return errText(String(e));
      }
    }

    if (name === "find_similar") {
      const query = str(args["query"]);
      if (!query) return errText("missing query");
      try {
        const col = resolveCollection(str(args["collection"]));
        const results = await findSimilar(query, col.vectorsPath, col.manifestPath, {
          topK: num(args["top_k"]) ?? 10,
          minScore: num(args["min_score"]) ?? 0.5,
        });
        return jsonText(results);
      } catch (e) {
        return errText(String(e));
      }
    }

    if (name === "cluster") {
      try {
        const col = resolveCollection(str(args["collection"]));
        const threshold = num(args["threshold"]) ?? 0.82;
        const groups = clusterDuplicates(col.vectorsPath, col.manifestPath, threshold);
        groups.sort((a, b) => b.length - a.length);
        return jsonText(groups);
      } catch (e) {
        return errText(String(e));
      }
    }

    if (name === "status") {
      try {
        const col = resolveCollection(str(args["collection"]));
        const links = readJsonl(col.jsonlPath);
        const byType: Record<string, number> = {};
        const byConf: Record<string, number> = {};
        for (const l of links) {
          byType[l.expected_destination] = (byType[l.expected_destination] ?? 0) + 1;
          byConf[l.classification_confidence] = (byConf[l.classification_confidence] ?? 0) + 1;
        }
        return jsonText({
          collection: col.name,
          vault_path: col.path,
          total_targets: links.length,
          by_type: byType,
          by_confidence: byConf,
        });
      } catch (e) {
        return errText(String(e));
      }
    }

    return errText(`unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
