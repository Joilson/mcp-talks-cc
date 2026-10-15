import type { Session } from 'neo4j-driver';
import { z } from 'zod';
import { redact } from '../ingest/redact.ts';
import {
  HIERARCHY_WORD_RE,
  isBucketTitle,
  parentRefsFromText,
  parseTaskLines,
  taskKeyFromSlug,
  taskKeysFromText,
} from '../ingest/entities.ts';
import { runHeadless } from '../distill/headless.ts';
import { META_PROJECTS } from '../mcp/tuning.ts';

/**
 * Vínculo task -> pai (epic/story), a partir do que já está na memória.
 *
 * Não acessa o Jira. A hierarquia já aparece nas conversas ("Épico EDC-3208",
 * "Parent: EDC-2491"), nos planos e na task memory; falta só virar aresta pra
 * cruzar repos: a task do back e a do front são filhas do mesmo epic.
 *
 * Três fontes, gravando o mesmo resultado, em ordem de confiança:
 *   prompt  linha fixa `[task] EDC-1 pai=EDC-2 (Epic: ...)` do fluxo "analise
 *           EDC-XXXX" (bloco do CLAUDE.md). Determinístico, sem custo.
 *   haiku   leitura dos trechos em volta das menções. Opt-in (gasta token).
 *   regex   piso: 1 task na unidade + 1 único pai citado logo depois de
 *           "épico/epic/parent/pai". Medido contra o Jira: 16/16 certos,
 *           mas cobre só 1/3 dos pais. Confiança medium.
 *
 * Uma task tem no máximo 1 PART_OF. Conflito: fonte de rank maior vence, e no
 * empate a evidência mais recente. Exceção: trocar o PAI dado por outra fonte
 * exige confiança high (medido: o Haiku em medium trocou "Épico EDC-3338" pelo
 * PRD citado na mesma linha). Tudo MERGE + SET absoluto.
 */

export const EPIC_LINK_VERSION = 1;
const RANK = { prompt: 3, haiku: 2, regex: 1 } as const;
type Source = keyof typeof RANK;
type Confidence = 'high' | 'medium' | 'low';

/** Janela em volta de cada menção de hierarquia. */
const WINDOW = 350;
const MAX_INPUT_CHARS = 6_000;
const CALL_TIMEOUT_MS = 90_000;

const CANDIDATE_RE =
  '(?isU).*(?<![\\p{L}\\p{N}])(épico|epico|epic|parent|pai|história|historia|story)(?![\\p{L}\\p{N}]).*';

export interface Unit {
  kind: 'session' | 'plan' | 'taskdoc';
  /** Session.id ou path do Plan/TaskMemoryDoc. */
  id: string;
  project: string | null;
  /** Tasks da unidade pelo grafo (branch, ABOUT_TASK). Contexto, não verdade. */
  tasks: string[];
  texts: string[];
  lastTs: string;
  llmVersion: number;
  llmAt: string | null;
}

export interface Link {
  task: string;
  parent: string;
  parentType: 'epic' | 'story' | null;
  parentTitle: string | null;
  bucketHint: boolean | null;
  relates: string[];
  source: Source;
  confidence: Confidence;
  unit: string;
  at: string;
}

const TEXT_KEY_RE = /(EDC|US|DEV|QUAL)-\d{2,6}/;

