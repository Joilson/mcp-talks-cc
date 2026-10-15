import { readFileSync, statSync } from 'node:fs';
import { learningPaths } from '../learning/paths.ts';
import { TUNING_BOUNDS, type Tuning } from '../learning/types.ts';

// Defaults de retrieval — única fonte (antes duplicados em searchMemory.ts).
// lambda e peso hybrid NÃO são tunados pelo loop (decisão: tuner coadjuvante);
// o self-tune apenas comenta sobre eles no rationale.
export const LAMBDA_DEFAULT = 0.7;

/**
 * Constante do Reciprocal Rank Fusion: `1/(RRF_K + rank)` por lista.
 *
 * 60 é o valor do paper original (Cormack et al., 2009) e o default de
 * praticamente toda implementação. Amortece a diferença entre os primeiros
 * ranks, então um hit em 1º numa lista não atropela sozinho um hit que está em
 * 3º nas duas.
 *
 * Substituiu o HYBRID_VEC_WEIGHT=0.7 da fusão por soma ponderada, que exigia
 * que cosseno e BM25 saturado fossem comensuráveis. Não eram: casar o token
 * literal virava penalidade no score. Ver rrfScore() em tools/searchMemory.ts.
 */
export const RRF_K = 60;

/**
 * Abaixo deste P(entrega) o chunk é candidato a ser rebaixado na busca.
 *
 * Escolhido a partir da população, não de chute. Medido no conjunto retido em
 * 22/09/2026 (5.091 exemplos de sessões que o treino nunca viu):
 *
 *   limiar 0,20 -> rebaixa  7% dos chunks, acerta 92,4%
 *   limiar 0,30 -> rebaixa 19% dos chunks, acerta 87,5%
 *   limiar 0,50 -> rebaixa 58% dos chunks, acerta 81,4%
 *
 * 0,30 é o ponto onde a fatia deixa de ser simbólica sem que o erro passe de um
 * oitavo, e o veto lexical abaixo cobre parte do que sobra. Mudar este número
 * NÃO exige reclassificar: o que está gravado no Chunk é a probabilidade.
 */
export const VALUE_DEMOTE_THRESHOLD = 0.3;

/**
 * Peso para chunk de sessão cuja task a query NOMEIA explicitamente.
 *
 * Alto porque a evidência é literal, não estatística: o usuário escreveu o
 * código da task e existe uma aresta ON_TASK ligando aquela sessão a ele. Não
 * é tunável pelo loop justamente por isso — não há o que aprender sobre uma
 * correspondência exata.
 */
export const QUERY_TASK_BOOST = 1.6;

/**
 * Peso para chunk de sessão de task IRMÃ (mesmo epic) da task nomeada na query
 * ou da sessão que está buscando. É a ponte entre repos: a irmã costuma ser o
 * outro lado (back/front) da mesma feature.
 *
 * Bem abaixo do QUERY_TASK_BOOST de propósito: o vínculo é inferido (linha
 * [task], regex ou Haiku), não literal. E as irmãs NÃO furam o teto por sessão
 * do MMR nem entram no task recall, senão um epic com 10 filhas lotaria o top-k.
 */
export const EPIC_SIBLING_BOOST = 1.2;

/** Teto de chunks recrutados pela task nomeada na query. */
export const TASK_RECALL_LIMIT = 120;

// Retrieval em dois estágios. O bge-m3 devolve cosseno entre 0.87 e 0.91 pra
// praticamente qualquer par, então o ranking por similaridade pura é quase
// arbitrário nessa faixa: medido em 2026-08-03, 2000 candidatos couberam em
// 0.043 de spread e o chunk correto de uma query dirigida estava no rank 149.
// Um pool de 40 (o `k * 5` antigo) é loteria, e boost de ranking não recupera
// o que nunca entrou no pool.
//
// Estágio A (RECALL_POOL): pool largo SEM embedding — só metadata, barato de
// trafegar. É onde os boosts aprendidos passam a agir de fato.
// Estágio B (MMR_POOL_MULT): busca embedding só dos finalistas, porque 1024
// doubles por candidato é o que dominava o p90 de latência.
export const RECALL_POOL = 500;
/** Retry quando scope/project/since derrubam o pool abaixo de k (post-filter). */
export const RECALL_POOL_MAX = 2000;
/** Pool do caminho de push (hook por prompt): latência > recall fundo. */
export const FAST_RECALL_POOL = 200;
export const MMR_POOL_MULT = 5;
export const MMR_POOL_MAX = 60;

// Decay de recência: multiplica SÓ o termo de relevância do MMR (ranking),
// nunca o score reportado. Sem isso um chunk de janeiro empata com o de ontem.
// Floor alto de propósito: memória velha ainda é o valor do produto.
export const RECENCY_HALFLIFE_DAYS = 120;
export const RECENCY_FLOOR = 0.75;

/**
 * Repos cujo assunto é o próprio sistema de memória. Conversa sobre o MCP
 * (tuning, calibração, primer) é vocabulário parecido com qualquer pergunta
 * sobre "memória/decisão/regra" e voltava no topo de busca feita de OUTRO repo:
 * medido em 2026-09-29, a busca "objetivo do mcp-talks-cc..." trouxe o aviso de
 * tuning repassado ao user como hit nº 1. Match por nome da pasta do projeto.
 * Não se aplica quando quem busca está no próprio repo.
 */
/**
 * Peso de chunk destilado (nó Decision, src/distill/). Fixo, não tunado: a
 * regra é curta e autocontida por construção, e o grader ainda não tem sinal
 * limpo pra aprender isso. Revisar pelo bench:recall, não pelo self-tune.
 */
export const DECISION_BOOST = Number(process.env.MCP_TALKS_DECISION_BOOST ?? 1.25);

