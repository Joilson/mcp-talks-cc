import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Session } from 'neo4j-driver';
import { withSession } from '../../neo4j/driver.ts';
import { embed } from '../../embeddings/localEmbedder.ts';
import { toToolError } from '../../domain/errors.ts';
import {
  getTuning,
  LAMBDA_DEFAULT,
  RRF_K,
  RECENCY_FLOOR,
  RECENCY_HALFLIFE_DAYS,
  VALUE_DEMOTE_THRESHOLD,
  QUERY_TASK_BOOST,
  TASK_RECALL_LIMIT,
  RECALL_POOL,
  RECALL_POOL_MAX,
  MMR_POOL_MULT,
  MMR_POOL_MAX,
  META_PROJECTS,
  META_PROJECT_DEMOTE,
  FAST_RECALL_POOL,
  DECISION_BOOST,
  MAX_HITS_PER_SESSION,
  FOCUS_DIVERSITY,
} from '../tuning.ts';
import { confidenceFromVec, getScoreCalibration } from '../scoreCalibration.ts';
import { gistOf, lexicalHints } from '../../ingest/quality.ts';
import { day, fmtConf, projectName, shortId, withStructured } from '../output.ts';
import { taskKeysFromText } from '../../ingest/entities.ts';
import { resolveCallerSession } from '../callerSession.ts';
import { logQuery } from '../../learning/queryLog.ts';

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Natural language query. Hybrid retrieval: vector embed (semantic) + BM25 fulltext (exact terms like ABC-XXXX, useEffect, file paths).',
    ),
  // Sem .default(): o SDK preencheria antes do handler e anularia o valor aprendido (tuning.json).
  k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of results to return (default 8, learned via tuning).'),
  scope: z
    .array(z.enum(['conversation', 'plan', 'task_memory', 'decision']))
    .optional()
    .describe('Restrict to specific source kinds. Omit to search everything.'),
  project: z
    .string()
    .optional()
    .describe(
      'Absolute project path (e.g. /Users/you/Documents/code/your-project). SOFT BOOST: same-project hits rank higher but cross-repo hits stay eligible (rules often span repos). Use projectStrict to hard-filter.',
    ),
  projectStrict: z
    .boolean()
    .optional()
    .describe('If true, `project` becomes a hard filter (old behavior). Default false (soft boost).'),
  since: z
    .string()
    .optional()
    .describe('ISO timestamp. Only chunks with timestamp >= since.'),
  diversity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'MMR lambda. 0 = max diversity (different sessions), 1 = pure relevance. Default 0.7. Use 0.3 for panorama, 0.9 to focus a single topic.',
    ),
  detail: z
    .enum(['brief', 'full'])
    .optional()
    .describe(
      "Output size. 'brief' (default): 1 line per hit (~40 tokens) with a short id; call expand_hits(ids) for full text of the ones worth reading. 'full': whole snippets.",
    ),
  hybrid: z
    .boolean()
    .default(true)
    .describe('Combine vector + BM25 fulltext. Disable only for debug.'),
};

export interface SearchHit {
  id: string;
  score: number;
  /** Percentil histórico do vec_score. null = calibração ainda não pronta. */
  confidence: number | null;
  vec_score: number;
  bm25_score: number | null;
  /** P(entrega) do classificador de valor; null se o chunk ainda não foi classificado. */
  value_score: number | null;
  source: string;
  sessionId: string | null;
  project: string | null;
  timestamp: string | null;
  snippet: string;
  neighbors: string[];
  parentLabel: string | null;
  parentKey: string | null;
  /** Tasks (ON_TASK) da sessão do hit, no máx 2. */
  tasks: string[];
}

/**
 * Token literal DE VERDADE: só isso deve ligar o BM25.
 * Cuidado com padrão frouxo aqui: um branch tipo `\b[a-z][A-Za-z0-9_]{4,}\b`
 * casa qualquer palavra com 5+ letras ("quando", "memoria"), o que liga hybrid
 * em toda query em prosa e infla o score de todo hit topo via BM25.
 */
export const LITERAL_TOKEN_RE = new RegExp(
  [
    '\\b[A-Z]{2,}-\\d+\\b', // EDC-2410
    '\\b[\\w/.-]+\\.(?:ts|tsx|js|jsx|mjs|php|md|py|go|rb|sql|json|ya?ml|sh|css|scss)\\b', // path/arquivo
    '\\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\\b', // camelCase: useEffect, projectBoost
    '\\b[a-z][a-z0-9]*_[a-z0-9_]+\\b', // snake_case
    '\\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\\b', // CONST_CASE
    '\\b[A-Z]{3,}\\b', // sigla: MCP, SQL, JWT
    '\\b\\d+\\.\\d+(?:\\.\\d+)?\\b', // versão: 5.26, 1.2.3
  ].join('|'),
  'g',
);

/**
 * Token "de vocabulário" (palavra de 5+ letras). NÃO serve pra gatear hybrid,
 * só pra extrair terminologia recorrente no profile (src/learning/profile.ts).
 */
