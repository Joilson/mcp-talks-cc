import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withSession } from '../neo4j/driver.ts';
import { searchMemory, isMetaProject } from './tools/searchMemory.ts';
import { getScoreCalibration } from './scoreCalibration.ts';
import { benchGate } from '../learning/confidenceGate.ts';
import { learningPaths } from '../learning/paths.ts';
import { logQuery } from '../learning/queryLog.ts';
import { gistOf, stripWrappers } from '../ingest/quality.ts';
import { normalizeFilePath } from '../ingest/entities.ts';
import { crossRepoRuleForFile } from '../epics/family.ts';
import { day, projectName, shortId } from './output.ts';
import type { Profile } from '../learning/types.ts';

/**
 * Push de memória: o hook manda o prompt (ou o arquivo aberto) e recebe, no
 * máximo, UM ponteiro de 1-2 linhas. Nunca conteúdo: o modelo decide se vale
 * `expand_hits`. Sem hit que passe no gate, a resposta é vazia e custa 0 token.
 *
 * Por que existe: em 57 dias o modelo buscou em 35% das sessões, quase sempre
 * só no começo. No meio da conversa, quando o assunto muda, ele não volta a
 * buscar. O ponteiro traz o sinal sem depender dessa decisão, e o custo fica
 * limitado por construção (dedup por sessão + teto).
 */

export const PUSH_MAX_PER_SESSION = 8;
const PROMPT_MIN_CHARS = 15;
/** Prompt que é só confirmação/comando curto não é pergunta nova. */
const TRIVIAL_RE =
  /^(?:ok|okay|sim|s|n|não|nao|beleza|blz|valeu|vlw|faz|fazer|pode|pode sim|manda|segue|continua|continue|go|yes|no|y|commit|push|isso|exato|perfeito|show|top|bora|vai)\b[\s!.,]*\S{0,20}$/i;
const GATE_FALLBACK = { strong: 0.9, floor: 0.59 };

interface PushState {
  injectedChunks: string[];
  injectedSessions: string[];
  files: string[];
  /** Decisions de outro repo já empurradas via epic (uma vez por sessão cada). */
  epicDecisions: string[];
  count: number;
}

function stateFile(sessionId: string): string {
  return join(learningPaths.sessionsDir, `${sessionId.replace(/[^A-Za-z0-9-]/g, '-')}.push.json`);
}

function readState(sessionId: string): PushState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(sessionId), 'utf8')) as Partial<PushState>;
    return {
      injectedChunks: raw.injectedChunks ?? [],
      injectedSessions: raw.injectedSessions ?? [],
      files: raw.files ?? [],
      epicDecisions: raw.epicDecisions ?? [],
      count: raw.count ?? 0,
    };
  } catch {
    return { injectedChunks: [], injectedSessions: [], files: [], epicDecisions: [], count: 0 };
  }
}

function writeState(sessionId: string, st: PushState): void {
  try {
    mkdirSync(learningPaths.sessionsDir, { recursive: true });
    writeFileSync(stateFile(sessionId), JSON.stringify(st));
  } catch {
    // estado perdido = no pior caso repete um ponteiro; nunca quebra o hook
  }
}

/** Gate vigente: bench > quota publicada no profile > fallback fixo. */
export function currentGate(): { strong: number; floor: number } {
  const b = benchGate();
  if (b) return b;
  try {
    const p = JSON.parse(readFileSync(learningPaths.profile, 'utf8')) as Profile;
    if (p.confidenceGate) return p.confidenceGate;
  } catch {
    // sem profile ainda
  }
  return GATE_FALLBACK;
}

export function isTrivialPrompt(text: string): boolean {
  const t = stripWrappers(text).trim();
  if (t.length < PROMPT_MIN_CHARS) return true;
  if (t.startsWith('/')) return true; // slash command
  return TRIVIAL_RE.test(t);
}

