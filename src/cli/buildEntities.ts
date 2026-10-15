import { parseArgs } from 'node:util';
import type { Session } from 'neo4j-driver';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import {
  taskKeyFromBranch,
  taskKeyFromSlug,
  taskKeysFromText,
  normalizeFilePath,
  filePathFromSnippet,
  FILE_TOOLS,
  WRITE_TOOLS,
} from '../ingest/entities.ts';

/**
 * Constrói o grafo de entidades a partir do que já está indexado.
 *
 * Antes disto o Neo4j era um depósito de texto com índice vetorial: o único
 * vínculo de sentido era SIMILAR_TO, que diz "esses parágrafos se parecem" e
 * nunca "isto continua aquilo". Aqui entram Task e File, que é o que responde
 * continuidade e trabalho relacionado.
 *
 * Nenhum passo apaga nada. Todos são idempotentes (MERGE + SET de valor
 * absoluto, nunca incremento, que quebraria no segundo run).
 */

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    step: { type: 'string', default: 'all' },
    page: { type: 'string', default: '5000' },
  },
});
const apply = values.apply as boolean;
const only = values.step as string;
const PAGE = parseInt(values.page as string, 10);

const run = (name: string): boolean => only === 'all' || only === name;
const log = (...a: unknown[]): void => console.log(...a);

async function guardConstraints(s: Session): Promise<void> {
  const r = await s.run(`SHOW CONSTRAINTS YIELD name RETURN collect(name) AS names`);
  const names: string[] = r.records[0]!.get('names');
  const missing = ['task_key', 'file_key'].filter((n) => !names.includes(n));
  if (missing.length > 0) {
    console.error(`constraints faltando: ${missing.join(', ')} — rode 'npm run db:init' antes`);
    process.exit(1);
  }
}