export const TERM_TOKEN_RE = /\b[a-zA-Zà-úÀ-Ú][A-Za-zà-úÀ-Ú0-9_]{4,}\b/g;

export function isMetaProject(path: string | null | undefined): boolean {
  if (!path) return false;
  const name = path.split('/').filter(Boolean).pop();
  return name !== undefined && META_PROJECTS.includes(name);
}

export function hasLiteralTokens(q: string): boolean {
  LITERAL_TOKEN_RE.lastIndex = 0;
  return LITERAL_TOKEN_RE.test(q);
}

/**
 * Decay de recência aplicado SÓ no termo de relevância do MMR. Sem isso um
 * chunk de janeiro empata com o de ontem no ranking.
 */
export function recencyMult(
  timestamp: string | null,
  nowMs: number = Date.now(),
): number {
  if (!timestamp) return 1;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 1;
  const ageDays = (nowMs - t) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS));
}

/**
 * Query lexical a partir SÓ dos tokens literais, cada um como frase exata.
 *
 * O escape antigo (`q.replace(/[+\-...]/g, '\\$&')`) preservava o hífen como
 * caractere mas não como separador: o analyzer padrão quebrava `EDC\-3197` em
 * `EDC` OR `3197`, então a busca casava todo chunk que citasse qualquer EDC.
 * Medido: `EDC\-3197` batia em 500 chunks (o pool inteiro), `"EDC-3197"` bate
 * em 15, que é exatamente o `CONTAINS` real. Com tudo casando, o BM25 não
 * discriminava nada e o sinal lexical virava ruído uniforme.
 *
 * Só os tokens de LITERAL_TOKEN_RE entram: o resto da frase é prosa, que já é
 * trabalho do vetor. Retorna null quando não há token literal (o caller então
 * não roda fulltext nenhum).
 */
export function buildFulltextQuery(q: string): string | null {
  LITERAL_TOKEN_RE.lastIndex = 0;
  const tokens = [...new Set(q.match(LITERAL_TOKEN_RE) ?? [])];
  if (tokens.length === 0) return null;
  return tokens
    .map((t) => `"${t.replace(/[\\"]/g, '\\$&')}"`)
    .join(' OR ');
}

/**
 * Saturação do BM25 pra [0,1): `s / (s + med)`, com med = mediana do pool
 * retornado. Antes era max-normalização, que forçava o top a 1.0 sempre e
 * dava +0.30 fixo no score do primeiro hit, independente
 * de o match lexical ser bom ou ruim. Monótona e sem teto artificial.
 */
export function saturateBm25(values: number[]): number[] {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const med = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const c = med > 0 ? med : 1;
  return values.map((v) => (v > 0 ? v / (v + c) : 0));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // already normalized (HF normalize: true)
}

/** Metadata do estágio A: tudo que dá pra rankear sem trafegar o embedding. */
interface CandidateMeta {
  id: string;
  source: string;
  sessionId: string | null;
  project: string | null;
  timestamp: string | null;
  /** P(entrega) do classificador de valor; null = chunk ainda sem classificação. */
  valueScore: number | null;
  role: string | null;
}

/** Candidato do estágio A (pool largo): sem embedding, sem texto. */
interface PreCandidate {
  id: string;
  /** null = veio só do BM25; o cosseno real é calculado no estágio B. */
  vec_score: number | null;
  bm25_score: number | null;
  /** Posição 1-based em cada lista; null = não apareceu naquela lista. */
  vec_rank: number | null;
  bm25_rank: number | null;
  /** Terceira lista: chunk de sessão cuja task a query nomeia. */
  task_rank: number | null;
  meta: CandidateMeta;
}

/** Finalista do estágio B: embedding e texto buscados só pra estes. */
interface Candidate extends PreCandidate {
  embedding: number[];
  snippet: string;
  /** No estágio B todo finalista tem cosseno, inclusive o que veio só do BM25. */
  vec_score: number;
}

/**
 * Fusão por rank (RRF), não por soma de scores.
 *
 * A fusão anterior era `0.7*vec + 0.3*bm25`, com `bm25 null` caindo pra `vec`
 * puro. Como o cosseno do bge-m3 vive comprimido em ~0.82-0.89 e o BM25
 * saturado gira em torno de 0.5, misturar ABAIXAVA o score: casar lexicalmente
 * virava penalidade, e um chunk sem match nenhum guardava o vec inteiro. Na
 * busca por `EDC-3197` o plano da própria task caía pro rank 349 enquanto os
 * finalistas são os 25 primeiros.
 *
 * RRF compara posições, não magnitudes, então as duas escalas deixam de
 * precisar ser comensuráveis e aparecer nas duas listas só soma.
 */
function rrfScore(c: Pick<PreCandidate, 'vec_rank' | 'bm25_rank' | 'task_rank'>): number {
  return (
    (c.vec_rank !== null ? 1 / (RRF_K + c.vec_rank) : 0) +
    (c.bm25_rank !== null ? 1 / (RRF_K + c.bm25_rank) : 0) +
    (c.task_rank !== null ? 1 / (RRF_K + c.task_rank) : 0)
  );
}

