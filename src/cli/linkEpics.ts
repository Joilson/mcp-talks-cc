import { withSession, closeDriver } from '../neo4j/driver.ts';
import {
  aggregateParents,
  bestPerTask,
  buildLlmInput,
  collectUnits,
  llmLinks,
  markLlmDone,
  needsLlm,
  promptLinks,
  regexLinks,
  worthLlm,
  writeLinks,
} from '../epics/link.ts';
import type { Link } from '../epics/link.ts';
import { writeEpicPrimers } from '../epics/primer.ts';

/**
 * Vínculo task -> epic a partir da memória (ver src/epics/link.ts).
 *
 *   npm run link:epics -- [--apply] [--no-llm] [--limit=10] [--unit=<id>] [--verbose]
 *
 * Sem --apply é dry-run e NUNCA chama o Haiku: imprime candidatos, vínculos
 * determinísticos e quantas unidades iriam pro Haiku, com estimativa de token.
 * --no-llm: só linha [task] + regex (o que o hook roda sem opt-in).
 */

const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const NO_LLM = process.argv.includes('--no-llm');
const VERBOSE = process.argv.includes('--verbose');
const LIMIT = Number(arg('limit') ?? 10);
const ONLY = arg('unit');

const fmt = (l: Link): string =>
  `${l.task} -> ${l.parent}${l.parentTitle ? ` (${l.parentTitle})` : ''} [${l.source}/${l.confidence}]${l.relates.length ? ` relates ${l.relates.join(',')}` : ''}`;

await withSession(async (s) => {
  const all = await collectUnits(s);
  const units = ONLY ? all.filter((u) => u.id === ONLY) : all;
  const byKind = (k: string): number => units.filter((u) => u.kind === k).length;
  console.error(`[link:epics] ${units.length} unidades candidatas (session ${byKind('session')}, plan ${byKind('plan')}, taskdoc ${byKind('taskdoc')})${APPLY ? '' : ' (dry-run)'}`);

  // determinístico: sempre, sobre tudo (idempotente)
  const det: Link[] = [];
  for (const u of units) {
    const p = promptLinks(u);
    det.push(...(p.length > 0 ? p : regexLinks(u)));
  }
  const detBest = bestPerTask(det);
  console.error(`[link:epics] determinístico: ${det.filter((l) => l.source === 'prompt').length} linha [task], ${det.filter((l) => l.source === 'regex').length} regex -> ${detBest.length} tasks`);
  if (VERBOSE) for (const l of detBest) console.log(`  ${fmt(l)}`);
  if (APPLY) await writeLinks(s, detBest);

  // Haiku: só unidade com sinal forte e ainda não lida
  // mais recente primeiro: é o que está em uso, e o backlog anda pelo limite
  const queue = units.filter((u) => needsLlm(u) && worthLlm(u)).sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  const skipped = units.filter((u) => needsLlm(u) && !worthLlm(u));
  const est = queue.reduce((a, u) => a + buildLlmInput(u).length, 0);
  console.error(`[link:epics] fila Haiku: ${queue.length} unidades (~${Math.round(est / 3.5 / 1000)}k tokens de input), ${skipped.length} sem sinal`);

  let llmTotal = 0;
  let failed = 0;
  if (APPLY && !NO_LLM) {
    for (const u of queue.slice(0, LIMIT)) {
      const input = buildLlmInput(u);
      if (!input) {
        await markLlmDone(s, u);
        continue;
      }
      const t0 = Date.now();
      try {
        const links = await llmLinks(u, input);
        const n = await writeLinks(s, bestPerTask(links));
        llmTotal += n;
        await markLlmDone(s, u);
        console.error(`[link:epics] ${u.kind} ${u.id.slice(-40)} +${n} (${links.length} extraídos, ${Date.now() - t0}ms)`);
        if (VERBOSE) for (const l of links) console.log(`  ${fmt(l)}`);
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[link:epics] ${u.kind} ${u.id.slice(-40)} falhou: ${msg}`);
        await markLlmDone(s, u, msg.slice(0, 200));
      }
    }
  }
  // unidade sem sinal também é marcada: senão volta pra fila a cada run
  if (APPLY && !NO_LLM) for (const u of skipped) await markLlmDone(s, u);

  if (APPLY) {
    const a = await aggregateParents(s);
    console.error(`[link:epics] pais: ${a.parents} (${a.buckets} balde, ${a.crossRepo} cruzam repos)`);
    console.error(`[link:epics] primer por epic: ${await writeEpicPrimers(s)} tasks`);
  }
  console.error(`[link:epics] done: +${llmTotal} via Haiku, ${failed} falhas`);
});
await closeDriver();
