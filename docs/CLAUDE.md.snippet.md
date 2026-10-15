# Snippet pro seu `~/.claude/CLAUDE.md`

Cole o bloco abaixo no seu `~/.claude/CLAUDE.md` (escopo de usuário, vale em todos os
projetos). **Sem ele o MCP conecta mas não é usado direito:** o Claude não sabe quando
buscar, e lê `score` em vez de `confidence` — o que aprova qualquer hit, inclusive lixo.

Substitua `KEY` pelo prefixo do seu projeto Jira (`EDC`, `US`, `AQ`, ...) onde fizer
sentido, ou deixe genérico como está — o retrieval já trata `[A-Z]{2,}-\d+` como token
literal, então funciona pra qualquer prefixo.

---

<!-- mcp-talks-cc:snippet v4 (npm run upgrade compara esta versão) -->
## Memória cross-conversa (MCP `mcp-talks-cc`)

O server MCP se chama `mcp-talks-cc` (tools no formato `mcp__mcp-talks-cc__*`). Sempre referir a ele por esse nome, nunca "memory". MCP local indexa conversas Claude Code passadas, plans, todos e task memory em Neo4j com busca vetorial. Tools: `search_memory`, `expand_hits`, `get_session_transcript`, `find_related_plans`, `find_decisions`, `list_project_activity`, `recall_task`. Resources: `memory://stats`, `memory://schema`, `memory://profile` (perfil aprendido pelo self-tune; use pra responder "oq vc aprendeu de mim").

### Quando consultar (regra firme)

Antes de responder sobre decisão passada, abordagem já discutida, ou contexto de task/projeto: **busca primeiro com `search_memory`, só então responde**. Não é opcional nesses casos.

**Busca de novo no meio da conversa**, não só no começo. Gatilhos:
- o assunto mudou (outra feature, outro fluxo, outro repo);
- vai tomar decisão de design ou escolher entre abordagens;
- apareceu um erro/comportamento que parece já visto;
- vai mexer em arquivo/módulo que não abriu ainda nesta conversa;
- o user referiu o passado ("como fizemos", "aquela vez", "já discutimos").

2-3 buscas por conversa é o esperado. A saída é brief (1 linha por hit, ~400 tokens com k=8), então re-buscar é barato. Leia texto completo só do que for usar, com `expand_hits({ ids })` (o id curto de 12 chars basta).

Exceções (não buscar): pergunta trivial/casual, sintaxe genérica de linguagem/framework, assunto claramente novo que nunca passou pelos projetos.

No início de cada sessão pode vir um primer `[memória mcp-talks-cc ...]` com projetos quentes, temas, buscas de alto valor e o **gate de citação vigente**. Se a pergunta bate com tema do primer, é sinal forte de buscar. O primer é só índice: pra detalhe, sempre `search_memory`.

### Ponteiros automáticos (push)

Hooks podem injetar 1 linha `[memória mcp-talks-cc] talvez relevante: id=... conf=... | gist` no prompt, ou `[memória mcp-talks-cc] <arquivo> já foi alterado em: <tasks>` ao abrir arquivo. É **sinal, não resposta**: só passou no gate de similaridade.
- Se o gist parece útil pro que está fazendo, chame `expand_hits` com o id antes de usar. Nunca cite ponteiro sem ler.
- Se não parece útil, ignore em silêncio. Não comente o ponteiro com o user.
- Ponteiro de arquivo: se a task citada tem a ver com a mudança atual, vale `search_memory` com o nome do arquivo ou da task.

### Fluxo de análise de task do Jira

Quando o user pedir "analise KEY-1234" (ou variações tipo "vamos mexer na KEY-1234"), onde `KEY` é qualquer prefixo de projeto Jira:

1. **Busca a task no Jira** normalmente (skill de análise de issue ou MCP atlassian)
   - Logo depois, **escreva 1 linha fixa** com a hierarquia que veio do Jira, no formato exato:
     `[task] KEY-1234 pai=KEY-1200 (Epic: <título do pai>)` (use `História:` se o pai for story; `pai=-` se não tiver pai).
     O ingest do `mcp-talks-cc` lê essa linha e liga a task ao epic, que é o que faz regra do back aparecer no front. Não pule, mesmo que o pai pareça óbvio.
   - Chame `recall_task({ taskKey })` (~300 tokens, sem snippet): mostra o epic e as tasks irmãs em outros repos. Se tiver irmã, `find_decisions({ taskId })` traz as regras dela (ex: regra do back que vale pro front).