/**
 * Relevância crua em [0,1], que é o que o MMR e o campo `score` consomem.
 *
 * Cosseno (sem híbrido) ou RRF (com), sempre normalizado min-max DENTRO dos
 * finalistas: o RRF cru vale ~0.03 no topo, e
 * nessa escala o termo de diversidade do MMR (`(1-lambda)*maxSim`, ~0.27)
 * engoliria a relevância por completo e a seleção degeneraria em diversidade
 * pura.
 */
function normalizeRelevance(values: number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  return values.map((v) => (span > 0 ? (v - min) / span : 1));
}

/**
 * Sessões da task que a PRÓPRIA QUERY nomeia.
 *
 * Diferente do boost por chamador: aqui o vínculo é explícito, o usuário
 * escreveu `EDC-3197`. Antes disto, achar a sessão daquela task dependia de o
 * cosseno e o BM25 colocarem um chunk dela no top-k, e isso falhava justamente
 * onde mais dói: as 28 falhas medidas eram todas de sessões de janeiro a maio,
 * com 33 chunks de média contra 84 das demais. Memória antiga e magra deixava
 * de ser recuperável.
 *
 * Com o nó de Task o vínculo é estrutural, então o acerto para de depender de
 * ranking. Multiplicador próprio e alto, porque a evidência aqui é literal e
 * não estatística.
 */
async function sessionsOfQueryTasks(s: Session, query: string): Promise<Set<string>> {
  const keys = taskKeysFromText(query);
  if (keys.length === 0) return new Set();
  const r = await s.run(
    `MATCH (t:Task)<-[:ON_TASK]-(se:Session) WHERE t.key IN $keys RETURN collect(se.id) AS ids`,
    { keys },
  );
  return new Set((r.records[0]?.get('ids') as string[]) ?? []);
}

/**
 * Sessões "irmãs" da que está chamando: mesma task, ou que escreveram um
 * arquivo em comum.
 *
 * É o vínculo mais barato que existe em tokens: influencia o ranking sem
 * acrescentar uma palavra à resposta.
 *
 * O `f.idf > 2.0` no ramo de arquivo é essencial. Sem ele, um arquivo central
 * como `contract/types.ts` (44 sessões) arrastaria 44 sessões inteiras pra
 * dentro do conjunto e o boost deixaria de discriminar qualquer coisa.
 *
 * Risco conhecido: auto-reforço. O boost puxa sempre a mesma vizinhança e o
 * acervo "de fora" some. Por isso o teto é 1.35 e o conjunto é vazio (boost
 * neutro) quando a sessão chamadora não tem entidade nenhuma.
 */
async function kinSessions(s: Session, sessionId: string | null): Promise<Set<string>> {
  if (!sessionId) return new Set();
  const r = await s.run(`
    MATCH (me:Session { id: $id })
    OPTIONAL MATCH (me)-[:ON_TASK]->(:Task)<-[:ON_TASK]-(s1:Session)
    OPTIONAL MATCH (me)-[:WROTE]->(f:File)<-[:WROTE]-(s2:Session) WHERE f.idf > 2.0
    WITH collect(DISTINCT s1.id) + collect(DISTINCT s2.id) AS ids
    RETURN [x IN ids WHERE x IS NOT NULL AND x <> $id][..200] AS kin
  `, { id: sessionId });
  return new Set((r.records[0]?.get('kin') as string[]) ?? []);
}

/**
 * Demoção assimétrica de narração.
 *
 * Promover conteúdo bom não precisa de cuidado; REBAIXAR precisa, porque o erro
 * some com informação. Por isso o multiplicador só sai de 1 quando as três
 * condições valem, e qualquer falha devolve neutro em vez de punir:
 *
 *  1. `valueScore` abaixo do limiar (medido: em 0,30 acerta 87,5%);
 *  2. papel diferente de `user` — pedido e restrição são curtos e imperativos,
 *     sintaticamente iguais a anúncio, e são 18,5 mil chunks. Tratá-los pelo
 *     mesmo modelo rebaixaria mais de um terço do acervo por acidente;
 *  3. veto lexical: bloco de código, bullet, `porque`/`because` ou seta indicam
 *     entrega, e vencem o modelo. Defesa contra o overlap de 150 chars do
 *     chunker, que faz um pedaço começar com cauda de anúncio e mesmo assim
 *     entregar conteúdo.
 *
 * Aplicado SÓ no MMR, nunca no corte do estágio A: lá o texto ainda não foi
 * buscado, então o veto não teria como rodar e um chunk bom poderia cair fora
 * do pool de finalistas sem chance de defesa.
 */
function valueMult(c: Candidate, demote: number): number {
  if (demote >= 1) return 1;
  const p = c.meta.valueScore;
  if (p === null || p >= VALUE_DEMOTE_THRESHOLD) return 1;
  if (c.meta.role === 'user') return 1;
  if (lexicalHints(c.snippet).payload) return 1;
  return demote;
}

