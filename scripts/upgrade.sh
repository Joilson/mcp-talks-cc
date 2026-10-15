#!/usr/bin/env bash
# Upgrade idempotente de uma instalação existente do mcp-talks-cc.
#
#   git pull && npm run upgrade
#   npm run upgrade -- --snooze[=DIAS]   # 'agora não': primer não pergunta por N dias (default 3)
#   npm run upgrade -- --distill=on|off  # resposta da pergunta de distilação (grava no .env)
#   npm run upgrade -- --epic-llm=on|off # resposta da pergunta do vínculo task -> epic com Haiku
#
# Seguro re-rodar. Não re-ingere nada nem apaga dado: só aplica o que uma versão
# nova precisa (deps, schema, hooks, calibração) e grava a versão instalada em
# ~/.cache/mcp-talks-cc/installed-version. O session-primer.sh compara esse
# carimbo com o package.json e avisa no início da sessão quando o repo foi
# atualizado sem rodar isto.
#
# O que NÃO dá pra automatizar vai impresso no fim (bloco do CLAUDE.md,
# opt-ins que gastam tokens). Detalhe por versão em CHANGELOG.md.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
CACHE="${HOME}/.cache/mcp-talks-cc"
STAMP="${CACHE}/installed-version"
# versão do bloco = a do marcador no snippet do repo (fonte única)
SNIPPET_VERSION="$(sed -nE 's/.*mcp-talks-cc:snippet (v[0-9]+).*/\1/p' docs/CLAUDE.md.snippet.md | head -1)"
mkdir -p "$CACHE"

# Resposta 'agora não' da pergunta que o primer manda o Claude fazer.
for a in "$@"; do
  case "$a" in
    --snooze|--snooze=*)
      DAYS="${a#--snooze=}"; [ "$DAYS" = "--snooze" ] && DAYS=3
      case "$DAYS" in ''|*[!0-9]*) DAYS=3 ;; esac
      echo $(( $(date +%s) + DAYS * 86400 )) > "${CACHE}/upgrade-snooze"
      echo "mcp-talks-cc: atualização adiada por ${DAYS} dia(s). Rode npm run upgrade quando quiser."
      exit 0 ;;
  esac
done
# Respostas das perguntas de opt-in (gastam token Haiku). Grava explícito (=1
# ou =0): linha ausente é o que faz o primer perguntar, então "não" também fica.
set_env() { # chave valor comentário
  touch .env
  if grep -q "^$1=" .env; then
    tmp="$(mktemp "${TMPDIR:-/tmp}/mcp-env.XXXXXX")"
    sed -E "s/^$1=.*/$1=$2/" .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
  else
    printf '\n# %s (ver .env.example)\n%s=%s\n' "$3" "$1" "$2" >> .env
  fi
}
for a in "$@"; do
  case "$a" in
    --distill=on|--distill=off)
      V=0; [ "$a" = "--distill=on" ] && V=1
      set_env MCP_TALKS_DISTILL "$V" "distilação automática no hook"
      [ "$V" = 1 ] && echo "mcp-talks-cc: distilação automática LIGADA (vale a partir da próxima sessão)." \
                   || echo "mcp-talks-cc: distilação automática desligada. Manual: npm run distill -- --limit=10"
      exit 0 ;;
    --epic-llm=on|--epic-llm=off)
      V=0; [ "$a" = "--epic-llm=on" ] && V=1
      set_env MCP_TALKS_EPIC_LLM "$V" "vínculo task -> epic com Haiku no hook"
      [ "$V" = 1 ] && echo "mcp-talks-cc: vínculo task -> epic com Haiku LIGADO (maior precisão; vale a partir da próxima sessão)." \
                   || echo "mcp-talks-cc: vínculo task -> epic só com linha [task] e regex. Manual: npm run link:epics -- --apply --limit=10"
      exit 0 ;;
  esac
done
rm -f "${CACHE}/upgrade-snooze"

step() { echo; echo "==> $1"; }
REPO_VERSION="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)"
FROM="$(cat "$STAMP" 2>/dev/null || echo 'desconhecida')"
echo "mcp-talks-cc: instalada ${FROM} -> repo ${REPO_VERSION}"

