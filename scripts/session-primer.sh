#!/usr/bin/env bash
# Hook SessionStart SÍNCRONO. Duas funções:
#   1. registra a sessão (session_id + cwd) em sessions/<slug>.json, porque o
#      Claude Code não passa o session id pro processo MCP e sem isso o grader
#      do self-tune não consegue casar busca com resposta (echo sempre nulo).
#   2. injeta o primer aprendido (profile do self-tune) como additionalContext,
#      com aviso quando o ingest está atrasado ou falhando.
# Puro bash, sem Node/Neo4j: o primer.json já vem pré-escapado do builder JS.
set -u

# claude -p da distilação não recebe primer nem push
[ "${MCP_TALKS_IN_DISTILL:-}" = "1" ] && exit 0

CACHE="${HOME}/.cache/mcp-talks-cc"
PRIMER="${CACHE}/primer.json"
HEALTH="${CACHE}/health.json"
SESSIONS="${CACHE}/sessions"
STALE_SECS=172800 # 48h sem ingest bem-sucedido = memória desatualizada

# Path real da instalação (o hook é registrado com caminho absoluto pelo
# install-hook.mjs). Entra no WARN, que passa por sed com | e vai pra JSON:
# path com | & " \ cai num texto genérico em vez de quebrar a saída.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
case "$PROJECT_DIR" in
  "$HOME"/*) PROJECT_HINT="~${PROJECT_DIR#"$HOME"}" ;;
  *) PROJECT_HINT="$PROJECT_DIR" ;;
esac
case "$PROJECT_HINT" in
  '' | *[\|\&\"\\]*) PROJECT_HINT="no diretorio onde o mcp-talks-cc foi instalado" ;;
  *) PROJECT_HINT="em ${PROJECT_HINT}" ;;
esac

# ── 1) registro da sessão ───────────────────────────────────────────────────
INPUT="$(cat 2>/dev/null || true)"
SID="$(printf '%s' "$INPUT" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
CWD="$(printf '%s' "$INPUT" | sed -nE 's/.*"cwd"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
[ -z "$CWD" ] && CWD="$PWD"

if [ -n "$SID" ]; then
  # slug igual ao cwdSlug() de src/mcp/callerSession.ts
  SLUG="$(printf '%s' "$CWD" | tr -c '[:alnum:]' '-')"
  mkdir -p "$SESSIONS" 2>/dev/null
  printf '{"sessionId":"%s","project":"%s","updatedEpoch":%s}\n' \
    "$SID" "$CWD" "$(date +%s)" > "${SESSIONS}/${SLUG}.json" 2>/dev/null
  # limpa registros com mais de 7 dias
  find "$SESSIONS" -name '*.json' -mtime +7 -delete 2>/dev/null
fi

# ── 2) aviso de saúde do ingest ─────────────────────────────────────────────
# Texto ASCII e sem os caracteres | & " \ porque entra num sed sobre JSON.
WARN=""
if [ -s "$HEALTH" ]; then
  STATUS="$(sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$HEALTH" | head -1)"
  LAST_OK="$(sed -nE 's/.*"lastOkEpoch"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$HEALTH" | head -1)"
  [ -z "$LAST_OK" ] && LAST_OK=0
  AGE=$(( $(date +%s) - LAST_OK ))
  if [ "$LAST_OK" -eq 0 ] || [ "$AGE" -gt "$STALE_SECS" ]; then
    # lastOkEpoch=0 é "nunca", não "há 20 mil dias".
    if [ "$LAST_OK" -eq 0 ]; then LAST_TXT="nunca teve ingest ok"; else LAST_TXT="ultimo ingest ok ha $(( AGE / 86400 ))d"; fi
    WARN="[ALERTA mcp-talks-cc] memoria DESATUALIZADA: ${LAST_TXT} (status atual: ${STATUS}). Avise o user na primeira resposta e sugira rodar npm run ingest -- --source=all ${PROJECT_HINT}. Resultados de search_memory nao cobrem conversas recentes. "
  # lock-held é ingest em andamento, não falha (versões até 0.3.0 gravavam isso
  # no skip; o dono do lock grava o status real ao terminar)
  elif [ "$STATUS" != "ok" ] && [ "$STATUS" != "lock-held" ]; then
    WARN="[ALERTA mcp-talks-cc] ultimo ingest terminou em status ${STATUS}; conferir ~/.cache/mcp-talks-cc/ingest.log. "
  fi
# Sem health.json no primeiro SessionStart depois da instalação é corrida, não
# falha: o ingest async começa junto com este hook e só grava o health ao
# terminar. Lock presente ou log sem nenhum start = primeiro ingest rodando.
elif [ -d "${CACHE}/ingest.lock.d" ] || ! grep -q '\[session-ingest\] start' "${CACHE}/ingest.log" 2>/dev/null; then
  WARN="[mcp-talks-cc] primeiro ingest desta maquina em andamento: search_memory pode vir incompleto por alguns minutos. Nao precisa rodar ingest manual. "
else
  WARN="[ALERTA mcp-talks-cc] sem health.json: o hook de ingest nunca completou nesta maquina. Conferir ~/.cache/mcp-talks-cc/ingest.log. "
fi

# ── 2b) versão: repo atualizado (git pull) sem rodar o upgrade ───────────────
# O carimbo é gravado por scripts/upgrade.sh. Sem ele (instalação anterior à
# v0.3) também conta como desatualizado: é justamente quem precisa do aviso.
# Em vez de só avisar, o primer manda o Claude PERGUNTAR (atualizar agora ou
# não) e, aceito, perguntar de novo antes de mexer no CLAUDE.md. Recusa grava
# upgrade-snooze e cala a pergunta por alguns dias.
# Texto sem aspas duplas, | & ou \ : entra num sed sobre JSON.
REPO_VERSION="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "${PROJECT_DIR}/package.json" 2>/dev/null | head -1)"
INSTALLED="$(cat "${CACHE}/installed-version" 2>/dev/null || true)"
SNOOZE_UNTIL="$(cat "${CACHE}/upgrade-snooze" 2>/dev/null || echo 0)"
case "$SNOOZE_UNTIL" in ''|*[!0-9]*) SNOOZE_UNTIL=0 ;; esac
# versão do bloco = a do marcador no snippet do repo (fonte única)
SNIPPET_VER="$(sed -nE 's/.*mcp-talks-cc:snippet (v[0-9]+).*/\1/p' "${PROJECT_DIR}/docs/CLAUDE.md.snippet.md" 2>/dev/null | head -1)"
SNIPPET_OK=1
if [ -n "$SNIPPET_VER" ]; then
  grep -q "mcp-talks-cc:snippet ${SNIPPET_VER}" "${HOME}/.claude/CLAUDE.md" 2>/dev/null || SNIPPET_OK=0