/** Passo 1: task a partir da branch. Cobre a sessão inteira de uma vez. */
async function tasksFromBranch(s: Session): Promise<void> {
  const r = await s.run(`MATCH (se:Session) WHERE se.gitBranch IS NOT NULL
    RETURN se.id AS id, se.gitBranch AS branch`);
  const rows = r.records
    .map((x) => {
      const branch = x.get('branch') as string;
      const key = taskKeyFromBranch(branch);
      return key ? { id: x.get('id') as string, key, prefix: key.split('-')[0]!, branch } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  log(`  [tasks-from-branch] ${rows.length} sessões, ${new Set(rows.map((r2) => r2.key)).size} tasks`);
  if (!apply) return;
  await s.run(`UNWIND $rows AS r
    MATCH (se:Session { id: r.id })
    MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = r.prefix
    MERGE (se)-[rel:ON_TASK]->(t) SET rel.source = 'branch', rel.branch = r.branch
    SET se.taskKey = r.key`, { rows });
}

/** Passo 2: task citada no texto, para referência cruzada entre tasks. */
async function tasksFromText(s: Session): Promise<void> {
  let cursor = '';
  let pairs = 0;
  const keys = new Set<string>();
  for (;;) {
    const page = await s.run(
      `MATCH (c:Chunk) WHERE c.id > $cursor AND c.text CONTAINS '-'
       RETURN c.id AS id, c.text AS text ORDER BY c.id LIMIT toInteger($page)`,
      { cursor, page: PAGE },
    );
    if (page.records.length === 0) break;
    cursor = page.records[page.records.length - 1]!.get('id') as string;

    const rows: { id: string; key: string; prefix: string }[] = [];
    for (const rec of page.records) {
      const id = rec.get('id') as string;
      for (const key of taskKeysFromText(rec.get('text') as string)) {
        rows.push({ id, key, prefix: key.split('-')[0]! });
        keys.add(key);
      }
    }
    pairs += rows.length;
    if (apply && rows.length > 0) {
      await s.run(`UNWIND $rows AS r
        MATCH (c:Chunk { id: r.id })
        MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = r.prefix
        MERGE (c)-[:MENTIONS_TASK]->(t)`, { rows });
    }
  }
  log(`  [tasks-from-text] ${pairs} arestas, ${keys.size} tasks distintas`);
}

/** Passo 3: arquivo tocado, a partir do input serializado no ToolCall. */
async function filesFromToolCalls(s: Session): Promise<void> {
  const proj = await s.run(`MATCH (p:Project) RETURN collect(p.path) AS paths`);
  const projectPaths: string[] = proj.records[0]!.get('paths');

  let cursor = '';
  // Agrega no cliente: a escrita grava valor ABSOLUTO, então rodar de novo não
  // duplica contagem. Incremento em Cypher quebraria a idempotência.
  const wrote = new Map<string, { sessionId: string; key: string; repo: string; path: string; ext: string; count: number }>();
  const read = new Map<string, typeof wrote extends Map<string, infer V> ? V : never>();

  for (;;) {
    const page = await s.run(
      `MATCH (m:Message)-[:INVOKED]->(tc:ToolCall)
       WHERE tc.id > $cursor AND tc.name IN $tools
       RETURN tc.id AS id, tc.name AS name, tc.outputSnippet AS snip, m.sessionId AS sid
       ORDER BY tc.id LIMIT toInteger($page)`,
      { cursor, page: PAGE, tools: [...FILE_TOOLS] },
    );
    if (page.records.length === 0) break;
    cursor = page.records[page.records.length - 1]!.get('id') as string;

    for (const rec of page.records) {
      const sid = rec.get('sid') as string;
      const abs = filePathFromSnippet(rec.get('snip') as string);
      if (!sid || !abs) continue;
      const ref = normalizeFilePath(abs, projectPaths);
      if (!ref) continue;
      const bucket = WRITE_TOOLS.has(rec.get('name') as string) ? wrote : read;
      const k = `${sid}\u0000${ref.key}`;
      const cur = bucket.get(k);
      if (cur) cur.count++;
      else bucket.set(k, { sessionId: sid, ...ref, count: 1 });
    }
  }

  const files = new Set([...wrote.values(), ...read.values()].map((v) => v.key));
  log(`  [files-from-toolcalls] ${files.size} arquivos, ${wrote.size} WROTE, ${read.size} READ`);
  if (!apply) return;

  for (const [rel, bucket] of [['WROTE', wrote], ['READ', read]] as const) {
    const all = [...bucket.values()];
    for (let i = 0; i < all.length; i += 500) {
      await s.run(`UNWIND $rows AS r
        MATCH (se:Session { id: r.sessionId })
        MERGE (f:File { key: r.key }) ON CREATE SET f.repo = r.repo, f.path = r.path, f.ext = r.ext
        MERGE (se)-[e:${rel}]->(f) SET e.count = r.count`, { rows: all.slice(i, i + 500) });
    }
  }
}

/** Passo 4: agregados derivados. Recalculados do zero, nunca incrementados. */
async function aggregates(s: Session): Promise<void> {
  if (!apply) {
    log('  [aggregates] (dry-run: depende dos passos anteriores terem sido aplicados)');
    return;
  }
  await s.run(`MATCH (t:Task)<-[:ON_TASK]-(se:Session)<-[:HAS_SESSION]-(p:Project)
    WITH t, p, count(DISTINCT se) AS n
    MERGE (t)-[r:IN_PROJECT]->(p) SET r.sessions = n`);
  await s.run(`MATCH (t:Task) OPTIONAL MATCH (t)<-[:ON_TASK]-(se:Session)
    WITH t, count(DISTINCT se) AS n, min(se.startedAt) AS f, max(se.startedAt) AS l
    SET t.sessionCount = n, t.firstSeenAt = f, t.lastSeenAt = l`);
  // IDF: arquivo central do repo continua valendo, só pesa menos. Corte duro
  // perderia `contract/types.ts`, que aparece em 41 sessões e é sinal real.
  await s.run(`MATCH (:Session) WITH count(*) AS total
    MATCH (f:File) OPTIONAL MATCH (f)<-[:WROTE|READ]-(se:Session)
    WITH f, total, count(DISTINCT se) AS n
    SET f.sessionCount = n, f.idf = log(toFloat(total) / (1 + n))`);
  const r = await s.run(`MATCH (t:Task)<-[:ON_TASK]-(se:Session)-[w:WROTE]->(f:File)
    WITH t, f, count(DISTINCT se) AS sessions, sum(w.count) AS writes
    MERGE (t)-[rel:TOUCHES]->(f) SET rel.sessions = sessions, rel.writes = writes
    RETURN count(rel) AS n`);
  log(`  [aggregates] TOUCHES: ${r.records[0]!.get('n')}`);
}

/** Passo 5: planos órfãos. 148 pela evidência do ToolCall, o resto pelo slug. */
async function plans(s: Session): Promise<void> {
  const byTool = await s.run(`MATCH (m:Message)-[:INVOKED]->(tc:ToolCall)
    WHERE tc.name IN ['Write','Edit','MultiEdit'] AND tc.outputSnippet CONTAINS '/.claude/plans/'
    RETURN DISTINCT tc.outputSnippet AS snip, m.sessionId AS sid`);
  const rows: { path: string; sid: string }[] = [];
  for (const r of byTool.records) {
    const p = filePathFromSnippet(r.get('snip') as string);
    const sid = r.get('sid') as string;
    if (p && sid && p.includes('/.claude/plans/')) rows.push({ path: p, sid });
  }
  log(`  [plans] ${rows.length} pares plano→sessão pela evidência do ToolCall`);
  if (!apply) return;

  await s.run(`UNWIND $rows AS r
    MATCH (pl:Plan { path: r.path })
    MATCH (se:Session { id: r.sid })
    MERGE (pl)-[e:PLANNED_IN]->(se) SET e.source = 'toolcall'
    WITH pl, se
    MATCH (p:Project)-[:HAS_SESSION]->(se)
    MERGE (p)-[:HAS_PLAN]->(pl)`, { rows });

  // Fallback pelo slug: cobre o que o ToolCall não alcança (plano escrito em
  // sessão já podada, ou caminho corrompido pelo bug do redact).
  const rest = await s.run(`MATCH (pl:Plan) WHERE NOT (pl)-[:PLANNED_IN]->()
    RETURN pl.path AS path, pl.slug AS slug`);
  const bySlug = rest.records
    .map((r) => {
      const key = taskKeyFromSlug(r.get('slug') as string);
      return key ? { path: r.get('path') as string, key } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  log(`  [plans] ${bySlug.length} planos restantes ligados por código no slug`);
  await s.run(`UNWIND $rows AS r
    MATCH (pl:Plan { path: r.path })
    MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = split(r.key, '-')[0]
    MERGE (pl)-[:ABOUT_TASK]->(t)`, { rows: bySlug });
}

/**
 * Passo 7: task memory (`<repo>/.claude/tasks/EDC-1234/*.md`) ligada à Task.
 * Sem isto o doc só era alcançável por vetor/BM25: `find_decisions` e o
 * resolvedor de task da busca não o enxergavam. O nome da pasta passa pela
 * mesma normalização da branch, então `EDC-0123` e `EDC-123` caem no mesmo nó.
 */
async function taskMemory(s: Session): Promise<void> {
  const r = await s.run(`MATCH (d:TaskMemoryDoc) RETURN d.path AS path, d.taskId AS taskId`);
  const rows = r.records
    .map((rec) => {
      const key = taskKeyFromSlug(rec.get('taskId') as string);
      return key ? { path: rec.get('path') as string, key } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  log(`  [task-memory] ${rows.length}/${r.records.length} docs ligados a task`);
  if (!apply || rows.length === 0) return;
  await s.run(`UNWIND $rows AS r
    MATCH (d:TaskMemoryDoc { path: r.path })
    MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = split(r.key, '-')[0]
    MERGE (d)-[:ABOUT_TASK]->(t)`, { rows });
}

/** Passo 6: os 72 Todos são fósseis de 3 sessões que não existem. Relabela. */
async function todos(s: Session): Promise<void> {
  const r = await s.run(`MATCH (t:Todo) WHERE NOT (t)--() RETURN count(t) AS n`);
  log(`  [todos] ${r.records[0]!.get('n')} órfãos → :Orphan`);
  if (!apply) return;
  await s.run(`MATCH (t:Todo) WHERE NOT (t)--() SET t:Orphan`);
}

await withSession(async (s) => {
  await guardConstraints(s);
  log(apply ? '=== APLICANDO ===' : '=== DRY-RUN (use --apply) ===');
  const t0 = Date.now();
  if (run('tasks-from-branch')) await tasksFromBranch(s);
  if (run('tasks-from-text')) await tasksFromText(s);
  if (run('files-from-toolcalls')) await filesFromToolCalls(s);
  if (run('aggregates')) await aggregates(s);
  if (run('plans')) await plans(s);
  if (run('todos')) await todos(s);
  if (run('task-memory')) await taskMemory(s);
  log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s`);
});
await closeDriver();
