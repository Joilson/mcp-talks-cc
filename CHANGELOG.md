# Changelog

Toda versão nova: `git pull` e abrir uma sessão nova do Claude Code. O primer detecta que o
repo está à frente da instalação e o Claude pergunta na primeira resposta:

- **Atualizar agora**: ele roda `npm run upgrade`, mostra o diff do bloco de memória e pergunta
  se aplica no seu `~/.claude/CLAUDE.md` (com backup). Nada no CLAUDE.md muda sem o seu ok.
- Em seguida ele explica a **distilação automática** (o que é, por que vale, quanto custa) e
  pergunta se liga. A resposta fica no `.env` (`MCP_TALKS_DISTILL=1` ou `=0`) e não é perguntada
  de novo; muda com `npm run upgrade -- --distill=on|off`.
- **Agora não**: adia 3 dias (`npm run upgrade -- --snooze[=DIAS]`).

Sem o Claude: `npm run upgrade` e `npm run upgrade:claude-md -- --dry-run | --apply`. Tudo idempotente.

Convenção: **patch** (0.3.x) não tem passo de upgrade e não gera pergunta; o código vale no
`git pull`. **Minor** (0.x.0) pode ter migração e dispara a pergunta de atualização.

## 0.4.0 (2026-10-15)

Epic como ponte entre repos: regra escrita no back passa a aparecer no front (e vice-versa)
quando as duas tasks são filhas do mesmo epic. Nada acessa o Jira: a hierarquia vem do que já
está na memória.

- **Vínculo task -> epic** (`npm run link:epics`, `src/epics/link.ts`): `(Task)-[:PART_OF]->(Task:Epic)`
  e `(Epic)-[:RELATES]->(Epic)`, de três fontes, em ordem de confiança:
  - linha fixa `[task] KEY-1 pai=KEY-2 (Epic: título)` que o fluxo "analise KEY" passa a emitir
    (bloco do CLAUDE.md v4);
  - Haiku lendo só os trechos em volta de "épico/parent/pai" (~2k tokens por sessão, opt-in junto
    com a distilação, 5 sessões por SessionStart);
  - regex no caso inequívoco ("Épico EDC-3208" com 1 task na sessão), sem custo.
  Medido contra o Jira: 20/20 vínculos certos. O Haiku só troca o pai dado por outra fonte com
  confiança high (em medium ele confundiu PRD com epic). Projeto meta (o próprio mcp-talks-cc)
  não é fonte: tem keys de exemplo. Epic balde (Bugs, Débitos técnicos) não forma família;
  override com `MCP_TALKS_EPIC_BUCKETS` / `MCP_TALKS_EPIC_NOT_BUCKETS`.
- **Consumo**:
  - `find_decisions({ taskId })` traz também as decisões das tasks irmãs e do epic (metade das
    vagas, outro repo primeiro), marcadas `via irmã EDC-X`.
  - Tool nova `recall_task({ taskKey })`: índice da task em ~300 tokens (repos, epic, irmãs,
    contagem de decisões, planos, arquivos).
  - Push por arquivo anexa 1 regra de outro repo do mesmo epic que cite o assunto do arquivo.
  - Primer: sessão aberta numa branch de task ganha as regras das irmãs
    (`~/.cache/mcp-talks-cc/epic-primer/<KEY>.txt`, gerado pelo link:epics).
  - `search_memory`: sessões de irmãs ganham boost 1.2 no MMR (`bench:epic-cross`: MRR do 1º hit
    de outro repo 0.147 -> 0.200; `bench:task-recall` inalterado, 100% / 0.990).
- **Base**: `taskKeyFromSlug` centraliza o regex de slug; TaskMemoryDoc ganha `ABOUT_TASK`; stats
  contam todo label; `memory://schema` documenta Decision, Epic, PART_OF e RELATES; chamada
  `claude -p` do distill extraída pra `src/distill/headless.ts`.
- **Kin ligado** (`entityBoost` 1 -> 1.35): boost das sessões irmãs (mesma task ou arquivo escrito
  em comum) estava morto desde que entrou. Medido no `bench:recall` (39 casos, contra a main):
  r@3 73.0% -> 75.7%, MRR 0.675 -> 0.684, ruído igual (10.9%). Boost por epic sozinho empata com
  a main no mesmo bench (não piora a busca geral).
- **Bench novo** `npm run bench:epic-cross`. `bench:recall` passa o caller do caso, então o kin e o
  boost por epic passam a ser medidos no A/B.

Minor: o primer pergunta "atualizar agora". O `npm run upgrade` ganha o passo 6/7, que roda
`build:entities` e `link:epics --no-llm` na hora (sem esperar chunk novo), e em seguida o Claude
mostra o diff do bloco v4 do CLAUDE.md (linha `[task]` e `recall_task` no fluxo de análise). A parte
do vínculo com Haiku segue o opt-in da distilação.