/** Todas as unidades com texto candidato, agrupadas. Sem filtro de versão. */
export async function collectUnits(s: Session): Promise<Unit[]> {
  const r = await s.run(
    `MATCH (c:Chunk)
     WHERE c.sourceKind IN ['conversation','plan','task_memory']
       AND (c.text CONTAINS '[task]' OR (c.text =~ $re AND c.text =~ '(?s).*(EDC|US|DEV|QUAL)-[0-9]{2,6}.*'))
     OPTIONAL MATCH (p)-[:HAS_CHUNK]->(c) WHERE p:Plan OR p:TaskMemoryDoc
     RETURN c.text AS text, c.sourceKind AS kind, c.sessionId AS sid, c.projectPath AS project,
            toString(c.timestamp) AS ts, p.path AS ppath, CASE WHEN p:Plan THEN 'plan' WHEN p:TaskMemoryDoc THEN 'taskdoc' ELSE null END AS pkind
     ORDER BY c.timestamp`,
    { re: CANDIDATE_RE },
  );
  const units = new Map<string, Unit>();
  for (const rec of r.records) {
    const isConv = rec.get('kind') === 'conversation';
    const id = (isConv ? rec.get('sid') : rec.get('ppath')) as string | null;
    const kind = (isConv ? 'session' : rec.get('pkind')) as Unit['kind'] | null;
    if (!id || !kind) continue;
    const key = `${kind}\u0000${id}`;
    let u = units.get(key);
    if (!u) {
      u = { kind, id, project: rec.get('project') as string | null, tasks: [], texts: [], lastTs: '', llmVersion: 0, llmAt: null };
      units.set(key, u);
    }
    u.texts.push(rec.get('text') as string);
    const ts = (rec.get('ts') as string | null) ?? '';
    if (ts > u.lastTs) u.lastTs = ts;
  }

  // tasks pelo grafo + marcas da passada Haiku, por tipo de unidade
  const byKind = (k: Unit['kind']): Unit[] => [...units.values()].filter((u) => u.kind === k);
  const meta = async (k: Unit['kind'], cypher: string): Promise<void> => {
    const list = byKind(k);
    if (list.length === 0) return;
    const res = await s.run(cypher, { ids: list.map((u) => u.id) });
    const m = new Map(res.records.map((x) => [x.get('id') as string, x]));
    for (const u of list) {
      const x = m.get(u.id);
      if (!x) continue;
      u.tasks = ((x.get('tasks') as string[]) ?? []).filter(Boolean);
      u.llmVersion = Number(x.get('v') ?? 0);
      u.llmAt = (x.get('at') as string | null) ?? null;
      if (x.has('project') && x.get('project')) u.project = x.get('project') as string;
    }
  };
  await meta('session', `UNWIND $ids AS id MATCH (n:Session {id: id})
    OPTIONAL MATCH (n)-[:ON_TASK]->(t:Task)
    RETURN id, collect(DISTINCT t.key) AS tasks, n.epicLinkVersion AS v, n.epicLinkAt AS at`);
  await meta('plan', `UNWIND $ids AS id MATCH (n:Plan {path: id})
    OPTIONAL MATCH (n)-[:ABOUT_TASK]->(t1:Task)
    OPTIONAL MATCH (n)-[:PLANNED_IN]->(ps:Session)
    OPTIONAL MATCH (ps)-[:ON_TASK]->(t2:Task)
    RETURN id, collect(DISTINCT t1.key) + collect(DISTINCT t2.key) AS tasks, n.epicLinkVersion AS v, n.epicLinkAt AS at,
           head(collect(ps.projectPath)) AS project`);
  await meta('taskdoc', `UNWIND $ids AS id MATCH (n:TaskMemoryDoc {path: id})
    OPTIONAL MATCH (n)-[:ABOUT_TASK]->(t:Task)
    RETURN id, collect(DISTINCT t.key) AS tasks, n.epicLinkVersion AS v, n.epicLinkAt AS at`);
  // O próprio mcp-talks-cc discute esses formatos com keys de EXEMPLO
  // ("[task] EDC-3309 pai=EDC-3208", e a EDC-3309 não tem pai no Jira). Fonte
  // de vínculo só é trabalho de verdade.
  return [...units.values()].filter((u) => !isMetaUnit(u));
}

function isMetaUnit(u: Unit): boolean {
  const name = u.project?.split('/').filter(Boolean).pop();
  if (name && META_PROJECTS.includes(name)) return true;
  return u.kind === 'plan' && /mcp-talks/i.test(u.id);
}

/** Fonte 1: linhas `[task]`. */
export function promptLinks(u: Unit): Link[] {
  const out: Link[] = [];
  for (const t of u.texts) {
    for (const l of parseTaskLines(t)) {
      if (!l.parent) continue;
      out.push({
        task: l.task, parent: l.parent, parentType: l.parentType, parentTitle: l.parentTitle,
        bucketHint: null, relates: [], source: 'prompt', confidence: 'high', unit: u.id, at: u.lastTs,
      });
    }
  }
  return out;
}

