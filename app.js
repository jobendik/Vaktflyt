/* Vaktflyt — UI. Norwegian interface, English code. Depends on engine.js (VF) and demo.js (VF_DEMO). */
(function () {
  'use strict';

  const STORAGE_KEY = 'vaktflyt.v1';
  const AUTH_KEY = 'vaktflyt.auth';
  const LOGINS = { erik: 'vaktflyt', jo: 'vaktflyt', demo: 'demo' };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtH = VF.fmtHours;
  const nb = n => (Math.round(n * 10) / 10).toString().replace('.', ',');

  // ------------------------------------------------------------------ state
  let model = load();
  const ui = { view: 'oversikt', sel: null, undo: [], busy: false, progress: null, repairOpen: {}, pendingChange: null, ver: 0 };
  let worker = null, jobSeq = 0;
  const cache = { ver: -1, ctx: null, reportVer: -1, report: null };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { const m = JSON.parse(raw); if (m && m.version === 1) return migrate(m); }
    } catch (e) { /* fall through */ }
    return migrate(VF_DEMO.demoModel());
  }
  function migrate(m) {
    m.absences = m.absences || []; m.wishes = m.wishes || []; m.changelog = m.changelog || [];
    m.settings.tags = m.settings.tags || [];
    for (const e of m.employees) for (const t of (e.tags || [])) if (!m.settings.tags.includes(t)) m.settings.tags.push(t);
    if (m.roster && !m.roster.asg) m.roster = null;
    return m;
  }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(model)); } catch (e) { toast('Kunne ikke lagre i nettleseren.'); } }
  function commit() { ui.ver++; save(); }
  function ctx() { if (cache.ver !== ui.ver) { cache.ctx = VF.buildCtx(model); cache.ver = ui.ver; } return cache.ctx; }
  function report() {
    if (!model.roster) return null;
    if (cache.reportVer !== ui.ver) { cache.report = VF.evaluateCtx(ctx(), model.roster.asg); cache.reportVer = ui.ver; }
    return cache.report;
  }
  function rules() { return Object.assign(VF.defaultRules(), model.rules || {}, { weights: Object.assign(VF.defaultRules().weights, (model.rules && model.rules.weights) || {}) }); }
  function empById(id) { return model.employees.find(e => e.id === id); }
  function shiftById(id) { return model.settings.shiftTypes.find(s => s.id === id); }
  function dayISO(d) { return VF.addDays(model.settings.periodStart, d); }
  function dayIndex(iso) { return Math.round((VF.parseISO(iso) - VF.parseISO(model.settings.periodStart)) / 86400000); }
  function ensureRosterRows() {
    if (!model.roster) return;
    const days = model.settings.weeks * 7;
    for (const e of model.employees) {
      if (!model.roster.asg[e.id]) model.roster.asg[e.id] = new Array(days).fill(null);
      else if (model.roster.asg[e.id].length !== days) { const r = model.roster.asg[e.id].slice(0, days); while (r.length < days) r.push(null); model.roster.asg[e.id] = r; }
    }
    for (const id of Object.keys(model.roster.asg)) if (!empById(id)) delete model.roster.asg[id];
  }
  function pushUndo() {
    ui.undo.push(JSON.stringify({ roster: model.roster, changelog: model.changelog }));
    if (ui.undo.length > 40) ui.undo.shift();
  }
  function undo() {
    const s = ui.undo.pop(); if (!s) return;
    const o = JSON.parse(s); model.roster = o.roster; model.changelog = o.changelog; commit(); render(); toast('Angret.');
  }
  function logChange(text, changes) {
    model.changelog.unshift({ ts: new Date().toISOString(), text, changes });
    if (model.changelog.length > 200) model.changelog.length = 200;
  }
  function applyChanges(changes) { for (const c of changes) model.roster.asg[c.e][c.d] = c.to; }
  function describeChanges(changes) {
    return changes.map(c => {
      const e = empById(c.e); const name = e ? e.name : c.e;
      const iso = dayISO(c.d);
      if (c.to && c.from) return `${name}: ${shiftById(c.from).name.toLowerCase()} → ${shiftById(c.to).name.toLowerCase()} ${VF.fmtDateWd(iso)}`;
      if (c.to) return `${name} får ${shiftById(c.to).name.toLowerCase()}vakt ${VF.fmtDateWd(iso)}`;
      return `${name} fritas fra ${shiftById(c.from).name.toLowerCase()}vakt ${VF.fmtDateWd(iso)}`;
    }).join('; ');
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ------------------------------------------------------------------ auth
  function isAuthed() { return sessionStorage.getItem(AUTH_KEY) === '1'; }
  function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); setTimeout(() => $('#loginUser').focus(), 0); }
  function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); render(); }
  $('#loginForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const u = $('#loginUser').value.trim().toLowerCase(), p = $('#loginPass').value;
    if (LOGINS[u] && LOGINS[u] === p) { sessionStorage.setItem(AUTH_KEY, '1'); $('#loginError').classList.add('hidden'); showApp(); }
    else $('#loginError').classList.remove('hidden');
  });
  $('#btnLogout').addEventListener('click', () => { sessionStorage.removeItem(AUTH_KEY); showLogin(); });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('Dette sletter alle endringer og laster demodataene på nytt. Fortsette?')) return;
    model = migrate(VF_DEMO.demoModel()); ui.undo = []; ui.sel = null; commit(); render(); toast('Demodata lastet.');
  });

  // ------------------------------------------------------------------ nav
  $('#nav').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-view]'); if (!b) return;
    ui.view = b.dataset.view; ui.pendingChange = null; render();
  });
  function renderNav() {
    $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));
    $('#sideUnit').textContent = model.settings.unitName || '';
    $('#navAnsatte').textContent = model.employees.length;
    const r = report();
    const nt = $('#navTurnus');
    if (!r) { nt.textContent = 'ikke laget'; nt.className = 'badge'; }
    else if (r.hardCount) { nt.textContent = `${r.hardCount} brudd`; nt.className = 'badge badge-danger'; }
    else { nt.textContent = 'ok'; nt.className = 'badge badge-ok'; }
    const nf = $('#navFravaer');
    const holes = model.roster ? VF.uncoveredSlots(model, model.roster.asg).length : 0;
    nf.textContent = holes ? `${holes} hull` : ''; nf.className = holes ? 'badge badge-warn' : 'badge hidden';
  }

  // ------------------------------------------------------------------ render
  function render() {
    ensureRosterRows();
    renderNav();
    const main = $('#main');
    main.scrollTop = 0;
    switch (ui.view) {
      case 'oversikt': viewOversikt(main); break;
      case 'ansatte': viewAnsatte(main); break;
      case 'bemanning': viewBemanning(main); break;
      case 'regler': viewRegler(main); break;
      case 'turnus': viewTurnus(main); break;
      case 'fravaer': viewFravaer(main); break;
      case 'eksport': viewEksport(main); break;
    }
  }
  function periodLabel() {
    const s = model.settings; const end = VF.addDays(s.periodStart, s.weeks * 7 - 1);
    return `Uke ${VF.isoWeek(s.periodStart)}–${VF.isoWeek(end)} · ${VF.fmtDate(s.periodStart)} til ${VF.fmtDate(end)} ${end.slice(0, 4)} · ${s.weeks} uker`;
  }

  // ================================================================== OVERSIKT
  function viewOversikt(main) {
    const cap = VF.capacity(model);
    const r = report();
    const ratio = cap.perWeek.available / Math.max(1, cap.perWeek.demandMin);
    const meterCls = ratio < 1 ? 'danger' : ratio < 1.04 ? 'warn' : '';
    const fteStr = nb(cap.fte);
    const statusHtml = !r
      ? `<div class="value">Ikke laget</div><div class="note">Gå til Turnus og trykk «Generer turnus».</div>`
      : `<div class="value">${r.hardCount === 0 ? 'Går opp' : r.hardCount + ' brudd'}</div><div class="note">${r.coverage.filled} av ${r.coverage.required} vakter dekket · ${r.hardCount === 0 ? 'ingen brudd på regler' : 'se Turnus for detaljer'}</div>`;
    main.innerHTML = `
      <div class="page-head"><div><h1>Oversikt</h1><div class="sub">${esc(model.settings.unitName)} · ${esc(periodLabel())}</div></div></div>
      <div class="grid-4">
        <div class="stat"><div class="label">Ansatte</div><div class="value">${model.employees.length}<small>${fteStr} årsverk</small></div><div class="note">${model.employees.filter(e => e.onlyWeekends).length} helgestillinger · ${model.employees.filter(e => e.shifts && e.shifts.N !== false).length} kan gå natt</div></div>
        <div class="stat"><div class="label">Behov per uke</div><div class="value">${nb(cap.perWeek.demandMin)}<small>– ${nb(cap.perWeek.demandMax)} t</small></div><div class="note">${cap.demandMinShifts} vakter må dekkes i perioden</div></div>
        <div class="stat"><div class="label">Kapasitet per uke</div><div class="value">${nb(cap.perWeek.available)}<small>t</small></div><div class="note">${Math.round(ratio * 100)} % av minstebehovet</div><div class="meter ${meterCls}"><span style="width:${Math.min(100, ratio * 100 / 1.25)}%"></span></div></div>
        <div class="stat"><div class="label">Turnus</div>${statusHtml}</div>
      </div>
      ${ratio < 1 ? `<div class="panel" style="border-color:var(--danger)"><b>Staben er for liten for bemanningskravet.</b> Behovet er ${nb(cap.perWeek.demandMin)} t/uke, de ansatte har ${nb(cap.perWeek.available)} t/uke. Reduser kravene under Bemanning, eller legg til ansatte.</div>` : ''}
      <div class="grid-2">
        <div class="panel">
          <h2>Periode og enhet</h2>
          <div class="field"><label for="unitName">Navn på enhet</label><input id="unitName" value="${esc(model.settings.unitName)}"></div>
          <div class="form-grid">
            <div class="field"><label for="periodStart">Turnusen starter (mandag)</label><input id="periodStart" type="date" value="${model.settings.periodStart}"></div>
            <div class="field"><label for="weeks">Lengde</label><select id="weeks">${[4, 6, 8, 10, 12].map(w => `<option value="${w}" ${w === model.settings.weeks ? 'selected' : ''}>${w} uker</option>`).join('')}</select></div>
          </div>
          <p class="help">Endrer du periode, må turnusen lages på nytt.</p>
        </div>
        <div class="panel">
          <h2>Slik fungerer Vaktflyt</h2>
          <div class="steps" style="grid-template-columns:1fr">
            <div class="step"><div class="n">1</div><b>Beskriv kriteriene</b>Ansatte med stillingsprosent, kompetanse, vakttyper og begrensninger. Bemanningskrav per vakt. Regler fra lov og tariff.</div>
            <div class="step"><div class="n">2</div><b>Generer turnusen</b>Vaktflyt legger helgene først, så ukedagene, og forbedrer planen til den går opp – med færrest mulig kompromisser på ønsker.</div>
            <div class="step"><div class="n">3</div><b>Reparer når noen blir syke</b>Meld fravær, og få rangerte forslag til hvem som kan ta vakten lovlig – med begrunnelse for hvem som ikke kan.</div>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Fravær og ønsker i perioden</h2>
        ${absenceWishSummary()}
      </div>`;
    $('#unitName').addEventListener('change', ev => { model.settings.unitName = ev.target.value.trim(); commit(); renderNav(); });
    $('#periodStart').addEventListener('change', ev => {
      let v = ev.target.value; if (!v) return;
      const mon = VF.nextMonday(v);
      if (mon !== v) toast(`Flyttet til nærmeste mandag: ${VF.fmtDateWd(mon)}`);
      if (mon === model.settings.periodStart) { ev.target.value = mon; return; }
      if (model.roster && !confirm('Turnusen slettes når perioden endres. Fortsette?')) { ev.target.value = model.settings.periodStart; return; }
      model.settings.periodStart = mon; model.roster = null; ui.undo = []; commit(); render();
    });
    $('#weeks').addEventListener('change', ev => {
      const w = +ev.target.value;
      if (model.roster && !confirm('Turnusen slettes når perioden endres. Fortsette?')) { ev.target.value = model.settings.weeks; return; }
      model.settings.weeks = w; model.roster = null; ui.undo = []; commit(); render();
    });
  }
  function absenceWishSummary() {
    const c = ctx();
    const abs = model.absences.filter(a => dayIndex(a.to) >= 0 && dayIndex(a.from) < c.days).sort((a, b) => a.from.localeCompare(b.from));
    const wishes = model.wishes.filter(w => dayIndex(w.date) >= 0 && dayIndex(w.date) < c.days).sort((a, b) => a.date.localeCompare(b.date));
    if (!abs.length && !wishes.length) return '<p class="muted">Ingen registrert. Legg inn ferie, permisjon og ønsker under Ansatte.</p>';
    const absHtml = abs.map(a => `<tr><td>${esc(empById(a.employeeId)?.name || '?')}</td><td>${absType(a.type)}</td><td class="nowrap">${VF.fmtDateWd(a.from)}${a.from !== a.to ? ' – ' + VF.fmtDateWd(a.to) : ''}</td><td class="muted">${esc(a.note || '')}</td></tr>`).join('');
    const wHtml = wishes.map(w => `<tr><td>${esc(empById(w.employeeId)?.name || '?')}</td><td>${wishType(w)}</td><td class="nowrap">${VF.fmtDateWd(w.date)}</td><td class="muted">${esc(w.note || '')}</td></tr>`).join('');
    return `<div class="grid-2"><div><h3 class="muted" style="margin-bottom:6px">Fravær</h3><table class="data">${absHtml || '<tr><td class="muted">Ingen</td></tr>'}</table></div>
      <div><h3 class="muted" style="margin-bottom:6px">Ønsker</h3><table class="data">${wHtml || '<tr><td class="muted">Ingen</td></tr>'}</table></div></div>`;
  }
  function absType(t) { return ({ syk: 'Syk', ferie: 'Ferie', permisjon: 'Permisjon', kurs: 'Kurs', annet: 'Annet' })[t] || t; }
  function wishType(w) { if (w.kind === 'fri') return w.hard ? 'Fri (innvilget)' : 'Ønsker fri'; return 'Ønsker vakt' + (w.shift && shiftById(w.shift) ? ` (${shiftById(w.shift).name.toLowerCase()})` : ''); }

  // ================================================================== ANSATTE
  function viewAnsatte(main) {
    const R = rules();
    const rows = model.employees.map(e => {
      const shifts = model.settings.shiftTypes.filter(s => !e.shifts || e.shifts[s.id] !== false).map(s => `<span class="chip chip-${s.id}">${s.id}</span>`).join(' ');
      const lim = [];
      if (e.onlyWeekends) lim.push('bare helg');
      if (e.noWeekends) lim.push('ikke helg');
      if (e.blockedWeekdays && e.blockedWeekdays.length) lim.push('ikke ' + e.blockedWeekdays.map(d => VF.WD_LONG[d]).join('/'));
      if (e.notWith && e.notWith.length) lim.push('ikke med ' + e.notWith.map(id => (empById(id) || {}).name || '').map(n => n.split(' ')[0]).join(', '));
      if (e.preferWith && e.preferWith.length) lim.push('gjerne med ' + e.preferWith.map(id => (empById(id) || {}).name || '').map(n => n.split(' ')[0]).join(', '));
      if (e.wantsExtra) lim.push('ønsker ekstravakter');
      const nAbs = model.absences.filter(a => a.employeeId === e.id).length, nW = model.wishes.filter(w => w.employeeId === e.id).length;
      return `<tr>
        <td><b>${esc(e.name)}</b><div class="muted small">${esc(e.title || '')}</div></td>
        <td class="num">${e.percent} %<div class="muted small nowrap">${nb(e.percent / 100 * R.avgWeeklyHours)} t/uke</div></td>
        <td>${e.gender === 'K' ? 'Kvinne' : e.gender === 'M' ? 'Mann' : '–'}</td>
        <td class="nowrap">${shifts}</td>
        <td>${(e.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">–</span>'}</td>
        <td class="nowrap">hver ${e.weekendEvery || R.weekendEvery}.</td>
        <td class="small">${esc(lim.join(' · ')) || '<span class="muted">–</span>'}${nAbs || nW ? `<div class="muted">${nAbs ? nAbs + ' fravær' : ''}${nAbs && nW ? ' · ' : ''}${nW ? nW + ' ønsker' : ''}</div>` : ''}</td>
        <td class="actions"><button class="btn btn-sm" data-edit="${e.id}">Rediger</button></td>
      </tr>`;
    }).join('');
    main.innerHTML = `
      <div class="page-head"><div><h1>Ansatte</h1><div class="sub">${model.employees.length} ansatte · ${nb(model.employees.reduce((a, e) => a + e.percent, 0) / 100)} årsverk</div></div>
        <div class="toolbar"><button class="btn btn-primary" id="btnNewEmp">Ny ansatt</button></div></div>
      <div class="panel" style="padding:0 0 4px"><table class="data"><thead><tr><th>Navn</th><th>Stilling</th><th>Kjønn</th><th>Vakter</th><th>Kompetanse</th><th>Helg</th><th>Begrensninger og ønsker</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="help">Kompetanse er frie merkelapper (f.eks. «medikament», «erfaren») som bemanningskravet kan kreve. Innvilget fri er bindende; ønsker vektes.</p>`;
    $('#btnNewEmp').addEventListener('click', () => openEmployeeDialog(null));
    $$('[data-edit]', main).forEach(b => b.addEventListener('click', () => openEmployeeDialog(b.dataset.edit)));
  }

  function openEmployeeDialog(id) {
    const isNew = !id;
    const e = isNew ? { id: 'e' + Date.now().toString(36), name: '', title: '', percent: 100, gender: 'K', tags: [], shifts: {}, notWith: [], preferWith: [], blockedWeekdays: [], wantsExtra: false, notes: '' } : JSON.parse(JSON.stringify(empById(id)));
    e.shifts = e.shifts || {}; e.tags = e.tags || []; e.notWith = e.notWith || []; e.preferWith = e.preferWith || []; e.blockedWeekdays = e.blockedWeekdays || [];
    const R = rules();
    const others = model.employees.filter(x => x.id !== e.id);
    const absences = model.absences.filter(a => a.employeeId === e.id);
    const wishes = model.wishes.filter(w => w.employeeId === e.id);
    const dlg = $('#dlg'), c = $('#dlgContent');
    const shiftsHtml = model.settings.shiftTypes.map(s => `<label><input type="checkbox" name="shift" value="${s.id}" ${e.shifts[s.id] !== false ? 'checked' : ''}> <span class="chip chip-${s.id}">${s.id}</span> ${esc(s.name)} ${s.start}–${s.end}</label>`).join('');
    const tagsHtml = model.settings.tags.map(t => `<label><input type="checkbox" name="tag" value="${esc(t)}" ${e.tags.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
    const wdHtml = VF.WD_LONG.map((n, i) => `<label><input type="checkbox" name="bwd" value="${i}" ${e.blockedWeekdays.includes(i) ? 'checked' : ''}> ${n}</label>`).join('');
    const colleagues = kind => others.map(x => `<label><input type="checkbox" name="${kind}" value="${x.id}" ${e[kind].includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('');
    const absRows = absences.map(a => `<tr data-abs="${a.id}"><td>${absType(a.type)}</td><td class="nowrap">${VF.fmtDateWd(a.from)}${a.from !== a.to ? ' – ' + VF.fmtDateWd(a.to) : ''}</td><td class="muted">${esc(a.note || '')}</td><td class="actions"><button type="button" class="btn btn-sm btn-danger" data-del-abs="${a.id}">Slett</button></td></tr>`).join('');
    const wishRows = wishes.map(w => `<tr><td>${wishType(w)}</td><td class="nowrap">${VF.fmtDateWd(w.date)}</td><td class="muted">${esc(w.note || '')}</td><td class="actions"><button type="button" class="btn btn-sm btn-danger" data-del-wish="${w.id}">Slett</button></td></tr>`).join('');
    const shiftOpts = model.settings.shiftTypes.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    c.innerHTML = `<form id="empForm"><div class="dialog-body">
      <h2 style="margin-bottom:14px">${isNew ? 'Ny ansatt' : esc(e.name)}</h2>
      <div class="form-grid">
        <div class="field"><label>Navn</label><input name="name" value="${esc(e.name)}" required></div>
        <div class="field"><label>Stilling / tittel</label><input name="title" value="${esc(e.title || '')}"></div>
        <div class="field"><label>Stillingsprosent</label><input name="percent" type="number" min="1" max="100" step="1" value="${e.percent}" required></div>
        <div class="field"><label>Kjønn</label><select name="gender"><option value="K" ${e.gender === 'K' ? 'selected' : ''}>Kvinne</option><option value="M" ${e.gender === 'M' ? 'selected' : ''}>Mann</option><option value="X" ${e.gender === 'X' ? 'selected' : ''}>Annet / ikke oppgitt</option></select></div>
        <div class="field span-2"><label>Kan jobbe</label><div class="checks">${shiftsHtml}</div></div>
        <div class="field span-2"><label>Kompetanse</label><div class="checks">${tagsHtml}<label><input name="newTag" placeholder="ny merkelapp…" style="padding:3px 6px;border:1px solid var(--line);border-radius:4px;width:150px"></label></div></div>
        <div class="field"><label>Helgefrekvens</label><select name="weekendEvery"><option value="">Standard (hver ${R.weekendEvery}. helg)</option>${[1, 2, 3, 4].map(n => `<option value="${n}" ${e.weekendEvery === n ? 'selected' : ''}>Hver ${n === 1 ? '' : n + '. '}helg${n === 1 ? ' (ingen begrensning)' : ''}</option>`).join('')}</select></div>
        <div class="field"><label>Helg</label><div class="checks" style="padding-top:6px"><label><input type="checkbox" name="onlyWeekends" ${e.onlyWeekends ? 'checked' : ''}> Helgestilling (bare helg)</label><label><input type="checkbox" name="noWeekends" ${e.noWeekends ? 'checked' : ''}> Fritatt fra helg</label></div></div>
        <div class="field span-2"><label>Kan ikke jobbe på</label><div class="checks">${wdHtml}</div></div>
        <div class="field"><label>Skal ikke jobbe sammen med</label><div class="checks" style="max-height:120px;overflow:auto">${colleagues('notWith')}</div></div>
        <div class="field"><label>Jobber godt sammen med</label><div class="checks" style="max-height:120px;overflow:auto">${colleagues('preferWith')}</div></div>
        <div class="field"><label>Annet</label><div class="checks" style="padding-top:6px"><label><input type="checkbox" name="wantsExtra" ${e.wantsExtra ? 'checked' : ''}> Ønsker ekstravakter ved fravær</label></div></div>
        <div class="field"><label>Maks dager på rad (overstyr)</label><input name="maxConsecutiveDays" type="number" min="1" max="14" value="${e.maxConsecutiveDays || ''}" placeholder="${R.maxConsecutiveDays}"></div>
        <div class="field span-2"><label>Notater</label><textarea name="notes">${esc(e.notes || '')}</textarea></div>
      </div>
      ${isNew ? '' : `
      <fieldset style="margin-top:14px"><legend>Fravær (ferie, permisjon, kurs, sykdom)</legend>
        <table class="data" id="absTable">${absRows || '<tr><td class="muted">Ingen registrert</td></tr>'}</table>
        <div class="toolbar" style="margin-top:8px"><select id="absType"><option value="ferie">Ferie</option><option value="permisjon">Permisjon</option><option value="kurs">Kurs</option><option value="syk">Syk</option><option value="annet">Annet</option></select>
          <input id="absFrom" type="date" value="${model.settings.periodStart}"> <span class="muted">til</span> <input id="absTo" type="date" value="${model.settings.periodStart}"> <input id="absNote" placeholder="merknad" style="width:140px">
          <button type="button" class="btn btn-sm" id="btnAddAbs">Legg til</button></div>
      </fieldset>
      <fieldset><legend>Ønsker</legend>
        <table class="data">${wishRows || '<tr><td class="muted">Ingen registrert</td></tr>'}</table>
        <div class="toolbar" style="margin-top:8px"><select id="wishKind"><option value="fri">Ønsker fri</option><option value="frihard">Fri (innvilget – bindende)</option><option value="vakt">Ønsker vakt</option></select>
          <select id="wishShift"><option value="">valgfri vakttype</option>${shiftOpts}</select> <input id="wishDate" type="date" value="${model.settings.periodStart}"> <input id="wishNote" placeholder="merknad" style="width:140px">
          <button type="button" class="btn btn-sm" id="btnAddWish">Legg til</button></div>
      </fieldset>`}
    </div>
    <div class="dialog-foot">
      <div>${isNew ? '' : `<button type="button" class="btn btn-danger" id="btnDelEmp">Slett ansatt</button>`}</div>
      <div class="right"><button type="button" class="btn" id="btnCancel">Avbryt</button><button type="submit" class="btn btn-primary">Lagre</button></div>
    </div></form>`;
    dlg.showModal();
    $('#btnCancel').addEventListener('click', () => dlg.close());
    const form = $('#empForm');
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const fd = new FormData(form);
      e.name = (fd.get('name') || '').trim(); if (!e.name) return;
      e.title = (fd.get('title') || '').trim();
      e.percent = Math.max(1, Math.min(100, +fd.get('percent') || 100));
      e.gender = fd.get('gender');
      e.shifts = {}; for (const s of model.settings.shiftTypes) e.shifts[s.id] = fd.getAll('shift').includes(s.id);
      e.tags = fd.getAll('tag');
      const nt = (fd.get('newTag') || '').trim().toLowerCase();
      if (nt) { e.tags.push(nt); if (!model.settings.tags.includes(nt)) model.settings.tags.push(nt); }
      e.weekendEvery = fd.get('weekendEvery') ? +fd.get('weekendEvery') : undefined;
      e.onlyWeekends = !!fd.get('onlyWeekends'); e.noWeekends = !!fd.get('noWeekends');
      e.blockedWeekdays = fd.getAll('bwd').map(Number);
      e.notWith = fd.getAll('notWith'); e.preferWith = fd.getAll('preferWith');
      e.wantsExtra = !!fd.get('wantsExtra');
      e.maxConsecutiveDays = +fd.get('maxConsecutiveDays') || undefined;
      e.notes = (fd.get('notes') || '').trim();
      if (isNew) model.employees.push(e); else model.employees[model.employees.findIndex(x => x.id === e.id)] = e;
      ensureRosterRows(); commit(); dlg.close(); render(); toast(isNew ? 'Ansatt lagt til.' : 'Lagret.');
    });
    if (!isNew) {
      $('#btnDelEmp').addEventListener('click', () => {
        if (!confirm(`Slette ${e.name}?`)) return;
        model.employees = model.employees.filter(x => x.id !== e.id);
        for (const x of model.employees) { x.notWith = (x.notWith || []).filter(i => i !== e.id); x.preferWith = (x.preferWith || []).filter(i => i !== e.id); }
        model.absences = model.absences.filter(a => a.employeeId !== e.id); model.wishes = model.wishes.filter(w => w.employeeId !== e.id);
        ensureRosterRows(); commit(); dlg.close(); render(); toast('Ansatt slettet.');
      });
      $('#btnAddAbs').addEventListener('click', () => {
        const from = $('#absFrom').value, to = $('#absTo').value || from; if (!from) return;
        model.absences.push({ id: 'a' + Date.now().toString(36), employeeId: e.id, from, to: to < from ? from : to, type: $('#absType').value, note: $('#absNote').value.trim() });
        commit(); openEmployeeDialog(e.id);
      });
      $('#btnAddWish').addEventListener('click', () => {
        const date = $('#wishDate').value; if (!date) return;
        const k = $('#wishKind').value;
        model.wishes.push({ id: 'w' + Date.now().toString(36), employeeId: e.id, date, kind: k === 'vakt' ? 'vakt' : 'fri', hard: k === 'frihard', shift: k === 'vakt' ? ($('#wishShift').value || null) : null, note: $('#wishNote').value.trim() });
        commit(); openEmployeeDialog(e.id);
      });
      $$('[data-del-abs]', c).forEach(b => b.addEventListener('click', () => { model.absences = model.absences.filter(a => a.id !== b.dataset.delAbs); commit(); openEmployeeDialog(e.id); }));
      $$('[data-del-wish]', c).forEach(b => b.addEventListener('click', () => { model.wishes = model.wishes.filter(w => w.id !== b.dataset.delWish); commit(); openEmployeeDialog(e.id); }));
    }
  }

  // ================================================================== BEMANNING
  function viewBemanning(main) {
    const c = ctx();
    const cap = VF.capacity(model);
    const shiftRows = model.settings.shiftTypes.map(s => {
      const cs = c.shiftById[s.id];
      return `<tr data-shift="${s.id}"><td><span class="chip chip-${s.id}">${s.id}</span></td><td><input type="text" data-f="name" value="${esc(s.name)}"></td><td><input type="time" data-f="start" value="${s.start}"></td><td><input type="time" data-f="end" value="${s.end}"></td><td class="num">${nb(cs.hours)} t</td><td>${cs.isNight ? 'Ja' : 'Nei'}</td></tr>`;
    }).join('');
    const demandTable = key => `<table class="data"><thead><tr><th>Vakt</th><th>Min</th><th>Maks</th>${model.settings.tags.map(t => `<th>${esc(t)}</th>`).join('')}<th>Min kvinner</th><th>Min menn</th></tr></thead><tbody>
      ${model.settings.shiftTypes.map(s => { const d = model.demand[key][s.id] || (model.demand[key][s.id] = { min: 0, max: 0, tags: {}, minK: 0, minM: 0 }); return `<tr data-key="${key}" data-shift="${s.id}">
        <td><span class="chip chip-${s.id}">${s.id}</span> ${esc(s.name)}</td>
        <td><input type="number" min="0" max="20" data-f="min" value="${d.min}"></td><td><input type="number" min="0" max="20" data-f="max" value="${d.max}"></td>
        ${model.settings.tags.map(t => `<td><input type="number" min="0" max="10" data-tag="${esc(t)}" value="${(d.tags || {})[t] || 0}"></td>`).join('')}
        <td><input type="number" min="0" max="10" data-f="minK" value="${d.minK || 0}"></td><td><input type="number" min="0" max="10" data-f="minM" value="${d.minM || 0}"></td></tr>`; }).join('')}
    </tbody></table>`;
    const ratio = cap.perWeek.available / Math.max(1, cap.perWeek.demandMin);
    main.innerHTML = `
      <div class="page-head"><div><h1>Bemanning</h1><div class="sub">Vakttyper og hvor mange som må være på jobb</div></div></div>
      <div class="panel"><h2>Vakttyper</h2>
        <table class="data"><thead><tr><th>Kode</th><th>Navn</th><th>Start</th><th>Slutt</th><th>Timer</th><th>Natt</th></tr></thead><tbody id="shiftRows">${shiftRows}</tbody></table>
        <p class="help" style="margin-top:8px">En vakt som slutter etter midnatt regnes som natt. Hviletid beregnes fra slutt til neste start.</p>
      </div>
      <div class="panel"><div class="panel-head"><h2>Bemanningskrav på hverdager</h2></div>${demandTable('weekday')}</div>
      <div class="panel"><div class="panel-head"><h2>Bemanningskrav i helg</h2><span class="muted small">lørdag og søndag, samt natt fredag og lørdag</span></div>${demandTable('weekend')}</div>
      <div class="panel"><h2>Går regnskapet opp?</h2>
        <div class="sumline"><span>Minstebehov <b>${nb(cap.perWeek.demandMin)} t/uke</b></span><span>Maks <b>${nb(cap.perWeek.demandMax)} t/uke</b></span><span>Kapasitet <b>${nb(cap.perWeek.available)} t/uke</b> (${nb(cap.fte)} årsverk)</span><span>Dekning <b>${Math.round(ratio * 100)} %</b></span></div>
        <div class="meter ${ratio < 1 ? 'danger' : ratio < 1.04 ? 'warn' : ''}" style="max-width:480px"><span style="width:${Math.min(100, ratio * 100 / 1.25)}%"></span></div>
        <p class="help" style="margin-top:8px">${ratio < 1 ? 'Kapasiteten er lavere enn minstebehovet – turnusen kan ikke gå opp uten flere ansatte eller lavere krav.' : ratio < 1.04 ? 'Svært lite slakk. Regn med at noen ansatte får litt færre timer enn stillingen tilsier, eller at helgekabalen blir stram.' : 'Kapasiteten dekker minstebehovet med margin. Overskuddet brukes til å møte stillingsprosentene (maks-grensen setter taket per vakt).'}</p>
      </div>`;
    $$('#shiftRows input', main).forEach(inp => inp.addEventListener('change', () => {
      const tr = inp.closest('tr'); const s = shiftById(tr.dataset.shift); const f = inp.dataset.f;
      if (f === 'name') s.name = inp.value.trim() || s.name; else s[f] = inp.value || s[f];
      commit(); viewBemanning(main);
    }));
    $$('tr[data-key] input', main).forEach(inp => inp.addEventListener('change', () => {
      const tr = inp.closest('tr'); const d = model.demand[tr.dataset.key][tr.dataset.shift];
      const v = Math.max(0, +inp.value || 0);
      if (inp.dataset.tag) { d.tags = d.tags || {}; d.tags[inp.dataset.tag] = v; }
      else d[inp.dataset.f] = v;
      if (d.max < d.min) d.max = d.min;
      commit(); viewBemanning(main);
    }));
  }

  // ================================================================== REGLER
  function viewRegler(main) {
    const R = rules();
    const rule = (key, label, help, type, extra) => `<div class="rule"><div><b>${label}</b></div>${type === 'checkbox' ? `<input type="checkbox" data-rule="${key}" ${R[key] ? 'checked' : ''}>` : `<input type="number" data-rule="${key}" value="${R[key]}" ${extra || ''}>`}<div class="help">${help}</div></div>`;
    const weight = (key, label, help) => `<div class="weight"><div><b>${label}</b><div class="help">${help}</div></div><input type="range" min="0" max="25" step="0.5" data-weight="${key}" value="${R.weights[key]}"><span class="num muted" id="w_${key}">${nb(R.weights[key])}</span></div>`;
    main.innerHTML = `
      <div class="page-head"><div><h1>Regler</h1><div class="sub">Arbeidsmiljøloven, tariff og lokale avtaler. Harde regler brytes aldri av generatoren.</div></div>
        <div class="toolbar"><button class="btn" id="btnRulesReset">Tilbakestill til standard</button></div></div>
      <div class="grid-2">
        <div class="panel"><h2>Arbeidstid og hvile</h2>
          ${rule('avgWeeklyHours', 'Ukentlig arbeidstid for 100 % stilling (timer)', 'AML § 10-4 (3): 35,5 t for turnus med natt- eller søndagsarbeid. Brukes til å regne ut hver ansatts timetall i perioden.', 'number', 'step="0.5" min="20" max="40"')}
          ${rule('minRestHours', 'Minste daglige hvile (timer)', 'AML § 10-8 (1): 11 timer sammenhengende mellom to vakter. Kveld etterfulgt av dag gir bare 9,5 t og blir derfor aldri foreslått.', 'number', 'step="0.5" min="8" max="16"')}
          ${rule('weeklyRestHours', 'Ukentlig sammenhengende fri (timer)', 'AML § 10-8 (2): 35 timer sammenhengende i løpet av sju dager (F1).', 'number', 'step="1" min="24" max="48"')}
          ${rule('maxWeekHours', 'Maks timer i én enkelt uke', 'AML § 10-5: tak per uke ved gjennomsnittsberegning. 48 t uten særskilt avtale; opptil 54 t med avtale med tillitsvalgte.', 'number', 'step="1" min="35" max="60"')}
          ${rule('maxConsecutiveDays', 'Maks arbeidsdager på rad', 'Vanlig grense i turnusavtaler er 6 (noen steder 5). Kan overstyres per ansatt.', 'number', 'min="3" max="12"')}
          ${rule('maxConsecutiveNights', 'Maks nattevakter på rad', 'Lokalt avtalt, ofte 3–4. Etter siste natt må det alltid følge en fridag (sikres av hvileregelen).', 'number', 'min="1" max="7"')}
        </div>
        <div class="panel"><h2>Helg</h2>
          ${rule('weekendEvery', 'Jobber hver … helg', 'Tariff (f.eks. hver 3. helg). Kan settes per ansatt – helgestillinger jobber gjerne hver 2. helg.', 'number', 'min="1" max="6"')}
          ${rule('weekendHard', 'Helgefrekvens er en hard regel', 'Av: avvik blir et avvik som vektes, ikke et brudd.', 'checkbox')}
          ${rule('fridayNightIsWeekend', 'Natt fredag regnes som helg', 'Nattevakt fredag → lørdag teller som helgearbeid.', 'checkbox')}
          ${rule('sundayNightIsWeekend', 'Natt søndag regnes som helg', 'Vanligvis av: natt søndag → mandag tilhører den nye uken.', 'checkbox')}
        </div>
      </div>
      <div class="panel"><h2>Hva skal veie tyngst når alt ikke kan oppfylles?</h2>
        <p class="help">Regler over er absolutte. Disse er avveininger: høyere tall betyr at generatoren strekker seg lenger for å unngå avviket.</p>
        ${weight('hours', 'Treffe stillingsprosenten', 'Straff per time over eller under det ansatte skal jobbe i perioden')}
        ${weight('wishFri', 'Innfri ønsker om fri', 'Per ønske som ikke innfris (innvilget fri er alltid bindende)')}
        ${weight('wishVakt', 'Innfri ønsker om vakt', 'Per ønske om ekstra vakt som ikke innfris')}
        ${weight('splitWeekend', 'Hele helger', 'Straff når noen jobber bare én av helgedagene')}
        ${weight('singleNight', 'Netter i blokker', 'Straff for enkeltstående nattevakter')}
        ${weight('singleFree', 'Unngå enkeltstående fridager', 'En fridag klemt mellom to arbeidsdager gir lite hvile')}
        ${weight('typeChange', 'Stabile vakttyper', 'Straff når vakttypen skifter midt i en arbeidsperiode (D D A A er bedre enn D A D A)')}
        ${weight('fairness', 'Rettferdig fordeling', 'Netter og helgevakter fordeles i forhold til stillingsprosent')}
        ${weight('preferWith', 'Gode team', 'Bonus når kolleger som jobber godt sammen får samme vakt')}
      </div>`;
    $$('[data-rule]', main).forEach(inp => inp.addEventListener('change', () => {
      model.rules = model.rules || {}; const k = inp.dataset.rule;
      model.rules[k] = inp.type === 'checkbox' ? inp.checked : +inp.value;
      commit(); renderNav();
    }));
    $$('[data-weight]', main).forEach(inp => {
      inp.addEventListener('input', () => { $('#w_' + inp.dataset.weight).textContent = nb(+inp.value); });
      inp.addEventListener('change', () => { model.rules = model.rules || {}; model.rules.weights = model.rules.weights || {}; model.rules.weights[inp.dataset.weight] = +inp.value; commit(); renderNav(); });
    });
    $('#btnRulesReset').addEventListener('click', () => { model.rules = null; commit(); render(); toast('Standardregler gjenopprettet.'); });
  }

  // ================================================================== TURNUS
  function viewTurnus(main) {
    const c = ctx();
    const r = report();
    const head = `<div class="page-head"><div><h1>Turnus</h1><div class="sub">${esc(periodLabel())}</div></div>
      <div class="toolbar no-print">
        <button class="btn" id="btnUndo" ${ui.undo.length ? '' : 'disabled'}>Angre</button>
        <button class="btn" id="btnClear" ${model.roster ? '' : 'disabled'}>Tøm</button>
        <button class="btn" id="btnImprove" ${model.roster && !ui.busy ? '' : 'disabled'}>Forbedre videre</button>
        <button class="btn btn-primary" id="btnGenerate" ${ui.busy ? 'disabled' : ''}>${model.roster ? 'Generer på nytt' : 'Generer turnus'}</button>
      </div></div>`;
    if (!model.roster) {
      main.innerHTML = head + `<div class="panel"><div class="empty"><b>Ingen turnus ennå</b>Kabalen er ikke lagt. ${model.employees.length} ansatte og ${c.days} dager venter.<div style="margin-top:14px"><button class="btn btn-primary" id="btnGenerate2">Generer turnus</button></div></div>
        <div id="progress" class="hidden"><div class="progress"><span style="width:0%"></span></div><div class="muted small" id="progressText"></div></div></div>`;
      $('#btnGenerate').addEventListener('click', generateRoster);
      $('#btnGenerate2').addEventListener('click', generateRoster);
      return;
    }
    main.innerHTML = head + `
      <div class="panel no-print" style="padding:12px 18px">
        <div class="sumline" id="sumline">${sumlineHtml(c, r)}</div>
        <div id="progress" class="hidden"><div class="progress"><span style="width:0%"></span></div><div class="muted small" id="progressText"></div></div>
      </div>
      <div class="roster-wrap">
        <div><div class="roster-scroll" id="rosterScroll">${rosterTable(c, r)}</div>
          <div class="legend no-print" style="margin:10px 2px">
            ${model.settings.shiftTypes.map(s => `<span><span class="c" style="background:var(--shift-${s.id})"></span>${esc(s.name)} ${s.start}–${s.end}</span>`).join('')}
            <span><span class="c" style="background:var(--ferie)"></span>Ferie/permisjon</span><span><span class="c" style="background:var(--syk)"></span>Syk</span>
            <span><span class="c" style="box-shadow:inset 0 0 0 2px var(--danger)"></span>Brudd</span><span>· Prikk = ønske denne dagen · Klikk en celle for detaljer og alternativer</span>
          </div>
        </div>
        <div class="inspector no-print"><div class="panel" id="inspector">${inspectorHtml(c, r)}</div></div>
      </div>
      <div class="panel no-print"><h2>Brudd og avvik</h2><div id="violations">${violationsHtml(c, r)}</div></div>`;
    $('#btnGenerate').addEventListener('click', generateRoster);
    $('#btnImprove').addEventListener('click', improveRosterUI);
    $('#btnUndo').addEventListener('click', undo);
    $('#btnClear').addEventListener('click', () => { if (!confirm('Tømme turnusen?')) return; pushUndo(); model.roster = null; ui.sel = null; commit(); render(); });
    $('#rosterScroll').addEventListener('click', ev => {
      const td = ev.target.closest('td.cell'); if (td) { ui.sel = { e: td.dataset.e, d: +td.dataset.d }; ui.pendingChange = null; refreshTurnus(); return; }
      const ft = ev.target.closest('td[data-slot]'); if (ft) { ui.sel = { d: +ft.dataset.d, s: ft.dataset.slot }; ui.pendingChange = null; refreshTurnus(); }
    });
    bindInspector();
    bindViolations();
    if (ui.sel) scrollToDay(ui.sel.d, true);
  }
  function scrollToDay(d, gentle) {
    const sc = $('#rosterScroll'); if (!sc) return;
    const th = sc.querySelector(`th[data-d="${d}"]`); if (!th) return;
    const target = th.offsetLeft - 236 - sc.clientWidth / 2 + 60;
    if (!gentle || target < sc.scrollLeft || target > sc.scrollLeft + sc.clientWidth - 300) sc.scrollLeft = Math.max(0, target);
  }
  function refreshTurnus() {
    const c = ctx(), r = report();
    const sc = $('#rosterScroll'); if (!sc) return;
    const left = sc.scrollLeft, top = sc.scrollTop;
    sc.innerHTML = rosterTable(c, r); sc.scrollLeft = left; sc.scrollTop = top;
    $('#inspector').innerHTML = inspectorHtml(c, r); bindInspector();
    const u = $('#btnUndo'); if (u) u.disabled = !ui.undo.length;
    const vi = $('#violations'); if (vi) { vi.innerHTML = violationsHtml(c, r); bindViolations(); }
    const sl = $('#sumline'); if (sl) sl.innerHTML = sumlineHtml(c, r);
  }
  function bindViolations() {
    $$('.viol .v[data-d]', $('#violations')).forEach(v => v.addEventListener('click', () => {
      ui.sel = v.dataset.s ? { d: +v.dataset.d, s: v.dataset.s } : { e: v.dataset.e, d: +v.dataset.d };
      ui.pendingChange = null; refreshTurnus(); scrollToDay(ui.sel.d);
    }));
  }
  function sumlineHtml(c, r) {
    const softCounts = {};
    for (const er of Object.values(r.employees)) for (const v of er.soft) softCounts[v.code] = (softCounts[v.code] || 0) + 1;
    const wishesTotal = model.wishes.filter(w => dayIndex(w.date) >= 0 && dayIndex(w.date) < c.days).length;
    const wishesMissed = (softCounts.wishFri || 0) + (softCounts.wishVakt || 0);
    const hoursDev = model.employees.reduce((a, e) => a + Math.abs(r.employees[e.id].stats.dev), 0);
    return `<span>Dekning <b>${r.coverage.filled} / ${r.coverage.required}</b> vakter</span>
          <span>Brudd på regler <b style="color:${r.hardCount ? 'var(--danger)' : 'var(--ok)'}">${r.hardCount}</b></span>
          <span>Ønsker innfridd <b>${wishesTotal - wishesMissed} / ${wishesTotal}</b></span>
          <span>Delte helger <b>${softCounts.splitWeekend || 0}</b></span>
          <span>Enkeltnetter <b>${softCounts.singleNight || 0}</b></span>
          <span>Timeavvik totalt <b>${fmtH(hoursDev)}</b></span>
          <span class="muted">laget ${new Date(model.roster.generatedAt).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })}</span>`;
  }

  function rosterTable(c, r) {
    const asg = model.roster.asg;
    const weeks = [];
    for (let w = 0; w < c.weeks; w++) weeks.push(`<th colspan="7" class="${w % 2 ? 'we' : ''}">Uke ${c.dayInfo[w * 7].isoWeek}</th>`);
    const dates = c.dayInfo.map(di => `<th data-d="${di.d}" class="${di.weekend ? 'we' : ''}">${new Date(VF.parseISO(di.iso)).getUTCDate()}</th>`).join('');
    const wds = c.dayInfo.map(di => `<th class="${di.weekend ? 'we' : ''}">${VF.WD_SHORT[di.wd][0].toUpperCase()}</th>`).join('');
    const badCells = {};
    for (const e of model.employees) for (const v of r.employees[e.id].hard) if (v.d >= 0) badCells[e.id + ':' + v.d] = (badCells[e.id + ':' + v.d] || '') + v.msg + '\n';
    const softCells = {};
    for (const e of model.employees) for (const v of r.employees[e.id].soft) if (v.d >= 0 && (v.code === 'wishFri' || v.code === 'wishVakt' || v.code === 'wishShift')) softCells[e.id + ':' + v.d] = (softCells[e.id + ':' + v.d] || '') + v.msg + '\n';
    const rows = model.employees.map(e => {
      const st = r.employees[e.id].stats;
      const pct = Math.min(100, st.hours / Math.max(1, st.target) * 100);
      const cls = st.dev > 4 ? 'over' : st.dev < -4 ? 'under' : '';
      const cells = c.dayInfo.map(di => {
        const d = di.d; const s = asg[e.id][d];
        const a = c.absAt[e.id] && c.absAt[e.id][d];
        const w = c.wishAt[e.id] && c.wishAt[e.id][d];
        let inner;
        if (a && !a.planned) inner = `<span class="c syk" title="Syk${s ? ' (planlagt ' + shiftById(s).name.toLowerCase() + ')' : ''}">S</span>`;
        else if (a) inner = `<span class="c ${a.type === 'ferie' ? 'ferie' : 'perm'}" title="${esc(a.typeName)}">${a.type === 'ferie' ? 'F' : 'P'}</span>`;
        else if (s) inner = `<span class="c ${s}">${s}</span>`;
        else inner = `<span class="c off">·</span>`;
        if (w) inner = `<span class="w" title="${esc(wishType(w))}">${inner}</span>`;
        const key = e.id + ':' + d;
        const sel = ui.sel && ui.sel.e === e.id && ui.sel.d === d ? ' sel' : '';
        const bad = badCells[key] ? ' bad' : softCells[key] ? ' soft' : '';
        const title = badCells[key] || softCells[key] || '';
        return `<td class="cell${di.weekend ? ' we' : ''}${sel}${bad}" data-e="${e.id}" data-d="${d}" ${title ? `title="${esc(title.trim())}"` : ''}>${inner}</td>`;
      }).join('');
      return `<tr><td class="name"><div class="n" title="${esc(e.title || '')}">${esc(e.name)}</div><div class="s"><b class="num">${e.percent} %</b><span class="hm ${cls}"><span style="width:${pct}%"></span></span><span class="num nowrap" title="planlagt / stilling">${nb(st.hours)}/${nb(st.target)} t</span><span class="nowrap" title="netter · helgevakter">${st.nights} N · ${st.weekendShifts} H</span></div></td>${cells}</tr>`;
    }).join('');
    const foot = model.settings.shiftTypes.map(s => {
      const cells = c.dayInfo.map(di => {
        const q = r.slots[di.d + ':' + s.id];
        const n = q.present.length, min = q.demand.min;
        const bad = q.hard.length > 0;
        const sel = ui.sel && ui.sel.s === s.id && ui.sel.d === di.d;
        return `<td data-slot="${s.id}" data-d="${di.d}" class="${bad ? 'short' : 'ok'}${di.weekend ? ' we' : ''}" style="cursor:pointer${sel ? ';outline:2px solid var(--ink);outline-offset:-2px' : ''}" title="${esc(q.hard.map(v => v.msg).join('\n') || `${s.name}: ${n} av ${min}`)}">${min ? `${n}` : ''}</td>`;
      }).join('');
      return `<tr style="--foot:${(model.settings.shiftTypes.length - 1 - model.settings.shiftTypes.indexOf(s)) * 20}px"><td class="name"><span class="chip chip-${s.id}">${s.id}</span> ${esc(s.name)} <span class="muted">på jobb</span></td>${cells}</tr>`;
    }).join('');
    return `<table class="roster"><thead><tr><th class="name" rowspan="3">Ansatt</th>${weeks.join('')}</tr><tr>${dates}</tr><tr>${wds}</tr></thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table>`;
  }

  function inspectorHtml(c, r) {
    if (!ui.sel) return `<h2>Detaljer</h2><p class="muted">Klikk på en celle i turnusen for å se hvorfor den er som den er, endre vakt, eller finne ut hvem som kan ta vakten. Klikk på tallene nederst for å se hvem som kan fylle et hull.</p>`;
    const asg = model.roster.asg;
    const d = ui.sel.d; const iso = dayISO(d);
    if (ui.sel.s) return slotInspector(c, r, d, ui.sel.s);
    const e = empById(ui.sel.e); if (!e) return '';
    const s = asg[e.id][d]; const st = s && shiftById(s);
    const a = c.absAt[e.id] && c.absAt[e.id][d];
    const w = c.wishAt[e.id] && c.wishAt[e.id][d];
    const er = r.employees[e.id];
    const hereHard = er.hard.filter(v => v.d === d), hereSoft = er.soft.filter(v => v.d === d);
    const week = c.dayInfo[d].week;
    let html = `<div class="who">${esc(e.name)}</div><div class="when">${VF.WD_LONG[c.dayInfo[d].wd]} ${VF.fmtDate(iso)} · uke ${c.dayInfo[d].isoWeek}</div>
      <div class="now">${st ? `<span class="chip chip-${s}">${s}</span> <b>${esc(st.name)}</b> ${st.start}–${st.end} (${nb(c.shiftById[s].hours)} t)` : '<span class="chip chip-off">Fri</span>'}${a ? ` · <b>${esc(a.typeName)}</b>` : ''}${w ? ` · ${wishType(w)}${w.note ? ' («' + esc(w.note) + '»)' : ''}` : ''}</div>
      <div class="small muted" style="margin-bottom:8px">Uke ${c.dayInfo[d].isoWeek}: ${nb(er.stats.weekHours[week])} t · perioden: ${nb(er.stats.hours)} av ${nb(er.stats.target)} t (${er.stats.dev >= 0 ? '+' : ''}${nb(er.stats.dev)})</div>`;
    if (hereHard.length) html += `<div class="viol" style="margin-bottom:8px">${hereHard.map(v => `<div class="v">${esc(v.msg)}</div>`).join('')}</div>`;
    if (hereSoft.length) html += `<div class="viol" style="margin-bottom:8px">${hereSoft.map(v => `<div class="v soft">${esc(v.msg)}</div>`).join('')}</div>`;
    html += `<h3 style="margin:10px 0 6px">Endre</h3><div class="shift-btns">${model.settings.shiftTypes.map(x => `<button class="btn ${x.id}${s === x.id ? ' cur' : ''}" data-set="${x.id}" title="${esc(x.name)}">${x.id}</button>`).join('')}<button class="btn off${!s ? ' cur' : ''}" data-set="">Fri</button></div>`;
    if (ui.pendingChange && ui.pendingChange.e === e.id && ui.pendingChange.d === d) {
      const p = ui.pendingChange;
      html += `<div class="viol" style="margin-bottom:8px"><div class="v" style="cursor:default"><div><b>${p.to ? shiftById(p.to).name + 'vakt' : 'Fri'} her bryter regler:</b><br>${p.reasons.map(esc).join('<br>')}</div></div></div>
        <div class="toolbar" style="margin-bottom:12px"><button class="btn btn-sm btn-danger" data-force="1">Sett likevel</button><button class="btn btn-sm" data-cancel-pending="1">Avbryt</button></div>`;
    }
    if (s) {
      const work = VF.cloneAsg(asg); work[e.id][d] = null;
      const rep = VF.findReplacements(model, work, d, s, { swaps: true });
      const cands = rep.candidates.filter(x => x.employeeId !== e.id && x.partnerId !== e.id).slice(0, 6);
      html += `<h3 style="margin:14px 0 4px">Hvem kan ta ${esc(st.name.toLowerCase())}vakten i stedet?</h3>`;
      html += cands.length ? cands.map(cd => candidateHtml(cd, [{ e: e.id, d, from: s, to: null }])).join('') : '<p class="muted small">Ingen kan ta vakten uten å bryte regler.</p>';
      html += excludedHtml(rep.excluded.filter(x => x.employeeId !== e.id));
    } else if (!a) {
      html += `<h3 style="margin:14px 0 4px">Kan ${esc(e.name.split(' ')[0])} jobbe denne dagen?</h3>`;
      for (const x of model.settings.shiftTypes) {
        const chk = VF.checkChange(c, asg, e.id, d, x.id);
        html += `<div class="excl"><b><span class="chip chip-${x.id}">${x.id}</span> ${esc(x.name)}</b>: ${chk.ok ? '<span style="color:var(--ok)">ja</span>' : esc(chk.reasons.join('; '))}</div>`;
      }
    }
    return html;
  }
  function slotInspector(c, r, d, s) {
    const asg = model.roster.asg; const st = shiftById(s); const q = r.slots[d + ':' + s];
    let html = `<div class="who"><span class="chip chip-${s}">${s}</span> ${esc(st.name)}vakt</div><div class="when">${VF.WD_LONG[c.dayInfo[d].wd]} ${VF.fmtDate(dayISO(d))} · uke ${c.dayInfo[d].isoWeek} · ${st.start}–${st.end}</div>
      <div class="now">${q.present.length} av ${q.demand.min} på jobb${q.demand.max ? ` (maks ${q.demand.max})` : ''}: ${q.present.map(e => esc(e.name.split(' ')[0])).join(', ') || '<span class="muted">ingen</span>'}</div>`;
    const req = [];
    for (const [t, n] of Object.entries(q.demand.tags || {})) if (n) req.push(`${n} ${t}`);
    if (q.demand.minK) req.push(`${q.demand.minK} kvinne${q.demand.minK > 1 ? 'r' : ''}`);
    if (q.demand.minM) req.push(`${q.demand.minM} ${q.demand.minM > 1 ? 'menn' : 'mann'}`);
    if (req.length) html += `<div class="small muted" style="margin-bottom:8px">Krav: minst ${req.join(', ')}</div>`;
    if (q.hard.length) html += `<div class="viol" style="margin-bottom:8px">${q.hard.map(v => `<div class="v" style="cursor:default">${esc(v.msg)}</div>`).join('')}</div>`;
    if (!q.hard.length && q.demand.max && q.present.length >= q.demand.max) {
      html += `<p class="muted small" style="margin-top:10px">Vakten er fullt bemannet. Klikk på en av de ansatte i turnusen for å se hvem som kan overta for vedkommende.</p>`;
      return html;
    }
    const rep = VF.findReplacements(model, asg, d, s, { swaps: true });
    const title = q.hard.length ? 'Hvem kan fylle hullet?' : 'Hvem kan legges til?';
    html += `<h3 style="margin:12px 0 4px">${title}</h3>`;
    const cands = rep.candidates.slice(0, 8);
    html += cands.length ? cands.map(cd => candidateHtml(cd, [])).join('') : '<p class="muted small">Ingen kan ta vakten uten å bryte regler. Vurder innleie/vikar eller endre kravene.</p>';
    html += excludedHtml(rep.excluded);
    return html;
  }
  function candidateHtml(cd, pre) {
    const e = empById(cd.employeeId); if (!e) return '';
    const changes = pre.concat(cd.changes);
    const kind = cd.kind === 'direct' ? (e.wantsExtra ? 'ønsker ekstravakter · ' : '') : cd.kind === 'move' ? 'bytte av vakttype · ' : 'to endringer · ';
    return `<div class="cand" data-apply='${esc(JSON.stringify(changes))}'><div class="n">${esc(e.name)}${cd.partnerId ? ` + ${esc((empById(cd.partnerId) || {}).name || '')}` : ''}</div><div class="l">${kind}${esc(cd.label)}${cd.fixes > 1 ? ` · dekker ${cd.fixes} krav` : ''}</div><button class="btn btn-sm" data-choose="1">Velg</button></div>`;
  }
  function excludedHtml(excluded) {
    if (!excluded.length) return '';
    return `<details><summary>Hvorfor ikke de andre (${excluded.length})</summary>${excluded.map(x => `<div class="excl"><b>${esc((empById(x.employeeId) || {}).name || x.employeeId)}</b>: ${esc(x.reasons.join('; '))}</div>`).join('')}</details>`;
  }
  function bindInspector() {
    const box = $('#inspector'); if (!box) return;
    $$('[data-set]', box).forEach(b => b.addEventListener('click', () => {
      const to = b.dataset.set || null; const e = ui.sel.e, d = ui.sel.d;
      const from = model.roster.asg[e][d]; if (from === to) return;
      const chk = VF.checkChange(ctx(), model.roster.asg, e, d, to);
      if (!chk.ok) { ui.pendingChange = { e, d, to, reasons: chk.reasons }; refreshTurnus(); return; }
      doManualChange([{ e, d, from, to }]);
    }));
    $$('[data-force]', box).forEach(b => b.addEventListener('click', () => {
      const p = ui.pendingChange; if (!p) return;
      doManualChange([{ e: p.e, d: p.d, from: model.roster.asg[p.e][p.d], to: p.to }], true);
    }));
    $$('[data-cancel-pending]', box).forEach(b => b.addEventListener('click', () => { ui.pendingChange = null; refreshTurnus(); }));
    $$('.cand [data-choose]', box).forEach(b => b.addEventListener('click', () => {
      const changes = JSON.parse(b.closest('.cand').dataset.apply);
      doManualChange(changes);
    }));
  }
  function doManualChange(changes, forced) {
    pushUndo(); applyChanges(changes);
    logChange((forced ? 'Manuell endring (tross regelbrudd): ' : 'Manuell endring: ') + describeChanges(changes), changes);
    ui.pendingChange = null; commit(); renderNav(); refreshTurnus(); toast('Turnusen er oppdatert.');
  }
  function violationsHtml(c, r) {
    const items = [];
    for (let d = 0; d < c.days; d++) for (const s of model.settings.shiftTypes) for (const v of r.slots[d + ':' + s.id].hard) items.push(`<div class="v" data-d="${d}" data-s="${s.id}">${esc(v.msg)}</div>`);
    for (const e of model.employees) for (const v of r.employees[e.id].hard) items.push(`<div class="v" data-e="${e.id}" data-d="${Math.max(0, v.d)}"><b>${esc(e.name)}:</b> ${esc(v.msg)}</div>`);
    const soft = [];
    for (const e of model.employees) for (const v of r.employees[e.id].soft) if (['wishFri', 'wishVakt', 'wishShift', 'splitWeekend', 'singleNight', 'fairNights', 'fairWeekend', 'hours'].includes(v.code) && !(v.code === 'hours' && Math.abs(r.employees[e.id].stats.dev) < 4)) soft.push(`<div class="v soft" data-e="${e.id}" data-d="${Math.max(0, v.d)}"><b>${esc(e.name)}:</b> ${esc(v.msg)}</div>`);
    let html = items.length ? `<div class="viol">${items.join('')}</div>` : `<p style="color:var(--ok)"><b>Ingen brudd.</b> Alle vakter er dekket og alle harde regler er oppfylt.</p>`;
    if (soft.length) html += `<details><summary>Avvik fra ønsker og preferanser (${soft.length})</summary><div class="viol">${soft.join('')}</div></details>`;
    return html;
  }

  // ------------------------------------------------------------ solver jobs
  function getWorker() {
    if (worker) return worker;
    try {
      worker = new Worker('worker.js');
      worker.onmessage = ev => { const job = jobs[ev.data.id]; if (job) job(ev.data); };
      worker.onerror = ev => { console.error(ev); };
    } catch (e) { worker = null; }
    return worker;
  }
  const jobs = {};
  function runJob(type, payload, onProgress, onDone) {
    const id = ++jobSeq;
    const plain = JSON.parse(JSON.stringify(model));
    const w = getWorker();
    if (w) {
      jobs[id] = msg => {
        if (msg.type === 'progress') onProgress(msg.progress);
        else { delete jobs[id]; if (msg.type === 'error') { console.error(msg.error); toast('Generering feilet: ' + msg.error.split('\n')[0]); onDone(null); } else onDone(msg.result); }
      };
      w.postMessage({ id, type, model: plain, asg: payload.asg, opts: payload.opts });
    } else {
      setTimeout(() => {
        try {
          const res = type === 'generate' ? VF.generate(plain, Object.assign({}, payload.opts, { onProgress })) : VF.improveRoster(plain, payload.asg, Object.assign({}, payload.opts, { onProgress }));
          onDone(res);
        } catch (e) { console.error(e); toast('Generering feilet.'); onDone(null); }
      }, 20);
    }
  }
  function showProgress(p) {
    const box = $('#progress'); if (!box) return;
    box.classList.remove('hidden');
    const frac = Math.min(1, (p.elapsedMs || 0) / (p.budget || 3000));
    const att = p.attempts > 1 ? `Forsøk ${p.attempt} av ${p.attempts} · ` : '';
    box.querySelector('span').style.width = (frac * 100) + '%';
    $('#progressText').textContent = `${att}${(p.iterations || 0).toLocaleString('nb-NO')} forsøk på forbedringer…`;
  }
  function generateRoster() {
    if (ui.busy) return;
    if (!model.employees.length) { toast('Legg inn ansatte først.'); return; }
    if (model.roster) pushUndo();
    ui.busy = true;
    $$('#btnGenerate, #btnGenerate2, #btnImprove').forEach(b => { if (b) b.disabled = true; });
    const box = $('#progress'); if (box) { box.classList.remove('hidden'); $('#progressText').textContent = 'Legger helgene først …'; }
    const seed = Date.now() & 0xffffff;
    runJob('generate', { opts: { seed, timeBudgetMs: 3000, polishMs: 2000, attempts: 2 } }, showProgress, res => {
      ui.busy = false;
      if (!res) { render(); return; }
      model.roster = { asg: res.asg, generatedAt: new Date().toISOString(), seed };
      logChange(`Turnus generert (${(res.iterations || 0).toLocaleString('nb-NO')} forbedringsforsøk, ${nb((res.elapsedMs || 0) / 1000)} s)`, []);
      ui.sel = null; commit(); render();
      const r = report();
      toast(r.hardCount === 0 ? 'Turnusen går opp – ingen brudd.' : `Ferdig med ${r.hardCount} brudd som må løses manuelt.`);
    });
  }
  function improveRosterUI() {
    if (ui.busy || !model.roster) return;
    pushUndo(); ui.busy = true;
    $$('#btnGenerate, #btnImprove').forEach(b => { if (b) b.disabled = true; });
    const box = $('#progress'); if (box) { box.classList.remove('hidden'); $('#progressText').textContent = 'Leter etter forbedringer …'; }
    const before = report().objective;
    runJob('improve', { asg: model.roster.asg, opts: { seed: Date.now() & 0xffffff, timeBudgetMs: 3000, polishMs: 2000 } }, showProgress, res => {
      ui.busy = false;
      if (!res) { render(); return; }
      model.roster.asg = res.asg; commit();
      const after = report().objective;
      logChange('Turnus forbedret', []); render();
      toast(after < before - 0.5 ? 'Fant en bedre løsning.' : 'Fant ingen bedre løsning denne gangen.');
    });
  }

  // ================================================================== FRAVÆR
  function viewFravaer(main) {
    const c = ctx();
    const empOpts = model.employees.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    const holes = model.roster ? VF.uncoveredSlots(model, model.roster.asg) : [];
    const absRows = model.absences.slice().sort((a, b) => a.from.localeCompare(b.from)).map(a => `<tr><td>${esc((empById(a.employeeId) || {}).name || '?')}</td><td>${absType(a.type)}</td><td class="nowrap">${VF.fmtDateWd(a.from)}${a.from !== a.to ? ' – ' + VF.fmtDateWd(a.to) : ''}</td><td class="muted">${esc(a.note || '')}</td><td class="actions"><button class="btn btn-sm btn-danger" data-del-abs="${a.id}">Fjern</button></td></tr>`).join('');
    const holesHtml = !model.roster ? '<p class="muted">Lag en turnus først.</p>' : !holes.length ? '<p style="color:var(--ok)"><b>Alle vakter er dekket.</b></p>' : holes.map(h => {
      const open = ui.repairOpen[h.d + ':' + h.s];
      const st = shiftById(h.s);
      let inner = '';
      if (open) {
        const rep = VF.findReplacements(model, model.roster.asg, h.d, h.s, { swaps: true });
        inner = `<div style="padding:6px 0 4px">${rep.candidates.slice(0, 8).map(cd => candidateHtml(cd, [])).join('') || '<p class="muted small">Ingen kan ta vakten uten å bryte regler. Vurder innleie eller å senke kravet for denne vakten.</p>'}${excludedHtml(rep.excluded)}</div>`;
      }
      return `<div style="padding:8px 0;border-bottom:1px solid var(--line-2)"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div><span class="chip chip-${h.s}">${h.s}</span> <b>${esc(st.name)} ${VF.fmtDateWd(h.iso)}</b> <span class="muted small">· ${esc(h.problems.map(p => p.replace(/^[^:]*: /, '')).join(' · '))}</span></div>
        <button class="btn btn-sm" data-hole="${h.d}:${h.s}">${open ? 'Skjul' : 'Finn erstatter'}</button></div>${inner}</div>`;
    }).join('');
    const logHtml = model.changelog.length ? `<div class="log">${model.changelog.slice(0, 40).map(l => `<div class="e"><div class="t">${new Date(l.ts).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })}</div><div>${esc(l.text)}</div></div>`).join('')}</div>` : '<p class="muted">Ingen endringer ennå.</p>';
    main.innerHTML = `
      <div class="page-head"><div><h1>Fravær og endringer</h1><div class="sub">Meld sykdom, se hvilke vakter som må dekkes, og velg blant lovlige løsninger</div></div>
        <div class="toolbar">${holes.length ? `<button class="btn btn-primary" id="btnAutoRepair">Løs alle automatisk (${holes.length})</button>` : ''}<button class="btn" id="btnUndo2" ${ui.undo.length ? '' : 'disabled'}>Angre siste</button></div></div>
      <div class="grid-2">
        <div class="panel"><h2>Meld fravær</h2>
          <div class="form-grid">
            <div class="field"><label for="fAbsEmp">Ansatt</label><select id="fAbsEmp">${empOpts}</select></div>
            <div class="field"><label for="fAbsType">Type</label><select id="fAbsType"><option value="syk">Syk</option><option value="ferie">Ferie</option><option value="permisjon">Permisjon</option><option value="kurs">Kurs</option><option value="annet">Annet</option></select></div>
            <div class="field"><label for="fAbsFrom">Fra</label><input id="fAbsFrom" type="date" value="${model.settings.periodStart}"></div>
            <div class="field"><label for="fAbsTo">Til</label><input id="fAbsTo" type="date" value="${model.settings.periodStart}"></div>
            <div class="field span-2"><label for="fAbsNote">Merknad</label><input id="fAbsNote" placeholder="valgfritt"></div>
          </div>
          <button class="btn btn-primary" id="btnAddAbs2">Registrer fravær</button>
          <p class="help" style="margin-top:8px">Sykdom fjerner personen fra vaktene, men beholder timene. Ferie og permisjon regnes som planlagt fravær.</p>
        </div>
        <div class="panel"><h2>Vakter som må dekkes</h2>${holesHtml}</div>
      </div>
      <div class="grid-2">
        <div class="panel"><h2>Registrert fravær</h2><table class="data">${absRows || '<tr><td class="muted">Ingen</td></tr>'}</table></div>
        <div class="panel"><h2>Endringslogg</h2>${logHtml}</div>
      </div>`;
    $('#btnAddAbs2').addEventListener('click', () => {
      const from = $('#fAbsFrom').value, to = $('#fAbsTo').value || from; if (!from) return;
      const type = $('#fAbsType').value;
      model.absences.push({ id: 'a' + Date.now().toString(36), employeeId: $('#fAbsEmp').value, from, to: to < from ? from : to, type, note: $('#fAbsNote').value.trim() });
      const e = empById($('#fAbsEmp').value);
      logChange(`${absType(type)} registrert for ${e ? e.name : ''} ${VF.fmtDateWd(from)}${to !== from ? ' – ' + VF.fmtDateWd(to) : ''}`, []);
      commit(); render();
      const n = model.roster ? VF.uncoveredSlots(model, model.roster.asg).length : 0;
      toast(n ? `Registrert. ${n} vakt${n > 1 ? 'er' : ''} må dekkes.` : 'Registrert.');
    });
    $$('[data-del-abs]', main).forEach(b => b.addEventListener('click', () => { model.absences = model.absences.filter(a => a.id !== b.dataset.delAbs); commit(); render(); }));
    $$('[data-hole]', main).forEach(b => b.addEventListener('click', () => { ui.repairOpen[b.dataset.hole] = !ui.repairOpen[b.dataset.hole]; viewFravaer(main); }));
    $$('.cand [data-choose]', main).forEach(b => b.addEventListener('click', () => {
      const changes = JSON.parse(b.closest('.cand').dataset.apply);
      pushUndo(); applyChanges(changes); logChange('Erstatter valgt: ' + describeChanges(changes), changes); commit(); render(); toast('Vakten er dekket.');
    }));
    const auto = $('#btnAutoRepair');
    if (auto) auto.addEventListener('click', () => {
      pushUndo();
      const res = VF.autoRepair(model, model.roster.asg);
      model.roster.asg = res.asg;
      for (const l of res.log) logChange(`Automatisk: ${describeChanges(l.candidate.changes)} (${l.candidate.label})`, l.candidate.changes);
      commit(); render();
      toast(res.unresolved.length ? `${res.log.length} vakter dekket, ${res.unresolved.length} kunne ikke løses lovlig.` : `${res.log.length} endringer gjort – alle vakter dekket.`);
    });
    $('#btnUndo2').addEventListener('click', undo);
  }

  // ================================================================== EKSPORT
  function viewEksport(main) {
    const has = !!model.roster;
    const csv = has ? VF.toCSV(model, model.roster.asg) : '';
    main.innerHTML = `
      <div class="page-head"><div><h1>Eksport</h1><div class="sub">Ta turnusen med deg videre – til Gat, Excel eller papir</div></div></div>
      <div class="grid-2">
        <div class="panel"><h2>Turnus</h2>
          <div class="toolbar" style="margin-bottom:10px">
            <button class="btn btn-primary" id="btnCopy" ${has ? '' : 'disabled'}>Kopier til utklippstavlen</button>
            <button class="btn" id="btnCsv" ${has ? '' : 'disabled'}>Last ned CSV</button>
            <button class="btn" id="btnPrint" ${has ? '' : 'disabled'}>Skriv ut</button>
          </div>
          <p class="help">Utklippstavlen gir en tabell (ansatt × dato) som kan limes rett inn i Excel eller Gat. Koder: D/A/N = vakt, F = fri, FE = ferie, P = permisjon/kurs, S = syk.</p>
          ${has ? `<pre class="export">${esc(csv.split('\n').slice(0, 8).map(l => l.split(';').slice(0, 16).join('\t')).join('\n'))}\n…</pre>` : '<p class="muted">Lag en turnus først.</p>'}
        </div>
        <div class="panel"><h2>Sikkerhetskopi</h2>
          <p class="help">Alle data (ansatte, krav, regler, turnus, logg) som én fil. Bruk den til å flytte mellom maskiner eller dele oppsettet.</p>
          <div class="toolbar"><button class="btn" id="btnJson">Last ned sikkerhetskopi</button><label class="btn">Importer fil <input type="file" id="fileImport" accept=".json,application/json" class="hidden"></label></div>
        </div>
      </div>`;
    if (has) {
      $('#btnCopy').addEventListener('click', async () => {
        const tsv = csv.split('\n').map(l => l.split(';').join('\t')).join('\n');
        try { await navigator.clipboard.writeText(tsv); toast('Kopiert – lim inn i Excel eller Gat.'); }
        catch (e) { toast('Kunne ikke kopiere automatisk. Last ned CSV i stedet.'); }
      });
      $('#btnCsv').addEventListener('click', () => download(`vaktflyt-turnus-${model.settings.periodStart}.csv`, '﻿' + csv, 'text/csv;charset=utf-8'));
      $('#btnPrint').addEventListener('click', () => { ui.view = 'turnus'; render(); setTimeout(() => window.print(), 300); });
    }
    $('#btnJson').addEventListener('click', () => download(`vaktflyt-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(model, null, 2), 'application/json'));
    $('#fileImport').addEventListener('change', ev => {
      const f = ev.target.files[0]; if (!f) return;
      f.text().then(txt => {
        const m = JSON.parse(txt);
        if (!m || m.version !== 1 || !m.employees || !m.settings) throw new Error('Ikke en Vaktflyt-fil');
        model = migrate(m); ui.undo = []; ui.sel = null; commit(); render(); toast('Importert.');
      }).catch(() => toast('Kunne ikke lese filen.'));
    });
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------ start
  document.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z' && !ev.target.matches('input, textarea, select') && $('#app') && !$('#app').classList.contains('hidden')) { ev.preventDefault(); undo(); }
  });
  if (isAuthed()) showApp(); else showLogin();
})();