function mmrSelect(
  pool: Candidate[],
  lambda: number,
  k: number,
  maxPerSession: number,
  /** Sessões fora do teto: as da task que a query nomeia, onde o que se quer é profundidade. */
  uncapped: Set<string>,
  relOf: (c: Candidate) => number,
  boostOf: (c: Candidate) => number,
): Candidate[] {
  const selected: Candidate[] = [];
  const remaining = [...pool];
  const perSession = new Map<string, number>();

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      if (
        maxPerSession > 0 &&
        c.meta.sessionId &&
        !uncapped.has(c.meta.sessionId) &&
        (perSession.get(c.meta.sessionId) ?? 0) >= maxPerSession
      ) {
        continue;
      }
      // boost multiplica SÓ o termo de relevância (ranking); o termo de
      // diversidade (maxSim) e o score reportado ficam crus.
      const rel = relOf(c) * boostOf(c);
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((s) => cosine(c.embedding, s.embedding)));
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break; // só sobrou candidato de sessão já no teto
    const pickedC = remaining.splice(bestIdx, 1)[0]!;
    if (pickedC.meta.sessionId) perSession.set(pickedC.meta.sessionId, (perSession.get(pickedC.meta.sessionId) ?? 0) + 1);
    selected.push(pickedC);
  }
  return selected;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Fundo daquela query: mediana de vec_score do pool de candidatos. */
  poolVecMedian: number | null;
  poolSize: number;
  calibrated: boolean;
}

