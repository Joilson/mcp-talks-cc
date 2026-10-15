# mcp-talks-cc

MCP local que indexa toda a memória do Claude Code (conversas + plans + task memory) em Neo4j com busca vetorial e grafo de entidades (task, epic, arquivo, decisão). Permite que o Claude busque contexto cross-conversa e cross-repo via tools MCP: regra decidida no back aparece quando vc mexe no front da mesma feature.

## Stack

- **TypeScript/Node 22+** (ESM, `--experimental-strip-types`)
- **Neo4j 5.26 community** via docker compose (porta 7687 Bolt, 7474 Browser)
- **Embeddings local** via `@huggingface/transformers` — modelo `Xenova/bge-m3` (1024-dim, multilíngue pt/en, quantizado q8 ~150MB)
- **MCP SDK** `@modelcontextprotocol/sdk` stdio transport

## Pré-requisitos

- **Node >= 22.13** (usa `--experimental-strip-types`, sem build step)
- **Docker** + `docker compose` (Neo4j sobe em container). No macOS com OrbStack, deixe ele iniciar com o login (`orb config set app.start_at_login true`): o hook sobe o container sozinho, mas não o Docker
- **Claude Code CLI** no PATH (`claude`) — o `install.sh` usa `claude mcp add`
- ~2GB de disco: imagem Neo4j + store do grafo + modelo bge-m3 q8 (~150MB em `~/.cache/huggingface/`)

Testado em macOS. Os scripts evitam dependência de `flock` (que não existe no macOS) e usam
lockdir com pidfile, então devem rodar em Linux também.

## Setup

