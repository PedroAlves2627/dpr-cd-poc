/*
 * Scripted REST API — inicia uma release do DPR (Pending -> In Progress)
 *
 * Criar em: System Web Services > Scripted REST APIs > New
 *   Name: DPR POC        API ID: dpr      (scope à escolha, ex: x_poc)
 * Resource:
 *   Name: Start release  HTTP method: POST
 *   Relative path: /release/{id}/start
 *   Requires authentication: true
 *   (ACL: restringir a quem tem sn_dpr_model.release_admin ou product_manager)
 *
 * URL final: /api/<scope>/dpr/release/{id}/start
 * -> coloca este caminho na variável DPR_START_ENDPOINT do GitHub.
 *
 * O ÚNICO ponto por preencher é startViaDprLogic(): tem de chamar a mesma lógica
 * que o botão "Start release" do DPR Workspace usa. Ver discover-start-logic.js.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var releaseId = request.pathParams.id;

    var rel = new GlideRecord('sn_dpr_model_release');
    if (!rel.get(releaseId)) {
        response.setStatus(404);
        return { error: true, message: 'Release não encontrada: ' + releaseId };
    }

    var before = rel.getDisplayValue('state');
    if (rel.getValue('state') == '' + inProgressValue()) {
        return { error: false, releaseId: releaseId, state: before, message: 'Já estava In Progress' };
    }

    try {
        startViaDprLogic(rel);
    } catch (e) {
        gs.error('[DPR POC] Falha ao iniciar release ' + releaseId + ': ' + e);
        response.setStatus(500);
        return { error: true, message: 'Falha ao iniciar a release: ' + e };
    }

    rel.get(releaseId); // reler depois da lógica do DPR
    return {
        error: false,
        releaseId: releaseId,
        previousState: before,
        state: rel.getDisplayValue('state')
    };

    // ------------------------------------------------------------------

    function startViaDprLogic(releaseGr) {
        // TODO: substituir pela chamada real que o botão "Start release" faz.
        // Exemplo do formato esperado (nomes fictícios — confirmar na instância):
        //   new sn_dpr_model.ReleaseUtils().startRelease(releaseGr.getUniqueValue());
        throw 'startViaDprLogic() ainda não implementado — ver discover-start-logic.js';
    }

    function inProgressValue() {
        // Valor interno do state "In Progress" na tabela sn_dpr_model_release.
        // Confirmar em sys_choice (name=sn_dpr_model_release, element=state).
        var ch = new GlideRecord('sys_choice');
        ch.addQuery('name', 'sn_dpr_model_release');
        ch.addQuery('element', 'state');
        ch.addQuery('label', 'In Progress');
        ch.setLimit(1);
        ch.query();
        return ch.next() ? ch.getValue('value') : '';
    }
})(request, response);
