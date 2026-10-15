import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bench da ponte entre repos pelo epic.
 *
 *   npm run bench:epic-cross -- [--boosts=1,1.2,1.35] [--k=8] [--verbose]
 *
 * Caso = task A de um epic de feature cujas filhas estão em >= 2 repos.
 * Simula uma sessão NOVA em A: a sessão mais recente de A é a chamadora e
 * todas as sessões de A ficam fora do resultado (senão a própria decisão
 * volta como hit). Query = texto de uma decisão de A, o assunto da feature
 * visto do lado de A.
 *
 * Relevante = conteúdo das irmãs (ou do epic) em OUTRO repo. É o que o user
 * não acharia sozinho buscando do repo dele.
 *
 *   crossHit@k   casos com >= 1 hit cruzado no top-k     (precisa subir)
 *   crossMRR     posição do primeiro hit cruzado          (precisa subir)
 *   crossShare   fração cruzada do top-k                  (sobe sem lotar)
 *
 * Gerado dos dados, sem gabarito: cresce sozinho conforme vínculos entram.
 */

process.env.MCP_TALKS_DISABLE_QUERY_LOG = '1';
const { config } = await import('../config.ts');
const { withSession, closeDriver } = await import('../neo4j/driver.ts');
const { searchMemory } = await import('../mcp/tools/searchMemory.ts');

const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const BOOSTS = (arg('boosts') ?? '1,1.2,1.35').split(',').map(Number);
const K = Number(arg('k') ?? 8);
const VERBOSE = process.argv.includes('--verbose');

interface Case {
  task: string;
  epic: string;
  repo: string;
  caller: string;
  own: string[];
  query: string;
  cross: Set<string>;
}

const cases: Case[] = await withSession(async (s) => {
  const r = await s.run(`
    MATCH (a:Task)-[r:PART_OF]->(p:Task)
    WHERE coalesce(r.confidence, 'low') <> 'low' AND coalesce(p.bucket, false) = false AND size(coalesce(p.childRepos, [])) > 1
    MATCH (a)<-[:ON_TASK]-(se:Session)
    WITH a, p, collect(se) AS ss
    WITH a, p, [x IN ss | x.id] AS own, ss, head([x IN ss | x.projectPath]) AS repo
    UNWIND ss AS last WITH a, p, own, repo, last ORDER BY last.startedAt DESC
    WITH a, p, own, repo, head(collect(last.id)) AS caller
    MATCH (d:Decision {status: 'active'})-[:ON_TASK]->(a)
    WITH a, p, own, repo, caller, d ORDER BY d.createdAt DESC
    WITH a, p, own, repo, caller, head(collect(d.text)) AS query
    MATCH (p)<-[r2:PART_OF]-(sib:Task) WHERE sib <> a AND coalesce(r2.confidence, 'low') <> 'low'
    OPTIONAL MATCH (sib)<-[:ON_TASK]-(ss:Session) WHERE ss.projectPath <> repo
    OPTIONAL MATCH (p)<-[:ON_TASK]-(ps:Session) WHERE ps.projectPath <> repo
    WITH a, p, own, repo, caller, query, collect(DISTINCT ss.id) + collect(DISTINCT ps.id) AS cross
    WHERE size(cross) > 0
    RETURN a.key AS task, p.key AS epic, repo, caller, own, query, cross ORDER BY a.key`);
  return r.records.map((x) => ({
    task: x.get('task'), epic: x.get('epic'), repo: x.get('repo'), caller: x.get('caller'),
    own: x.get('own'), query: x.get('query'), cross: new Set(x.get('cross') as string[]),
  }));
});

console.log(`### bench:epic-cross: ${cases.length} casos (${new Set(cases.map((c) => c.epic)).size} epics)`);
const results: Record<string, { crossHit: number; crossMRR: number; crossShare: number }> = {};
for (const boost of BOOSTS) {
  let hit = 0;
  let mrr = 0;
  let share = 0;
  for (const c of cases) {
    const r = await searchMemory({ query: c.query, k: K, callerSessionId: c.caller, excludeSessions: c.own, epicBoost: boost });
    const flags = r.hits.map((h) => h.sessionId !== null && c.cross.has(h.sessionId));
    const first = flags.indexOf(true);
    if (first >= 0) {
      hit++;
      mrr += 1 / (first + 1);
    }
    share += flags.filter(Boolean).length / Math.max(r.hits.length, 1);
    if (VERBOSE) console.log(`  [${boost}] ${c.task} (${c.epic}) first=${first + 1 || '-'} ${flags.map((f) => (f ? 'X' : '.')).join('')}`);
  }
  const n = Math.max(cases.length, 1);
  results[String(boost)] = { crossHit: hit / n, crossMRR: mrr / n, crossShare: share / n };
  console.log(`  boost ${boost.toFixed(2)}: crossHit@${K} ${((hit / n) * 100).toFixed(1)}%  crossMRR ${(mrr / n).toFixed(3)}  crossShare ${((share / n) * 100).toFixed(1)}%`);
}

const out = join(config.paths.cacheDir, 'epic-cross.json');
writeFileSync(out, JSON.stringify({ v: 1, ranAt: new Date().toISOString(), k: K, cases: cases.length, results }, null, 2));
console.log(`\ngravado em ${out}`);
await closeDriver();