export interface PushResult {
  context: string | null;
  reason: string;
}

/** Ponteiro por prompt do user (hook UserPromptSubmit). */
export async function pushForPrompt(args: {
  prompt: string;
  sessionId: string | null;
  cwd: string | null;
}): Promise<PushResult> {
  if (isTrivialPrompt(args.prompt)) return { context: null, reason: 'trivial' };
  const st = args.sessionId ? readState(args.sessionId) : null;
  if (st && st.count >= PUSH_MAX_PER_SESSION) return { context: null, reason: 'cap' };

  const cal = getScoreCalibration();
  if (!cal?.ready) return { context: null, reason: 'uncalibrated' };
  const gate = currentGate();
  const marginFloor = cal.marginPercentiles?.p75 ?? null;

  const t0 = Date.now();
  const query = stripWrappers(args.prompt).slice(0, 500);
  const r = await searchMemory({
    query,
    k: 3,
    fast: true,
    ...(args.cwd && !isMetaProject(args.cwd) ? { project: args.cwd } : {}),
    ...(args.sessionId ? { excludeSessions: [args.sessionId] } : {}),
  });

  const pick = r.hits.find((h) => {
    if (h.confidence === null || h.confidence < gate.strong) return false;
    if (marginFloor !== null && r.poolVecMedian !== null && h.vec_score - r.poolVecMedian < marginFloor) return false;
    if (h.value_score !== null && h.value_score < 0.3) return false;
    if (st && (st.injectedChunks.includes(h.id) || (h.sessionId && st.injectedSessions.includes(h.sessionId)))) return false;
    return true;
  });

  void logQuery({
    v: 1,
    ts: new Date().toISOString(),
    tool: 'push',
    sessionId: args.sessionId,
    callerProject: args.cwd,
    query: query.slice(0, 300),
    k: 3,
    scope: null,
    project: args.cwd,
    projectStrict: null,
    diversity: null,
    hybridUsed: null,
    nResults: pick ? 1 : 0,
    topScore: pick?.score ?? null,
    scores: pick ? [pick.score] : [],
    latencyMs: Date.now() - t0,
    poolVecMedian: r.poolVecMedian,
    hits: pick
      ? [{ id: pick.id, sessionId: pick.sessionId, source: pick.source, project: pick.project, vecScore: pick.vec_score, bm25Score: pick.bm25_score }]
      : [],
  });

  if (!pick) return { context: null, reason: 'gate' };
  if (args.sessionId && st) {
    st.injectedChunks.push(pick.id);
    if (pick.sessionId) st.injectedSessions.push(pick.sessionId);
    st.count++;
    writeState(args.sessionId, st);
  }
  const tasks = pick.tasks.length ? ` ${pick.tasks.join(',')}` : '';
  return {
    context:
      `[memória mcp-talks-cc] talvez relevante: id=${shortId(pick.id)} ${projectName(pick.project)} ${day(pick.timestamp)}${tasks} conf=${pick.confidence!.toFixed(2)} | ${gistOf(pick.snippet, 140)} ` +
      `(expand_hits se servir; não cite sem ler)`,
    reason: 'hit',
  };
}

let _projectPaths: { at: number; paths: string[] } | null = null;
async function projectPaths(): Promise<string[]> {
  if (_projectPaths && Date.now() - _projectPaths.at < 10 * 60_000) return _projectPaths.paths;
  const paths = await withSession(async (s) => {
    const r = await s.run('MATCH (p:Project) RETURN collect(p.path) AS paths');
    return (r.records[0]?.get('paths') as string[]) ?? [];
  });
  _projectPaths = { at: Date.now(), paths };
  return paths;
}

/** Arquivo mais central que isto (idf baixo) não diz nada: aparece em tudo. */
const FILE_MIN_IDF = 2.0;

/**
 * Ponteiro por arquivo aberto/editado (hook PostToolUse). Só estrutura, sem
 * embedding: quais tasks já mexeram neste arquivo, em outras sessões.
 */
