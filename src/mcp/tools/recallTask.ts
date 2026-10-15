import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';
import { taskKeyFromSlug } from '../../ingest/entities.ts';
import { familyOf } from '../../epics/family.ts';
import { day, projectName, withStructured } from '../output.ts';

/**
 * Índice estrutural de uma task: epic, irmãs por repo, decisões, planos e
 * arquivos. Sem snippet nenhum, de propósito: custa ~300 tokens contra os
 * milhares de um search_memory, e o drill-in vem depois, dirigido
 * (find_decisions, get_session_transcript, search_memory com a key).
 */

const inputSchema = {
  taskKey: z.string().min(3).describe('Jira key, e.g. EDC-1234.'),
};

interface TaskRecall {
  task: string;
  repos: Array<{ repo: string; sessions: number }>;
  lastSeenAt: string | null;
  epic: { key: string; title: string | null; bucket: boolean; childRepos: string[]; relates: string[] } | null;
  siblings: Array<{ key: string; repos: string[]; sessions: number }>;
  decisions: { own: number; family: number };
  plans: string[];
  files: Array<{ key: string; writes: number }>;
}

export async function recallTask(raw: string): Promise<TaskRecall | null> {
  const key = taskKeyFromSlug(raw) ?? raw.toUpperCase();
  return withSession(async (s) => {
    const t = await s.run(
      `MATCH (t:Task {key: $key})
       OPTIONAL MATCH (t)-[ip:IN_PROJECT]->(p:Project)
       WITH t, collect({repo: p.path, sessions: ip.sessions}) AS repos
       RETURN t.lastSeenAt AS last, repos`,
      { key },
    );
    if (!t.records[0]) return null;
    const fam = await familyOf(s, key);

    let epic: TaskRecall['epic'] = null;
    let siblings: TaskRecall['siblings'] = [];
    if (fam.epic) {
      const e = await s.run(
        `MATCH (p:Task {key: $ek}) OPTIONAL MATCH (p)-[:RELATES]->(o:Task)
         RETURN p.childRepos AS repos, collect(o.key) AS rel`,
        { ek: fam.epic.key },
      );
      epic = {
        ...fam.epic,
        childRepos: ((e.records[0]?.get('repos') as string[]) ?? []).map((r) => projectName(r)),
        relates: (e.records[0]?.get('rel') as string[]) ?? [],
      };
      const sib = await s.run(
        `UNWIND $keys AS k MATCH (x:Task {key: k})
         OPTIONAL MATCH (x)-[ip:IN_PROJECT]->(p:Project)
         RETURN k AS key, collect(p.path) AS repos, coalesce(x.sessionCount, 0) AS n`,
        { keys: fam.siblings },
      );
      siblings = sib.records
        .map((r) => ({ key: r.get('key') as string, repos: (r.get('repos') as string[]).map((x) => projectName(x)), sessions: Number(r.get('n')) }))
        .sort((a, b) => b.sessions - a.sessions);
    }

    const famKeys = [...fam.siblings, ...(fam.epic ? [fam.epic.key] : [])];
    const d = await s.run(
      `OPTIONAL MATCH (d1:Decision {status: 'active'})-[:ON_TASK]->(:Task {key: $key})
       WITH count(DISTINCT d1) AS own
       OPTIONAL MATCH (d2:Decision {status: 'active'})-[:ON_TASK]->(f:Task) WHERE f.key IN $fam
       RETURN own, count(DISTINCT d2) AS family`,
      { key, fam: famKeys },
    );
    const pl = await s.run(
      `MATCH (pl:Plan) WHERE (pl)-[:ABOUT_TASK]->(:Task {key: $key})
         OR (pl)-[:PLANNED_IN]->(:Session)-[:ON_TASK]->(:Task {key: $key})
       RETURN DISTINCT pl.slug AS slug LIMIT 5`,
      { key },
    );
    const fl = await s.run(
      `MATCH (:Task {key: $key})-[r:TOUCHES]->(f:File)
       RETURN f.key AS key, r.writes AS writes ORDER BY r.writes DESC LIMIT 6`,
      { key },
    );
    return {
      task: key,
      repos: (t.records[0].get('repos') as Array<{ repo: string | null; sessions: unknown }>)
        .filter((r) => r.repo)
        .map((r) => ({ repo: projectName(r.repo), sessions: Number(r.sessions ?? 0) })),
      lastSeenAt: t.records[0].get('last') as string | null,
      epic,
      siblings,
      decisions: { own: Number(d.records[0]?.get('own') ?? 0), family: Number(d.records[0]?.get('family') ?? 0) },
      plans: pl.records.map((r) => r.get('slug') as string).filter(Boolean),
      files: fl.records.map((r) => ({ key: r.get('key') as string, writes: Number(r.get('writes') ?? 0) })),
    };
  });
}

export function formatTaskRecall(r: TaskRecall): string {
  const lines: string[] = [];
  const repos = r.repos.map((x) => `${x.repo} ${x.sessions}s`).join(', ') || 'sem sessão';
  lines.push(`${r.task}: ${repos}, última ${day(r.lastSeenAt)}`);
  if (r.epic) {
    lines.push(
      `epic ${r.epic.key}${r.epic.title ? ` ${r.epic.title}` : ''}${r.epic.bucket ? ' [balde: irmãs sem relação]' : ''}` +
        `${r.epic.childRepos.length ? ` | filhas em ${r.epic.childRepos.join(', ')}` : ''}` +
        `${r.epic.relates.length ? ` | relacionados ${r.epic.relates.join(', ')}` : ''}`,
    );
    if (r.siblings.length) lines.push(`irmãs: ${r.siblings.slice(0, 8).map((x) => `${x.key} (${x.repos.join('/') || '-'})`).join(', ')}`);
  } else {
    lines.push('epic: não identificado na memória');
  }
  lines.push(`decisões: ${r.decisions.own} da task, ${r.decisions.family} da família (find_decisions({ taskId: '${r.task}' }))`);
  if (r.plans.length) lines.push(`planos: ${r.plans.join(', ')}`);
  // repo:nome, sem o caminho: o caminho inteiro custava ~60 tokens por arquivo
  const short = (k: string): string => `${k.split(':')[0]}:${k.split('/').pop()}`;
  if (r.files.length) lines.push(`arquivos: ${r.files.slice(0, 4).map((f) => `${short(f.key)} (${f.writes})`).join(', ')}`);
  return lines.join('\n');
}

export function registerRecallTaskTool(server: McpServer): void {
  server.registerTool(
    'recall_task',
    {
      description:
        'Structural index of a Jira task from memory, no snippets (~300 tokens): repos and sessions, parent epic with sibling tasks in other repos (front/back of the same feature), decision counts, plans and most-written files. Use it first when a task key comes up, then drill in with find_decisions / search_memory.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = await recallTask(args.taskKey);
        const text = r ? formatTaskRecall(r) : `nada na memória sobre ${args.taskKey}.`;
        return withStructured({ content: [{ type: 'text', text }] }, r ?? {});
      } catch (e) {
        const err = toToolError(e);
        return withStructured(
          { isError: true, content: [{ type: 'text', text: `recall_task ${err.errorType}: ${err.message}` }] },
          err,
        );
      }
    },
  );
}
