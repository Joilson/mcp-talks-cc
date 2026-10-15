import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from '../helpers.ts';

interface SearchHit {
  score: number;
  confidence: number | null;
  source: string;
  sessionId: string | null;
  project: string | null;
  snippet: string;
}

interface SearchResult {
  structuredContent: {
    hits: SearchHit[];
    poolVecMedian: number | null;
    poolSize: number;
    calibrated: boolean;
  };
}

describe('search_memory tool', () => {
  let client: Client;

  before(async () => {
    client = await createTestClient();
  });

  after(async () => {
    await client.close();
  });

  it('lists 8 tools', async () => {
    const r = await client.listTools();
    const names = r.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'expand_hits',
      'find_decisions',
      'find_related_plans',
      'find_similar_chunks',
      'get_session_transcript',
      'list_project_activity',
      'recall_task',
      'search_memory',
    ]);
  });

  it('returns hits for a known query', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 3 },
    })) as unknown as SearchResult;
    assert.ok(Array.isArray(r.structuredContent.hits), 'hits should be array');
    assert.ok(r.structuredContent.hits.length > 0, 'should return at least 1 hit');
    for (const h of r.structuredContent.hits) {
      assert.ok(typeof h.score === 'number');
      assert.ok(h.snippet.length > 0);
    }
  });

  it('reports confidence and pool stats', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5 },
    })) as unknown as SearchResult;
    const { hits, poolVecMedian, poolSize, calibrated } = r.structuredContent;
    assert.ok(poolSize >= hits.length, 'pool deve conter pelo menos os hits devolvidos');
    if (hits.length > 0) {
      assert.ok(typeof poolVecMedian === 'number', 'poolVecMedian deve vir preenchido');
    }
    for (const h of hits) {
      assert.ok(h.confidence === null || (h.confidence >= 0 && h.confidence <= 1));
      // confidence só existe quando a calibração local está pronta
      assert.equal(h.confidence === null, !calibrated);
    }
  });

  it('pool de recall é fundo, não k*5', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5 },
    })) as unknown as SearchResult;
    // Antes o pool era min(k*5, 60) = 25 aqui, e saía do cosseno puro. Num
    // corpus onde 2000 candidatos cabem em 0.043 de spread, esse corte raso
    // deixava o chunk certo fora do alcance de qualquer boost (medido em
    // 2026-08-03: chunk correto no rank 149, pool 40).
    assert.ok(
      r.structuredContent.poolSize > 60,
      `pool de recall deve ser fundo, veio ${r.structuredContent.poolSize}`,
    );
  });

  it('filtro não estrangula o top-k (post-filter sobre pool fundo)', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'plano de implementação', k: 5, scope: ['plan'] },
    })) as unknown as SearchResult;
    const { hits, poolSize } = r.structuredContent;
    if (hits.length === 0) return; // grafo local sem plans indexados
    // scope/project/since são post-filter no Neo4j 5.26; o pool fundo é o que
    // garante que ainda sobre material pra encher k depois do filtro.
    assert.ok(
      hits.length >= Math.min(5, poolSize),
      `esperava k hits (ou o pool todo), veio ${hits.length} com pool ${poolSize}`,
    );
  });

  it('respects scope filter', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'plano', k: 5, scope: ['plan'] },
    })) as unknown as SearchResult;
    for (const h of r.structuredContent.hits) {
      assert.equal(h.source, 'plan', 'all hits should have source=plan');
    }
  });

  it('project is soft boost; projectStrict hard-filters', async () => {
    const base = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5 },
    })) as unknown as SearchResult;
    const anyProject = base.structuredContent.hits.find((h) => h.project)?.project;
    if (!anyProject) return; // dataset sem projectPath — nada a verificar

    const strict = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5, project: anyProject, projectStrict: true },
    })) as unknown as SearchResult;
    for (const h of strict.structuredContent.hits) {
      assert.equal(h.project, anyProject, 'strict mode must hard-filter by project');
    }

    const soft = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5, project: anyProject },
    })) as unknown as SearchResult;
    assert.ok(soft.structuredContent.hits.length > 0, 'soft boost must still return hits');
    // soft: scores ficam crus (<= 1.0 sempre, boost não vaza pro score)
    for (const h of soft.structuredContent.hits) {
      assert.ok(h.score <= 1.000001, 'reported score must stay raw (no boost inflation)');
    }
  });

  it('brief é o default e cabe no orçamento; expand_hits resolve o id curto', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 8 },
    })) as unknown as SearchResult & { content: Array<{ text: string }> };
    const text = r.content[0]!.text;
    const lines = text.split('\n');
    // header + 1 linha por hit, nada de snippet inteiro
    assert.equal(lines.length, 1 + r.structuredContent.hits.length);
    assert.ok(text.length < 8 * 260, `brief estourou: ${text.length} chars`);
    const short = /id=([0-9a-f]{12})/.exec(lines[1] ?? '')?.[1];
    if (!short) return;
    const ex = (await client.callTool({
      name: 'expand_hits',
      arguments: { ids: [short] },
    })) as unknown as { structuredContent: { hits: Array<{ id: string }> } };
    assert.equal(ex.structuredContent.hits.length, 1);
    assert.ok(ex.structuredContent.hits[0]!.id.startsWith(short));
  });

  it('rejects empty query (Zod or isError)', async () => {
    let rejected = false;
    let isError = false;
    try {
      const r = (await client.callTool({
        name: 'search_memory',
        arguments: { query: '', k: 3 },
      })) as unknown as { isError?: boolean; structuredContent?: { isError?: boolean } };
      isError = !!(r.isError || r.structuredContent?.isError);
    } catch {
      rejected = true;
    }
    assert.ok(rejected || isError, 'empty query should fail validation (reject or isError)');
  });
});