export async function pushForFile(args: {
  path: string;
  sessionId: string | null;
}): Promise<PushResult> {
  const st = args.sessionId ? readState(args.sessionId) : null;
  if (st && st.count >= PUSH_MAX_PER_SESSION) return { context: null, reason: 'cap' };
  const ref = normalizeFilePath(args.path, await projectPaths());
  if (!ref) return { context: null, reason: 'unknown-file' };
  if (st?.files.includes(ref.key)) return { context: null, reason: 'dup' };

  const rows = await withSession(async (s) => {
    const r = await s.run(
      `MATCH (f:File { key: $key }) WHERE f.idf > $minIdf
       MATCH (f)<-[:WROTE]-(se:Session) WHERE se.id <> coalesce($sid, '')
       OPTIONAL MATCH (se)-[:ON_TASK]->(t:Task)
       WITH se, collect(DISTINCT t.key) AS tasks
       RETURN se.id AS sid, se.startedAt AS at, tasks
       ORDER BY at DESC LIMIT 4`,
      { key: ref.key, minIdf: FILE_MIN_IDF, sid: args.sessionId },
    );
    const sessions = r.records.map((rec) => ({
      sid: rec.get('sid') as string,
      at: rec.get('at') as string | null,
      tasks: rec.get('tasks') as string[],
    }));
    // regra/gotcha destilado sobre o arquivo vale mais que a lista de tasks
    const d = await s.run(
      `MATCH (f:File { key: $key })<-[:ABOUT]-(d:Decision { status: 'active' })
       WHERE coalesce(d.sessionId, '') <> coalesce($sid, '')
       RETURN d.id AS id, d.kind AS kind, d.text AS text
       ORDER BY CASE d.kind WHEN 'gotcha' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END, d.createdAt DESC LIMIT 1`,
      { key: ref.key, sid: args.sessionId },
    );
    const dec = d.records[0]
      ? { id: d.records[0].get('id') as string, kind: d.records[0].get('kind') as string, text: d.records[0].get('text') as string }
      : null;
    // regra de OUTRO repo pelo epic da task da sessão (back -> front)
    const cross = await crossRepoRuleForFile(s, {
      sessionId: args.sessionId,
      fileRepo: ref.repo,
      path: ref.path,
      exclude: [...(st?.epicDecisions ?? []), ...(dec ? [dec.id] : [])],
    });
    return { sessions, dec, cross };
  });

  const { sessions, dec, cross } = rows;
  if (args.sessionId && st) {
    st.files.push(ref.key);
    if (cross) st.epicDecisions.push(cross.id);
    if (sessions.length > 0 || dec || cross) st.count++;
    writeState(args.sessionId, st);
  }
  if (sessions.length === 0 && !dec && !cross) return { context: null, reason: 'no-history' };

  const refs = sessions
    .map((r) => (r.tasks.length ? r.tasks.join('/') : `session ${r.sid.slice(0, 8)}`) + ` ${day(r.at)}`)
    .join(', ');
  const decLine = dec ? ` ${dec.kind} (id=${shortId(dec.id)}): ${gistOf(dec.text, 200)}` : '';
  const hist = sessions.length > 0 ? ` já foi alterado em: ${refs}.` : '';
  const crossLine = cross
    ? ` ${cross.kind} de ${projectName(cross.project)} (${cross.relation === 'epic' ? 'epic' : 'irmã'} ${cross.via}, id=${shortId(cross.id)}): ${gistOf(cross.text, 200)}`
    : '';
  const head = sessions.length > 0 || dec ? `${ref.path}${hist}${decLine}` : `${ref.path}:`;
  return {
    context: `[memória mcp-talks-cc] ${head}${crossLine} search_memory com o nome do arquivo/task se o contexto importar.`,
    reason: 'hit',
  };
}