## 0.3.4 (2026-10-07)

- Hook recria o `value-model.json` quando ele não existe. O modelo mora em `~/.cache`, então
  máquina nova ou cache limpo ficava sem ele, e o hook só logava "pulado": chunk novo entrava
  sem `valueScore` (busca recente sem rebaixar narração) e o distill nunca achava sessão
  elegível ("0 sessões" a cada run). Agora o hook treina (~20s, em background) e reclassifica
  o acervo. `train:value --strict` não grava modelo que não separa (grafo pequeno): o hook
  tenta de novo na próxima sessão.

## 0.3.3 (2026-10-06)

- Primer para de dar `[ALERTA]` falso no primeiro SessionStart depois da instalação. O ingest
  async começa junto com o primer e só grava o `health.json` ao terminar, então "sem health"
  ali é corrida, não falha. Com lock de ingest ativo ou log sem nenhum start, o primer agora
  solta só um aviso de "primeiro ingest em andamento", sem mandar rodar ingest manual.

## 0.3.2 (2026-10-02)

- Fim do pico de CPU ao abrir sessão. Arquivo que mudou (sessão que cresceu) era re-embedado
  inteiro a cada SessionStart: ~300 chunks e ~75s com todos os cores cravados por sessão longa.
  Agora só passa pelo modelo o chunk novo ou com texto diferente; o resto reaproveita o vetor
  gravado. Medido: sessão de 295 chunks foi de ~73s pra 320ms, ingest do hook ~2s.
- Ingest do hook limita o onnx a metade dos cores (`MCP_TALKS_BG=1`). O bge-m3 escala mal
  depois de ~4 threads, então não fica mais lento. `EMBED_THREADS=N` no `.env` fixa o número.
  MCP server e `npm run` manual seguem sem limite.

Nada a fazer: `git pull` basta. A primeira sessão depois do pull ainda embeda o que estiver
pendente; dali em diante cai pra segundos.

## 0.3.1 (2026-10-01)

- Fim do `[ALERTA mcp-talks-cc] ... lock-held` falso. Abrir uma sessão (ou `/clear`) enquanto
  outro ingest rodava gravava `lock-held` no health, e o primer seguinte tratava como falha.
  Quem pula por lock ativo agora só loga; o dono do lock grava o status final.
- Primer compara só `major.minor` da versão: patch não pergunta "atualizar agora".

Nada a fazer: `git pull` basta.

## 0.3.0 (2026-09-29)

### O que fazer ao atualizar

1. Aceitar a pergunta de atualização (ou `npm run upgrade`). Aplica a constraint nova (`Decision.id`), instala os 2 hooks de push
   (`UserPromptSubmit` e `PostToolUse`), calibra a `confidence` por replay se ela ainda não
   estiver pronta e grava a versão instalada.
2. Aceitar a atualização do bloco de memória do `~/.claude/CLAUDE.md` (ou
   `npm run upgrade:claude-md -- --apply`). Sem isso o Claude continua buscando só no começo da
   conversa e não sabe o que fazer com os ponteiros de memória. Se vc customizou essa seção,
   confira o diff: ela é substituída inteira (o resto do arquivo não é tocado).
3. Abra uma sessão nova.

### Opcional

- **Distilação automática**: o Claude pergunta no fluxo de atualização. Desligada até vc
  responder que sim (gasta tokens de Haiku da sua conta, ~10k por sessão destilada). Sem ligar,
  dá pra rodar à mão: `npm run distill -- --limit=10`.
- **Gabarito de recall**: sem ele o gate de citação é percentil em vez de precisão medida, e
  o self-tune não valida proposta de tuning. Ver README, seção Medição.

### O que muda sem você fazer nada

- `search_memory` devolve 1 linha por hit (~450 tokens por busca em vez de ~3.5k) e a tool
  nova `expand_hits` traz o texto completo dos hits escolhidos.
- Ranking: relevância normalizada também no modo vetorial e no máximo 1 hit por sessão (fora
  as sessões da task citada na query). No bench de referência: recall@8 73% -> 89%.
- `confidence` não depende mais de tráfego recente (antes voltava a `null` quando o uso caía).
- `find_decisions` lê as decisões destiladas.

### Compatibilidade

- `structuredContent` só sai com `MCP_TALKS_STRUCTURED=1`. Quem consumia o JSON das tools
  por fora do Claude Code precisa ligar isso.
- `scope` não aceita mais `tool_output` nem `todo` (nunca tiveram chunk). Aceita `decision`.