/** Fonte 3: piso por regex. Só o caso inequívoco. */
export function regexLinks(u: Unit): Link[] {
  if (u.tasks.length !== 1) return [];
  const task = u.tasks[0]!;
  const parents = new Set<string>();
  for (const t of u.texts) for (const p of parentRefsFromText(t)) if (p !== task) parents.add(p);
  if (parents.size !== 1) return [];
  return [{
    task, parent: [...parents][0]!, parentType: null, parentTitle: null, bucketHint: null,
    relates: [], source: 'regex', confidence: 'medium', unit: u.id, at: u.lastTs,
  }];
}

/**
 * Unidade vale a chamada do Haiku se tem key logo depois de palavra de
 * hierarquia (o mesmo sinal do piso), ou a palavra a até 80 chars de uma key.
 * Corta o "pai" solto e o "story" de user story genérica.
 */
export function worthLlm(u: Unit): boolean {
  for (const t of u.texts) {
    if (parentRefsFromText(t).length > 0) return true;
    HIERARCHY_WORD_RE.lastIndex = 0;
    for (const m of t.matchAll(HIERARCHY_WORD_RE)) {
      const near = t.slice(Math.max(0, m.index! - 80), m.index! + m[0].length + 80);
      if (TEXT_KEY_RE.test(near)) return true;
    }
  }
  return false;
}

export function needsLlm(u: Unit): boolean {
  if (u.texts.some((t) => t.includes('[task]'))) return false;
  if (u.llmVersion < EPIC_LINK_VERSION) return true;
  return !!u.llmAt && u.lastTs > u.llmAt;
}

/** Janelas em volta das menções, fundidas, com teto. */
export function buildLlmInput(u: Unit): string {
  const parts: string[] = [];
  let total = 0;
  for (const raw of u.texts) {
    const t = redact(raw);
    const spans: Array<[number, number]> = [];
    HIERARCHY_WORD_RE.lastIndex = 0;
    for (const m of t.matchAll(HIERARCHY_WORD_RE)) {
      spans.push([Math.max(0, m.index! - WINDOW), Math.min(t.length, m.index! + m[0].length + WINDOW)]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
      else merged.push([...sp]);
    }
    for (const [a, b] of merged) {
      const piece = t.slice(a, b).trim();
      if (!TEXT_KEY_RE.test(piece)) continue;
      if (total + piece.length > MAX_INPUT_CHARS) return parts.join('\n---\n');
      parts.push(piece);
      total += piece.length;
    }
  }
  return parts.join('\n---\n');
}

const SYSTEM_PROMPT = `Você extrai a HIERARQUIA de tasks do Jira citada em trechos de conversas de desenvolvimento.

Pra cada task citada cujo PAI (epic ou story) o texto declara EXPLICITAMENTE, devolva um link:
- task: a key da task filha (ex. EDC-3309).
- parent: a key do pai (ex. EDC-3208).
- parentType: epic, story ou unknown.
- parentTitle: título do pai se aparecer no texto, senão vazio.
- parentIsBucket: true quando o pai é epic "balde" que junta coisas sem relação (Bugs, Débitos técnicos, Melhorias, Sustentação); false se é epic de feature; false se não souber.
- relatesTo: keys de OUTROS epics que o texto diz que o pai continua, substitui ou com que se relaciona (antecessor, V1/V2, PRD). Vazio se nenhum.
- confidence: high quando o texto diz literalmente que X é filha/pertence ao epic Y; medium quando é claro pelo contexto (ex. "Épico EDC-3208" no cabeçalho da análise da task EDC-3309); low quando é palpite.

PRD, documento de requisitos, spec, design ou protótipo NUNCA é pai: em "Épico EDC-3338 / PRD EDC-3345" o pai é EDC-3338. O pai é a key que o texto chama de épico/epic/parent/pai/história.
Quando o texto cita uma story E um epic sem dizer qual é o pai da task ("contexto na story X e no epic Y"), o pai é o EPIC; a story fica de fora.
NÃO crie link por mera co-ocorrência de keys, nem entre duas tasks irmãs, nem de task pra PR ou branch. Só use keys que aparecem no texto. Sem nada explícito: links vazio.`;

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    links: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          parent: { type: 'string' },
          parentType: { type: 'string', enum: ['epic', 'story', 'unknown'] },
          parentTitle: { type: 'string', maxLength: 160 },
          parentIsBucket: { type: 'boolean' },
          relatesTo: { type: 'array', items: { type: 'string' }, maxItems: 4 },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['task', 'parent', 'parentType', 'parentTitle', 'parentIsBucket', 'relatesTo', 'confidence'],
      },
    },
  },
  required: ['links'],
};