fi
# Distilação sem resposta ainda (linha ausente no .env; =0 também é resposta).
DISTILL_STEP=""
if ! grep -q '^MCP_TALKS_DISTILL=' "${PROJECT_DIR}/.env" 2>/dev/null; then
  DISTILL_STEP="Por fim pergunte com AskUserQuestion se liga a distilacao automatica (opcoes: Ligar, Nao ligar). Explique em 3 linhas curtas, sem empurrar: O QUE E: ao abrir uma sessao, conversas ja encerradas viram regras, decisoes e armadilhas curtas (ate 300 chars, ex: limite de convites e por empresa por dia, mudar a config so vale no dia seguinte), ligadas a task e aos arquivos. POR QUE VALE: essas regras aparecem sozinhas no inicio da sessao e ao abrir um arquivo que ja deu problema, e uma regra custa uns 50 tokens de contexto contra 3 trechos de conversa de uns 150 cada; sem isso a memoria so devolve trecho bruto de conversa. CUSTO: roda em background com claude -p Haiku, uns 10k tokens da conta dele por sessao destilada (ate 5 recentes mais 3 antigas por sessao aberta), nao atrasa nada, desliga quando quiser. Depois rode npm run upgrade -- --distill=on ou --distill=off ${PROJECT_HINT}."
