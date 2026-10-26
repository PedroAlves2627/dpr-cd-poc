#!/usr/bin/env bash
# Helper para o POC CD -> ServiceNow Digital Product Release (DPR)
#
# Uso:
#   dpr.sh create <nome> <versao>      -> cria a release (fica Pending) e imprime o releaseId
#   dpr.sh start <releaseId>           -> chama o endpoint custom de start (DPR_START_ENDPOINT)
#   dpr.sh wait-started <releaseId>    -> espera até a release estar In Progress
#   dpr.sh gate <releaseId> [fase]     -> corre policies, espera compliant e completa a fase atual
#   dpr.sh complete <releaseId>        -> espera por Review e chama DPR_COMPLETE_ENDPOINT (-> Completed)
#   dpr.sh change-create <releaseId> <versao>   -> cria um normal change (Change Mgmt API); imprime "sys_id number"
#   dpr.sh change-attach <releaseId> <changeId> -> associa o CR à release (API oficial related_task)
#   dpr.sh change-wait <changeId>               -> espera até o CR estar aprovado (falha se rejeitado)
#   dpr.sh status <releaseId>          -> mostra o estado da release e das policies
#
# Variáveis de ambiente:
#   SN_INSTANCE, SN_USER, SN_PASS                       (obrigatórias)
#   DPR_TEMPLATE_ID, DPR_PRODUCT_ID, DPR_RELEASE_OWNER  (para create)
#   DPR_START_ENDPOINT   ex: /api/2076683/dpr_poc/release/{id}/start  (vazio = start manual)
#   DPR_COMPLETE_ENDPOINT ex: /api/2076683/dpr_poc/release/{id}/complete  (vazio = complete manual)
#   DPR_START_TIMEOUT    segundos à espera do start (default 600)
#   DPR_POLICY_TIMEOUT   segundos à espera de compliance (default 300)
#   DPR_CHANGE_ENDPOINT  opcional: endpoint custom para ligar o CR à fase em vez de related_task
#   CHG_ASSIGNMENT_GROUP sys_id do grupo do CR (opcional)
#   CHG_APPROVAL_TIMEOUT segundos à espera da aprovação do CR (default 1800)
#   DPR_PHASES           nomes das fases do template por ordem, ex: "Build,Test,Deploy"
#                        (permite ao gate saltar uma fase que o DPR já completou sozinho)

set -euo pipefail

: "${SN_INSTANCE:?SN_INSTANCE em falta}"
: "${SN_USER:?SN_USER em falta}"
: "${SN_PASS:?SN_PASS em falta}"

log() { echo "$*" >&2; }

# Limpa espaços/quebras de linha que costumam vir ao colar secrets
trim() { local s=$1; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }
SN_INSTANCE=$(trim "$SN_INSTANCE"); SN_USER=$(trim "$SN_USER"); SN_PASS=$(trim "$SN_PASS")

SN_INSTANCE="${SN_INSTANCE%/}"
DPR_API="$SN_INSTANCE/api/sn_dpr/v1/digital_product_release"

# call <METHOD> <URL> [JSON] -> imprime o body em stdout; falha em HTTP >= 400 ou result.error == true
call() {
  local method=$1 url=$2 data=${3:-} tmp code body
  tmp=$(mktemp)
  local args=(-sS -o "$tmp" -w '%{http_code}' -u "$SN_USER:$SN_PASS"
              -H 'Accept: application/json' -X "$method" "$url")
  if [[ -n "$data" ]]; then
    args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  code=$(curl "${args[@]}")
  body=$(cat "$tmp"); rm -f "$tmp"
  log "[$method ${url#"$SN_INSTANCE"}] HTTP $code"
  log "$body"
  if (( code >= 400 )) || [[ "$(jq -r '.result.error // false' <<<"$body" 2>/dev/null)" == "true" ]]; then
    log "::error::Chamada ao ServiceNow falhou (HTTP $code)"
    exit 1
  fi
  printf '%s' "$body"
}

