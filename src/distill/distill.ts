import { createHash } from 'node:crypto';
import type { Session } from 'neo4j-driver';
import { z } from 'zod';
import { config } from '../config.ts';
import { embed } from '../embeddings/localEmbedder.ts';
import { stripWrappers } from '../ingest/quality.ts';
import { redact } from '../ingest/redact.ts';
import { runHeadless } from './headless.ts';

/**
 * Distilação: de uma sessão fechada, extrai decisões, regras e gotchas curtos
 * (≤300 chars) que valem fora dela, e grava como nó `Decision` com um Chunk
 * `sourceKind: 'decision'` no mesmo índice vetorial.
 *
 * Por que: o recall hoje devolve trechos de transcript de ~600 chars, metade
 * narração de processo, e o bge-m3 comprime o cosseno a ponto de o trecho certo
 * empatar com ruído. Uma regra destilada é curta, autocontida e densa: ~50
 * tokens no lugar de 3 chunks de ~150, e embeda sobre o CONTEÚDO, não sobre a
 * conversa em volta.
 *
 * A seleção é estrutural (sessão fechada com entrega suficiente), não por
 * grade: o ROADMAP travava a distilação em "grades suficientes pra saber quais
 * conversas valem", e com ~40 buscas/mês esse pré-requisito nunca fechava.
 *
 * O LLM é o `claude -p` headless com Haiku: sem tools, sem MCP, sem hooks do
 * usuário e sem persistir sessão (senão a própria chamada viraria transcript
 * indexado e dispararia o SessionStart de novo).
 */

export const DISTILL_VERSION = 1;
export const DISTILL_MODEL = process.env.DISTILL_MODEL ?? 'claude-haiku-4-5-20251001';
/** Sessão com atividade mais recente que isso ainda pode estar em andamento. */
const CLOSED_AFTER_MS = 2 * 3600 * 1000;
/** Mínimo de mensagens de entrega pra valer a chamada. */
const MIN_DELIVERIES = 3;
const MAX_INPUT_CHARS = 24_000;
/** Acima disto contra Decision existente do mesmo repo, é a mesma regra. */
const DUP_COSINE = 0.93;
const CALL_TIMEOUT_MS = 120_000;

export const itemSchema = z.object({
  kind: z.enum(['decision', 'rule', 'gotcha']),
  text: z.string().min(20).max(400),
  scope: z.enum(['repo', 'cross']),
  files: z.array(z.string()).max(6),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type DistillItem = z.infer<typeof itemSchema>;

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['decision', 'rule', 'gotcha'] },
          text: { type: 'string', maxLength: 300 },
          scope: { type: 'string', enum: ['repo', 'cross'] },
          files: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['kind', 'text', 'scope', 'files', 'confidence'],
      },
    },
  },
  required: ['items'],
};

const SYSTEM_PROMPT = `Você destila conhecimento DURÁVEL de uma conversa de desenvolvimento (Claude Code) pra uma memória de longo prazo.

Extraia de 0 a 6 itens, só o que continua valendo depois desta conversa:
- decision: escolha feita entre alternativas, com o porquê ("X em vez de Y porque Z").
- rule: convenção ou restrição do projeto/negócio que outra tarefa precisa respeitar.
- gotcha: armadilha não óbvia e como contornar (bug sutil, comportamento inesperado, pré-condição escondida).

NÃO extraia: narração de processo ("verifiquei X", "rodei os testes"), estado temporário (branch, PR aberto, status de CI), coisa óbvia pelo código, preferência de formato de resposta, nem o que só vale pra esta conversa.

Cada text: pt-BR, no máximo 300 caracteres, AUTOCONTIDO (nomeia a entidade, o arquivo, a flag, o endpoint; nunca "isso", "o componente acima"). Sem travessão. Em "files", caminhos relativos ao repo que o item cita (vazio se nenhum). scope=cross quando vale além deste repo (regra de negócio, contrato de API entre front e back). confidence=low quando a conversa não fechou a decisão.

Conversa sem nada durável: devolva items vazio. Melhor vazio que item fraco.`;

export interface SessionInput {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  tasks: string[];
  lastAt: string;
  text: string;
}

