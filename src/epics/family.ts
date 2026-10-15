import type { Session } from 'neo4j-driver';

/**
 * Família de uma task pelo epic: o pai e as irmãs (outras filhas do mesmo pai).
 *
 * É a ponte entre repos: a task do back e a do front são irmãs. Regras que
 * todo consumidor respeita:
 *   - vínculo `low` não conta (piso por regex já sai medium; low é descarte);
 *   - pai balde (Bugs, Débitos técnicos) não forma família: só o pai conta,
 *     as irmãs não têm relação entre si;
 *   - a própria task nunca volta como irmã.
 */

export const LINK_OK = "coalesce(r.confidence, 'low') <> 'low'";

export interface EpicInfo {
  key: string;
  title: string | null;
  bucket: boolean;
}

export interface Family {
  task: string;
  epic: EpicInfo | null;
  /** Irmãs, vazio quando o pai é balde. */
  siblings: string[];
}

export async function familyOf(s: Session, taskKey: string): Promise<Family> {
  const r = await s.run(
    `MATCH (t:Task {key: $key})-[r:PART_OF]->(p:Task) WHERE ${LINK_OK}
     OPTIONAL MATCH (p)<-[r2:PART_OF]-(sib:Task)
       WHERE sib.key <> $key AND coalesce(r2.confidence, 'low') <> 'low' AND coalesce(p.bucket, false) = false
     RETURN p.key AS key, p.title AS title, coalesce(p.bucket, false) AS bucket, collect(DISTINCT sib.key) AS sibs`,
    { key: taskKey },
  );
  const rec = r.records[0];
  if (!rec) return { task: taskKey, epic: null, siblings: [] };
  return {
    task: taskKey,
    epic: { key: rec.get('key'), title: rec.get('title'), bucket: rec.get('bucket') },
    siblings: (rec.get('sibs') as string[]).filter(Boolean),
  };
}

/** Tasks da sessão (branch), base do "de onde estou buscando". */
export async function sessionTaskKeys(s: Session, sessionId: string | null): Promise<string[]> {
  if (!sessionId) return [];
  const r = await s.run(`MATCH (:Session {id: $id})-[:ON_TASK]->(t:Task) RETURN collect(t.key) AS keys`, { id: sessionId });
  return (r.records[0]?.get('keys') as string[]) ?? [];
}

/**
 * Sessões das irmãs (e do próprio epic) das tasks dadas, menos as sessões das
 * próprias tasks. Alimenta o boost fraco da busca: puxa o trabalho do outro
 * repo sem concorrer com o task recall, que é evidência literal.
 */
export async function epicSiblingSessions(s: Session, taskKeys: string[]): Promise<Set<string>> {
  if (taskKeys.length === 0) return new Set();
  const r = await s.run(
    `UNWIND $keys AS k
     MATCH (t:Task {key: k})-[r:PART_OF]->(p:Task) WHERE ${LINK_OK} AND coalesce(p.bucket, false) = false
     MATCH (p)<-[r2:PART_OF]-(sib:Task) WHERE NOT sib.key IN $keys AND coalesce(r2.confidence, 'low') <> 'low'
     WITH collect(DISTINCT sib) + collect(DISTINCT p) AS fam
     UNWIND fam AS f
     MATCH (f)<-[:ON_TASK]-(se:Session)
     RETURN collect(DISTINCT se.id)[..300] AS ids`,
    { keys: taskKeys },
  );
  return new Set((r.records[0]?.get('ids') as string[]) ?? []);
}

export interface FamilyDecision {
  id: string;
  kind: string;
  text: string;
  project: string | null;
  tasks: string[];
  timestamp: string | null;
  /** 'task' = da própria task, 'irmã' = de outra filha do epic, 'epic' = do próprio epic. */
  relation: 'task' | 'irmã' | 'epic';
  via: string;
}

/**
 * Decisões da task + irmãs + epic, DISTINCT (uma Decision ligada a duas tasks
 * da família vem uma vez, com a relação mais próxima). Ordem: própria task,
 * depois as de OUTRO repo (é o que o caller não teria visto), depois recência.
 */