const llmLinkSchema = z.object({
  task: z.string(),
  parent: z.string(),
  parentType: z.enum(['epic', 'story', 'unknown']),
  parentTitle: z.string(),
  parentIsBucket: z.boolean(),
  relatesTo: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
});

/**
 * Fonte 2: Haiku. Valida contra alucinação: as duas keys têm que existir no
 * input e passar pela allowlist; low é descartado.
 */
export async function llmLinks(u: Unit, input: string): Promise<Link[]> {
  const header = `Unidade: ${u.kind} | repo: ${u.project ?? '-'} | tasks da unidade: ${u.tasks.join(', ') || '-'}\n\n`;
  const out = (await runHeadless({ system: SYSTEM_PROMPT, schema: JSON_SCHEMA, input: header + input, timeoutMs: CALL_TIMEOUT_MS })) as {
    links?: unknown[];
  } | null;
  const present = new Set(taskKeysFromTextLoose(input));
  const links: Link[] = [];
  for (const raw of out?.links ?? []) {
    const p = llmLinkSchema.safeParse(raw);
    if (!p.success || p.data.confidence === 'low') continue;
    const task = taskKeyFromSlug(p.data.task);
    const parent = taskKeyFromSlug(p.data.parent);
    if (!task || !parent || task === parent || !present.has(task) || !present.has(parent)) continue;
    links.push({
      task, parent,
      parentType: p.data.parentType === 'unknown' ? null : p.data.parentType,
      parentTitle: p.data.parentTitle.trim() || null,
      bucketHint: p.data.parentIsBucket,
      relates: p.data.relatesTo.map((k) => taskKeyFromSlug(k)).filter((k): k is string => !!k && present.has(k) && k !== parent),
      source: 'haiku', confidence: p.data.confidence, unit: u.id, at: u.lastTs,
    });
  }
  return links;
}

/** Keys do input sem o corte de "listagem de backlog" do taskKeysFromText. */
function taskKeysFromTextLoose(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) for (const k of taskKeysFromText(line)) out.add(k);
  for (const m of text.matchAll(/\b(EDC|US|DEV|QUAL)-(\d{2,6})\b/g)) {
    const k = taskKeyFromSlug(m[0]);
    if (k) out.add(k);
  }
  return [...out];
}

/** Melhor link por task: rank da fonte, depois recência. */
export function bestPerTask(links: Link[]): Link[] {
  const best = new Map<string, Link>();
  for (const l of links) {
    const cur = best.get(l.task);
    if (!cur || RANK[l.source] > RANK[cur.source] || (RANK[l.source] === RANK[cur.source] && l.at > cur.at)) best.set(l.task, l);
  }
  return [...best.values()];
}

/**
 * Grava respeitando o que já existe: link de rank menor (ou igual e mais
 * velho) que o atual não substitui. Devolve quantos gravou.
 */
