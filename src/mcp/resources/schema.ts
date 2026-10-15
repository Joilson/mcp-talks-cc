import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withSession } from '../../neo4j/driver.ts';

/**
 * Inventário de nós e arestas lido do banco, não escrito à mão.
 *
 * A versão anterior era 92 linhas de markdown fixo, e já estava errada antes de
 * qualquer mudança nova: documentava `HAS_TODO`, que nunca produziu uma aresta
 * sequer, e descrevia o score como `RRF: 1/(60+rank_vec) + 1/(60+rank_bm25)`, substituído por RRF.
 * Doc de schema mantida à mão drifta; gerar é a única forma de não voltar a
 * mentir. O glossário semântico abaixo continua escrito à mão porque ISSO o
 * banco não sabe dizer.
 */
async function liveInventory(): Promise<string> {
  try {
    return await withSession(async (s) => {
      const nodes = await s.run(
        `CALL db.labels() YIELD label
         CALL (label) { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS n }
         RETURN label, n ORDER BY n DESC`,
      );
      const edges = await s.run(
        `CALL db.relationshipTypes() YIELD relationshipType AS t
         CALL (t) { WITH t MATCH ()-[r]->() WHERE type(r) = t RETURN count(r) AS n }
         RETURN t, n ORDER BY n DESC`,
      );
      const fmt = (rs: { get: (k: string) => unknown }[], a: string, b: string): string =>
        rs.map((r) => `- ${String(r.get(a))} — ${String(r.get(b))}`).join('\n');
      return [
        '## Nodes (live count)',
        fmt(nodes.records, 'label', 'n'),
        '',
        '## Edges (live count)',
        fmt(edges.records, 't', 'n'),
      ].join('\n');
    });
  } catch {
    return '_(inventário indisponível: Neo4j fora do ar)_';
  }
}