/**
 * Teto de hits da MESMA sessão no top-k. O MMR diversifica por embedding, não
 * por sessão: medido em 2026-09-29, "fila de espera contrato espelho" devolveu
 * 8 de 8 hits da EDC-3291. Pra recall o que importa é cobrir sessões distintas,
 * e o resto da sessão está a um expand_hits/get_session_transcript de distância.
 *
 * Medido no bench:recall (37 casos, sem decisions), teto 0 → 2 → 1:
 *   r@8 73.0% → 75.7% → 81.1% | MRR 0.612 → 0.617 → 0.633 | tokens 463 → 435 → 412
 * Refeito com relevância normalizada (mesmo dia): r@8 86.5% → 89.2% → 89.2% |
 * MRR 0.699 → 0.706 → 0.716. Empate em recall, 1 ganha em MRR e tokens.
 * Desligado quando o caller pede foco (diversity >= FOCUS_DIVERSITY).
 * 0 = sem teto. Override por env só pro bench comparar valores.
 */
export const MAX_HITS_PER_SESSION = Number(process.env.MCP_TALKS_MAX_PER_SESSION ?? 1);
export const FOCUS_DIVERSITY = 0.9;

export const META_PROJECTS = ['mcp-talks-cc'];
export const META_PROJECT_DEMOTE = 0.5;

export const DEFAULT_TUNING: Tuning = {
  v: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  projectBoost: 1.15,
  perSourceKind: {},
  perProject: {},
  // Neutro por default: a demoção só liga quando alguém escrever o valor em
  // tuning.json. Isso é o kill switch — voltar pra 1 desliga tudo em <=60s,
  // sem deploy e sem reclassificar, porque os rótulos ficam no grafo.
  valueDemote: 1,
  entityBoost: 1,
  k: 8,
};

const RECHECK_MS = 60_000;

let _tuning: Tuning = DEFAULT_TUNING;
/** Só pro bench avaliar um candidate em processo, sem promover. null = normal. */
let _override: Tuning | null = null;
export function setTuningOverride(t: Tuning | null): void {
  _override = t;
}
let _lastCheck = 0;
let _lastMtimeMs = -1;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clampRecord(
  raw: unknown,
  bounds: { min: number; max: number },
): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[key] = clamp(val, bounds.min, bounds.max);
    }
  }
  return out;
}

/** Sanitiza campo a campo: arquivo meio-escrito não envenena o resto. */
export function sanitizeTuning(raw: unknown): Tuning {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_TUNING;
  const r = raw as Record<string, unknown>;
  return {
    v: 1,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : DEFAULT_TUNING.updatedAt,
    projectBoost:
      typeof r.projectBoost === 'number' && Number.isFinite(r.projectBoost)
        ? clamp(r.projectBoost, TUNING_BOUNDS.projectBoost.min, TUNING_BOUNDS.projectBoost.max)
        : DEFAULT_TUNING.projectBoost,
    perSourceKind: clampRecord(r.perSourceKind, TUNING_BOUNDS.perSourceKind),
    perProject: clampRecord(r.perProject, TUNING_BOUNDS.perProject),
    valueDemote:
      typeof r.valueDemote === 'number' && Number.isFinite(r.valueDemote)
        ? clamp(r.valueDemote, TUNING_BOUNDS.valueDemote.min, TUNING_BOUNDS.valueDemote.max)
        : DEFAULT_TUNING.valueDemote,
    entityBoost:
      typeof r.entityBoost === 'number' && Number.isFinite(r.entityBoost)
        ? clamp(r.entityBoost, TUNING_BOUNDS.entityBoost.min, TUNING_BOUNDS.entityBoost.max)
        : DEFAULT_TUNING.entityBoost,
    k:
      typeof r.k === 'number' && Number.isInteger(r.k)
        ? clamp(r.k, TUNING_BOUNDS.k.min, TUNING_BOUNDS.k.max)
        : DEFAULT_TUNING.k,
  };
}

/**
 * Igualdade semântica de tuning: ignora `updatedAt` e ordem de chaves.
 * Serve pro self-tune saber se o candidate já é o tuning aplicado — sem isso
 * o primer cobra "TUNING PENDENTE" pra sempre por uma proposta que não muda nada.
 */
export function tuningEquals(a: Tuning, b: Tuning): boolean {
  const canon = (t: Tuning): string => {
    const sorted = (r: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(r).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    return JSON.stringify({
      v: t.v,
      projectBoost: t.projectBoost,
      valueDemote: t.valueDemote,
      entityBoost: t.entityBoost,
      k: t.k,
      perSourceKind: sorted(t.perSourceKind),
      perProject: sorted(t.perProject),
    });
  };
  return canon(a) === canon(b);
}

/**
 * Tuning aceito (tuning.json), cacheado em module scope.
 * Re-stat no máx 1x/min; entre checks, zero syscall.
 * Ausente/corrupto → último valor bom ou defaults (== comportamento sem loop).
 */
export function getTuning(): Tuning {
  if (_override) return _override;
  const now = Date.now();
  if (now - _lastCheck < RECHECK_MS) return _tuning;
  _lastCheck = now;
  try {
    const st = statSync(learningPaths.tuning);
    if (st.mtimeMs === _lastMtimeMs) return _tuning;
    _lastMtimeMs = st.mtimeMs;
    _tuning = sanitizeTuning(JSON.parse(readFileSync(learningPaths.tuning, 'utf8')));
  } catch {
    _lastMtimeMs = -1;
    _tuning = DEFAULT_TUNING;
  }
  return _tuning;
}

/** Só p/ testes: zera o cache do módulo. */
export function resetTuningCache(): void {
  _tuning = DEFAULT_TUNING;
  _lastCheck = 0;
  _lastMtimeMs = -1;
}
