/*
 * Scripted REST API — botões "Start release" e "Complete release" do DPR,
 * que a API pública não expõe.
 *
 * Replica a UI Action "Start release":
 *     current.state = sn_dpr.ReleaseCommonConstants.RELEASE_STATES.IN_PROGRESS;
 *     current.update();
 * As business rules do DPR tratam do resto (iniciar a 1.ª fase, aprovações, tasks).
 *
 * Criar em: System Web Services > Scripted REST APIs > New
 *   Name: DPR POC          API ID: dpr        (scope: global)
 *
 * Resource 1                              Resource 2
 *   Name: Start release                     Name: Complete release
 *   HTTP method: POST                       HTTP method: POST
 *   Relative path: /release/{id}/start      Relative path: /release/{id}/complete
 *   Script: este ficheiro com               Script: este ficheiro com
 *           ACTION = 'start'                        ACTION = 'complete'
 *
 * Em ambos: Requires authentication = true e uma ACL que exija
 * sn_dpr_model.release_admin (ou product_manager) — o GlideRecord aqui não
 * aplica ACLs, por isso a proteção tem de estar no resource.
 *
 * URLs: /api/<namespace>/dpr/release/{id}/start  e  /api/<namespace>/dpr/release/{id}/complete
 *  O <namespace> NÃO é "global": em scope global é o company code da instância
 *  (propriedade glide.appcreator.company.code). Copia o valor do campo
 *  "Resource path" do resource depois de gravar.
 *  -> no GitHub: DPR_START_ENDPOINT e DPR_COMPLETE_ENDPOINT
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {

    var ACTION = 'start';   // 'start' ou 'complete' — muda no resource "Complete release"

    var CONFIG = {
        // Igual à UI Action "Start release" (confirmado)
        start:    { fromStates: ['PENDING'], to: 'IN_PROGRESS' },
        // TODO confirmar com o script da UI Action "Complete release"
        complete: { fromStates: ['REVIEW'], to: 'COMPLETED' }
    }[ACTION];

    var STATES = releaseStates();

    var current = new GlideRecord('sn_dpr_model_release');
    if (!current.get(request.pathParams.id)) {
        response.setStatus(404);
        return { error: true, message: 'Release não encontrada: ' + request.pathParams.id };
    }

    var before = current.getValue('state');
    var beforeLabel = current.getDisplayValue('state');
    var target = STATES[CONFIG.to];

    if (!target) {
        response.setStatus(500);
        return { error: true, message: 'Estado ' + CONFIG.to + ' não encontrado em RELEASE_STATES', states: STATES };
    }

    // Idempotente
    if (before == target) {
        return { error: false, action: ACTION, state: beforeLabel, message: 'Já estava em ' + beforeLabel };
    }

    // Mesma condição que o botão: só a partir do estado certo
    var allowed = CONFIG.fromStates.map(function (k) { return STATES[k]; });
    if (allowed.indexOf(before) == -1) {
        response.setStatus(409);
        return {
            error: true, action: ACTION, state: beforeLabel,
            message: 'Não é possível fazer "' + ACTION + '" a partir de ' + beforeLabel
        };
    }

    // --- lógica da UI Action ---
    current.state = target;
    if (!current.update()) {
        response.setStatus(500);
        return { error: true, action: ACTION, message: 'update() falhou: ' + current.getLastErrorMessage() };
    }
    // ---------------------------

    current.get(request.pathParams.id);   // reler depois das business rules
    var ok = current.getValue('state') == target;
    if (!ok) response.setStatus(500);

    return {
        error: !ok,
        action: ACTION,
        releaseId: current.getUniqueValue(),
        previousState: beforeLabel,
        state: current.getDisplayValue('state'),
        message: ok ? 'OK' : 'Uma business rule repôs o estado — vê o System Log'
    };

    // Constantes do DPR; se não forem acessíveis deste scope, lê os valores do sys_choice
    function releaseStates() {
        try {
            var c = sn_dpr.ReleaseCommonConstants.RELEASE_STATES;
            if (c && c.IN_PROGRESS) return c;
        } catch (e) {
            gs.warn('[DPR POC] ReleaseCommonConstants inacessível, a usar sys_choice: ' + e);
        }
        var map = {}, ch = new GlideRecord('sys_choice');
        ch.addQuery('name', 'sn_dpr_model_release');
        ch.addQuery('element', 'state');
        ch.query();
        while (ch.next()) map[ch.getValue('label').toUpperCase().replace(/\s+/g, '_')] = ch.getValue('value');
        return map;
    }
})(request, response);