export async function writeLinks(s: Session, links: Link[]): Promise<number> {
  if (links.length === 0) return 0;
  const cur = await s.run(
    `UNWIND $tasks AS k MATCH (t:Task {key: k})-[r:PART_OF]->(p:Task)
     RETURN k AS task, p.key AS parent, r.source AS source, r.at AS at, r.confidence AS confidence`,
    { tasks: links.map((l) => l.task) },
  );
  const existing = new Map(cur.records.map((x) => [x.get('task') as string, {
    parent: x.get('parent') as string, source: x.get('source') as Source, at: (x.get('at') as string) ?? '',
    confidence: x.get('confidence') as Confidence,
  }]));
  const rows = links.filter((l) => {
    const e = existing.get(l.task);
    if (!e) return true;
    const re = RANK[e.source] ?? 0;
    if (e.parent === l.parent) return RANK[l.source] >= re; // mesmo vínculo: só atualiza props
    if (l.confidence !== 'high' && e.source !== l.source && e.confidence !== 'low') return false;
    if (RANK[l.source] !== re) return RANK[l.source] > re;
    return l.at > e.at;
  });
  if (rows.length === 0) return 0;
  await s.run(
    `UNWIND $rows AS r
     MERGE (t:Task {key: r.task}) ON CREATE SET t.prefix = split(r.task, '-')[0]
     MERGE (p:Task {key: r.parent}) ON CREATE SET p.prefix = split(r.parent, '-')[0]
     WITH t, p, r
     OPTIONAL MATCH (t)-[old:PART_OF]->(other:Task) WHERE other.key <> r.parent
     DELETE old
     WITH DISTINCT t, p, r
     MERGE (t)-[e:PART_OF]->(p)
     SET e.source = r.source, e.confidence = r.confidence, e.unit = r.unit, e.at = r.at
     SET p.title = coalesce(r.parentTitle, p.title),
         p.parentType = coalesce(r.parentType, p.parentType),
         p.bucketHint = coalesce(r.bucketHint, p.bucketHint)
     FOREACH (_ IN CASE WHEN r.parentType = 'story' THEN [1] ELSE [] END | SET p:Story)
     FOREACH (_ IN CASE WHEN r.parentType <> 'story' OR r.parentType IS NULL THEN [1] ELSE [] END | SET p:Epic)
     WITH p, r
     UNWIND (CASE WHEN size(r.relates) = 0 THEN [null] ELSE r.relates END) AS rk
     WITH p, r, rk WHERE rk IS NOT NULL
     MERGE (o:Task {key: rk}) ON CREATE SET o.prefix = split(rk, '-')[0]
     MERGE (p)-[x:RELATES]->(o) SET x.source = r.source`,
    { rows },
  );
  return rows.length;
}

/** Marca a unidade como lida pelo Haiku até o último chunk visto. */
export async function markLlmDone(s: Session, u: Unit, error: string | null = null): Promise<void> {
  const label = u.kind === 'session' ? 'Session' : u.kind === 'plan' ? 'Plan' : 'TaskMemoryDoc';
  const key = u.kind === 'session' ? 'id' : 'path';
  await s.run(
    `MATCH (n:${label} {${key}: $id}) SET n.epicLinkVersion = $v, n.epicLinkAt = $at, n.epicLinkError = $err`,
    { id: u.id, v: EPIC_LINK_VERSION, at: u.lastTs, err: error },
  );
}

function keysFromEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((k) => taskKeyFromSlug(k.trim())).filter((k): k is string => !!k);
}

/**
 * Agregados do pai, recalculados do zero: balde, filhos e repos dos filhos.
 * Balde: override do .env > título > palpite do Haiku.
 */
export async function aggregateParents(s: Session): Promise<{ parents: number; buckets: number; crossRepo: number }> {
  const forced = keysFromEnv('MCP_TALKS_EPIC_BUCKETS');
  const notBucket = keysFromEnv('MCP_TALKS_EPIC_NOT_BUCKETS');
  const r = await s.run(`MATCH (p:Task)<-[:PART_OF]-(:Task) RETURN DISTINCT p.key AS key, p.title AS title, p.bucketHint AS hint`);
  const rows = r.records.map((x) => {
    const key = x.get('key') as string;
    const bucket = forced.includes(key) ? true : notBucket.includes(key) ? false : isBucketTitle(x.get('title') as string | null) || x.get('hint') === true;
    return { key, bucket };
  });
  await s.run(`UNWIND $rows AS r MATCH (p:Task {key: r.key}) SET p.bucket = r.bucket`, { rows });
  const agg = await s.run(`MATCH (p:Task)<-[:PART_OF]-(c:Task)
    OPTIONAL MATCH (c)<-[:ON_TASK]-(:Session)<-[:HAS_SESSION]-(proj:Project)
    WITH p, count(DISTINCT c) AS kids, collect(DISTINCT proj.path) AS repos
    SET p.childCount = kids, p.childRepos = repos
    RETURN count(p) AS parents, sum(CASE WHEN p.bucket THEN 1 ELSE 0 END) AS buckets,
           sum(CASE WHEN size(repos) > 1 THEN 1 ELSE 0 END) AS crossRepo`);
  const a = agg.records[0]!;
  return { parents: Number(a.get('parents')), buckets: Number(a.get('buckets')), crossRepo: Number(a.get('crossRepo')) };
}