Atalho: `./scripts/install.sh` roda os passos 1-6 abaixo + registra o MCP + instala o hook de auto-ingest (idempotente). Veja [Instalar / reinstalar do zero](#instalar--reinstalar-do-zero). Os passos manuais abaixo ficam como referência/fallback.

```bash
# 1. dependencies
npm install

# 2. env (defaults já funcionam)
cp .env.example .env

# 3. start Neo4j (waits for healthy)
npm run infra:up

# 4. create constraints + vector index
npm run db:init

# 5. ingest everything (~5-15min depending on corpus + cold model load on first call)
npm run ingest -- --source=all

# 6. check counts
npm run db:stats
```

## Sources ingeridos

| Source | Path | Nodes |
|---|---|---|
| `conversations` | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `Project`, `Session`, `Message`, `ToolCall`, `Chunk` |
| `plans` | `~/.claude/plans/*.md` | `Plan`, `Chunk` |
| `todos` | `~/.claude/todos/*.json` (dormente: o Claude Code não grava mais aí) | `Todo` |
| `tasks` | `<project>/.claude/tasks/<TICKET>-*/*.md` | `Project`, `TaskMemoryDoc`, `Chunk` |

Por cima disso, passos derivados montam o grafo de entidades a partir do que já foi ingerido: `Task` (da branch e do texto), `File` (do input dos ToolCalls), `Decision` (distilação) e o vínculo task -> epic (ver [Epic como ponte entre repos](#epic-como-ponte-entre-repos)).

`Chunk.sourceKind`: `conversation` (msgs user/assistant) | `plan` | `task_memory` | `decision` (destilado, ver [Distilação](#distilação)). Saída de ferramenta fica como nó `ToolCall`, sem embedding.

Ingestão é **incremental** — `~/.cache/mcp-talks-cc/checkpoint.json` guarda `mtime + sha256` por arquivo. Re-rodar `npm run ingest` pula arquivos inalterados. Arquivo que mudou (sessão que cresceu) é relido inteiro, mas só passa pelo modelo o chunk novo ou com texto diferente: o resto reaproveita o vetor já gravado. `--force` re-embeda tudo (use ao trocar de modelo).

## Auto-ingest (SessionStart hook)

O ingest roda sozinho a cada abertura de sessão do Claude Code. Um hook `SessionStart` em `~/.claude/settings.json` dispara `scripts/session-ingest.sh` em background (`async: true`, não atrasa o boot da sessão).

O wrapper:
- checa a porta Bolt (`nc -z localhost 7687`) e, se estiver fechada, **sobe o container** (`docker compose up -d --wait`) antes de desistir (o driver não tem connect-timeout, daí o check de porta);
- toma lock via `mkdir` de um lockdir com pidfile (não `flock`, que não existe no macOS), liberando por liveness do pid: run de horas não é roubado, e processo morto não bloqueia pra sempre;
- roda `npm run ingest -- --source=all` (incremental);
- limita o onnx a metade dos cores (`MCP_TALKS_BG=1`), pra não travar a máquina; `EMBED_THREADS=N` no `.env` fixa o número;
- escreve `~/.cache/mcp-talks-cc/health.json` (`ok` / `neo4j-down` / `failed`), que é o que o `session-primer.sh` lê pra injetar `[ALERTA mcp-talks-cc]` quando a memória está atrasada. Run que pula por lock de outro ingest não grava nada (o dono do lock grava);
- classificação de valor: chunk novo ganha `valueScore` (entrega x narração). Sem `value-model.json` (máquina nova, cache limpo) treina antes (`train:value --strict`, ~20s; não grava modelo que não separa);
- com chunk novo: `build:entities` (Task, File, planos), `link:epics --no-llm` (vínculo task -> epic sem custo) e `rebuild:similar` (no máx 1x/20h);
- `self-tune` (grada as buscas da sessão anterior, recalibra `confidence` e o gate);
- com `MCP_TALKS_EPIC_LLM=1`: `link:epics` com Haiku (5 sessões por run); com `MCP_TALKS_DISTILL=1`: a distilação (ver [Distilação](#distilação)). Os dois soltam o lock do ingest antes;
- append com timestamp em `~/.cache/mcp-talks-cc/ingest.log`.

**Fail-open é regra aqui.** Guard de lock que falha fechado mata o ingest em silêncio: `flock` não existe no macOS, então `command not found` era lido como "já tem ingest rodando" e o hook saía toda vez, por semanas, sem erro visível. Guard quebrado nunca pode significar skip, e é pra isso que existe o `health.json` mais o alerta no primer.

```bash
tail -f ~/.cache/mcp-talks-cc/ingest.log   # acompanhar
```

**Por que SessionStart e não cron/Stop/SessionEnd:** conversa nova só nasce enquanto uso o Claude, então abrir uma sessão é o momento certo de indexar as anteriores. `Stop` dispara a cada turno (frequente demais); `SessionEnd` não roda confiável quando fecho o terminal direto (SIGHUP); cron seria redundante (rodaria sem nada novo). Custo ocioso é baixo: o embedder é lazy, então um run sem nada novo nem carrega o modelo — só conexão Neo4j + stat/hash dos arquivos.

**Gap conhecido:** o transcript da sessão atual só entra no próximo SessionStart. Aceitável pro uso.

Instalado via `./scripts/install.sh` (passo 7) ou direto com `node scripts/install-hook.mjs` — ambos fazem merge sem sobrescrever hooks existentes.

## CLI

```bash
npm run ingest -- --source=conversations|plans|todos|tasks|all [--limit=N] [--force]
npm run search -- --query="..." --k=5    # CLI de teste de busca vetorial
npm run db:stats                          # counts por label
npm run mcp:start                         # roda o MCP server (stdio)
npm run mcp:inspect                       # MCP Inspector UI
npm run self-tune -- --regrade-from=all   # re-grada o query-log inteiro (usar quando o grader muda)
npm run self-tune:accept                  # promove tuning.candidate.json -> tuning.json
npm run self-tune:reject                  # recusa o candidate e para de cobrar accept
npm run backfill:message-text             # repara Message.text sem re-embedar
npm run calibrate:probe                   # CDF de confidence por replay das queries reais (não depende de tráfego recente)
npm run eval:candidates                   # candidatos pro gabarito de recall
npm run bench:recall                      # recall@k/MRR/tokens contra o gabarito, publica o gate
npm run bench:task-recall                 # invariante: buscar EDC-XXXX acha as sessões da task
npm run bench:epic-cross                  # ponte entre repos: busca do repo A acha a irmã do repo B
npm run distill -- --limit=10             # destila sessões fechadas em nós Decision
npm run link:epics -- [--apply] [--no-llm] [--limit=10]   # vínculo task -> epic (dry-run não chama o Haiku)
npm run build:entities -- --apply         # Task, File, planos e task memory a partir do grafo
npm run train:value -- --apply            # treina o classificador entrega x narração
npm run classify:chunks -- --apply        # grava valueScore nos chunks
npm run rebuild:similar                   # recalcula as arestas SIMILAR_TO
npm run upgrade                           # aplica o que uma versão nova precisa (idempotente)
npm run upgrade:claude-md -- --dry-run    # diff do bloco do CLAUDE.md (--apply grava, com backup)
```

`self-tune:reject` é a contrapartida do accept. O self-tune regenera o candidate a cada
sessão, então sem registrar a recusa o primer cobra a mesma proposta pra sempre e aplicar
vira a única saída. A recusa é comparada por CONTEÚDO (`tuningEquals`, ignora `updatedAt`):
proposta diferente volta a cobrar accept, e um accept posterior limpa o registro.

`backfill:message-text` repara `Message.text` quando ele fica vazio no grafo (foi o caso enquanto `writeMessages()` não gravava o campo: `get_session_transcript` devolvia transcript vazio e o echo do self-tune era impossível de calcular). Re-parseia os JSONL em disco e só faz `SET m.text`, sem tocar em Chunk nem no checkpoint. Sessão cujo JSONL o Claude Code já podou não tem como voltar.

## Tools MCP expostas

| Tool | Para que serve |
|---|---|
| `search_memory(query, k?, scope?, project?, since?, diversity?, detail?)` | Busca híbrida em todo corpus. Saída **brief** por default (1 linha por hit, ~400 tokens com k=8); `detail: 'full'` traz os snippets. No máx 1 hit por sessão (`diversity >= 0.9` tira o teto). `scope` aceita `conversation\|plan\|task_memory\|decision` |
| `expand_hits(ids, neighbors?)` | Texto completo dos hits escolhidos (id curto de 12 chars basta). É o 2º estágio da saída brief e o sinal de uso mais limpo pro grader |
| `get_session_transcript(sessionId, limit?)` | Transcript completo de uma sessão. Retorna `found: false` se sessionId não existe |
| `find_related_plans(query, k?)` | Restrita a `Plan` (~/.claude/plans/*.md) |
| `find_decisions(query, taskId?, k?)` | Decisões/regras/gotchas destilados (nós `Decision`) + task memory. Com `taskId`: as da task **e as das tasks irmãs do mesmo epic** (metade das vagas, outro repo primeiro, marcadas `via irmã EDC-X`) |
| `recall_task(taskKey)` | Índice estrutural da task, sem snippet (~300 tokens): repos e sessões, epic, irmãs por repo, contagem de decisões, planos e arquivos mais escritos. Primeiro passo quando aparece uma key |
| `list_project_activity(project, since?)` | Estatísticas por projeto (Cypher puro, sem embed). Retorna `found: false` se project não existe |

Prompts:
- `recall_context(query, scope?)` — guia Claude a buscar memória antes de responder
- `extract_decision(taskId, topic?)` — orquestra find_decisions + transcript pra extrair decisão estruturada

Resources:
- `memory://stats` — counts por label
- `memory://schema` — referência: nodes, edges, vector index, Cypher exemplos (contagem ao vivo)
- `memory://profile` — perfil aprendido pelo self-tune (projetos quentes, temas, gate de citação)

Por que brief: o Claude Code entrega `structuredContent` ao modelo como JSON quando ele existe. Com k=5 isso era ~6.5KB (~1.8k tokens) por busca, e com esse preço o modelo não re-busca no meio da conversa. `structuredContent` agora só sai com `MCP_TALKS_STRUCTURED=1` (a suite liga).

## Push: memória sem o modelo pedir

Dois hooks síncronos (instalados pelo `install-hook.mjs`) mandam o contexto pro MCP server já quente via unix socket (`~/.cache/mcp-talks-cc/sock/<pid>.sock`) e injetam **no máximo 1 linha**:

- `UserPromptSubmit` → `push-recall.sh prompt`: busca rápida (pool 200, top 3) no prompt; se um hit passa no gate (conf >= FORTE, margem acima do p75, não é narração, sessão ainda não citada), vira `[memória mcp-talks-cc] talvez relevante: id=... | gist`. Senão, nada (0 token).
- `PostToolUse` (Read/Edit/Write) → `push-recall.sh file`: só Cypher, sem embedding. Quais tasks já alteraram aquele arquivo, a decisão destilada ligada a ele e, se a task da sessão tem epic, 1 regra de **outro repo** do mesmo epic que cite o assunto do arquivo (termos do nome/pasta no texto da regra).

Dedup por sessão e teto de 8 ponteiros. Fail-open: sem server vivo, sem curl ou estourando ~850ms, sai vazio. `MCP_TALKS_DISABLE_PUSH=1` no server desliga o socket. Medido: ~120-470ms com o server quente.

## Distilação

`npm run distill -- [--limit=10] [--session=<id>] [--dry-run]`: de cada sessão fechada (sem atividade há 2h, com 3+ falas de entrega), o `claude -p` headless com Haiku extrai até 6 itens `decision`/`rule`/`gotcha` de ≤300 chars, autocontidos. Viram nó `Decision` (ligado a `Session`, `Task` e `File`) + Chunk `sourceKind: 'decision'` no mesmo índice, com boost fixo de 1.25.

- A chamada roda sem tools, sem MCP, sem settings de usuário (sem hooks) e sem persistir sessão, pra não virar transcript indexado nem disparar o SessionStart de novo (`MCP_TALKS_IN_DISTILL=1` é a segunda guarda).
- O hook de ingest destila até `MCP_TALKS_DISTILL_PER_RUN` sessões por SessionStart (default 5, 0 desliga), em duas filas: as recentes (últimos 7 dias) e mais `MCP_TALKS_DISTILL_BACKLOG_PER_RUN` do backlog (default 3, da mais antiga pra mais nova, pra não mexer no que está em uso). Backfill de uma vez: `npm run distill -- --limit=N --oldest-first`. Custo medido: ~20-40s e ~10k tokens de Haiku por sessão.
- Incremental por `Session.distillVersion`; subir `DISTILL_VERSION` reprocessa.

## Epic como ponte entre repos

Task do back e do front costumam ser filhas do mesmo epic no Jira. O `link:epics` grava isso
como `(Task)-[:PART_OF]->(Task:Epic)`, e as irmãs viram a ponte: regra destilada numa task do
px-torre-core chega em quem mexe na task irmã do app. **Nada acessa o Jira**: a hierarquia sai do
que já está na memória, de três fontes (uma task tem no máximo 1 pai; vence a de cima):

| Fonte | Como | Custo |
|---|---|---|
| `prompt` | linha fixa `[task] EDC-3309 pai=EDC-3208 (Epic: título)` que o fluxo "analise KEY" emite (bloco do CLAUDE.md) | zero |
| `haiku` | `claude -p` lê só os trechos em volta de "épico/epic/parent/pai" (~2k tokens por sessão). Só troca pai vindo de outra fonte com confiança `high` | opt-in `MCP_TALKS_EPIC_LLM=1` (sem a linha, segue a distilação), 5 por SessionStart (`MCP_TALKS_EPIC_LINK_PER_RUN`) |
| `regex` | 1 task na sessão + 1 único "Épico EDC-X" citado | zero |

Medido contra o Jira (52 tasks): 20/20 vínculos certos. Sem o Haiku só entra o caso literal,
~1/3 dos pais; por isso o primer pergunta se liga ("maior precisão") pra quem está com a
distilação desligada. Muda com `npm run upgrade -- --epic-llm=on|off`. O projeto meta (este repo) não é fonte,
porque discute os formatos com keys de exemplo.

**Epic balde** (`Bugs`, `Débitos técnicos`, `Melhorias`...) junta tasks sem relação: as filhas não
viram irmãs. Detectado pelo título; corrija com `MCP_TALKS_EPIC_BUCKETS=EDC-341` /
`MCP_TALKS_EPIC_NOT_BUCKETS=` no `.env`.

Onde aparece:
- `find_decisions({ taskId })` e `recall_task({ taskKey })`;
- push por arquivo (regra de outro repo do mesmo epic que cite o assunto do arquivo);
- primer: sessão aberta numa branch de task ganha as regras das irmãs (`~/.cache/mcp-talks-cc/epic-primer/<KEY>.txt`, regenerado a cada `link:epics`);
- `search_memory`: sessões de irmãs ganham boost 1.2 no MMR (sem furar o teto por sessão).

## Medição: gabarito de recall

`bench:task-recall` só prova o plumbing de `EDC-XXXX` → sessão. O juiz de ranking é `npm run bench:recall`, sobre um gabarito em `~/.cache/mcp-talks-cc/recall-eval.jsonl` (**fora do repo**: é feito das suas queries e sessões reais).

1. `npm run eval:candidates` lista, pra cada query real do query-log, as sessões candidatas (ranker + task nomeada), rodando "no momento" da query.
2. Marque quais sessões respondem de fato (à mão ou com um agente + revisão) no formato `{id, query, ts, callerSession, project, kind, expect: {sessionIds, planPaths}}`.
3. `npm run bench:recall` dá recall@3/@8, MRR, ruído, tokens por busca e publica o gate de citação (`bench-gate.json`: FORTE = precision 0.8, PISO = 0.5). Flags de A/B: `--tuning=<file>`, `--exclude-kinds=decision`, `MCP_TALKS_MAX_PER_SESSION=n`.

Com gabarito presente, o self-tune só cobra accept de um candidate que não piore recall nem MRR.

## Registro no Claude Code

Para usar o MCP dentro do Claude Code, registre o server. Forma mais segura via CLI. O `-s user` registra em escopo de usuário (global, vale em todos os projetos); sem ele o default é escopo `local`, que só anexa o server no diretório de onde o comando rodou:

```bash
claude mcp add mcp-talks-cc -s user \
  -- node \
  --env-file=/ABSOLUTE/PATH/TO/mcp-talks-cc/.env \
  --experimental-strip-types \
  /ABSOLUTE/PATH/TO/mcp-talks-cc/src/mcp/server.ts
```

Ou cole o snippet de `claude-mcp-config.snippet.json` em `~/.claude.json` (root level — não em `settings.json` se este tiver hooks). Depois `/mcp` no Claude Code lista o server `mcp-talks-cc` como conectado.

## Config no CLAUDE.md (obrigatório)

Registrar o server **não basta**. O que faz o Claude realmente usar a memória é um bloco de
instruções no seu `~/.claude/CLAUDE.md`: quando buscar, como ler `confidence` (e por que
`score` não serve de corte), qual o limite de citações, quais anti-padrões evitar.

Sem esse bloco o sintoma é silencioso: o `/mcp` mostra o server conectado, mas o Claude ou
ignora as tools, ou cita hit irrelevante porque olhou `score` (o bge-m3 devolve cosseno
entre 0.86 e 0.91 pra praticamente qualquer par de textos — cortar em `score` aprova tudo).

Copie de [`docs/CLAUDE.md.snippet.md`](docs/CLAUDE.md.snippet.md). O snippet é neutro de
projeto: o fluxo de análise de task do Jira serve pra qualquer prefixo (`EDC-1234`,
`US-77`, `AQ-1831`), já que o BM25 trata `[A-Z]{2,}-\d+` como token literal.

## Instalar / reinstalar do zero

Caminho único pra montar tudo (máquina nova, reset, config quebrada):

```bash
./scripts/install.sh
```

Idempotente — seguro re-rodar. Faz, em ordem:

1. `npm install`
2. `.env` (cria de `.env.example` se faltar; mantém o existente)
3. `npm run infra:up` (Neo4j via docker, espera healthy)
4. `npm run db:init` (constraints + vector index)
5. `npm run ingest -- --source=all` (1º ingest; incremental depois)
6. registra o MCP `mcp-talks-cc` no Claude Code, só se ainda não estiver (`claude mcp get mcp-talks-cc`)
7. `scripts/upgrade.sh`: instala os 4 hooks (`session-ingest.sh` async, `session-primer.sh`, `push-recall.sh prompt` e `push-recall.sh file`) com merge sem clobber e backup em `~/.claude/settings.json.bak`, gera a calibração e grava a versão instalada

No fim imprime onde fica o log e como verificar (`npm run db:stats`, `/mcp`).

## Atualizar uma instalação existente

```bash
git pull && npm run upgrade
```

Idempotente, não re-ingere nem apaga dado. Aplica schema novo, hooks novos, calibração se faltar,
e grava a versão em `~/.cache/mcp-talks-cc/installed-version`.

Na prática basta o `git pull`: na sessão seguinte o primer detecta a versão nova e o Claude
pergunta "atualizar agora / agora não". Aceitando, ele roda o upgrade e depois pergunta se
aplica o bloco novo no seu CLAUDE.md, mostrando o diff (`npm run upgrade:claude-md`, com
backup). "Agora não" adia 3 dias. Os passos que não dá pra
automatizar (bloco do CLAUDE.md, opt-ins que gastam tokens) saem impressos no fim. O que muda em
cada versão, e o que fazer, fica no [CHANGELOG](CHANGELOG.md).

## Migrar pra outra máquina

O repo não carrega o estado. Copie, além de clonar:

| O quê | Onde | Se faltar |
|---|---|---|
| grafo | `neo4j/data/` do repo (com o container parado) | re-ingest só recupera o que ainda está em disco; transcript podado (>90 dias) some de vez |
| transcripts | `~/.claude/projects/` (`rsync --ignore-existing`, não o `.claude` inteiro) | idem |
| gabarito do bench | `~/.cache/mcp-talks-cc/recall-eval.jsonl` | **irrecuperável**: é anotação manual. Sem ele o `bench:recall` não roda e o self-tune não valida candidate |
| tuning aprendido | `~/.cache/mcp-talks-cc/tuning.json` | volta pro default (ex. `valueDemote` neutro: sem rebaixar narração) |
| modelo de valor | `~/.cache/mcp-talks-cc/value-model.json` | o hook treina de novo sozinho (~20s) |

Depois: `./scripts/install.sh` (idempotente) e abrir uma sessão nova. Ligue o Docker no login
(ver Pré-requisitos), senão todo boot começa com `[ALERTA] neo4j-down`.

## Schema Neo4j

Resumo. A referência completa, com contagem ao vivo e Cypher de exemplo, é o resource
`memory://schema` (`src/mcp/resources/schema.ts`), que é o que deve ser mantido em dia.

```
(Project)-[:HAS_SESSION]->(Session)-[:HAS_MESSAGE]->(Message)-[:HAS_CHUNK]->(Chunk)
(Message)-[:REPLIES_TO]->(Message)  (Message)-[:INVOKED]->(ToolCall)
(Plan|TaskMemoryDoc|Decision)-[:HAS_CHUNK]->(Chunk)
(Session)-[:ON_TASK]->(Task)  (Chunk)-[:MENTIONS_TASK]->(Task)            ← build:entities
(Session)-[:WROTE|READ]->(File)  (Task)-[:TOUCHES]->(File)  (Task)-[:IN_PROJECT]->(Project)
(Plan)-[:PLANNED_IN]->(Session)  (Plan|TaskMemoryDoc)-[:ABOUT_TASK]->(Task)
(Task)-[:PART_OF]->(Task:Epic)  (Task:Epic)-[:RELATES]->(Task)             ← link:epics
(Decision)-[:FROM_SESSION]->(Session)  (Decision)-[:ON_TASK]->(Task)  (Decision)-[:ABOUT]->(File)
(Chunk)-[:SIMILAR_TO]->(Chunk)                                             ← rebuild:similar
```

Vector index `chunks_embedding`: `Chunk.embedding` (1024d cosine). Fulltext `chunks_text` (BM25)
sobre `Chunk.text`. `Todo` existe só como fóssil `:Orphan` (fonte dormente).

## Segurança

Antes de embedar, redactor remove tokens/keys comuns (OpenAI/Anthropic/GitHub/Bearer/JWT/AWS keys + env-style secrets). Não é exaustivo — corpus deve permanecer local. Veja `src/ingest/redact.ts`.

## Limitações conhecidas (MVP)

- Embed cold-start (~30-60s primeira invocação por causa do bge-m3 q8). MCP server pré-carrega no boot.
- Tool calls (Bash outputs etc.) **não** são embedados — só ficam como nodes `ToolCall` rastreáveis via Cypher.
- Busca e ranking não usam LLM. LLM (Haiku via `claude -p`) só roda offline, no hook e com opt-in: distilação e vínculo task -> epic.
- Task que nunca passou por conversa nem plano fica sem epic (e também sem regra pra cruzar).

## Troubleshooting

- **`vector.dimensions mismatch`**: trocou de modelo e a dimensão difere de 1024. Ou ajuste `EMBED_DIM` no `.env` ou rode `npm run infra:reset && npm run db:init`.
- **MCP não aparece no `/mcp`**: cheque que o path em `~/.claude.json` é absoluto e que `npm run mcp:start` funciona direto no terminal.
- **bge-m3 download lento**: primeira chamada baixa o modelo (~150MB q8) pra `~/.cache/huggingface/`.
