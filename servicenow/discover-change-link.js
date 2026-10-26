/*
 * Corre em System Definition > Scripts - Background (scope: global).
 * Objetivo: descobrir como o DPR liga um change request a uma fase da release
 * (secção "Change requests" do Workspace, botões New/Add), para o endpoint /change.
 * Copia o output todo e envia.
 */
var out = [];
function line(s) { out.push(s); }

// 1) Tabelas do DPR com referências a change_request/task e à fase/release
line('=== Tabelas sn_dpr* que referenciam change_request / task ===');
var d = new GlideRecord('sys_dictionary');
d.addQuery('internal_type', 'reference');
d.addQuery('name', 'STARTSWITH', 'sn_dpr');
var r = d.addQuery('reference', 'change_request');
r.addOrCondition('reference', 'task');
d.query();
var tables = {};
while (d.next()) {
    line('  ' + d.getValue('name') + '.' + d.getValue('element') + ' -> ' + d.getValue('reference'));
    tables[d.getValue('name')] = true;
}
for (var t in tables) {
    line('  campos de ' + t + ':');
    var f = new GlideRecord('sys_dictionary');
    f.addQuery('name', t);
    f.addQuery('internal_type', 'reference');
    f.query();
    while (f.next()) line('      ' + f.getValue('element') + ' -> ' + f.getValue('reference'));
}

// 2) Campo "Software model" no change_request (preenchido pelo DPR)
line('=== Campos do change_request relacionados com DPR ===');
var c = new GlideRecord('sys_dictionary');
c.addQuery('name', 'change_request');
var cq = c.addQuery('column_label', 'CONTAINS', 'Software model');
cq.addOrCondition('column_label', 'CONTAINS', 'phase');
cq.addOrCondition('element', 'STARTSWITH', 'sn_dpr');
c.query();
while (c.next()) line('  ' + c.getValue('element') + ' (' + c.getValue('column_label') + ') -> ' + c.getValue('reference'));

// 3) Ações Add/New ligadas a change requests no DPR
line('=== Ações Add/New de change request no DPR ===');
['sys_declarative_action_assignment', 'sys_ui_action'].forEach(function (table) {
    var g = new GlideRecord(table);
    if (!g.isValid()) return;
    var field = table == 'sys_ui_action' ? 'name' : 'label';
    g.addQuery('sys_scope.scope', 'STARTSWITH', 'sn_dpr');
    var q = g.addQuery(field, 'CONTAINS', 'change');
    q.addOrCondition(field, 'CONTAINS', 'Add');
    g.query();
    while (g.next()) {
        line('  [' + table + '] ' + g.getDisplayValue() + ' | table=' + g.getValue('table') + ' | sys_id=' + g.getUniqueValue());
        if (table == 'sys_ui_action' && g.getValue('script'))
            line('      script: ' + g.getValue('script').replace(/\s+/g, ' ').substring(0, 400));
    }
});

// 4) Estados da fase
line('=== Estados de sn_dpr_model_release_phase ===');
var ch = new GlideRecord('sys_choice');
ch.addQuery('name', 'sn_dpr_model_release_phase');
ch.addQuery('element', 'state');
ch.query();
while (ch.next()) line('  ' + ch.getValue('label') + ' = ' + ch.getValue('value'));

line('release_related_task_types = ' + gs.getProperty('sn_dpr_model.release_related_task_types'));
gs.info('\n' + out.join('\n'));
