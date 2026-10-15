import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withSession } from '../../neo4j/driver.ts';

export function registerStatsResource(server: McpServer): void {
  server.registerResource(
    'memory://stats',
    'memory://stats',
    {
      description:
        'Counts per node label currently indexed in Neo4j. Useful to check coverage before searching.',
    },
    async () => {
      const counts = await withSession(async (s) => {
        const r = await s.run(
          // UNWIND, não labels(n)[0]: nó com 2 labels (:Task:Epic, :Todo:Orphan) tem
          // ordem de label não garantida e caía em qualquer um dos dois.
          `MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS c ORDER BY label`,
        );
        return r.records.map((rec) => ({ label: rec.get('label'), count: rec.get('c') }));
      });
      return {
        contents: [
          {
            uri: 'memory://stats',
            mimeType: 'application/json',
            text: JSON.stringify(counts, null, 2),
          },
        ],
      };
    },
  );
}
