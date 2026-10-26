/*
 * Corre em System Definition > Scripts - Background (scope: global).
 * Objetivo: descobrir que lógica server-side os botões "Start release" e
 * "Complete release" do DPR Workspace usam, para a Scripted REST API.
 *
 * Copia o output todo (System Log ou o ecrã do background script) e envia.
 */
var out = [];
function line(s) { out.push(s); }

// 1) Métodos da classe sn_dpr.Release (usada para criar releases por script)
line('=== Métodos de sn_dpr.Release ===');
try {
    var proto = sn_dpr.Release.prototype;
    for (var k in proto) {
        if (typeof proto[k] == 'function') line('  ' + k);
    }
} catch (e) {
    line('  (sn_dpr.Release não acessível a partir deste scope: ' + e + ')');
}

// 2) Script includes do DPR com lógica de start / complete
line('=== Script includes sn_dpr* com start/complete ===');
var si = new GlideRecord('sys_script_include');
si.addQuery('sys_scope.scope', 'STARTSWITH', 'sn_dpr');
var q = si.addQuery('script', 'CONTAINS', 'startRelease');
q.addOrCondition('script', 'CONTAINS', 'completeRelease');
q.addOrCondition('script', 'CONTAINS', 'start_release');
q.addOrCondition('script', 'CONTAINS', 'complete_release');
si.query();
while (si.next()) {
    var src = si.getValue('script') || '';
    var methods = [];
    var re = /(\w*(?:start|complete)\w*Release\w*)\s*[:=]\s*function/gi, m;
    while ((m = re.exec(src)) !== null) methods.push(m[1]);
    line('  ' + si.getValue('api_name') + ' | métodos: ' + (methods.join(', ') || '-') +
         ' | sys_id=' + si.getUniqueValue());
}

// 3) Ações do Workspace / UI actions com Start ou Complete nas tabelas do DPR
line('=== Ações Start/Complete em tabelas sn_dpr* ===');
['sys_declarative_action_assignment', 'sys_ui_action'].forEach(function (table) {
    var gr = new GlideRecord(table);
    if (!gr.isValid()) return;
    var field = table == 'sys_ui_action' ? 'name' : 'label';
    var c = gr.addQuery(field, 'CONTAINS', 'start');
    c.addOrCondition(field, 'CONTAINS', 'complete');
    gr.addQuery('table', 'STARTSWITH', 'sn_dpr');
    gr.query();
    while (gr.next()) {
        line('  [' + table + '] ' + gr.getDisplayValue() + ' | table=' + gr.getValue('table') +
             ' | sys_id=' + gr.getUniqueValue());
        if (table == 'sys_ui_action' && gr.getValue('script'))
            line('      script: ' + gr.getValue('script').replace(/\s+/g, ' ').substring(0, 300));
    }
});

// 4) Valores dos estados da release e da fase
['sn_dpr_model_release', 'sn_dpr_model_release_phase'].forEach(function (t) {
    line('=== Estados de ' + t + ' ===');
    var ch = new GlideRecord('sys_choice');
    ch.addQuery('name', t);
    ch.addQuery('element', 'state');
    ch.addQuery('inactive', false);
    ch.query();
    while (ch.next()) line('  ' + ch.getValue('label') + ' = ' + ch.getValue('value'));
});

// 5) Propriedades de transição automática
line('=== Propriedades sn_dpr auto_transition ===');
var p = new GlideRecord('sys_properties');
p.addQuery('name', 'STARTSWITH', 'sn_dpr');
p.addQuery('name', 'CONTAINS', 'transition');
p.query();
while (p.next()) line('  ' + p.getValue('name') + ' = ' + p.getValue('value'));

gs.info('\n' + out.join('\n'));
