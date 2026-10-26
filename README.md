# POC — Pipeline CD (GitHub Actions) ↔ ServiceNow Digital Product Release

Simula um pipeline de CD que, ao arrancar, cria uma release no DPR, a põe em
**In Progress** e, à medida que cada stage termina, faz avançar a fase da release.

```
GitHub Actions                        ServiceNow DPR
──────────────                        ──────────────
1. create-release ── POST /release ─────────► release criada (Pending)
                  ── POST <start custom> ───► In Progress + 1.ª fase iniciada
2. build (dummy)  ── policies/run ──────────► policies da fase 1
                  ── policies/status (poll) ► compliant?
                  ── complete_phase ────────► fase 2 arranca
3. test (dummy)   ── (igual ao 2) ──────────► fase 3 arranca
4. deploy (dummy) ── (igual ao 2) ──────────► última fase → Review
                  ── POST <complete custom> ► Completed
```

## Estrutura

| Ficheiro | O que é |
|---|---|
| `.github/workflows/cd-dpr-poc.yml` | Workflow com 4 jobs dummy; build, test e deploy completam uma fase cada |
| `scripts/dpr.sh` | Helper com as chamadas à API de DPR (`create`, `start`, `wait-started`, `gate`, `status`) |
| `servicenow/release-lifecycle-scripted-rest.js` | Scripted REST API com `/start` (Pending → In Progress) e `/complete` (Review → Completed) |
| `servicenow/discover-start-logic.js` | Background script que lista os métodos de `sn_dpr.Release`, ações Start/Complete, estados e propriedades |

## Setup

1. **ServiceNow (PDI)**
   - Utilizador de integração com `sn_dpr_model.product_manager` ou `sn_dpr_model.release_admin`
     (e leitura em `sn_dpr_model_release`, usada para confirmar o estado).
   - Template **stage-oriented** com 3 fases — build, test e deploy completam a fase 1, 2 e 3.
   - Criar a Scripted REST API com os 2 resources descritos no topo de `release-lifecycle-scripted-rest.js`
     (mesmo script, muda só `ACTION`). Replica a UI Action: `state = RELEASE_STATES.IN_PROGRESS` + `update()`.
2. **GitHub** — repo novo com estes ficheiros e, em *Settings > Secrets and variables > Actions*:
   - Secrets: `SN_INSTANCE`, `SN_USER`, `SN_PASS`
   - Variables: `DPR_TEMPLATE_ID`, `DPR_PRODUCT_ID`, `DPR_RELEASE_OWNER`, `DPR_START_ENDPOINT`,
     `DPR_COMPLETE_ENDPOINT` (ex: `/api/x_poc/dpr/release/{id}/start` e `.../complete`) e, opcionalmente, `DPR_PHASE_BUILD` / `DPR_PHASE_TEST` / `DPR_PHASE_DEPLOY` (nomes das fases do template).
3. *Actions > CD + ServiceNow DPR (POC) > Run workflow*.

## Sem os endpoints custom (para já)

Deixa `DPR_START_ENDPOINT` vazio. O job 1 cria a release, avisa e fica à espera
(até 10 min) que ela passe a In Progress — carregas em **Start release** no DPR
Workspace e o pipeline continua sozinho. O mesmo para `DPR_COMPLETE_ENDPOINT` vazio: no fim
o job de deploy espera que carregues em **Complete release**.

## Testar localmente

```bash
export SN_INSTANCE=https://devXXXXX.service-now.com SN_USER=... SN_PASS=...
export DPR_TEMPLATE_ID=... DPR_PRODUCT_ID=... DPR_RELEASE_OWNER=...
ID=$(bash scripts/dpr.sh create "POC local" 0.0.1)
bash scripts/dpr.sh status "$ID"
```

## Fases a avançar sozinhas

Se o DPR completar uma fase sem o pipeline pedir (ex: fase sem tasks nem policies, ou a
propriedade `sn_dpr.stage_workflow_auto_transition` ativa), o gate deteta-o e salta em vez de
fechar a fase seguinte por engano. Para isso define:

- `DPR_PHASES` — nomes das fases do template por ordem, ex: `Build,Test,Deploy`
- `DPR_PHASE_BUILD`, `DPR_PHASE_TEST`, `DPR_PHASE_DEPLOY` — a fase que cada stage fecha

Cada gate escreve no log a fase atual antes e depois do `complete_phase`.

## Notas

- `complete_phase` só completa a fase se **todas** as policies estiverem compliant;
  sem policies na fase, completa logo. Para testar o bloqueio, mapeia uma policy de aprovação
  e vê o job falhar após `DPR_POLICY_TIMEOUT`.
- O número de stages com gate tem de bater com o número de fases do template.
- Credenciais só em Secrets — nunca no YAML nem no repo.