export async function searchMemory(args: {
  query: string;
  k?: number;
  scope?: ('conversation' | 'plan' | 'task_memory' | 'decision')[];
  project?: string;
  projectStrict?: boolean;
  since?: string;
  diversity?: number;
  hybrid?: boolean;
  /**
   * Só uso interno (bench/probe), fora do inputSchema da tool. Simulam "estar
   * no momento da busca": sem eles a própria sessão onde a query nasceu, que
   * contém a resposta montada a partir da memória, volta como hit e o bench
   * mede vazamento em vez de recall.
   */
  until?: string;
  excludeSessions?: string[];
  /**
   * Só uso interno (bench). Sessão "de onde" a busca parte, no lugar da que o
   * processo resolve sozinho. Sem isto o kin e o boost por epic dependem do
   * caller real, que no bench é nenhum, e o A/B mede sempre boost neutro.
   */
  callerSessionId?: string | null;
  /**
   * Caminho do hook de push: pool menor, sem retry fundo, sem kin. Precisa
   * caber no orçamento de latência de um hook que roda a cada prompt.
   */
  fast?: boolean;
}): Promise<SearchResult> {
  const tuning = getTuning();
  const k = args.k ?? tuning.k;
  const lambda = args.diversity ?? LAMBDA_DEFAULT;
  const hybrid = (args.hybrid ?? true) && hasLiteralTokens(args.query);
  // Estágio B: só os finalistas trazem `node.embedding` (1024 doubles) pro MMR
  // client-side, que era a maior parte do p90 de latência.
  const mmrPool = args.fast ? Math.min(k * MMR_POOL_MULT, 15) : Math.min(k * MMR_POOL_MULT, MMR_POOL_MAX);

  // project é soft boost por padrão (regras cruzam repos); hard filter só com projectStrict
  const projectFilter = args.projectStrict ? (args.project ?? null) : null;
  const nowMs = Date.now();
  const callerIsMeta = isMetaProject(resolveCallerSession().project);
  const boostOf = (m: CandidateMeta): number =>
    (!callerIsMeta && isMetaProject(m.project) ? META_PROJECT_DEMOTE : 1) *
    (m.source === 'decision' ? DECISION_BOOST : 1) *
    (args.project && !args.projectStrict && m.project === args.project
      ? tuning.projectBoost
      : 1) *
    (tuning.perSourceKind[m.source] ?? 1) *
    (m.project ? (tuning.perProject[m.project] ?? 1) : 1) *
    recencyMult(m.timestamp, nowMs);

  const empty: SearchResult = { hits: [], poolVecMedian: null, poolSize: 0, calibrated: false };

  const [qvec] = await embed([args.query.trim()]);
  if (!qvec) return empty;

  return withSession(async (s) => {
    // (1) Estágio A — pool largo de recall, SEM embedding nem texto.
    // scope/project/since são post-filter (o índice vetorial do Neo4j 5.26
    // community não aceita pre-filter), então o pool precisa ser fundo o
    // bastante pra sobrar material depois deles.
    const queryTaskSessions = await sessionsOfQueryTasks(s, args.query);

    const stageA = async (poolSize: number): Promise<PreCandidate[]> => {
      const vecRes = await s.run(
        `CALL db.index.vector.queryNodes('chunks_embedding', toInteger($poolSize), $vec)
         YIELD node, score
         WHERE ($scope IS NULL OR node.sourceKind IN $scope)
           AND ($project IS NULL OR node.projectPath = $project)
           AND ($since IS NULL OR node.timestamp >= $since)
           AND ($until IS NULL OR node.timestamp <= $until)
           AND ($excl IS NULL OR node.sessionId IS NULL OR NOT node.sessionId IN $excl)
         RETURN node.id AS id,
                score AS vec_score,
                node.sourceKind AS source,
                node.sessionId AS sessionId,
                node.projectPath AS project,
                node.timestamp AS timestamp,
                node.valueScore AS valueScore,
                node.role AS role
         ORDER BY score DESC`,
        {
          vec: qvec,
          poolSize,
          scope: args.scope ?? null,
          project: projectFilter,
          since: args.since ?? null,
          until: args.until ?? null,
          excl: args.excludeSessions ?? null,
        },
      );

      // Fulltext no mesmo tamanho de pool; BM25 satura sobre ele (só pra
      // reportar: quem ordena agora é o rank, via RRF).
      const ftMap = new Map<string, { score: number; rank: number; meta: CandidateMeta }>();
      const ftQuery = hybrid ? buildFulltextQuery(args.query) : null;
      if (ftQuery) {
        try {
          const ftRes = await s.run(
            `CALL db.index.fulltext.queryNodes('chunks_text', $query, { limit: toInteger($limit) })
             YIELD node, score
             WHERE ($scope IS NULL OR node.sourceKind IN $scope)
               AND ($project IS NULL OR node.projectPath = $project)
               AND ($since IS NULL OR node.timestamp >= $since)
               AND ($until IS NULL OR node.timestamp <= $until)
               AND ($excl IS NULL OR node.sessionId IS NULL OR NOT node.sessionId IN $excl)
             RETURN node.id AS id,
                    score,
                    node.sourceKind AS source,
                    node.sessionId AS sessionId,
                    node.projectPath AS project,
                    node.timestamp AS timestamp,
                    node.valueScore AS valueScore,
                    node.role AS role
             ORDER BY score DESC`,
            {
              query: ftQuery,
              limit: poolSize,
              scope: args.scope ?? null,
              project: projectFilter,
              since: args.since ?? null,
              until: args.until ?? null,
              excl: args.excludeSessions ?? null,
            },
          );
          const rawScores = ftRes.records.map((r) => Number(r.get('score')));
          const saturated = saturateBm25(rawScores);
          ftRes.records.forEach((r, i) => {
            const id = r.get('id') as string;
            if (ftMap.has(id)) return;
            ftMap.set(id, {
              score: saturated[i] ?? 0,
              rank: i + 1,
              meta: {
                id,
                source: r.get('source'),
                sessionId: r.get('sessionId'),
                project: r.get('project'),
                timestamp: r.get('timestamp'),
                valueScore: r.get('valueScore') === null ? null : Number(r.get('valueScore')),
                role: r.get('role'),
              },
            });
          });
        } catch (e) {
          // fulltext index may not exist yet — fall back to vector only
          console.error('[search] fulltext skipped:', e instanceof Error ? e.message : String(e));
        }
      }

      // Pool = UNIÃO das duas listas. Antes o loop iterava só `vecRes`, então
      // um hit de BM25 fora do top-N vetorial era calculado, saturado, posto no
      // ftMap e descartado em silêncio: na prática o "hybrid" era recall
      // vetorial com rerank lexical, e casar o token literal nunca recrutava
      // ninguém. Medido em `EDC-3197`: dos 500 hits de fulltext, só 155 caíam
      // no pool vetorial.
      // Terceira fonte de RECALL, não de reordenação. Boost não resgata o que
      // nunca entrou no pool: as sessões antigas e magras de uma task não
      // apareciam entre os 500 candidatos vetoriais, então empurrá-las chegava
      // tarde. Aqui elas entram por construção, e o acerto para de depender de
      // o cosseno ter sorte.
      const taskMap = new Map<string, { rank: number; meta: CandidateMeta }>();
      if (queryTaskSessions.size > 0) {
        const tr = await s.run(
          `MATCH (c:Chunk) WHERE c.sessionId IN $sids
             AND ($scope IS NULL OR c.sourceKind IN $scope)
             AND ($project IS NULL OR c.projectPath = $project)
             AND ($since IS NULL OR c.timestamp >= $since)
             AND ($until IS NULL OR c.timestamp <= $until)
             AND ($excl IS NULL OR c.sessionId IS NULL OR NOT c.sessionId IN $excl)
           RETURN c.id AS id, c.sourceKind AS source, c.sessionId AS sessionId,
                  c.projectPath AS project, c.timestamp AS timestamp,
                  c.valueScore AS valueScore, c.role AS role
           ORDER BY coalesce(c.valueScore, 0.5) DESC
           LIMIT toInteger($limit)`,
          {
            sids: [...queryTaskSessions],
            limit: TASK_RECALL_LIMIT,
            scope: args.scope ?? null,
            project: projectFilter,
            since: args.since ?? null,
            until: args.until ?? null,
            excl: args.excludeSessions ?? null,
          },
        );
        tr.records.forEach((r, i) => {
          const id = r.get('id') as string;
          if (taskMap.has(id)) return;
          taskMap.set(id, {
            rank: i + 1,
            meta: {
              id,
              source: r.get('source'),
              sessionId: r.get('sessionId'),
              project: r.get('project'),
              timestamp: r.get('timestamp'),
              valueScore: r.get('valueScore') === null ? null : Number(r.get('valueScore')),
              role: r.get('role'),
            },
          });
        });
      }

      const seen = new Set<string>();
      const out: PreCandidate[] = [];
      vecRes.records.forEach((rec, i) => {
        const id = rec.get('id') as string;
        if (seen.has(id)) return;
        seen.add(id);
        const ft = ftMap.get(id);
        out.push({
          id,
          vec_score: Number(rec.get('vec_score')),
          bm25_score: ft?.score ?? null,
          vec_rank: i + 1,
          bm25_rank: ft?.rank ?? null,
          task_rank: taskMap.get(id)?.rank ?? null,
          meta: {
            id,
            source: rec.get('source'),
            sessionId: rec.get('sessionId'),
            project: rec.get('project'),
            timestamp: rec.get('timestamp'),
            valueScore: rec.get('valueScore') === null ? null : Number(rec.get('valueScore')),
            role: rec.get('role'),
          },
        });
      });
      for (const [id, ft] of ftMap) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          vec_score: null,
          bm25_score: ft.score,
          vec_rank: null,
          bm25_rank: ft.rank,
          task_rank: taskMap.get(id)?.rank ?? null,
          meta: ft.meta,
        });
      }
      for (const [id, t] of taskMap) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          vec_score: null,
          bm25_score: null,
          vec_rank: null,
          bm25_rank: null,
          task_rank: t.rank,
          meta: t.meta,
        });
      }
      return out;
    };

    let pool = await stageA(args.fast ? FAST_RECALL_POOL : RECALL_POOL);
    // Post-filter apertado (scope/projectStrict/since) devolvia menos que k
    // mesmo com material de sobra no grafo: aprofunda uma vez.
    if (!args.fast && pool.length < k && RECALL_POOL < RECALL_POOL_MAX) {
      pool = await stageA(RECALL_POOL_MAX);
    }
    if (pool.length === 0) return empty;

    // fundo da query: mediana de vec do pool de RECALL (não do top-k), pra o
    // caller ver o quão alto o piso de similaridade está naquela busca. É a
    // estimativa de ruído que a confidence consome (ver scoreCalibration.ts).
    // Só quem veio da lista vetorial entra: é o piso de SIMILARIDADE da query,
    // e candidato recrutado só pelo BM25 ainda não tem cosseno neste estágio.
    const poolVec = pool
      .map((c) => c.vec_score)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const poolVecMedian = poolVec[Math.floor(poolVec.length / 2)] ?? null;
    const calibration = getScoreCalibration();

    // (2) Re-ranking com os boosts aprendidos ANTES do corte. Aqui é que
    // perProject/perSourceKind/recência ganham poder de trazer pro top-k um
    // chunk que o cosseno puro tinha deixado de fora.
    // Ordenação de corte: RRF cru quando híbrido (monótono, a normalização
    // vem depois, sobre os finalistas), cosseno puro quando não.
    const cutScore = (c: PreCandidate): number =>
      hybrid ? rrfScore(c) : (c.vec_score ?? 0);
    // Aplicado JÁ no corte: a sessão antiga e magra da task muitas vezes nem
    // chegava aos finalistas, então boostar só no MMR chegaria tarde.
    const taskMult = (m: CandidateMeta): number =>
      m.sessionId && queryTaskSessions.has(m.sessionId) ? QUERY_TASK_BOOST : 1;
    const finalists = [...pool]
      .sort(
        (a, b) =>
          cutScore(b) * boostOf(b.meta) * taskMult(b.meta) -
          cutScore(a) * boostOf(a.meta) * taskMult(a.meta),
      )
      .slice(0, mmrPool);

    // (3) Estágio B — embedding e texto só dos finalistas.
    const embRes = await s.run(
      `UNWIND $ids AS id
       MATCH (c:Chunk { id: id })
       RETURN c.id AS id, c.text AS snippet, c.embedding AS embedding`,
      { ids: finalists.map((f) => f.id) },
    );
    const embMap = new Map<string, { snippet: string; embedding: number[] }>();
    for (const rec of embRes.records) {
      embMap.set(rec.get('id') as string, {
        snippet: rec.get('snippet') as string,
        embedding: rec.get('embedding') as number[],
      });
    }
    const candidates: Candidate[] = finalists.flatMap((f) => {
      const e = embMap.get(f.id);
      if (!e) return [];
      return [
        {
          ...f,
          snippet: e.snippet,
          embedding: e.embedding,
          // Recrutado só pelo BM25 não passou pelo índice vetorial, então o
          // cosseno sai aqui. Sem isso ele ficaria sem `confidence`, que é
          // justamente o número que decide se o hit pode ser citado.
          vec_score: f.vec_score ?? cosine(e.embedding, qvec),
        },
      ];
    });
    if (candidates.length === 0) return empty;

    // (4) MMR (ranking usa boosts aprendidos; scores reportados ficam crus).
    // A relevância é normalizada em [0,1] sobre os finalistas pra ficar na
    // mesma escala do termo de diversidade (cosseno) dentro do MMR.
    const relRaw = candidates.map((c) => (hybrid ? rrfScore(c) : c.vec_score));
    // Normaliza SEMPRE, não só no híbrido. Com cosseno cru o spread dos
    // finalistas é ~0.04, e os boosts multiplicam numa faixa 0.7-1.25
    // (recência, projeto, demote): o boost atropelava a similaridade. Medido no
    // bench:recall em 2026-09-29, o hit certo com o MAIOR vec (0.925) caía pro
    // 8º lugar. Normalizando: r@8 81.1% -> 89.2%, MRR 0.626 -> 0.718, ruído
    // 18.7% -> 11.1%.
    const relNorm = normalizeRelevance(relRaw);
    const relMap = new Map<string, number>();
    candidates.forEach((c, i) => relMap.set(c.id, relNorm[i] ?? 0));

    const kin =
      !args.fast && tuning.entityBoost > 1
        ? await kinSessions(s, args.callerSessionId !== undefined ? args.callerSessionId : resolveCallerSession().sessionId)
        : new Set<string>();

    const picked = mmrSelect(
      candidates,
      lambda,
      k,
      lambda >= FOCUS_DIVERSITY ? 0 : MAX_HITS_PER_SESSION,
      // medido: com teto nelas, narração no bench de task foi de 8.3% pra 24.2%
      queryTaskSessions,
      (c) => relMap.get(c.id) ?? 0,
      (c) =>
        boostOf(c.meta) *
        valueMult(c, tuning.valueDemote) *
        (c.meta.sessionId && kin.has(c.meta.sessionId) ? tuning.entityBoost : 1) *
        (c.meta.sessionId && queryTaskSessions.has(c.meta.sessionId) ? QUERY_TASK_BOOST : 1),
    );

    // (5) Context expansion + parent lookup (só dos k finais)
    const ids = picked.map((p) => p.id);
    const ctxRes = await s.run(
      `UNWIND $ids AS id
       MATCH (c:Chunk { id: id })
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(c)
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(sib:Chunk)
       WHERE sib.id <> c.id AND abs(sib.ordinal - c.ordinal) <= 1
       WITH c, parent, collect(DISTINCT sib.text)[..2] AS neighbors
       OPTIONAL MATCH (:Session { id: c.sessionId })-[:ON_TASK]->(t:Task)
       WITH c, parent, neighbors, collect(DISTINCT t.key)[..2] AS tasks
       RETURN c.id AS id,
              tasks,
              labels(parent)[0] AS parentLabel,
              coalesce(parent.uuid, parent.path, parent.id) AS parentKey,
              neighbors`,
      { ids },
    );
    const ctxMap = new Map<string, { parentLabel: string; parentKey: string; neighbors: string[]; tasks: string[] }>();
    for (const rec of ctxRes.records) {
      ctxMap.set(rec.get('id') as string, {
        parentLabel: rec.get('parentLabel'),
        parentKey: rec.get('parentKey'),
        neighbors: (rec.get('neighbors') as string[]) ?? [],
        tasks: (rec.get('tasks') as string[]) ?? [],
      });
    }

    const hits = picked.map((c) => {
      const ctx = ctxMap.get(c.id);
      return {
        id: c.id,
        // score RAW (sem boost) serve pra ORDENAÇÃO e comparação dentro da
        // mesma query. Pra decidir se cita, use `confidence`: o score cru não
        // é comparável entre queries (ver src/mcp/scoreCalibration.ts).
        score: relMap.get(c.id) ?? 0,
        confidence: confidenceFromVec(c.vec_score, calibration, poolVecMedian),
        vec_score: c.vec_score,
        bm25_score: c.bm25_score,
        value_score: c.meta.valueScore,
        source: c.meta.source,
        sessionId: c.meta.sessionId,
        project: c.meta.project,
        timestamp: c.meta.timestamp,
        snippet: c.snippet,
        neighbors: ctx?.neighbors ?? [],
        parentLabel: ctx?.parentLabel ?? null,
        parentKey: ctx?.parentKey ?? null,
        tasks: ctx?.tasks ?? [],
      };
    });

    return {
      hits,
      poolVecMedian,
      // pool de RECALL, não de finalistas: é o denominador que dá sentido ao
      // poolVecMedian reportado.
      poolSize: pool.length,
      calibrated: calibration?.ready === true,
    };
  });
}