/** Sessões fechadas, com entrega suficiente e ainda não destiladas nesta versão. */
export async function pendingSessions(
  s: Session,
  limit: number,
  recentDays: number | null = null,
  oldestFirst = false,
): Promise<string[]> {
  const closedBefore = new Date(Date.now() - CLOSED_AFTER_MS).toISOString();
  const since = recentDays === null ? '' : new Date(Date.now() - recentDays * 86_400_000).toISOString();
  const r = await s.run(
    `MATCH (se:Session)
     WHERE coalesce(se.distillVersion, 0) < $v
     MATCH (se)-[:HAS_MESSAGE]->(m:Message)
     WITH se, max(m.timestamp) AS lastAt
     WHERE lastAt < $closedBefore AND lastAt >= $since
     CALL {
       WITH se
       MATCH (se)-[:HAS_MESSAGE]->(:Message { role: 'assistant' })-[:HAS_CHUNK]->(c:Chunk)
       WHERE c.valueScore >= 0.5
       RETURN count(DISTINCT c) AS deliveries
     }
     WITH se, lastAt, deliveries WHERE deliveries >= $minDel
     RETURN se.id AS id ORDER BY lastAt ${oldestFirst ? 'ASC' : 'DESC'} LIMIT toInteger($limit)`,
    { v: DISTILL_VERSION, closedBefore, since, minDel: MIN_DELIVERIES, limit },
  );
  return r.records.map((rec) => rec.get('id') as string);
}

/**
 * Monta a entrada: pedidos do humano (restrições moram ali), falas de entrega
 * do assistant e planos ligados à sessão, com teto de tamanho. Narração
 * (valueScore < 0.5) fica de fora: é justamente o que não se quer destilar.
 */
export async function buildSessionInput(s: Session, sessionId: string): Promise<SessionInput | null> {
  const meta = await s.run(
    `MATCH (se:Session { id: $id })
     OPTIONAL MATCH (se)-[:ON_TASK]->(t:Task)
     WITH se, collect(DISTINCT t.key) AS tasks
     OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(m:Message)
     RETURN se.projectPath AS project, se.gitBranch AS branch, tasks, max(m.timestamp) AS lastAt`,
    { id: sessionId },
  );
  const rec = meta.records[0];
  if (!rec) return null;

  const msgs = await s.run(
    `MATCH (se:Session { id: $id })-[:HAS_MESSAGE]->(m:Message)
     WHERE m.text IS NOT NULL AND (
       (m.role = 'user' AND NOT EXISTS { MATCH (m)-[:INVOKED]->() })
       OR (m.role = 'assistant' AND EXISTS {
             MATCH (m)-[:HAS_CHUNK]->(c:Chunk) WHERE c.valueScore >= 0.5 }))
     RETURN m.role AS role, m.text AS text ORDER BY m.timestamp`,
    { id: sessionId },
  );
  const plans = await s.run(
    `MATCH (pl:Plan)-[:PLANNED_IN]->(:Session { id: $id })
     MATCH (pl)-[:HAS_CHUNK]->(c:Chunk)
     WITH pl, c ORDER BY c.ordinal
     WITH pl, reduce(t = '', x IN collect(c.text) | t + x) AS body
     RETURN pl.path AS path, substring(body, 0, 4000) AS body LIMIT 2`,
    { id: sessionId },
  );

  const parts: string[] = [];
  for (const p of plans.records) parts.push(`## PLANO ${p.get('path')}\n${stripWrappers(p.get('body') as string)}`);
  let humans = 0;
  for (const m of msgs.records) {
    const role = m.get('role') as string;
    const t = stripWrappers(m.get('text') as string);
    if (t.length < 20) continue;
    if (role === 'user') {
      if (++humans > 15) continue;
      parts.push(`## USER\n${t.slice(0, 600)}`);
    } else {
      parts.push(`## ASSISTANT\n${t.slice(0, 1500)}`);
    }
  }
  let text = '';
  for (const p of parts) {
    if (text.length + p.length > MAX_INPUT_CHARS) break;
    text += p + '\n\n';
  }
  if (text.length < 400) return null;
  return {
    sessionId,
    projectPath: rec.get('project'),
    gitBranch: rec.get('branch'),
    tasks: rec.get('tasks') as string[],
    lastAt: rec.get('lastAt') as string,
    text: redact(text),
  };
}

/** Uma chamada headless. Lança em erro/timeout (o caller marca e segue). */
export async function callClaude(input: SessionInput): Promise<DistillItem[]> {
  const header =
    `Repo: ${input.projectPath ?? '-'} | branch: ${input.gitBranch ?? '-'} | tasks: ${input.tasks.join(', ') || '-'}\n\n`;
  const out = (await runHeadless({
    system: SYSTEM_PROMPT,
    schema: JSON_SCHEMA,
    input: header + input.text,
    timeoutMs: CALL_TIMEOUT_MS,
    model: DISTILL_MODEL,
  })) as { items?: unknown[] } | null;
  const items = out?.items ?? [];
  return items
    .map((i) => itemSchema.safeParse(i))
    .filter((r): r is { success: true; data: DistillItem } => r.success)
    .map((r) => ({ ...r.data, text: r.data.text.replace(/\s*—\s*/g, ', ').slice(0, 300) }))
    .filter((i) => i.confidence !== 'low');
}

