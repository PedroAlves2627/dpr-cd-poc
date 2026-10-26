/*
 * Corre em System Definition > Scripts - Background (scope global).
 * Objetivo: descobrir o que o botão "Start release" do DPR Workspace chama,
 * para preencher startViaDprLogic() na Scripted REST API.
 *
 * Alternativa mais rápida: abrir uma release em Pending no DPR Workspace,
 * DevTools > Network, carregar em "Start release" e ver o pedido enviado.
 */
var out = [];

// 1) Declarative actions / UI actions com "Start" nas tabelas do DPR
['sys_declarative_action_assignment', 'sys_ui_action'].forEach(function (table) {
    var gr = new GlideRecord(table);
    if (!gr.isValid()) return;
    gr.addQuery((table == 'sys_ui_action' ? 'name' : 'label'), 'CONTAINS', 'start');
    gr.addQuery('table', 'STARTSWITH', 'sn_dpr');
    gr.query();
    while (gr.next()) {
        out.push('[' + table + '] ' + gr.getDisplayValue() + ' | table=' + gr.getValue('table') +
                 ' | sys_id=' + gr.getUniqueValue());
    }
});

// 2) Script includes do DPR que referem start de release
var si = new GlideRecord('sys_script_include');
si.addQuery('sys_scope.scope', 'STARTSWITH', 'sn_dpr');
var q = si.addQuery('script', 'CONTAINS', 'startRelease');
q.addOrCondition('script', 'CONTAINS', 'start_release');
q.addOrCondition('script', 'CONTAINS', 'startPhase');
si.query();
while (si.next()) {
    out.push('[script include] ' + si.getValue('api_name') + ' | sys_id=' + si.getUniqueValue());
}

// 3) Valores do campo state da release (para confirmar o valor de In Progress)
var ch = new GlideRecord('sys_choice');
ch.addQuery('name', 'sn_dpr_model_release');
ch.addQuery('element', 'state');
ch.query();
while (ch.next()) {
    out.push('[state] ' + ch.getValue('label') + ' = ' + ch.getValue('value'));
}

gs.info('\n' + out.join('\n'));