release_state() {
  call GET "$SN_INSTANCE/api/now/table/sn_dpr_model_release/$1?sysparm_fields=number,state&sysparm_display_value=true" \
    | jq -r '.result.state'
}

cmd_create() {
  local name=${1:?nome em falta} version=${2:?versao em falta}
  : "${DPR_TEMPLATE_ID:?}" "${DPR_PRODUCT_ID:?}" "${DPR_RELEASE_OWNER:?}"
  local payload body id
  payload=$(jq -n \
    --arg name "$name" --arg version "$version" \
    --arg owner "$DPR_RELEASE_OWNER" --arg template "$DPR_TEMPLATE_ID" --arg product "$DPR_PRODUCT_ID" \
    '{name: $name, releaseOwner: $owner, templateId: $template, productId: $product,
      autoCreateVersionName: $version, releaseDescription: "Criada pelo pipeline CD (POC)",
      isDraftRelease: false}')
  body=$(call POST "$DPR_API/release" "$payload")
  id=$(jq -r '.result.releaseId' <<<"$body")
  [[ -n "$id" && "$id" != "null" ]] || { log "::error::Sem releaseId na resposta"; exit 1; }
  echo "$id"
}

cmd_start() {
  local id=${1:?releaseId em falta}
  if [[ -z "${DPR_START_ENDPOINT:-}" ]]; then
    log "::warning::DPR_START_ENDPOINT não definido — carrega em 'Start release' no DPR Workspace."
    return 0
  fi
  call POST "$SN_INSTANCE${DPR_START_ENDPOINT//\{id\}/$id}" '{}' >/dev/null
}

cmd_wait_started() {
  local id=${1:?releaseId em falta} timeout=${DPR_START_TIMEOUT:-600} waited=0 state
  while :; do
    state=$(release_state "$id")
    log "Estado da release: $state"
    [[ "$state" == "In Progress" ]] && return 0
    (( waited >= timeout )) && { log "::error::Release não passou a In Progress em ${timeout}s"; exit 1; }
    sleep 10; waited=$((waited + 10))
  done
}

# Posição (1..n) de uma fase na lista DPR_PHASES ("Build,Test,Deploy"); 0 se não estiver
phase_index() {
  local name=$1 i=1 p
  IFS=',' read -ra _phases <<<"${DPR_PHASES:-}"
  for p in "${_phases[@]}"; do
    [[ "$(trim "$p")" == "$name" ]] && { echo "$i"; return; }
    i=$((i + 1))
  done
  echo 0
}

current_phase() {
  ( call GET "$DPR_API/releases/$1/policies/status" ) 2>/dev/null | jq -r '.result.overallSummary.currentPhase // empty'
}

cmd_gate() {
  local id=${1:?releaseId em falta} expected=${2:-} timeout=${DPR_POLICY_TIMEOUT:-300} waited=0
  local body compliant phase state ie ic

  # 1) A release ainda está ativa? Se o DPR já a fechou sozinho, não há nada para completar.
  state=$(release_state "$id")
  if [[ "$state" != "In Progress" ]]; then
    if [[ "$state" == "Review" || "$state" == "Completed" ]]; then
      log "::warning::Release já está em '$state' — esta fase foi completada automaticamente pelo DPR. Nada a fazer."
      return 0
    fi
    log "::error::Release em '$state' (esperava In Progress)"; exit 1
  fi

  # 2) Em que fase estamos, e é a que este stage deve fechar?
  phase=$(current_phase "$id")
  log "Fase atual no DPR: '${phase:-?}'  |  fase deste stage: '${expected:-(não definida)}'"
  if [[ -n "$expected" && -n "$phase" && "$phase" != "$expected" ]]; then
    ie=$(phase_index "$expected"); ic=$(phase_index "$phase")
    if (( ie > 0 && ic > 0 && ie < ic )); then
      log "::warning::'$expected' já foi completada (DPR já está em '$phase'). A saltar este gate."
      return 0
    fi
    log "::error::Fase atual é '$phase', esperava '$expected'"; exit 1
  fi

  # 3) Correr policies, esperar compliance e completar
  call POST "$DPR_API/release/$id/policies/run" >/dev/null
  while :; do
    body=$(call GET "$DPR_API/releases/$id/policies/status")
    compliant=$(jq -r '.result.overallSummary.compliant' <<<"$body")
    [[ "$compliant" == "true" ]] && break
    (( waited >= timeout )) && { log "::error::Policies da fase '$phase' não ficaram compliant em ${timeout}s"; exit 1; }
    sleep 15; waited=$((waited + 15))
  done
  call POST "$DPR_API/release_id/$id/complete_phase" >/dev/null
  log "::notice::Fase '$phase' completa"

  # 4) Mostrar para onde o DPR avançou (ajuda a detetar transições automáticas)
  sleep 3
  state=$(release_state "$id")
  log "Depois do complete_phase: release '$state', fase atual '$( [[ "$state" == "In Progress" ]] && current_phase "$id" )'"
}

