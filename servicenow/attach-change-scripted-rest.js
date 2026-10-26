(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    /*
     * POST /release/{id}/change      body: { "changeId": "<sys_id do CR>", "phaseName": "(opcional)", "dryRun": false }
     * Liga um change request à fase da release (por omissão a fase In Progress),
     * como o botão "Add" da secção Change requests do DPR Workspace.
     *
     * A tabela de ligação CR <-> fase é descoberta automaticamente no sys_dictionary.
     * Testa primeiro com "dryRun": true para ver o que foi encontrado sem gravar nada.
     */
    var body = request.body && request.body.data ? request.body.data : {};
    var releaseId = request.pathParams.id;
    var changeId = body.changeId;
    var dryRun = body.dryRun === true || body.dryRun === 'true';

    if (!changeId) return fail(400, 'Falta "changeId" no body');

    var release = new GlideRecord('sn_dpr_model_release');
    if (!release.get(releaseId)) return fail(404, 'Release não encontrada: ' + releaseId);

    var change = new GlideRecord('change_request');
    if (!change.get(changeId)) return fail(404, 'Change request não encontrado: ' + changeId);

    // 1) Fase: pelo nome (phaseName) ou a que está In Progress
    var PHASE_TABLE = 'sn_dpr_model_release_phase';
    var phaseReleaseField = findRefField(PHASE_TABLE, ['sn_dpr_model_release']);
    if (!phaseReleaseField) return fail(500, 'Não encontrei o campo que liga ' + PHASE_TABLE + ' à release');

    var phase = new GlideRecord(PHASE_TABLE);
    phase.addQuery(phaseReleaseField, releaseId);
    if (body.phaseName) {
        phase.addQuery('name', body.phaseName);
    } else {
        phase.addQuery('state', choiceValue(PHASE_TABLE, 'state', 'In Progress'));
    }
    phase.setLimit(1);
    phase.query();
    if (!phase.next()) {
        return fail(409, body.phaseName ? 'Fase "' + body.phaseName + '" não encontrada na release'
                                        : 'A release não tem nenhuma fase In Progress');
    }

    // 2) Tabela de ligação: tabela sn_dpr* com referência à fase E ao change_request/task
    var link = findLinkTable();
    if (!link) return fail(500, 'Não encontrei a tabela de ligação CR <-> fase. Corre discover-change-link.js e envia o output.');

    // Já ligado?
    var existing = new GlideRecord(link.table);
    existing.addQuery(link.phaseField, phase.getUniqueValue());
    existing.addQuery(link.changeField, changeId);
    existing.query();
    var already = existing.hasNext();

    var info = {
        release: release.getDisplayValue(),
        phase: phase.getDisplayValue(),
        change: change.getValue('number'),
        linkTable: link.table,
        phaseField: link.phaseField,
        changeField: link.changeField,
        alreadyLinked: already
    };

    if (dryRun) return ok('Dry run — nada foi gravado', info);
    if (already) return ok('O CR já estava ligado a esta fase', info);

    // 3) Criar a ligação (as business rules do DPR tratam do resto, como no botão Add)
    var gr = new GlideRecord(link.table);
    gr.initialize();
    gr.setValue(link.phaseField, phase.getUniqueValue());
    gr.setValue(link.changeField, changeId);
    var linkId = gr.insert();
    if (!linkId) return fail(500, 'insert() falhou: ' + gr.getLastErrorMessage(), info);

    info.linkId = linkId;
    return ok('CR ligado à fase', info);

    // ---------------- helpers ----------------

    function findRefField(table, refTables) {
        var d = new GlideRecord('sys_dictionary');
        d.addQuery('name', table);
        d.addQuery('internal_type', 'reference');
        d.addQuery('reference', 'IN', refTables.join(','));
        d.setLimit(1);
        d.query();
        return d.next() ? d.getValue('element') : '';
    }

    function findLinkTable() {
        // candidatas: tabelas sn_dpr* com um campo que referencia a fase
        var d = new GlideRecord('sys_dictionary');
        d.addQuery('name', 'STARTSWITH', 'sn_dpr');
        d.addQuery('internal_type', 'reference');
        d.addQuery('reference', PHASE_TABLE);
        d.query();
        var best = null;
        while (d.next()) {
            var t = d.getValue('name');
            if (t == PHASE_TABLE) continue;
            var chg = findRefField(t, ['change_request']);
            var score = 2;
            if (!chg) { chg = findRefField(t, ['task']); score = 1; }
            if (chg && (!best || score > best.score)) {
                best = { table: t, phaseField: d.getValue('element'), changeField: chg, score: score };
            }
        }
        return best;
    }

    function choiceValue(table, element, label) {
        var c = new GlideRecord('sys_choice');
        c.addQuery('name', table);
        c.addQuery('element', element);
        c.addQuery('label', label);
        c.setLimit(1);
        c.query();
        return c.next() ? c.getValue('value') : label;
    }

    function ok(message, data) {
        data = data || {};
        data.error = false;
        data.message = message;
        return data;
    }

    function fail(status, message, data) {
        response.setStatus(status);
        data = data || {};
        data.error = true;
        data.message = message;
        return data;
    }
})(request, response);
