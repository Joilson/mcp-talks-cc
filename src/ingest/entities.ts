/**
 * Extração de entidades de domínio (task e arquivo) a partir do que já está no
 * grafo. Funções puras, sem I/O, porque os DOIS caminhos consomem daqui: o
 * backfill dos dados velhos e o ingest dos novos. Se a extração viver
 * duplicada, os dois divergem em semanas e o grafo fica com duas gerações de
 * chave para a mesma coisa.
 */

/**
 * Prefixos que são código de task de verdade.
 *
 * Medido no acervo em 22/09/2026. Nas branches só aparecem EDC (301) e US (74).
 * No texto, EDC e US somam 92% das ocorrências; DEV e QUAL aparecem menos mas
 * são reais (vistos em commits do px-torre-core e em `Freight::isMeliContract`).
 *
 * Sem allowlist, o regex genérico `[A-Z]{2,6}-\d+` come ruído medido: NR-12
 * (norma regulamentadora, 267 ocorrências), ISO-8601, SHA-256, ADR-001, AC-1,
 * PR-123. Todos viram nó de task e poluem o grafo de trabalho relacionado.
 */
export const TASK_PREFIXES = ['EDC', 'US', 'DEV', 'QUAL'] as const;

const PREFIX_GROUP = TASK_PREFIXES.join('|');

/**
 * Primeiro código na branch, em qualquer posição.
 *
 * Ancorar no início parecia mais seguro e custou um caso real: a branch
 * `feature/US-372-delegated-ein-insurance-submission` ficava sem task. Como o
 * prefixo é de uma allowlist curta, procurar em qualquer posição não abre
 * espaço para falso positivo.
 */
const BRANCH_RE = new RegExp(`(?:^|[^A-Za-z0-9])(${PREFIX_GROUP})-(\\d{1,6})(?:[-_/]|$)`, 'i');

/**
 * No texto exige MAIÚSCULA e 2+ dígitos. Minúsculo só aparece em slug e URL,
 * onde a task já chega por outra rota; 2 dígitos mata `US-1`. `EDC-XXXX`
 * (placeholder literal de template, 18 sessões) não casa porque X não é dígito.
 */
const TEXT_RE = new RegExp(`\\b(${PREFIX_GROUP})-(\\d{2,6})\\b`, 'g');

/**
 * Acima disto o chunk é listagem de backlog, não discussão. Sem o corte, um
 * dump do Jira ligaria 30 tasks entre si e envenenaria o grafo de relacionadas.
 */
const MAX_TASKS_PER_CHUNK = 5;

/** Só o PRIMEIRO código da branch vira a task da sessão. */
export function taskKeyFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = BRANCH_RE.exec(branch);
  return m ? `${m[1]!.toUpperCase()}-${Number(m[2])}` : null;
}

/**
 * Código em identificador que não é prosa: slug de plano, nome de pasta de
 * task memory. Mesma regra da branch (qualquer posição, minúscula ok), porque é
 * o mesmo tipo de string. Vive aqui pra não haver uma terceira cópia do regex.
 */
export function taskKeyFromSlug(slug: string | null | undefined): string | null {
  return taskKeyFromBranch(slug);
}

/** Códigos citados no texto, para referência cruzada entre tasks. */
export function taskKeysFromText(text: string): string[] {
  TEXT_RE.lastIndex = 0;
  const found = new Set<string>();
  for (const m of text.matchAll(TEXT_RE)) found.add(`${m[1]}-${Number(m[2])}`);
  return found.size > MAX_TASKS_PER_CHUNK ? [] : [...found];
}

/** Caminho que não representa trabalho em repositório. */
const PATH_DENY = [
  '/.claude/',
  '/node_modules/',
  '/vendor/',
  '/dist/',
  '/build/',
  '/.next/',
  '/coverage/',
  '/.git/',
];

/** Worktree e workspace apontam para a mesma fonte; colapsa para o repo. */
const WORKTREE_RE = /^(.*)\/\.claude\/worktrees\/[^/]+\//;
const WORKSPACE_RE = /^\/Users\/[^/]+\/orca\/workspaces\/([^/]+)\/[^/]+\//;

export interface FileRef {
  /** `repo:caminho-relativo`, chave única do nó. */
  key: string;
  repo: string;
  path: string;
  ext: string;
}

/**
 * Normaliza um caminho absoluto em referência estável de arquivo.
 *
 * Sem normalizar, a mesma fonte aberta num worktree e no repo principal vira
 * dois nós distintos e o vínculo "mexeram no mesmo arquivo" não fecha.
 */
export function normalizeFilePath(
  abs: string,
  projectPaths: readonly string[],
): FileRef | null {
  if (!abs.startsWith('/')) return null;

  let p = abs;
  const ws = WORKSPACE_RE.exec(p);
  if (ws) {
    const rel = p.slice(ws[0].length);
    return buildRef(ws[1]!, rel);
  }
  const wt = WORKTREE_RE.exec(p);
  if (wt) p = `${wt[1]}/${p.slice(wt[0].length)}`;

  if (PATH_DENY.some((d) => p.includes(d))) return null;

  // Prefixo mais longo que bate com um Project conhecido vence: evita que
  // `px-painel` e `px-painel-legacy` colidam.
  let best: string | null = null;
  for (const root of projectPaths) {
    if (p.startsWith(`${root}/`) && (best === null || root.length > best.length)) best = root;
  }
  if (best === null) return null;

  const repo = best.slice(best.lastIndexOf('/') + 1);
  return buildRef(repo, p.slice(best.length + 1));
}

function buildRef(repo: string, rel: string): FileRef | null {
  if (!rel || PATH_DENY.some((d) => `/${rel}`.includes(d))) return null;
  const dot = rel.lastIndexOf('.');
  return {
    key: `${repo}:${rel}`,
    repo,
    path: rel,
    ext: dot > 0 ? rel.slice(dot + 1) : '',
  };
}

/** Ferramentas cujo input carrega `file_path`. */
export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Só estas representam MUDANÇA; ler um arquivo é sinal fraco e vai em aresta própria. */
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * `file_path` de dentro do input serializado no `outputSnippet`.
 *
 * `toolOutputSnippet` (sources/conversations.ts) faz `JSON.stringify(b.input)`
 * quando o bloco é `tool_use` e não tem saída, então o caminho exato está
 * gravado no grafo — inclusive para as 373 sessões cujo `.jsonl` já foi podado.
 * É por isso que a extração NÃO usa regex sobre prosa: medido, prosa produz
 * hub inútil (`references/git-patterns.md` em 76 sessões, exemplos de template
 * de skill, e o placeholder `.claude/tasks/EDC-XXXX/jira.md`).
 */
const FILE_PATH_RE = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export function filePathFromSnippet(snippet: string | null | undefined): string | null {
  if (!snippet) return null;
  const m = FILE_PATH_RE.exec(snippet);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1] ?? null;
  }
}