step "1/7 dependências"
# package-lock mais novo que o último install = dependência mudou
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install
else
  echo "  sem mudança de dependência, pulando."
fi

step "2/7 Neo4j"
npm run infra:up

step "3/7 schema (constraints e índices novos, IF NOT EXISTS)"
npm run db:init

step "4/7 hooks do Claude Code (merge sem sobrescrever, backup em settings.json.bak)"
node scripts/install-hook.mjs
chmod +x scripts/*.sh

step "5/7 calibração de confidence"
# Sem calibração pronta, search_memory devolve conf n/a e o push não dispara.
READY="$(sed -nE 's/.*"ready":[[:space:]]*(true|false).*/\1/p' "${CACHE}/score-calibration.json" 2>/dev/null | head -1)"
if [ "$READY" = "true" ]; then
  echo "  já calibrada, pulando."
else
  npm run calibrate:probe
fi

step "6/7 entidades e vínculo task -> epic (sem LLM, segundos)"
# Idempotente. No hook isso só roda quando entra chunk novo; aqui garante que a
# instalação atualizada já sai com Task/File, PART_OF e o primer por epic.
npm run build:entities -- --apply || echo "  build:entities falhou (o hook tenta de novo)"
npm run link:epics -- --apply --no-llm || echo "  link:epics falhou (o hook tenta de novo)"
step "7/7 carimbo de versão"
echo "$REPO_VERSION" > "$STAMP"
echo "  instalada agora: ${REPO_VERSION}"

# ── passos manuais ─────────────────────────────────────────────────────────
MANUAL=0
echo
echo "================================================================"
if ! grep -q "mcp-talks-cc:snippet ${SNIPPET_VERSION}" "${HOME}/.claude/CLAUDE.md" 2>/dev/null; then
  MANUAL=1
  echo "MANUAL: seu ~/.claude/CLAUDE.md não tem o bloco ${SNIPPET_VERSION} do mcp-talks-cc."
  echo "  Veja o diff: npm run upgrade:claude-md -- --dry-run"
  echo "  Aplique:     npm run upgrade:claude-md -- --apply   (backup automático)"
  echo "  (é o que faz o Claude re-buscar no meio da conversa, usar brief +"
  echo "  expand_hits e tratar os ponteiros de memória)."
  echo
fi
DISTILL_ON="$(sed -nE 's/^MCP_TALKS_DISTILL=([^[:space:]#]*).*/\1/p' .env 2>/dev/null | tail -1)"
if [ "$DISTILL_ON" != "1" ]; then
  echo "OPCIONAL: distilação automática está DESLIGADA (gasta tokens de Haiku da"
  echo "  sua conta, ~10k por sessão). Pra ligar: npm run upgrade -- --distill=on"
  echo "  Manual sem ligar: npm run distill -- --limit=10"
  echo
fi
EPIC_LLM="$(sed -nE 's/^MCP_TALKS_EPIC_LLM=([^[:space:]#]*).*/\1/p' .env 2>/dev/null | tail -1)"
[ -z "$EPIC_LLM" ] && EPIC_LLM="$DISTILL_ON"
if [ "$EPIC_LLM" != "1" ]; then
  echo "OPCIONAL: vínculo task -> epic com Haiku DESLIGADO. Sem ele só entra o caso"
  echo "  literal (Épico EDC-X), ~1/3 dos pais; com ele, maior precisão e cobertura"
  echo "  (~2k tokens por sessão que cita epic). Pra ligar: npm run upgrade -- --epic-llm=on"
  echo
fi
if [ ! -f "${CACHE}/recall-eval.jsonl" ]; then
  echo "OPCIONAL: sem gabarito de recall, o gate de citação usa percentil (cota)"
  echo "  em vez de precisão medida. Ver README, seção Medição."
  echo
fi
echo "Abra uma sessão NOVA do Claude Code: o MCP server e os hooks carregam o"
echo "código novo só no início da sessão."
[ "$MANUAL" -eq 1 ] && echo "Há passo MANUAL acima."
echo "Mudanças desta versão: ${PROJECT_DIR}/CHANGELOG.md"
echo "================================================================"