/**
 * Texto que o modelo lê. `brief` (default): 1 linha por hit, ~40 tokens, com o
 * id curto que `expand_hits` aceita. `full`: snippet inteiro + vizinhos
 * cortados, o formato antigo, pra quando o modelo já sabe que quer ler tudo.
 */
export function formatSearchResult(r: SearchResult, detail: 'brief' | 'full'): string {
  const { hits, poolVecMedian, poolSize, calibrated } = r;
  if (hits.length === 0) return 'sem resultado na memória indexada.';
  if (detail === 'brief') {
    const header =
      `pool=${poolSize} vec_med=${poolVecMedian?.toFixed(3) ?? '-'}` +
      (calibrated ? ' | cite pela conf' : ' | conf n/a (calibrando)') +
      ' | expand_hits(ids) pra texto completo';
    const lines = hits.map((h, i) => {
      const where = h.source === 'plan' ? projectName(h.parentKey) : projectName(h.project);
      const tasks = h.tasks.length > 0 ? ` ${h.tasks.join(',')}` : '';
      return `[${i + 1}] conf=${fmtConf(h.confidence)} id=${shortId(h.id)} ${h.source} ${where} ${day(h.timestamp)}${tasks} | ${gistOf(h.snippet)}`;
    });
    return [header, ...lines].join('\n');
  }
  const header =
    `pool: ${poolSize} candidatos, vec mediano=${poolVecMedian?.toFixed(3) ?? '-'}` +
    (calibrated
      ? ' | confidence = percentil histórico do vec (use isto pra decidir se cita)'
      : ' | confidence indisponível (calibração ainda coletando amostras)');
  const body = hits
    .map((h, i) => {
      const bm25 = h.bm25_score !== null ? ` bm25=${h.bm25_score.toFixed(3)}` : '';
      const ctx =
        h.neighbors.length > 0
          ? `\n  context: ${h.neighbors.map((n) => n.slice(0, 100)).join(' | ')}`
          : '';
      return `[${i + 1}] conf=${fmtConf(h.confidence)} id=${shortId(h.id)} score=${h.score.toFixed(3)} vec=${h.vec_score.toFixed(3)}${bm25} source=${h.source} project=${h.project ?? '-'} sessionId=${h.sessionId ?? '-'} tasks=${h.tasks.join(',') || '-'} parent=${h.parentLabel}/${h.parentKey}\n${h.snippet}${ctx}`;
    })
    .join('\n\n');
  return `${header}\n\n${body}`;
}