cmd_complete() {
  local id=${1:?releaseId em falta} timeout=${DPR_START_TIMEOUT:-600} waited=0 state
  # Depois da última fase o DPR leva a release para Review (pode demorar uns segundos)
  while :; do
    state=$(release_state "$id")
    log "Estado da release: $state"
    [[ "$state" == "Completed" ]] && { log "::notice::Release já está Completed"; return 0; }
    [[ "$state" == "Review" ]] && break
    (( waited >= 60 )) && { log "::error::Release em '$state', esperava Review depois da última fase"; exit 1; }
    sleep 5; waited=$((waited + 5))
  done

  if [[ -z "${DPR_COMPLETE_ENDPOINT:-}" ]]; then
    log "::warning::DPR_COMPLETE_ENDPOINT não definido — carrega em 'Complete release' no DPR Workspace."
  else
    call POST "$SN_INSTANCE${DPR_COMPLETE_ENDPOINT//\{id\}/$id}" '{}' >/dev/null
  fi

  waited=0
  while :; do
    state=$(release_state "$id")
    [[ "$state" == "Completed" ]] && { log "::notice::Release Completed"; return 0; }
    (( waited >= timeout )) && { log "::error::Release não passou a Completed em ${timeout}s (está '$state')"; exit 1; }
    sleep 10; waited=$((waited + 10))
  done
}

cmd_status() {
  local id=${1:?releaseId em falta}
  echo "Estado: $(release_state "$id")"
  call GET "$DPR_API/releases/$id/policies/status" | jq '.result.overallSummary' || true
}

# ---------- Change Request ----------

cmd_change_create() {
  local id=${1:?releaseId em falta} version=${2:?versao em falta} payload body chg num
  payload=$(jq -n --arg v "$version" --arg rel "$id" --arg run "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
    --arg grp "${CHG_ASSIGNMENT_GROUP:-}" \
    '{short_description: ("Deploy para PROD da versão " + $v),
      description: ("Change criado pelo pipeline CD.\nRelease DPR: " + $rel + "\nPipeline: " + $run),
      justification: "Deploy automático via pipeline CD (POC)",
      implementation_plan: "Deploy automático pelo pipeline após aprovação.",
      backout_plan: "Re-deploy da versão anterior pelo pipeline.",
      test_plan: "Testes automáticos do stage de testes do pipeline."}
     + (if $grp != "" then {assignment_group: $grp} else {} end)')
  body=$(call POST "$SN_INSTANCE/api/sn_chg_rest/change/normal" "$payload")
  chg=$(jq -r '.result.sys_id.value // .result.sys_id // empty' <<<"$body")
  num=$(jq -r '.result.number.value // .result.number // empty' <<<"$body")
  [[ -n "$chg" ]] || { log "::error::Sem sys_id do change na resposta"; exit 1; }
  log "::notice::Change $num criado ($chg)"
  echo "$chg $num"
}