export async function decisionsOfFamily(s: Session, taskKey: string, k: number): Promise<FamilyDecision[]> {
  const fam = await familyOf(s, taskKey);
  const members = [
    { key: taskKey, relation: 'task' as const },
    ...fam.siblings.map((key) => ({ key, relation: 'irmã' as const })),
    ...(fam.epic ? [{ key: fam.epic.key, relation: 'epic' as const }] : []),
  ];
  const r = await s.run(
    `UNWIND $members AS m
     MATCH (d:Decision {status: 'active'})-[:ON_TASK]->(:Task {key: m.key})
     RETURN d.id AS id, d.kind AS kind, d.text AS text, d.projectPath AS project, d.taskKeys AS tasks,
            d.createdAt AS ts, m.relation AS relation, m.key AS via`,
    { members },
  );
  const order = { task: 0, 'irmã': 1, epic: 2 } as const;
  const best = new Map<string, FamilyDecision>();
  for (const rec of r.records) {
    const d: FamilyDecision = {
      id: rec.get('id'), kind: rec.get('kind'), text: rec.get('text'), project: rec.get('project'),
      tasks: rec.get('tasks') ?? [], timestamp: rec.get('ts'), relation: rec.get('relation'), via: rec.get('via'),
    };
    const cur = best.get(d.id);
    if (!cur || order[d.relation] < order[cur.relation]) best.set(d.id, d);
  }
  // repo da task = onde ela mais teve sessão (pode não ter Decision própria)
  const pr = await s.run(
    `MATCH (:Task {key: $key})-[r:IN_PROJECT]->(p:Project) RETURN p.path AS path ORDER BY r.sessions DESC LIMIT 1`,
    { key: taskKey },
  );
  const ownRepo = (pr.records[0]?.get('path') as string | undefined) ?? null;
  const recent = (a: FamilyDecision, b: FamilyDecision): number => ((b.timestamp ?? '') < (a.timestamp ?? '') ? -1 : 1);
  const own = [...best.values()].filter((d) => d.relation === 'task').sort(recent);
  const kin = [...best.values()]
    .filter((d) => d.relation !== 'task')
    .sort((a, b) => {
      const ao = a.project !== ownRepo ? 0 : 1;
      const bo = b.project !== ownRepo ? 0 : 1;
      return ao !== bo ? ao - bo : recent(a, b);
    });
  // Metade das vagas é da família quando ela existe: sem isso a própria task
  // (que costuma ter 10+ decisões) ocupava tudo e a regra do outro repo, que é
  // o motivo da tool, nunca aparecia.
  const ownSlots = kin.length > 0 ? Math.max(k - Math.min(kin.length, Math.floor(k / 2)), 0) : k;
  const pickedOwn = own.slice(0, ownSlots);
  return [...pickedOwn, ...kin.slice(0, k - pickedOwn.length)];
}

const GENERIC_TERMS = new Set([
  'index', 'test', 'tests', 'spec', 'component', 'components', 'utils', 'util', 'types', 'type', 'hook', 'hooks',
  'screen', 'screens', 'page', 'pages', 'service', 'services', 'controller', 'controllers', 'model', 'models',
  'resource', 'resources', 'request', 'requests', 'helper', 'helpers', 'store', 'context', 'provider', 'config',
  'main', 'default', 'base', 'common', 'shared', 'layout', 'style', 'styles', 'view', 'views', 'list', 'item',
  'form', 'modal', 'button', 'http', 'feature', 'features', 'domain', 'module', 'modules', 'core', 'support',
]);

/**
 * Termos do caminho que identificam o assunto do arquivo: nome e pasta pai,
 * quebrados em camelCase/kebab/snake. `contract/extension/InviteOnboarding.tsx`
 * -> contract, extension, invite, onboarding. Genérico (index, screen,
 * controller) fica de fora, senão casa com qualquer regra.
 */
export function fileTerms(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const name = (parts.pop() ?? '').replace(/\.[^.]+$/, '');
  const dirs = parts.slice(-2);
  const out = new Set<string>();
  for (const piece of [name, ...dirs]) {
    for (const w of piece.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)) {
      const t = w.toLowerCase();
      if (t.length >= 4 && !GENERIC_TERMS.has(t)) out.add(t);
    }
  }
  return [...out];
}

/**
 * Regra de OUTRO repo, vinda de irmã ou do epic da task da sessão, que fala do
 * assunto do arquivo aberto. É o caminho por onde a regra do back chega no
 * front. Exige ao menos 1 termo do arquivo no texto da regra: sem isso seria
 * uma regra aleatória do epic a cada arquivo aberto.
 */
export async function crossRepoRuleForFile(
  s: Session,
  args: { sessionId: string | null; fileRepo: string; path: string; exclude: string[] },
): Promise<(FamilyDecision & { hits: number }) | null> {
  const terms = fileTerms(args.path);
  if (terms.length === 0) return null;
  const keys = await sessionTaskKeys(s, args.sessionId);
  let best: (FamilyDecision & { hits: number }) | null = null;
  for (const key of keys) {
    for (const d of await decisionsOfFamily(s, key, 40)) {
      if (d.relation === 'task' || args.exclude.includes(d.id)) continue;
      const repo = d.project?.split('/').filter(Boolean).pop() ?? null;
      if (!repo || repo === args.fileRepo) continue;
      const text = d.text.toLowerCase();
      const hits = terms.filter((t) => text.includes(t)).length;
      if (hits === 0) continue;
      const rank = (x: FamilyDecision): number => (x.kind === 'gotcha' ? 0 : x.kind === 'rule' ? 1 : 2);
      if (!best || hits > best.hits || (hits === best.hits && rank(d) < rank(best))) best = { ...d, hits };
    }
  }
  return best;
}