export function registerSearchMemoryTool(server: McpServer): void {
  server.registerTool(
    'search_memory',
    {
      description:
        'Hybrid semantic + fulltext search across your Claude Code history (conversations, tool outputs, plans, task memory, todos). Returns top-k chunks diversified via MMR (avoids 5 hits from same session). **Use BEFORE answering questions about past decisions, approaches, or context.** Pass `diversity` (0..1, default 0.7) to balance relevance vs variety. BM25 only kicks in for genuinely literal tokens (ABC-1234, file paths, camelCase identifiers, acronyms); plain prose stays pure vector. **Read `confidence` (0..1), not `score`, to decide whether to cite a hit**: confidence is the hit\'s vec_score percentile against the historical distribution, so it is comparable across queries, while `score` is only meaningful for ordering within one query. `confidence` is null until the local calibration has enough samples. `project` is a soft ranking boost (cross-repo hits stay visible).',
      inputSchema,
      // read-only: sem isso o plan mode do Claude Code pede permissão a cada chamada
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const t0 = Date.now();
        const { hits, poolVecMedian, poolSize, calibrated } = await searchMemory(args);
        const caller = resolveCallerSession();
        void logQuery({
          v: 1,
          ts: new Date().toISOString(),
          tool: 'search_memory',
          sessionId: caller.sessionId,
          callerProject: caller.project,
          query: args.query,
          k: args.k ?? null,
          scope: args.scope ?? null,
          project: args.project ?? null,
          projectStrict: args.projectStrict ?? null,
          diversity: args.diversity ?? null,
          hybridUsed: (args.hybrid ?? true) && hasLiteralTokens(args.query),
          nResults: hits.length,
          topScore: hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null,
          scores: hits.map((h) => h.score),
          latencyMs: Date.now() - t0,
          // piso da query: o self-tune calibra a CDF de margens a partir disto
          poolVecMedian,
          hits: hits.map((h) => ({
            id: h.id,
            sessionId: h.sessionId,
            source: h.source,
            project: h.project,
            vecScore: h.vec_score,
            bm25Score: h.bm25_score,
          })),
        });
        return withStructured(
          { content: [{ type: 'text', text: formatSearchResult({ hits, poolVecMedian, poolSize, calibrated }, args.detail ?? 'brief') }] },
          { hits, poolVecMedian, poolSize, calibrated },
        );
      } catch (e) {
        const err = toToolError(e);
        return withStructured(
          { isError: true, content: [{ type: 'text', text: `search_memory ${err.errorType}: ${err.message}` }] },
          err,
        );
      }
    },
  );
}