const SCHEMA_DOC = `# mcp-talks-cc — Neo4j schema

## Nodes
- Project { path, name, lastIndexed }                  — one per cwd
- Session { id, projectPath, startedAt, endedAt,
            messageCount, gitBranch, version }         — one per JSONL file
- Message { uuid, sessionId, role, timestamp,
            parentUuid, text }                         — one per user/assistant event
- ToolCall { id, name, outputSnippet, timestamp }      — extracted from tool_use/tool_result blocks
- Chunk { id, text, embedding (vec 1024 cosine),
          ordinal, sourceKind, projectPath,
          sessionId, timestamp }                       — embeddable unit
- Plan { path, slug, createdAt }                       — ~/.claude/plans/*.md
- Todo { ... } :Orphan                                — fonte dormente: ~/.claude/todos sumiu do disco;
                                                        os 72 nós referenciam sessões inexistentes
- Task { key, prefix, sessionCount,
         firstSeenAt, lastSeenAt }                    — EDC-3197 etc, da branch e do texto
  :Epic / :Story { title, bucket, childCount,
                   childRepos, bucketHint }           — label extra no mesmo nó Task quando é pai
                                                        (link:epics); bucket = epic balde (Bugs,
                                                        Débitos técnicos): filhas sem relação
- Decision { id, kind, text, scope, repo,
             projectPath, taskKeys, confidence,
             status, createdAt }                       — regra/decisão/gotcha destilado (distill)
- File { key, repo, path, ext, sessionCount, idf }    — arquivo tocado, do input do ToolCall
- TaskMemoryDoc { path, taskId, kind, projectPath,
                  lastModified }                       — <project>/.claude/tasks/ABC-XXXX/*.md

## Edges
- (Project)-[:HAS_SESSION]->(Session)
- (Session)-[:HAS_MESSAGE]->(Message)
- (Message)-[:REPLIES_TO]->(Message)        — via parentUuid
- (Message)-[:HAS_CHUNK]->(Chunk)
- (Message)-[:INVOKED]->(ToolCall)
- (ToolCall)-[:HAS_CHUNK]->(Chunk)          — only when tool output < 2k chars
- (Plan)-[:HAS_CHUNK]->(Chunk)
- (TaskMemoryDoc)-[:HAS_CHUNK]->(Chunk)
- (Project)-[:HAS_TASK_MEMORY]->(TaskMemoryDoc)
- (Session)-[:ON_TASK]->(Task)            — task da branch da sessão
- (Chunk)-[:MENTIONS_TASK]->(Task)        — task citada no texto
- (Session)-[:WROTE|READ]->(File)         — arquivo mudado / lido
- (Task)-[:TOUCHES]->(File)               — derivada, responde trabalho relacionado em 1 hop
- (Task)-[:IN_PROJECT]->(Project)
- (Plan)-[:PLANNED_IN]->(Session), (Plan)-[:ABOUT_TASK]->(Task), (Project)-[:HAS_PLAN]->(Plan)
- (TaskMemoryDoc)-[:ABOUT_TASK]->(Task)
- (Task)-[:PART_OF {source, confidence, unit, at}]->(Task:Epic|Story)
  source = prompt (linha [task] do fluxo "analise KEY") | haiku | regex; 1 pai por task.
  Irmãs (filhas do mesmo pai não-balde) são a ponte entre repos: back e front da mesma feature.
- (Task:Epic)-[:RELATES {source}]->(Task)  — epic que continua/se relaciona com outro (V1/V2, antecessor)
- (Decision)-[:HAS_CHUNK]->(Chunk), (Decision)-[:FROM_SESSION]->(Session)
- (Decision)-[:ON_TASK]->(Task), (Decision)-[:ABOUT]->(File)
- (Chunk)-[:SIMILAR_TO {score, computedAt}]->(Chunk)
  precomputed cross-chunk semantic neighbors (top-3, threshold>=0.75)
  use traversal via find_similar_chunks tool (no re-embed)

## Vector index
chunks_embedding  ON  (c:Chunk) ON (c.embedding)
  vector.dimensions = 1024
  vector.similarity_function = 'cosine'

## Fulltext index
chunks_text  ON  (c:Chunk) ON EACH [c.text]
  Lucene-based BM25
  used by hybrid scoring in search_memory / find_related_plans / find_decisions

## Hybrid retrieval scoring
BM25 only when the query has literal tokens (ABC-1234, path.ext, camelCase,
snake_case, CONST_CASE, ACRONYM, 1.2.3). Recall pool = union of vector top-500,
BM25 top-500 and chunks of sessions linked to a task named in the query.
Ranking = RRF (k=60) over the lists x learned boosts, then MMR (diversity).
Sessions of epic sibling tasks (of the task named in the query or of the
caller's branch task) get a weak boost (1.2) in MMR: cross-repo work of the
same feature surfaces without crowding the task's own sessions.
Output is brief by default; expand_hits(ids) returns full text.

## sourceKind values on Chunk
- conversation   — user/assistant message text
- plan           — ~/.claude/plans markdown
- task_memory    — <project>/.claude/tasks/<TICKET>/*.md
- decision       — distilled decision/rule/gotcha (<=300 chars), parent node Decision
(Todo is stored as node, not embedded; tool outputs are ToolCall nodes, not embedded)

## Useful Cypher

# top 10 chunks for embedding (when you have the query vector):
CALL db.index.vector.queryNodes('chunks_embedding', 10, $vec)
YIELD node, score
RETURN node.text, node.sourceKind, score

# all sessions in a project ordered by date:
MATCH (p:Project { path: $cwd })-[:HAS_SESSION]->(s:Session)
RETURN s.id, s.startedAt, s.gitBranch ORDER BY s.startedAt DESC

# decisions of a task and of its siblings under the same epic (other repos):
MATCH (t:Task { key: 'ABC-123' })-[:PART_OF]->(e:Task) WHERE NOT coalesce(e.bucket, false)
MATCH (e)<-[:PART_OF]-(sib:Task)<-[:ON_TASK]-(d:Decision { status: 'active' })
RETURN sib.key, d.repo, d.kind, d.text
(or just: find_decisions({ taskId: 'ABC-123' }) / recall_task({ taskKey: 'ABC-123' }))
`;

export function registerSchemaResource(server: McpServer): void {
  server.registerResource(
    'memory://schema',
    'memory://schema',
    {
      description:
        'Reference: nodes, edges, vector index, sourceKind values and useful Cypher queries for the indexed memory.',
    },
    async () => ({
      contents: [
        {
          uri: 'memory://schema',
          mimeType: 'text/markdown',
          text: `${await liveInventory()}\n\n${SCHEMA_DOC}`,
        },
      ],
    }),
  );
}
