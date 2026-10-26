/*
 * Scripted REST API — ações de ciclo de vida de uma release do DPR
 * que a API pública não expõe (botões "Start release" e "Complete release").
 *
 * Criar em: System Web Services > Scripted REST APIs > New
 *   Name: DPR POC          API ID: dpr        (scope à escolha, ex: x_poc)
 *
 * Resource 1                              Resource 2
 *   Name: Start release                     Name: Complete release
 *   HTTP method: POST                       HTTP method: POST
 *   Relative path: /release/{id}/start      Relative path: /release/{id}/complete
 *   Script: este ficheiro com               Script: este ficheiro com
 *           ACTION = 'start'                        ACTION = 'complete'
 *
 * Em ambos: Requires authentication = true e uma ACL que exija
 * sn_dpr_model.release_admin (ou product_manager).
 *
 * URLs: /api/<scope>/dpr/release/{id}/start  e  /api/<scope>/dpr/release/{id}/complete
 *  -> no GitHub: DPR_START_ENDPOINT e DPR_COMPLETE_ENDPOINT
 *
 * A lógica real é a da classe sn_dpr.Release (a mesma usada em createRelease).
 * Se o nome do método não for encontrado automaticamente, o erro devolve a lista
 * de métodos disponíveis — preenche METHOD_OVERRIDE com o nome certo.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {

    var ACTION = 'start';           // 'start' ou 'complete' — muda no resource "Complete release"
    var METHOD_OVERRIDE = '';       // ex: 'startRelease' — só se a deteção automática falhar
    var PASS_GLIDERECORD = false;   // true se o método esperar um GlideRecord em vez do sys_id

    var CONFIG = {
        start: {
            candidates: ['startRelease', 'start', 'startReleaseById'],
            from: ['Pending'],
            to: ['In Progress']
        },
        complete: {
            candidates: ['completeRelease', 'complete', 'markReleaseComplete', 'closeRelease'],
            from: ['Review', 'In Progress'],
            to: ['Completed']
        }
    }[ACTION];

    var releaseId = request.pathParams.id;
    var rel = new GlideRecord('sn_dpr_model_release');
    if (!rel.get(releaseId)) {
        response.setStatus(404);
        return { error: true, message: 'Release não encontrada: ' + releaseId };
    }

    var before = rel.getDisplayValue('state');

    // Idempotente: se já está no estado final, não faz nada
    if (CONFIG.to.indexOf(before) > -1) {
        return { error: false, releaseId: releaseId, state: before, message: 'Já estava em ' + before };
    }
    if (CONFIG.from.indexOf(before) == -1) {
        response.setStatus(409);
        return {
            error: true, releaseId: releaseId, state: before,
            message: 'Não é possível fazer "' + ACTION + '" a partir de ' + before +
                     ' (esperado: ' + CONFIG.from.join(' ou ') + ')'
        };
    }

    // Encontrar o método na classe do DPR
    var api, available = [];
    try {
        api = new sn_dpr.Release();
        for (var k in api) if (typeof api[k] == 'function') available.push(k);
    } catch (e) {
        response.setStatus(500);
        return { error: true, message: 'sn_dpr.Release não acessível neste scope: ' + e };
    }

    var method = METHOD_OVERRIDE;
    if (!method) {
        for (var i = 0; i < CONFIG.candidates.length; i++) {
            if (typeof api[CONFIG.candidates[i]] == 'function') { method = CONFIG.candidates[i]; break; }
        }
    }
    if (!method || typeof api[method] != 'function') {
        response.setStatus(501);
        return {
            error: true,
            message: 'Método para "' + ACTION + '" não encontrado em sn_dpr.Release. ' +
                     'Preenche METHOD_OVERRIDE com um destes:',
            availableMethods: available
        };
    }

    // Executar
    var result;
    try {
        result = api[method](PASS_GLIDERECORD ? rel : releaseId);
    } catch (e) {
        gs.error('[DPR POC] ' + method + '(' + releaseId + ') falhou: ' + e);
        response.setStatus(500);
        return { error: true, method: method, message: 'Falha em ' + method + ': ' + e };
    }

    // Confirmar que o estado mudou mesmo
    rel.get(releaseId);
    var after = rel.getDisplayValue('state');
    var ok = CONFIG.to.indexOf(after) > -1;
    if (!ok) response.setStatus(500);

    return {
        error: !ok,
        action: ACTION,
        method: method,
        releaseId: releaseId,
        previousState: before,
        state: after,
        dprResult: result === undefined ? null : JSON.stringify(result),
        message: ok ? 'OK' : 'O método correu mas a release ficou em ' + after +
                            '. Experimenta PASS_GLIDERECORD = true ou outro método.'
    };
})(request, response);