function decisionId(sessionId: string, text: string): string {
  return createHash('sha1').update(`${sessionId}\u0000${text}`).digest('hex');
}

/** Grava os itens não-duplicados. Devolve quantos entraram. */
export async function writeDecisions(s: Session, input: SessionInput, items: DistillItem[]): Promise<number> {
  if (items.length > 0) {
    const vecs = await embed(items.map((i) => `[${i.kind}] ${i.text}`));
    const keep: Array<{ item: DistillItem; vec: number[] }> = [];
    for (let i = 0; i < items.length; i++) {
      const vec = vecs[i]!;
      const dup = await s.run(
        `CALL db.index.vector.queryNodes('chunks_embedding', 20, $vec) YIELD node, score
         WHERE node.sourceKind = 'decision' AND score >= $min
           AND ($project IS NULL OR node.projectPath = $project)
         RETURN count(*) AS n`,
        { vec, min: DUP_COSINE, project: input.projectPath },
      );
      const isDup = Number(dup.records[0]?.get('n') ?? 0) > 0;
      // duplicata dentro do próprio lote também conta
      const selfDup = keep.some((k) => k.vec.reduce((a, v, j) => a + v * vec[j]!, 0) >= DUP_COSINE);
      if (!isDup && !selfDup) keep.push({ item: items[i]!, vec });
    }
    const repo = input.projectPath?.split('/').filter(Boolean).pop() ?? null;
    const rows = keep.map(({ item, vec }) => ({
      id: decisionId(input.sessionId, item.text),
      kind: item.kind,
      text: item.text,
      scope: item.scope,
      confidence: item.confidence,
      files: item.files,
      embedding: vec,
    }));
    if (rows.length > 0) {
      await s.run(
        `UNWIND $rows AS r
         MATCH (se:Session { id: $sid })
         MERGE (d:Decision { id: r.id })
         SET d.text = r.text, d.kind = r.kind, d.scope = r.scope, d.confidence = r.confidence,
             d.files = r.files, d.repo = $repo, d.projectPath = $project, d.sessionId = $sid,
             d.taskKeys = $tasks, d.createdAt = $at, d.status = 'active',
             d.model = $model, d.version = $v
         MERGE (d)-[:FROM_SESSION]->(se)
         MERGE (c:Chunk { id: r.id })
         SET c.text = '[' + r.kind + '] ' + r.text, c.ordinal = 0, c.sourceKind = 'decision',
             c.projectPath = $project, c.sessionId = $sid, c.timestamp = $at, c.role = null,
             c.valueScore = 1.0, c.embedding = r.embedding
         MERGE (d)-[:HAS_CHUNK]->(c)
         WITH d, r
         OPTIONAL MATCH (t:Task) WHERE t.key IN $tasks
         FOREACH (_ IN CASE WHEN t IS NULL THEN [] ELSE [1] END | MERGE (d)-[:ON_TASK]->(t))
         WITH d, r
         UNWIND (CASE WHEN size(r.files) = 0 THEN [null] ELSE r.files END) AS fp
         OPTIONAL MATCH (f:File { repo: $repo }) WHERE fp IS NOT NULL AND (f.path = fp OR f.path ENDS WITH ('/' + fp))
         FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END | MERGE (d)-[:ABOUT]->(f))`,
        {
          rows,
          sid: input.sessionId,
          repo,
          project: input.projectPath,
          tasks: input.tasks,
          at: input.lastAt,
          model: DISTILL_MODEL,
          v: DISTILL_VERSION,
        },
      );
    }
    await markDistilled(s, input.sessionId, rows.length);
    return rows.length;
  }
  await markDistilled(s, input.sessionId, 0);
  return 0;
}

export async function markDistilled(s: Session, sessionId: string, n: number, error?: string): Promise<void> {
  await s.run(
    `MATCH (se:Session { id: $id })
     SET se.distillVersion = $v, se.distilledAt = $now, se.distillCount = $n, se.distillError = $err`,
    { id: sessionId, v: DISTILL_VERSION, now: new Date().toISOString(), n, err: error ?? null },
  );
}