cmd_change_attach() {
  local id=${1:?releaseId em falta} chg=${2:?changeId em falta}
  if [[ -n "${DPR_CHANGE_ENDPOINT:-}" ]]; then
    # Opcional: endpoint custom que liga o CR a uma fase (sn_dpr_model_release_phase_cr)
    call POST "$SN_INSTANCE${DPR_CHANGE_ENDPOINT//\{id\}/$id}" "$(jq -n --arg c "$chg" '{changeId: $c}')" >/dev/null
    log "::notice::Change ligado à fase da release (endpoint custom)"
  else
    # Por omissão: API oficial do DPR — o CR fica no Release Scope da release.
    # Requer change_request em sn_dpr_model.release_related_task_types.
    call POST "$DPR_API/release/$id/related_task" "$(jq -n --arg c "$chg" '{taskIds: [$c]}')" >/dev/null
    log "::notice::Change associado à release (related_task)"
  fi
}

cmd_change_wait() {
  local chg=${1:?changeId em falta} timeout=${CHG_APPROVAL_TIMEOUT:-1800} waited=0 rec approval state num
  while :; do
    rec=$( ( call GET "$SN_INSTANCE/api/now/table/change_request/$chg?sysparm_fields=number,state,approval" ) 2>/dev/null )
    approval=$(jq -r '.result.approval' <<<"$rec"); state=$(jq -r '.result.state' <<<"$rec"); num=$(jq -r '.result.number' <<<"$rec")
    log "Change $num: approval=$approval state=$state"
    case "$approval" in
      approved) log "::notice::Change $num aprovado"; return 0 ;;
      rejected) log "::error::Change $num rejeitado — deploy para PROD cancelado"; exit 1 ;;
    esac
    # state -4 = Cancelled / 4 = Canceled em algumas versões
    [[ "$state" == "4" ]] && { log "::error::Change $num cancelado"; exit 1; }
    (( waited >= timeout )) && { log "::error::Change $num não foi aprovado em ${timeout}s"; exit 1; }
    sleep ${CHG_POLL:-30}; waited=$((waited + ${CHG_POLL:-30}))
  done
}

# Diagnóstico de credenciais sem revelar valores
cmd_check_auth() {
  local q="'\"" warn=0 code
  log "SN_INSTANCE = $SN_INSTANCE"
  log "SN_USER     = ${#SN_USER} caracteres, começa por '${SN_USER:0:1}', acaba em '${SN_USER: -1}'"
  log "SN_PASS     = ${#SN_PASS} caracteres"
  for v in SN_USER SN_PASS; do
    local val=${!v}
    if [[ $q == *"${val:0:1}"* || $q == *"${val: -1}"* ]]; then
      log "::warning::$v começa ou acaba com aspas — cola o valor sem aspas"; warn=1
    fi
  done
  [[ "$SN_INSTANCE" == https://*.service-now.com ]] || log "::warning::SN_INSTANCE devia ser https://devXXXXX.service-now.com"
  code=$(curl -sS -o /dev/null -w '%{http_code}' -u "$SN_USER:$SN_PASS" -H 'Accept: application/json' \
         "$SN_INSTANCE/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id")
  log "Teste de autenticação (Table API sys_user): HTTP $code"
  case $code in
    200) log "::notice::Credenciais OK" ;;
    401) log "::error::ServiceNow recusou as credenciais (401). Utilizador/password errados, 'Password needs reset' marcado, ou utilizador locked/inativo."; exit 1 ;;
    403) log "::notice::Autenticado, mas sem acesso a sys_user (normal num utilizador só com roles DPR)" ;;
    *)   log "::error::Resposta inesperada ($code) — a PDI pode estar a hibernar; acorda-a em developer.servicenow.com"; exit 1 ;;
  esac
}

case "${1:-}" in
  check-auth)   cmd_check_auth ;;
  create)       shift; cmd_create "$@" ;;
  start)        shift; cmd_start "$@" ;;
  wait-started) shift; cmd_wait_started "$@" ;;
  gate)         shift; cmd_gate "$@" ;;
  complete)     shift; cmd_complete "$@" ;;
  change-create) shift; cmd_change_create "$@" ;;
  change-attach) shift; cmd_change_attach "$@" ;;
  change-wait)   shift; cmd_change_wait "$@" ;;
  status)       shift; cmd_status "$@" ;;
  *) sed -n '2,32p' "$0"; exit 1 ;;
esac
