import { existsSync, readFileSync } from 'node:fs';
import { searchMemory, formatSearchResult } from '../mcp/tools/searchMemory.ts';
import { learningPaths } from './paths.ts';

/**
 * Núcleo do bench de recall com gabarito. Usado pelo CLI (src/cli/benchRecall.ts)
 * e pelo self-tune, que só deixa um candidate virar proposta se ele não piorar
 * este número.
 *
 * O gabarito mora em ~/.cache/mcp-talks-cc/recall-eval.jsonl, NÃO no repo: é
 * feito das suas queries e sessões reais (nome de task, trecho de conversa de
 * trabalho), e o repo é compartilhado. Gera candidatos com
 * `npm run eval:candidates` e marca à mão (ou com um agente + revisão).
 */

export interface EvalCase {
  id: string;
  query: string;
  ts: string;
  callerSession: string | null;
  project: string | null;
  kind: 'decision' | 'tech' | 'task' | 'midconv' | 'none';
  expect: { sessionIds?: string[]; planPaths?: string[] };
  grade?: 'strong' | 'partial';
}

export interface KindStats {
  n: number;
  r3: number;
  r8: number;
  rr: number;
}

export interface BenchResult {
  nCases: number;
  n: number;
  none: number;
  recallAt3: number;
  recallAtK: number;
  mrr: number;
  noise: number;
  tokensBrief: number;
  tokensFull: number;
  latencyMs: number;
  perKind: Record<string, KindStats>;
  gate: { strong: number | null; floor: number | null };
  calibrated: boolean;
  misses: string[];
  perCase: Array<{ id: string; rank: number | null }>;
  nHits: number;
}

export function readEvalCases(path: string = learningPaths.recallEval): EvalCase[] | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalCase);
}

type Kind = 'conversation' | 'plan' | 'task_memory' | 'decision';

export async function runRecallBench(
  cases: EvalCase[],
  opts: { k?: number; scope?: Kind[] } = {},
): Promise<BenchResult> {
  const K = opts.k ?? 8;
  const perKind = new Map<string, KindStats>();
  const scored: Array<{ conf: number | null; relevant: boolean }> = [];
  const perCase: BenchResult['perCase'] = [];
  let noise = 0;
  let totalHits = 0;
  let briefChars = 0;
  let fullChars = 0;
  let latSum = 0;
  let noneCases = 0;
  const misses: string[] = [];

  for (const c of cases) {
    const sessions = new Set(c.expect.sessionIds ?? []);
    const plans = new Set(c.expect.planPaths ?? []);
    const t0 = Date.now();
    const r = await searchMemory({
      query: c.query,
      k: K,
      until: c.ts,
      excludeSessions: c.callerSession ? [c.callerSession] : [],
      callerSessionId: c.callerSession,
      ...(c.project ? { project: c.project } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    latSum += Date.now() - t0;
    briefChars += formatSearchResult(r, 'brief').length;
    fullChars += formatSearchResult(r, 'full').length;

    const rel = r.hits.map(
      (h) =>
        (h.sessionId !== null && sessions.has(h.sessionId)) ||
        (h.source === 'plan' && h.parentKey !== null && plans.has(h.parentKey)),
    );
    r.hits.forEach((h, i) => {
      scored.push({ conf: h.confidence, relevant: rel[i]! });
      totalHits++;
      if (r.poolVecMedian !== null && h.vec_score <= r.poolVecMedian) noise++;
    });

    if (sessions.size === 0 && plans.size === 0) {
      noneCases++;
      continue;
    }
    const first = rel.indexOf(true);
    perCase.push({ id: c.id, rank: first >= 0 ? first + 1 : null });
    const s = perKind.get(c.kind) ?? { n: 0, r3: 0, r8: 0, rr: 0 };
    s.n++;
    if (first >= 0 && first < 3) s.r3++;
    if (first >= 0) {
      s.r8++;
      s.rr += 1 / (first + 1);
    } else misses.push(c.id);
    perKind.set(c.kind, s);
  }

  /** Menor confidence cuja precision acumulada (hits com conf >= t) atinge `target`. */
  const gateAt = (target: number, minN = 5): number | null => {
    const withConf = scored.filter((s) => s.conf !== null).sort((a, b) => b.conf! - a.conf!);
    let rel = 0;
    let best: number | null = null;
    withConf.forEach((s, i) => {
      if (s.relevant) rel++;
      if (i + 1 >= minN && rel / (i + 1) >= target) best = s.conf!;
    });
    return best;
  };

  const all = [...perKind.values()].reduce(
    (acc, v) => ({ n: acc.n + v.n, r3: acc.r3 + v.r3, r8: acc.r8 + v.r8, rr: acc.rr + v.rr }),
    { n: 0, r3: 0, r8: 0, rr: 0 },
  );
  const nc = Math.max(1, cases.length);
  return {
    nCases: cases.length,
    n: all.n,
    none: noneCases,
    recallAt3: all.n ? all.r3 / all.n : 0,
    recallAtK: all.n ? all.r8 / all.n : 0,
    mrr: all.n ? all.rr / all.n : 0,
    noise: totalHits ? noise / totalHits : 0,
    tokensBrief: Math.round(briefChars / 4 / nc),
    tokensFull: Math.round(fullChars / 4 / nc),
    latencyMs: Math.round(latSum / nc),
    perKind: Object.fromEntries(perKind),
    gate: { strong: gateAt(0.8), floor: gateAt(0.5) },
    calibrated: scored.some((s) => s.conf !== null),
    misses,
    perCase,
    nHits: scored.length,
  };
}

/**
 * Candidate não pode perder nenhum caso no recall, e o MRR só pode cair até
 * MRR_SLACK (reordenação dentro do top-k). Folga no recall deixaria o tuner
 * degradar aos poucos: cada accept perderia "só 1 caso".
 */
const MRR_SLACK = 0.01;
export function benchNotWorse(candidate: BenchResult, current: BenchResult): boolean {
  return candidate.recallAtK >= current.recallAtK - 1e-9 && candidate.mrr >= current.mrr - MRR_SLACK;
}