2. Da description + comentários da task, **identifique 2-3 tópicos técnicos centrais** (ex: "feature flag", "react query cache", "validação form com react-hook-form", "migration Laravel"). Você decide o que é relevante — não copie literalmente, abstraia.
3. Para cada tópico, chame `search_memory({ query: <tópico>, k: 4 })`. Se a task menciona repo específico, passe `project`: é soft boost (prioriza o repo sem esconder os outros, regras cruzam repos). Só use `projectStrict: true` quando quiser literalmente 1 repo.
4. **Avalie `confidence`, nunca `score`** (ver "Como ler os números" abaixo). Os cortes `FORTE` e `PISO` não são constantes: leia os valores vigentes antes de decidir (ver abaixo de onde).
   - confidence >= `FORTE`: hit forte. Integre 1 frase no início da análise no formato: `"Já discutimos <tópico> em <plan: slug> / <session: <sessionId> / <task: KEY-5678>>: <gist 1 linha>"`
   - confidence entre `PISO` e `FORTE`: hit fraco. Mencione apenas se for diretamente útil. Cite com cautela ("possivelmente relacionado:...")
   - todos < `PISO`: não mencione memória. Apenas prossiga com análise da task.
   - `confidence: null` (calibração ainda coletando amostras): trate como hit fraco, nunca como forte.
5. **Limite máximo: 3 referências de memória no output total**, mesmo que vários tópicos tenham hits fortes. Resuma. Não cole snippets longos.
6. Output final: análise da task Jira + (no máx) 3 linhas de "memória relevante" + plano de execução normal.

### Como ler os números do `search_memory`

Cada hit vem com `conf=` (e `score=` no `detail: 'full'`). **São coisas diferentes:**

- `confidence` (0..1): percentil do hit contra a distribuição histórica de similaridade. `conf=0.90` significa "melhor que 90% dos hits que essa busca normalmente devolve". É comparável entre queries, então **é o único número que decide se cita**. `null` = calibração local ainda sem amostra suficiente.
- `score`: fusão vetor + BM25, serve só pra ordenar dentro da MESMA query. Não é comparável entre queries e não tem corte absoluto útil: o embedder (bge-m3) devolve cosseno entre 0.86 e 0.91 pra praticamente qualquer coisa. Cortar score em 0.70 aprova 100% dos hits, inclusive lixo.
- O cabeçalho traz `pool=N vec_med=X`: é o piso de similaridade daquela busca. Hit perto da mediana do pool é ruído.
- **`FORTE` e `PISO` não são constantes.** Vêm do gabarito de recall (`npm run bench:recall`): FORTE é a menor confidence em que 80% dos hits são relevantes de verdade, PISO a de 50%. Sem bench recente, cai pra p75/p25 do melhor hit por query, que é cota e deriva com o volume.
- **Fonte dos valores vigentes:** a linha `gate de citação desta sessão` do primer. Use o valor de lá, não um lembrado.
- **Fallback**, quando o primer não traz o gate ou a busca devolve `conf n/a`: `FORTE = 0.90`, `PISO = 0.59`, e todo o meio é fraco. Com `conf n/a` nenhum hit pode ser tratado como forte, independente do score.

### Anti-padrões

- Não chame `search_memory` para cada palavra. Tópicos abstratos (`"feature flag pattern"`) recupera melhor que palavras isoladas (`"flag"`).
- Não cole snippets crus da memória na resposta. Resuma em 1 frase.
- Não use `detail: 'full'` por padrão: brief + `expand_hits` no que importa gasta uma fração do contexto.
- Se `memory://stats` mostrar Chunk < 100, o MCP está vazio/quebrado — avise o user e pule busca de memória.
- Tópicos genéricos ("typescript", "react") trazem ruído. Prefira combinar com domínio: "typescript zod validation form".

### Hybrid retrieval & diversidade

- `search_memory` é hybrid (vector + BM25 fulltext), mas o BM25 **só liga com token literal de verdade**: `KEY-1234`, path com extensão, camelCase (`useEffect`), snake_case, CONST_CASE, sigla (`MCP`) ou versão (`5.26`). Pergunta em prosa roda vetor puro, e isso é o certo. Passe a query natural, não tente truncar.
- Parâmetro `diversity` (0..1, default 0.7) controla MMR. Use `0.3` quando quiser variedade ("panorama do tema X em todas conversas"), `0.9` quando quiser foco em 1 tópico ("aprofunde decisão Y"). Por padrão vem no máx 1 hit por sessão (cobre mais conversas); `diversity >= 0.9` tira esse teto.
- Pra "mostre outras conversas parecidas a esta", use `find_similar_chunks({ chunkId, k: 5 })` em vez de nova `search_memory`. Não re-embeda — usa edges SIMILAR_TO precomputadas (~10ms).

### Ingest: automático, com alarme

O hook SessionStart ingere sozinho (incremental, sobe o Neo4j se estiver parado, lock por pid). **Não existe re-ingest manual de rotina.**

Se o primer trouxer uma linha `[ALERTA mcp-talks-cc]`, a memória está desatualizada ou o ingest falhou: avise na primeira resposta e rode

```bash
cd /ABSOLUTE/PATH/TO/mcp-talks-cc && npm run ingest -- --source=all
```

Diagnóstico: `~/.cache/mcp-talks-cc/health.json` (status + último ok) e `ingest.log`.

Limite conhecido: o Claude Code poda transcript com 90 dias (`cleanupPeriodDays`). O grafo é o único registro do que já foi podado, então gap de ingest maior que isso é perda definitiva.