fi
if [ "$(date +%s)" -ge "$SNOOZE_UNTIL" ]; then
  CLAUDE_MD_STEP="depois rode npm run upgrade:claude-md -- --dry-run ${PROJECT_HINT}, resuma o diff pro user e pergunte com AskUserQuestion se aplica as regras novas no CLAUDE.md dele (opcoes: Aplicar, Manter como esta); se Aplicar, rode npm run upgrade:claude-md -- --apply (faz backup). ${DISTILL_STEP}"
  # Compara só major.minor: patch é por convenção sem passo de upgrade (o código
# e os scripts já valem no git pull), então não merece pergunta.
if [ -n "$REPO_VERSION" ] && [ "${REPO_VERSION%.*}" != "${INSTALLED%.*}" ]; then
    WARN="${WARN}[ATUALIZACAO mcp-talks-cc] versao ${REPO_VERSION} disponivel (instalada: ${INSTALLED:-anterior a 0.3.0}). Na PRIMEIRA resposta, antes do resto, pergunte com AskUserQuestion se quer atualizar o mcp-talks-cc agora (opcoes: Atualizar agora, Agora nao). Se Atualizar agora: rode npm run upgrade ${PROJECT_HINT}; ${CLAUDE_MD_STEP} Se Agora nao: rode npm run upgrade -- --snooze no mesmo diretorio (adia 3 dias). Novidades em CHANGELOG.md. "
  elif [ "$SNIPPET_OK" -eq 0 ]; then
    WARN="${WARN}[ATUALIZACAO mcp-talks-cc] o bloco de memoria do CLAUDE.md esta desatualizado. Na PRIMEIRA resposta, ${CLAUDE_MD_STEP#depois } Se Manter como esta: rode npm run upgrade -- --snooze ${PROJECT_HINT}. "
  elif [ -n "$DISTILL_STEP" ]; then
    WARN="${WARN}[ATUALIZACAO mcp-talks-cc] Na PRIMEIRA resposta, antes do resto: ${DISTILL_STEP#Por fim } "
  fi
fi

# ── 2c) regras do epic da task da branch (pré-calculado pelo link:epics) ───
# A sessão nova ainda não está no grafo; o arquivo já vem sanitizado pra sed.
EPIC_TXT=""
BRANCH="$(git -C "$CWD" branch --show-current 2>/dev/null || true)"
TASK_KEY="$(printf '%s' "$BRANCH" | grep -oiE '(EDC|US|DEV|QUAL)-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]' | sed -E 's/-0+([0-9])/-\1/')"
if [ -n "$TASK_KEY" ] && [ -s "${CACHE}/epic-primer/${TASK_KEY}.txt" ]; then
  EPIC_TXT=" [memória mcp-talks-cc: ${TASK_KEY}] $(head -c 1500 "${CACHE}/epic-primer/${TASK_KEY}.txt" | tr -d '\n\r\"\\|&')"
fi

# ── 3) saída ────────────────────────────────────────────────────────────────
PRIMER_OK=0
if [ -s "$PRIMER" ]; then
  # primer com mais de 14 dias reflete trabalho velho; o ALERTA não expira.
  if [ -z "$(find "$PRIMER" -mtime +14 2>/dev/null)" ]; then
    PRIMER_OK=1
  fi
fi

if [ "$PRIMER_OK" -eq 1 ]; then
  # Fail-open: texto que quebre o sed (| & \\ que escapou da limpeza) não pode
  # derrubar o primer inteiro. Sem o bloco do epic, sai o primer como era.
  if OUT="$(sed -e "s|\"additionalContext\":\"|\"additionalContext\":\"${WARN}|" -e "s|\"}}[[:space:]]*\$|${EPIC_TXT}\"}}|" "$PRIMER" 2>/dev/null)" && [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
  else
    sed -e "s|\"additionalContext\":\"|\"additionalContext\":\"${WARN}|" "$PRIMER"
  fi
  exit 0
fi

if [ -n "$WARN" ] || [ -n "$EPIC_TXT" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "${WARN}${EPIC_TXT}"
fi
exit 0
