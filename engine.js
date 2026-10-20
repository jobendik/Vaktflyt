/*
 * Vaktflyt engine — rules, evaluation, roster generation and sickness repair.
 *
 * Pure logic: no DOM. Runs in the browser (window.VF), in a Web Worker
 * (importScripts) and in Node (module.exports) so the solver can be unit tested.
 *
 * Terminology (Norwegian domain, English code):
 *   shift type   = vakttype (D = dag, A = aften/kveld, N = natt)
 *   slot         = one (day, shiftType) pair that needs staffing
 *   roster       = turnus; asg[employeeId] = array(days) of shiftTypeId | null
 *   hard rule    = may never be broken (AML, tariff, availability)
 *   soft rule    = preference; the solver minimises a weighted penalty
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HARD_W = 1000;      // objective weight of one hard violation (staffing)
  const EMP_HARD_W = 1300;  // employee rule violations weigh more, so the solver never trades a hole for a breach
  const DAY = 1440;         // minutes
  const WD_SHORT = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
  const WD_LONG = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];

  // ------------------------------------------------------------------ dates
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function toISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(iso, n) { return toISO(parseISO(iso) + n * 86400000); }
  function weekdayOf(iso) { return (new Date(parseISO(iso)).getUTCDay() + 6) % 7; } // 0 = Monday
  function nextMonday(iso) { const wd = weekdayOf(iso); return wd === 0 ? iso : addDays(iso, 7 - wd); }
  function isoWeek(iso) {
    const d = new Date(parseISO(iso));
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const diff = (d - firstThu) / 86400000;
    return 1 + Math.round((diff - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  }
  function fmtDate(iso) { const d = new Date(parseISO(iso)); return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`; }
  function fmtDateWd(iso) { return `${WD_SHORT[weekdayOf(iso)]} ${fmtDate(iso)}`; }
  function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); }
  function fmtH(min) {
    const h = min / 60;
    return (Math.round(h * 10) / 10).toString().replace('.', ',') + ' t';
  }
  function fmtHours(h) { return (Math.round(h * 10) / 10).toString().replace('.', ',') + ' t'; }

  // --------------------------------------------------------------- defaults
  function defaultRules() {
    return {
      avgWeeklyHours: 35.5,      // AML § 10-4 (3): turnus med natt/helg
      minRestHours: 11,          // AML § 10-8 (1)
      weeklyRestHours: 35,       // AML § 10-8 (2)
      maxWeekHours: 48,          // AML § 10-5: tak per enkeltuke ved gjennomsnittsberegning
      maxConsecutiveDays: 6,
      maxConsecutiveNights: 4,
      weekendEvery: 3,           // tariff: arbeid hver 3. helg
      weekendHard: true,
      fridayNightIsWeekend: true,
      weights: {
        hours: 2.5,       // per time avvik fra stillingsprosent
        wishFri: 15,      // ønske om fri ikke innfridd
        wishVakt: 8,      // ønske om vakt ikke innfridd
        splitWeekend: 12, // jobber bare én av helgedagene
        singleNight: 12,  // enkeltstående nattevakt
        singleFree: 3,    // enkeltstående fridag
        singleWork: 4,    // enkeltstående arbeidsdag
        typeChange: 3,    // vakttype skifter midt i en arbeidsperiode
        fairness: 2,      // skjev fordeling av netter/helger
        preferWith: 3,    // bonus når foretrukne kolleger jobber sammen
      },
    };
  }

  function defaultShiftTypes() {
    return [
      { id: 'D', name: 'Dag', start: '07:30', end: '15:00', color: '#F3C65B' },
      { id: 'A', name: 'Kveld', start: '14:30', end: '22:00', color: '#E9825E' },
      { id: 'N', name: 'Natt', start: '21:45', end: '07:45', color: '#4A5BA6' },
    ];
  }

  function emptyDemand(shiftTypes) {
    const mk = () => Object.fromEntries(shiftTypes.map(s => [s.id, { min: 0, max: 0, tags: {}, minK: 0, minM: 0 }]));
    return { weekday: mk(), weekend: mk() };
  }

  // ---------------------------------------------------------------- context
  function buildCtx(model) {
    const { settings, employees, demand, rules, absences = [], wishes = [] } = model;
    const weeks = settings.weeks;
    const days = weeks * 7;
    const shifts = settings.shiftTypes.map(s => {
      const startMin = toMin(s.start);
      let durMin = (toMin(s.end) - startMin + DAY) % DAY;
      if (durMin === 0) durMin = DAY;
      return Object.assign({}, s, { startMin, durMin, hours: durMin / 60, isNight: s.night === true || startMin + durMin > DAY });
    });
    const shiftById = Object.fromEntries(shifts.map(s => [s.id, s]));
    const empById = Object.fromEntries(employees.map(e => [e.id, e]));
    const start = settings.periodStart;
    const dayInfo = [];
    for (let d = 0; d < days; d++) {
      const iso = addDays(start, d);
      dayInfo.push({ d, iso, wd: d % 7, weekend: d % 7 >= 5, week: Math.floor(d / 7), isoWeek: isoWeek(iso) });
    }
    const absAt = {};
    for (const a of absences) {
      const e = empById[a.employeeId];
      if (!e) continue;
      const planned = a.type !== 'syk';
      const typeName = ({ ferie: 'ferie', syk: 'sykefravær', permisjon: 'permisjon', kurs: 'kurs', annet: 'fravær' })[a.type] || 'fravær';
      let d0 = Math.round((parseISO(a.from) - parseISO(start)) / 86400000);
      let d1 = Math.round((parseISO(a.to) - parseISO(start)) / 86400000);
      for (let d = Math.max(0, d0); d <= Math.min(days - 1, d1); d++) {
        (absAt[e.id] = absAt[e.id] || {})[d] = { id: a.id, type: a.type, planned, typeName };
      }
    }
    const wishAt = {};
    for (const w of wishes) {
      const d = Math.round((parseISO(w.date) - parseISO(start)) / 86400000);
      if (d < 0 || d >= days) continue;
      (wishAt[w.employeeId] = wishAt[w.employeeId] || {})[d] = w;
    }
    const R = Object.assign(defaultRules(), rules || {});
    R.weights = Object.assign(defaultRules().weights, (rules && rules.weights) || {});

    function demandAt(d, s) {
      const key = dayInfo[d].weekend ? 'weekend' : 'weekday';
      return (demand[key] && demand[key][s]) || { min: 0, max: 0, tags: {}, minK: 0, minM: 0 };
    }
    // Weekend work: Saturday (any shift), Sunday day/evening, Friday night (ends Saturday).
    // Sunday night ends on Monday and belongs to the coming week unless the rules say otherwise.
    function isWeekendShift(d, s) {
      const wd = d % 7;
      const night = shiftById[s] && shiftById[s].isNight;
      if (wd === 5) return true;
      if (wd === 6) return !night || !!R.sundayNightIsWeekend;
      if (wd === 4 && R.fridayNightIsWeekend !== false && night) return true;
      return false;
    }
    function weekendEveryFor(e) { return e.weekendEvery || R.weekendEvery || 1; }
    function targetHours(e) { return (e.percent / 100) * R.avgWeeklyHours * weeks; }

    // Fair-share expectations for nights and weekend shifts (used as soft fairness)
    let totalNight = 0, totalWeekend = 0;
    for (let d = 0; d < days; d++) for (const s of shifts) {
      const dem = demandAt(d, s.id);
      if (s.isNight) totalNight += dem.min;
      if (isWeekendShift(d, s.id)) totalWeekend += dem.min;
    }
    const nightCap = employees.filter(e => canShift(e, shifts.filter(s => s.isNight).map(s => s.id)));
    const sumNightPct = nightCap.reduce((a, e) => a + e.percent, 0) || 1;
    const wkCap = employees.filter(e => !e.noWeekends);
    const sumWkPct = wkCap.reduce((a, e) => a + e.percent, 0) || 1;
    const fair = {};
    for (const e of employees) {
      fair[e.id] = {
        nights: nightCap.includes(e) ? totalNight * e.percent / sumNightPct : 0,
        weekend: wkCap.includes(e) ? totalWeekend * e.percent / sumWkPct : 0,
      };
    }

    return { model, settings, employees, empById, shifts, shiftById, demand, rules: R, weeks, days, dayInfo, absAt, wishAt, demandAt, isWeekendShift, weekendEveryFor, targetHours, fair, start };
  }

  function canShift(e, ids) { return ids.some(id => !e.shifts || e.shifts[id] !== false); }
  function hasTag(e, tag) { return (e.tags || []).includes(tag); }

  // ------------------------------------------------------- employee evaluation
  // Returns hard violations, soft penalties and statistics for one employee row.
  function evalEmployee(ctx, emp, row) {
    const R = ctx.rules, W = R.weights, days = ctx.days;
    const hard = [], soft = [];
    const absRow = ctx.absAt[emp.id] || {};
    const wishRow = ctx.wishAt[emp.id] || {};
    const eff = new Array(days);   // shift actually worked (unplanned absence removes it)
    const weekHours = new Array(ctx.weeks).fill(0);
    const workedWeekend = new Array(ctx.weeks).fill(false);
    let hours = 0, nights = 0, evenings = 0, dayShifts = 0, shiftsCount = 0, weekendShifts = 0;
    const maxConsec = emp.maxConsecutiveDays || R.maxConsecutiveDays;
    const maxNights = emp.maxConsecutiveNights || R.maxConsecutiveNights;

    for (let d = 0; d < days; d++) {
      const s = row[d];
      const a = absRow[d];
      const w = wishRow[d];
      const di = ctx.dayInfo[d];
      if (s) {
        const st = ctx.shiftById[s];
        if (!st) { eff[d] = null; continue; }
        shiftsCount++;
        hours += st.hours; weekHours[di.week] += st.hours;
        if (st.isNight) nights++; else if (st.id === 'A') evenings++; else dayShifts++;
        if (emp.shifts && emp.shifts[s] === false) hard.push({ code: 'cantShift', d, msg: `Jobber ikke ${st.name.toLowerCase()}vakt` });
        if (a && a.planned) hard.push({ code: 'absence', d, msg: `Har ${a.typeName} ${fmtDateWd(di.iso)}` });
        if (emp.blockedWeekdays && emp.blockedWeekdays.includes(di.wd)) hard.push({ code: 'blockedWeekday', d, msg: `Jobber ikke på ${WD_LONG[di.wd]}er` });
        const wk = ctx.isWeekendShift(d, s);
        if (wk) {
          weekendShifts++; workedWeekend[di.week] = true;
          if (emp.noWeekends) hard.push({ code: 'noWeekends', d, msg: 'Fritatt fra helgearbeid' });
        } else if (emp.onlyWeekends) {
          hard.push({ code: 'onlyWeekends', d, msg: 'Helgestilling – jobber bare helg' });
        }
        if (w && w.kind === 'fri') {
          if (w.hard) hard.push({ code: 'wishHard', d, msg: `Har innvilget fri ${fmtDateWd(di.iso)}` });
          else soft.push({ code: 'wishFri', d, p: W.wishFri, msg: `Ønsket fri ${fmtDateWd(di.iso)}` });
        }
        if (w && w.kind === 'vakt' && w.shift && w.shift !== s) soft.push({ code: 'wishShift', d, p: W.wishVakt / 2, msg: `Ønsket ${ctx.shiftById[w.shift] ? ctx.shiftById[w.shift].name.toLowerCase() : ''}vakt ${fmtDateWd(di.iso)}` });
        eff[d] = (a && !a.planned) ? null : s;
      } else {
        eff[d] = null;
        if (w && w.kind === 'vakt' && !a) soft.push({ code: 'wishVakt', d, p: W.wishVakt, msg: `Ønsket vakt ${fmtDateWd(di.iso)}` });
      }
    }

    // --- rest between shifts (AML § 10-8 (1)) and runs
    let prevEnd = null, prevD = -1, run = 0, nightRun = 0, lastType = null;
    const runs = [];
    for (let d = 0; d < days; d++) {
      const s = eff[d];
      if (s) {
        const st = ctx.shiftById[s];
        const startAbs = d * DAY + st.startMin;
        const endAbs = startAbs + st.durMin;
        if (prevEnd !== null) {
          const gap = startAbs - prevEnd;
          if (gap < R.minRestHours * 60) {
            const ps = ctx.shiftById[eff[prevD]];
            hard.push({ code: 'rest', d, msg: `Bare ${fmtH(gap)} hvile mellom ${ps.name.toLowerCase()} ${fmtDateWd(ctx.dayInfo[prevD].iso)} og ${st.name.toLowerCase()} ${fmtDateWd(ctx.dayInfo[d].iso)} (krav ${R.minRestHours} t)` });
          }
        }
        prevEnd = endAbs; prevD = d;
        run++;
        if (st.isNight) nightRun++;
        else { if (nightRun === 1) soft.push({ code: 'singleNight', d: d - 1, p: W.singleNight, msg: `Enkeltstående nattevakt ${fmtDateWd(ctx.dayInfo[d - 1].iso)}` }); nightRun = 0; }
        if (nightRun > maxNights) hard.push({ code: 'nights', d, msg: `${nightRun} nattevakter på rad (maks ${maxNights})` });
        if (run > maxConsec) hard.push({ code: 'consecutive', d, msg: `${run} dager på rad ${fmtDateWd(ctx.dayInfo[d].iso)} (maks ${maxConsec})` });
        if (lastType && lastType !== s && run > 1) soft.push({ code: 'typeChange', d, p: W.typeChange, msg: 'Vakttype skifter midt i arbeidsperioden' });
        lastType = s;
      } else {
        if (nightRun === 1) soft.push({ code: 'singleNight', d: d - 1, p: W.singleNight, msg: `Enkeltstående nattevakt ${fmtDateWd(ctx.dayInfo[d - 1].iso)}` });
        if (run === 1 && d >= 2 && !ctx.shiftById[eff[d - 1]].isNight) soft.push({ code: 'singleWork', d: d - 1, p: W.singleWork || 0, msg: `Enkeltstående arbeidsdag ${fmtDateWd(ctx.dayInfo[d - 1].iso)}` });
        if (run > 0) runs.push(run);
        run = 0; nightRun = 0; lastType = null;
        if (d > 0 && d < days - 1 && eff[d - 1] && eff[d + 1] && !absRow[d]) soft.push({ code: 'singleFree', d, p: W.singleFree, msg: `Enkeltstående fridag ${fmtDateWd(ctx.dayInfo[d].iso)}` });
      }
    }
    if (run > 0) runs.push(run);

    // --- weekly rest: a continuous free period >= 35 h within each 7-day week (AML § 10-8 (2))
    const intervals = [];
    for (let d = 0; d < days; d++) if (eff[d]) { const st = ctx.shiftById[eff[d]]; const a0 = d * DAY + st.startMin; intervals.push([a0, a0 + st.durMin]); }
    for (let w = 0; w < ctx.weeks; w++) {
      const w0 = w * 7 * DAY, w1 = (w + 1) * 7 * DAY;
      let best = 0, pe = -Infinity;
      for (let i = 0; i <= intervals.length; i++) {
        const ns = i < intervals.length ? intervals[i][0] : Infinity;
        const ov = Math.min(ns, w1) - Math.max(pe, w0);
        if (ov > best) best = ov;
        if (i < intervals.length) pe = Math.max(pe, intervals[i][1]);
      }
      if (best < R.weeklyRestHours * 60) hard.push({ code: 'weeklyRest', d: w * 7, msg: `Uke ${ctx.dayInfo[w * 7].isoWeek}: lengste sammenhengende fritid er ${fmtH(best)} (krav ${R.weeklyRestHours} t)` });
      if (weekHours[w] > R.maxWeekHours) hard.push({ code: 'weekHours', d: w * 7, msg: `Uke ${ctx.dayInfo[w * 7].isoWeek}: ${fmtHours(weekHours[w])} planlagt (maks ${R.maxWeekHours} t)` });
    }

    // --- weekend frequency (tariff): at most one worked weekend in any window of N consecutive weekends
    const every = ctx.weekendEveryFor(emp);
    let workedWeekends = 0;
    for (let w = 0; w < ctx.weeks; w++) if (workedWeekend[w]) workedWeekends++;
    if (every > 1) {
      let lastHit = -10;
      for (let w = 0; w + every <= ctx.weeks; w++) {
        const hits = [];
        for (let k = 0; k < every; k++) if (workedWeekend[w + k]) hits.push(w + k);
        if (hits.length > 1 && hits[0] !== lastHit) {
          lastHit = hits[0];
          const v = { code: 'weekendFreq', d: hits[1] * 7 + 5, msg: `Jobber helg uke ${ctx.dayInfo[hits[0] * 7].isoWeek} og uke ${ctx.dayInfo[hits[1] * 7].isoWeek} (skal jobbe hver ${every}. helg)` };
          if (R.weekendHard) hard.push(v); else soft.push(Object.assign(v, { p: W.splitWeekend * 2 }));
        }
      }
    }
    // --- whole weekends (soft). A night counts towards the day it ends on: Fri night = Saturday, Sat night = Sunday.
    const isN = d => !!(eff[d] && ctx.shiftById[eff[d]].isNight);
    for (let w = 0; w < ctx.weeks; w++) {
      const fri = 7 * w + 4, sat = 7 * w + 5, sun = 7 * w + 6;
      const satW = (!!eff[sat] && !isN(sat)) || (isN(fri) && R.fridayNightIsWeekend !== false);
      const sunW = (!!eff[sun] && !isN(sun)) || isN(sat) || (isN(sun) && !!R.sundayNightIsWeekend);
      if (satW !== sunW) soft.push({ code: 'splitWeekend', d: sat, p: W.splitWeekend, msg: `Jobber bare én av helgedagene uke ${ctx.dayInfo[sat].isoWeek}` });
    }

    // --- contracted hours and fairness (soft)
    const target = ctx.targetHours(emp);
    const dev = hours - target;
    if (Math.abs(dev) > 0.01) soft.push({ code: 'hours', d: -1, p: W.hours * Math.abs(dev) * (dev > 0 ? 1.3 : 1), msg: `${dev > 0 ? '+' : ''}${fmtHours(dev)} i forhold til stillingen` });
    const f = ctx.fair[emp.id];
    if (f && f.nights > 0) { const dn = Math.abs(nights - f.nights); if (dn > 1) soft.push({ code: 'fairNights', d: -1, p: W.fairness * (dn - 1), msg: `${nights} netter (forventet ca. ${Math.round(f.nights)})` }); }
    if (f && f.weekend > 0) { const dw = Math.abs(weekendShifts - f.weekend); if (dw > 1) soft.push({ code: 'fairWeekend', d: -1, p: W.fairness * (dw - 1), msg: `${weekendShifts} helgevakter (forventet ca. ${Math.round(f.weekend)})` }); }

    const softSum = soft.reduce((a, x) => a + x.p, 0);
    return {
      hard, soft, softSum,
      stats: { hours, target, dev, nights, evenings, dayShifts, shiftsCount, weekendShifts, workedWeekends, weekHours, longestRun: runs.length ? Math.max(...runs) : 0 },
    };
  }

  // ------------------------------------------------------------ slot evaluation
  function presentIn(ctx, asg, d, s) {
    const out = [];
    for (const e of ctx.employees) {
      const row = asg[e.id];
      if (!row || row[d] !== s) continue;
      const a = ctx.absAt[e.id] && ctx.absAt[e.id][d];
      if (a && !a.planned) continue;   // sick: planned but not present
      out.push(e);
    }
    return out;
  }

  function evalSlot(ctx, d, s, asg) {
    const dem = ctx.demandAt(d, s);
    const st = ctx.shiftById[s];
    const present = presentIn(ctx, asg, d, s);
    const hard = [], soft = [];
    const label = `${st.name} ${fmtDateWd(ctx.dayInfo[d].iso)}`;
    if (present.length < dem.min) hard.push({ code: 'under', d, s, msg: `${label}: ${present.length} av ${dem.min} bemannet`, missing: dem.min - present.length });
    if (dem.max != null && dem.max > 0 && present.length > dem.max) hard.push({ code: 'over', d, s, msg: `${label}: ${present.length} på vakt (maks ${dem.max})` });
    for (const [tag, min] of Object.entries(dem.tags || {})) {
      if (!min) continue;
      const c = present.filter(e => hasTag(e, tag)).length;
      if (c < min) hard.push({ code: 'tag', d, s, tag, msg: `${label}: mangler ${tag} (${c} av ${min})` });
    }
    if (dem.minK) { const c = present.filter(e => e.gender === 'K').length; if (c < dem.minK) hard.push({ code: 'genderK', d, s, msg: `${label}: for få kvinner (${c} av ${dem.minK})` }); }
    if (dem.minM) { const c = present.filter(e => e.gender === 'M').length; if (c < dem.minM) hard.push({ code: 'genderM', d, s, msg: `${label}: for få menn (${c} av ${dem.minM})` }); }
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      const a = present[i], b = present[j];
      if ((a.notWith || []).includes(b.id) || (b.notWith || []).includes(a.id)) hard.push({ code: 'notWith', d, s, msg: `${label}: ${a.name} og ${b.name} skal ikke jobbe sammen` });
      if ((a.preferWith || []).includes(b.id) || (b.preferWith || []).includes(a.id)) soft.push({ code: 'preferWith', d, s, p: -ctx.rules.weights.preferWith, msg: `${a.name} og ${b.name} jobber sammen` });
    }
    const softSum = soft.reduce((a, x) => a + x.p, 0);
    return { hard, soft, softSum, present, demand: dem };
  }

  // -------------------------------------------------------- full evaluation
  function evaluate(model, asg) {
    const ctx = model.__ctx || buildCtx(model);
    return evaluateCtx(ctx, asg);
  }
  function evaluateCtx(ctx, asg) {
    const employees = {}, slots = {};
    let hardCount = 0, softSum = 0, required = 0, filled = 0;
    for (const e of ctx.employees) {
      const r = evalEmployee(ctx, e, asg[e.id] || new Array(ctx.days).fill(null));
      employees[e.id] = r; hardCount += r.hard.length; softSum += r.softSum;
    }
    for (let d = 0; d < ctx.days; d++) for (const s of ctx.shifts) {
      const r = evalSlot(ctx, d, s.id, asg);
      slots[`${d}:${s.id}`] = r; hardCount += r.hard.length; softSum += r.softSum;
      required += r.demand.min; filled += Math.min(r.present.length, r.demand.min);
    }
    return { employees, slots, hardCount, softSum, objective: hardCount * HARD_W + softSum, coverage: { required, filled } };
  }

  // -------------------------------------------------------------- capacity
  function capacity(model) {
    const ctx = buildCtx(model);
    let minH = 0, maxH = 0, minShifts = 0;
    for (let d = 0; d < ctx.days; d++) for (const s of ctx.shifts) {
      const dem = ctx.demandAt(d, s.id);
      minH += dem.min * s.hours; maxH += (dem.max || dem.min) * s.hours; minShifts += dem.min;
    }
    const avail = ctx.employees.reduce((a, e) => a + ctx.targetHours(e), 0);
    const fte = ctx.employees.reduce((a, e) => a + e.percent, 0) / 100;
    return { weeks: ctx.weeks, demandMinHours: minH, demandMaxHours: maxH, demandMinShifts: minShifts, availableHours: avail, fte, perWeek: { demandMin: minH / ctx.weeks, demandMax: maxH / ctx.weeks, available: avail / ctx.weeks } };
  }

  // ------------------------------------------------------- feasibility check
  // What new hard violations would appear if `empId` gets shift `s` (or null) on day `d`?
  function checkChange(ctx, asg, empId, d, s) {
    const emp = ctx.empById[empId];
    const row = asg[empId];
    const old = row[d];
    const before = evalEmployee(ctx, emp, row);
    const slotsBefore = {};
    for (const sid of [old, s]) if (sid) slotsBefore[sid] = evalSlot(ctx, d, sid, asg);
    row[d] = s;
    const after = evalEmployee(ctx, emp, row);
    const slotsAfter = {};
    for (const sid of [old, s]) if (sid) slotsAfter[sid] = evalSlot(ctx, d, sid, asg);
    row[d] = old;
    const newHard = diffMsgs(before.hard, after.hard);
    const slotNew = [];
    for (const sid of Object.keys(slotsAfter)) slotNew.push(...diffSlot(slotsBefore[sid].hard, slotsAfter[sid].hard));
    const slotFixed = [];
    for (const sid of Object.keys(slotsAfter)) slotFixed.push(...diffSlot(slotsAfter[sid].hard, slotsBefore[sid].hard));
    const weight = list => list.reduce((a, v) => a + (v.missing || 1), 0);
    let fixedCount = 0;
    for (const sid of Object.keys(slotsAfter)) fixedCount += weight(slotsBefore[sid].hard) - weight(slotsAfter[sid].hard);
    return {
      ok: newHard.length === 0 && slotNew.length === 0,
      reasons: newHard.map(v => v.msg).concat(slotNew.map(v => v.msg)),
      newHard, slotNew, slotFixed, fixedCount,
      softDelta: after.softSum - before.softSum,
      statsBefore: before.stats, statsAfter: after.stats,
    };
  }
  function diffMsgs(a, b) {   // items in b whose msg is not in a (multiset)
    return diffBy(a, b, v => v.msg);
  }
  // Slot violations are compared by kind, not wording: "1 av 3" instead of "0 av 3" is progress, not a new problem.
  function slotKey(v) { return v.code === 'notWith' ? v.msg : v.code + ':' + (v.tag || ''); }
  function diffSlot(a, b) { return diffBy(a, b, slotKey); }
  function diffBy(a, b, keyFn) {
    const seen = new Map();
    for (const v of a) { const k = keyFn(v); seen.set(k, (seen.get(k) || 0) + 1); }
    const out = [];
    for (const v of b) { const k = keyFn(v); const c = seen.get(k) || 0; if (c > 0) seen.set(k, c - 1); else out.push(v); }
    return out;
  }

  // ------------------------------------------------------------- randomness
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // -------------------------------------------------------------- generator
  function emptyAssignment(ctx) {
    const asg = {};
    for (const e of ctx.employees) asg[e.id] = new Array(ctx.days).fill(null);
    return asg;
  }

  // Build a roster from scratch. Runs up to `attempts` independent tries and keeps the best
  // (first one without hard violations wins).
  function generate(model, opts = {}) {
    const ctx = buildCtx(model);
    const baseSeed = opts.seed != null ? opts.seed : (Date.now() & 0xffffffff);
    const attempts = opts.attempts || 2;
    let bestRes = null;
    const t0 = Date.now();
    for (let a = 0; a < attempts; a++) {
      const rnd = mulberry32(baseSeed + a * 7919);
      const asg = emptyAssignment(ctx);
      construct(ctx, asg, rnd);
      const res = improve(ctx, asg, rnd, {
        timeBudgetMs: opts.timeBudgetMs || 3000, maxIter: opts.maxIter || 3000000,
        onProgress: opts.onProgress && (p => opts.onProgress(Object.assign(p, { attempt: a + 1, attempts }))),
      });
      const pol = polish(ctx, res.asg, { timeBudgetMs: opts.polishMs || 2500 });
      const report = evaluateCtx(ctx, res.asg);
      const out = { asg: res.asg, report, iterations: res.iterations, accepted: res.accepted, elapsedMs: Date.now() - t0, polished: pol.applied, attempt: a + 1 };
      if (!bestRes || report.objective < bestRes.report.objective) bestRes = out;
      if (report.hardCount === 0) break;
    }
    return bestRes;
  }

  // Continue improving an existing roster (used by the "improve" button).
  function improveRoster(model, asg, opts = {}) {
    const ctx = buildCtx(model);
    const rnd = mulberry32(opts.seed != null ? opts.seed : (Date.now() & 0xffffffff));
    const work = cloneAsg(asg);
    const res = improve(ctx, work, rnd, { timeBudgetMs: opts.timeBudgetMs || 3000, maxIter: opts.maxIter || 3000000, onProgress: opts.onProgress });
    const pol = polish(ctx, res.asg, { timeBudgetMs: opts.polishMs || 2500 });
    return { asg: res.asg, report: evaluateCtx(ctx, res.asg), iterations: res.iterations, accepted: res.accepted, elapsedMs: res.elapsedMs + pol.elapsedMs, polished: pol.applied };
  }
  function cloneAsg(asg) { const o = {}; for (const k in asg) o[k] = asg[k].slice(); return o; }

  // Greedy construction in two passes, the way experienced planners work:
  //   1. weekends first — the scarce resource, governed by the "every N-th weekend" rule;
  //   2. then weekdays, day by day, most constrained shift type first.
  // Every assignment is checked against the hard rules as it is made.
  function construct(ctx, asg, rnd) {
    const emps = ctx.employees;
    const target = {}; emps.forEach(e => target[e.id] = ctx.targetHours(e));
    const planned = {}; emps.forEach(e => planned[e.id] = 0);
    const nightsSoFar = {}; emps.forEach(e => nightsSoFar[e.id] = 0);
    const wkSoFar = {}; emps.forEach(e => wkSoFar[e.id] = 0);
    const nightIds = ctx.shifts.filter(s => s.isNight).map(s => s.id);

    // --- preferred weekend rhythm: split each frequency class into groups with an even spread of
    // gender, competence tags and night capability. Used as a preference, not a constraint.
    const offset = {};
    const byEvery = {};
    for (const e of emps) { if (e.noWeekends) continue; const k = ctx.weekendEveryFor(e); (byEvery[k] = byEvery[k] || []).push(e); }
    const attrsOf = e => {
      const a = ['g:' + (e.gender || '?')];
      for (const t of (e.tags || [])) a.push('t:' + t);
      if (canShift(e, nightIds)) { a.push('night'); a.push('night:' + (e.gender || '?')); }
      return a;
    };
    const freq = {};
    for (const e of emps) for (const a of attrsOf(e)) freq[a] = (freq[a] || 0) + 1;
    for (const [k, list] of Object.entries(byEvery)) {
      const every = +k;
      if (every <= 1) { list.forEach(e => offset[e.id] = 0); continue; }
      const groups = Array.from({ length: every }, () => ({ load: 0, attrs: {} }));
      const rarity = e => Math.min(...attrsOf(e).map(a => freq[a]));
      list.sort((a, b) => rarity(a) - rarity(b) || b.percent - a.percent || (rnd() - 0.5));
      for (const e of list) {
        let best = 0, bestScore = Infinity;
        for (let g = 0; g < every; g++) {
          let score = groups[g].load / 100;
          for (const a of attrsOf(e)) score += (groups[g].attrs[a] || 0) * (3 / freq[a]);
          score += rnd() * 0.01;
          if (score < bestScore) { bestScore = score; best = g; }
        }
        offset[e.id] = best;
        groups[best].load += e.percent;
        for (const a of attrsOf(e)) groups[best].attrs[a] = (groups[best].attrs[a] || 0) + 1;
      }
    }
    const onDutyWeekend = (e, w) => { const k = ctx.weekendEveryFor(e); if (e.noWeekends) return false; if (k <= 1) return true; return (w % k) === offset[e.id]; };

    // requirement keys a slot needs: 't:tag', 'g:K', 'g:M'
    const reqKeys = dem => {
      const out = {};
      for (const [t, n] of Object.entries(dem.tags || {})) if (n) out['t:' + t] = n;
      if (dem.minK) out['g:K'] = dem.minK;
      if (dem.minM) out['g:M'] = dem.minM;
      return out;
    };
    const hasKey = (e, key) => key.startsWith('t:') ? hasTag(e, key.slice(2)) : e.gender === key.slice(2);
    const isPlannedAbsent = (e, d) => { const a = ctx.absAt[e.id] && ctx.absAt[e.id][d]; return !!(a && a.planned); };
    // weekend eligibility while building: last worked weekend must be at least N weekends ago
    const lastWk = {};
    const weekendEligible = (e, w) => {
      if (e.noWeekends) return false;
      const every = ctx.weekendEveryFor(e);
      if (every <= 1 || lastWk[e.id] == null || lastWk[e.id] === w) return true;
      return w - lastWk[e.id] >= every;
    };

    // Fill one slot up to its minimum. `batchNeed` = attribute counts still needed by the current batch
    // (a weekend or a weekday), used for scarcity: don't spend a rare person on a slot that does not need them.
    function fillSlot(d, s, batchNeed, batchDays, scoreExtra) {
      const st = ctx.shiftById[s];
      const dem = ctx.demandAt(d, s);
      if (!dem.min) return;
      const weekendShift = ctx.isWeekendShift(d, s);
      const w = Math.floor(d / 7);
      const myReq = reqKeys(dem);
      const available = e => batchDays.some(dd => !asg[e.id][dd] && !isPlannedAbsent(e, dd)) && (!weekendShift || weekendEligible(e, w));
      for (let k = 0; k < dem.min; k++) {
        const present = presentIn(ctx, asg, d, s);
        if (present.length >= dem.min) break;
        const open = {};
        for (const key of Object.keys(myReq)) open[key] = Math.max(0, myReq[key] - present.filter(e => hasKey(e, key)).length);
        // people still available in this batch per required attribute
        const availKey = {};
        for (const key of Object.keys(batchNeed)) availKey[key] = emps.filter(e => hasKey(e, key) && available(e)).length;
        let best = null, bestScore = -Infinity;
        for (const e of emps) {
          const row = asg[e.id];
          if (row[d]) continue;
          if (e.shifts && e.shifts[s] === false) continue;
          if (isPlannedAbsent(e, d)) continue;
          if (!weekendShift && e.onlyWeekends) continue;
          if (weekendShift && !weekendEligible(e, w)) continue;
          const chk = checkChange(ctx, asg, e.id, d, s);
          if (!chk.ok) continue;
          let score = 0;
          // requirements this slot still needs
          for (const key of Object.keys(open)) if (open[key] > 0 && hasKey(e, key)) score += 25;
          // scarcity: keep rare people for the slots that need them
          for (const key of Object.keys(batchNeed)) {
            if (!hasKey(e, key) || myReq[key]) continue;
            if (batchNeed[key] > 0 && availKey[key] <= batchNeed[key]) score -= 30;
          }
          if (d > 0 && row[d - 1] === s) score += st.isNight ? 14 : 6; // keep blocks together, nights especially
          if (d > 0 && row[d - 1] && row[d - 1] !== s) score -= 3;  // avoid type change inside a run
          if (st.isNight) { const f = ctx.fair[e.id]; if (f && nightsSoFar[e.id] < f.nights * (d + 1) / ctx.days) score += 4; else score -= 2; }
          const wish = ctx.wishAt[e.id] && ctx.wishAt[e.id][d];
          if (wish && wish.kind === 'vakt' && (!wish.shift || wish.shift === s)) score += 14;
          if (wish && wish.kind === 'fri') score -= 40;
          for (const p of present) if ((e.preferWith || []).includes(p.id) || (p.preferWith || []).includes(e.id)) score += 3;
          score += scoreExtra(e, d, s) + rnd() * 2;
          if (score > bestScore) { bestScore = score; best = e; }
        }
        if (!best) break;
        asg[best.id][d] = s;
        planned[best.id] += st.hours;
        if (st.isNight) nightsSoFar[best.id]++;
        if (weekendShift) { wkSoFar[best.id]++; lastWk[best.id] = w; }
        for (const key of Object.keys(myReq)) if (open[key] > 0 && hasKey(best, key)) batchNeed[key] = Math.max(0, (batchNeed[key] || 0) - 1);
      }
    }

    // most constrained first: nights (gender mix), then the type with most requirements
    const slotOrder = ds => ds.sort((a, b) => {
      const sa = ctx.shiftById[a.s], sb = ctx.shiftById[b.s];
      const ra = Object.keys(reqKeys(ctx.demandAt(a.d, a.s))).length, rb = Object.keys(reqKeys(ctx.demandAt(b.d, b.s))).length;
      return (sb.isNight ? 1 : 0) - (sa.isNight ? 1 : 0) || rb - ra || a.d - b.d || sa.startMin - sb.startMin;
    });
    const batchNeedOf = slots => {
      const need = {};
      for (const x of slots) for (const [k, n] of Object.entries(reqKeys(ctx.demandAt(x.d, x.s)))) need[k] = (need[k] || 0) + n;
      return need;
    };

    // --- pass 1: weekends
    for (let w = 0; w < ctx.weeks; w++) {
      const slots = [];
      for (const dd of [7 * w + 4, 7 * w + 5, 7 * w + 6]) if (dd < ctx.days) for (const st of ctx.shifts) if (ctx.isWeekendShift(dd, st.id)) slots.push({ d: dd, s: st.id });
      const need = batchNeedOf(slots);
      const days = [...new Set(slots.map(x => x.d))];
      for (const x of slotOrder(slots)) {
        fillSlot(x.d, x.s, need, days, (e, d) => {
          let sc = 0;
          if (onDutyWeekend(e, w)) sc += 12;                                   // keep the regular rhythm
          const f = ctx.fair[e.id];
          if (f) sc += 10 * (f.weekend * (w + 1) / ctx.weeks - wkSoFar[e.id]) / Math.max(1, f.weekend / ctx.weeks);
          if (e.onlyWeekends) sc += 10 * (target[e.id] * (w + 1) / ctx.weeks - planned[e.id]) / ctx.shiftById[x.s].hours;
          for (const dd of days) if (dd !== d && asg[e.id][dd]) sc += 8;      // whole weekends
          return sc;
        });
      }
    }

    // --- pass 2: weekdays (and any weekend-day slot that is not weekend work, e.g. Sunday night)
    for (let d = 0; d < ctx.days; d++) {
      const slots = [];
      for (const st of ctx.shifts) if (!ctx.isWeekendShift(d, st.id)) slots.push({ d, s: st.id });
      if (!slots.length) continue;
      const need = batchNeedOf(slots);
      for (const x of slotOrder(slots)) {
        fillSlot(x.d, x.s, need, [d], (e, dd, s) => {
          const pace = target[e.id] * (dd + 1) / ctx.days - planned[e.id];
          return 10 * pace / ctx.shiftById[s].hours;
        });
      }
    }
    return asg;
  }

  // Simulated annealing over cell changes. Every move is a list of {e, d, from, to}.
  function improve(ctx, asg, rnd, opts) {
    const t0 = Date.now();
    const emps = ctx.employees;
    const shiftIds = ctx.shifts.map(s => s.id);
    const P = {}, Q = {};
    let objective = 0;
    for (const e of emps) { P[e.id] = evalEmployee(ctx, e, asg[e.id]); objective += P[e.id].hard.length * EMP_HARD_W + P[e.id].softSum; }
    for (let d = 0; d < ctx.days; d++) for (const s of shiftIds) { const r = evalSlot(ctx, d, s, asg); Q[d + ':' + s] = r; objective += r.hard.length * HARD_W + r.softSum; }

    let best = cloneAsg(asg), bestObj = objective;
    let it = 0, accepted = 0;
    const T0 = 12, T1 = 0.25;
    const budget = opts.timeBudgetMs;
    const maxIter = opts.maxIter;
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const canTake = (e, s) => !(e.shifts && e.shifts[s] === false);

    let badSlots = [], badWeekendEmps = [];
    function refreshBad() {
      badSlots = []; badWeekendEmps = [];
      for (const k in Q) if (Q[k].hard.some(v => v.code !== 'over')) { const [ds, s] = k.split(':'); badSlots.push({ d: +ds, s }); }
      for (const e of emps) if (P[e.id].hard.some(v => v.code === 'weekendFreq')) badWeekendEmps.push(e);
    }
    refreshBad();
    const weekendDays = w => [7 * w + 4, 7 * w + 5, 7 * w + 6].filter(dd => dd < ctx.days);
    const worksWeekend = (e, w) => weekendDays(w).some(dd => asg[e.id][dd] && ctx.isWeekendShift(dd, asg[e.id][dd]));
    // swap the weekend cells of e and f for weekends w1 and w2
    function weekendExchange(e, f, w1, w2) {
      const ch = [];
      for (const w of [w1, w2]) for (const dd of weekendDays(w)) {
        const se = asg[e.id][dd], sf = asg[f.id][dd];
        if (se === sf) continue;
        if (dd % 7 === 4) { // Friday: only nights belong to the weekend
          const ne = se && ctx.shiftById[se].isNight, nf = sf && ctx.shiftById[sf].isNight;
          if (!ne && !nf) continue;
          if ((se && !ne) || (sf && !nf)) return null;
        }
        if (se && !canTake(f, se)) return null; if (sf && !canTake(e, sf)) return null;
        ch.push({ e: e.id, d: dd, from: se, to: sf }, { e: f.id, d: dd, from: sf, to: se });
      }
      return ch.length ? ch : null;
    }

    function proposeMove() {
      if (badSlots.length && rnd() < 0.3) {   // targeted: work on a slot that still breaks a hard rule
        const b = pick(badSlots); const d = b.d;
        const f = pick(emps);
        if (asg[f.id][d] || !canTake(f, b.s)) return null;
        const q = Q[d + ':' + b.s];
        if (rnd() < 0.5 && !(q.demand.max && q.present.length >= q.demand.max)) return [{ e: f.id, d, from: null, to: b.s }];
        // exchange days with someone who has that shift type another day and is free on d
        const d2 = Math.floor(rnd() * ctx.days); if (d2 === d || asg[f.id][d2] !== b.s) return null;
        const e = pick(emps); if (e === f || asg[e.id][d2] || !canTake(e, b.s)) return null;
        return [{ e: f.id, d: d2, from: b.s, to: null }, { e: f.id, d, from: null, to: b.s }, { e: e.id, d: d2, from: null, to: b.s }];
      }
      const r = rnd();
      const d = Math.floor(rnd() * ctx.days);
      if (badWeekendEmps.length && r < 0.12) {   // targeted: someone breaks the weekend rule -> exchange weekends
        const e = pick(badWeekendEmps);
        const mine = []; for (let w = 0; w < ctx.weeks; w++) if (worksWeekend(e, w)) mine.push(w);
        if (!mine.length) return null;
        const w1 = pick(mine);
        const f = pick(emps); if (f === e || worksWeekend(f, w1)) return null;
        const theirs = []; for (let w = 0; w < ctx.weeks; w++) if (worksWeekend(f, w) && !worksWeekend(e, w)) theirs.push(w);
        const w2 = theirs.length && rnd() < 0.7 ? pick(theirs) : Math.floor(rnd() * ctx.weeks);
        if (w2 === w1) return null;
        return weekendExchange(e, f, w1, w2);
      }
      if (r < 0.20) {              // exchange two weekends between two employees
        const e = pick(emps), f = pick(emps); if (e === f) return null;
        const w1 = Math.floor(rnd() * ctx.weeks), w2 = Math.floor(rnd() * ctx.weeks); if (w1 === w2) return null;
        return weekendExchange(e, f, w1, w2);
      }
      if (r < 0.28) {              // consolidate a single night into a block: e takes a neighbouring night from f, f takes another night of e
        const e = pick(emps);
        const row = asg[e.id];
        const nights = []; for (let dd = 0; dd < ctx.days; dd++) if (row[dd] && ctx.shiftById[row[dd]].isNight) nights.push(dd);
        if (nights.length < 2) return null;
        const isN = dd => dd >= 0 && dd < ctx.days && row[dd] && ctx.shiftById[row[dd]].isNight;
        const singles = nights.filter(dd => !isN(dd - 1) && !isN(dd + 1));
        if (!singles.length) return null;
        const d1 = pick(singles);
        const d2 = rnd() < 0.5 ? d1 - 1 : d1 + 1;
        if (d2 < 0 || d2 >= ctx.days || row[d2]) return null;
        const s = row[d1];
        const f = pick(emps); if (f === e || asg[f.id][d2] !== s) return null;
        const free = nights.filter(dd => dd !== d1 && asg[f.id][dd] == null);
        if (!free.length) return null;
        const d4 = pick(free);
        return [{ e: e.id, d: d2, from: null, to: s }, { e: f.id, d: d2, from: s, to: null }, { e: e.id, d: d4, from: s, to: null }, { e: f.id, d: d4, from: null, to: s }];
      }
      if (r < 0.40) {              // move: hand a shift to someone free that day
        const e = pick(emps); const s = asg[e.id][d]; if (!s) return null;
        const f = pick(emps); if (f === e || asg[f.id][d] || !canTake(f, s)) return null;
        return [{ e: e.id, d, from: s, to: null }, { e: f.id, d, from: null, to: s }];
      } else if (r < 0.58) {       // swap two employees on the same day
        const e = pick(emps), f = pick(emps); if (e === f) return null;
        const se = asg[e.id][d], sf = asg[f.id][d]; if (se === sf) return null;
        if (se && !canTake(f, se)) return null; if (sf && !canTake(e, sf)) return null;
        return [{ e: e.id, d, from: se, to: sf }, { e: f.id, d, from: sf, to: se }];
      } else if (r < 0.80) {       // exchange days: e works d1, f works d2 with the same type -> swap days
        const e = pick(emps), f = pick(emps); if (e === f) return null;
        const d2 = Math.floor(rnd() * ctx.days); if (d2 === d) return null;
        const s = asg[e.id][d]; if (!s || asg[f.id][d2] !== s) return null;
        if (asg[e.id][d2] || asg[f.id][d]) return null;
        return [{ e: e.id, d, from: s, to: null }, { e: e.id, d: d2, from: null, to: s }, { e: f.id, d: d2, from: s, to: null }, { e: f.id, d, from: null, to: s }];
      } else if (r < 0.88) {       // add a shift for someone below target
        const e = pick(emps); if (asg[e.id][d]) return null;
        const s = pick(shiftIds); if (!canTake(e, s)) return null;
        const q = Q[d + ':' + s]; if (q.demand.max && q.present.length >= q.demand.max) return null;
        return [{ e: e.id, d, from: null, to: s }];
      } else if (r < 0.94) {       // remove a shift from someone above target
        const e = pick(emps); const s = asg[e.id][d]; if (!s) return null;
        if (P[e.id].stats.dev < 0) return null;
        return [{ e: e.id, d, from: s, to: null }];
      } else {                     // change shift type on the same day
        const e = pick(emps); const s = asg[e.id][d]; if (!s) return null;
        const s2 = pick(shiftIds); if (s2 === s || !canTake(e, s2)) return null;
        return [{ e: e.id, d, from: s, to: s2 }];
      }
    }

    function apply(ch) { for (const c of ch) asg[c.e][c.d] = c.to; }
    function undo(ch) { for (const c of ch) asg[c.e][c.d] = c.from; }

    let lastProgress = t0;
    while (it < maxIter) {
      it++;
      if ((it & 1023) === 0) refreshBad();
      if ((it & 255) === 0) {
        const now = Date.now();
        if (now - t0 > budget) break;
        if (opts.onProgress && now - lastProgress > 150) { lastProgress = now; opts.onProgress({ iterations: it, objective, bestObj, elapsedMs: now - t0, budget }); }
      }
      const ch = proposeMove();
      if (!ch) continue;
      const frac = Math.min(1, (Date.now() - t0) / budget);
      const T = T0 * Math.pow(T1 / T0, frac);
      apply(ch);
      const empIds = [...new Set(ch.map(c => c.e))];
      const slotKeys = [...new Set(ch.flatMap(c => [c.from && (c.d + ':' + c.from), c.to && (c.d + ':' + c.to)]).filter(Boolean))];
      let delta = 0;
      const newP = {}, newQ = {};
      for (const id of empIds) { const np = evalEmployee(ctx, ctx.empById[id], asg[id]); newP[id] = np; delta += (np.hard.length - P[id].hard.length) * EMP_HARD_W + (np.softSum - P[id].softSum); }
      for (const k of slotKeys) { const [ds, s] = k.split(':'); const nq = evalSlot(ctx, +ds, s, asg); newQ[k] = nq; delta += (nq.hard.length - Q[k].hard.length) * HARD_W + (nq.softSum - Q[k].softSum); }
      if (delta <= 0 || rnd() < Math.exp(-delta / T)) {
        accepted++;
        objective += delta;
        Object.assign(P, newP); Object.assign(Q, newQ);
        if (objective < bestObj - 1e-9) { bestObj = objective; best = cloneAsg(asg); }
      } else undo(ch);
    }
    return { asg: best, objective: bestObj, iterations: it, accepted, elapsedMs: Date.now() - t0 };
  }

  // Deterministic clean-up: for each remaining hard violation, search exhaustively for one
  // move (weekend exchange, direct fill, day exchange) that removes it without creating a new one.
  function polish(ctx, asg, opts = {}) {
    const t0 = Date.now();
    const budget = opts.timeBudgetMs || 2000;
    const emps = ctx.employees;
    const shiftIds = ctx.shifts.map(s => s.id);
    const canTake = (e, s) => !(e.shifts && e.shifts[s] === false);
    const weekendDays = w => [7 * w + 4, 7 * w + 5, 7 * w + 6].filter(dd => dd < ctx.days);
    const worksWeekend = (e, w) => weekendDays(w).some(dd => asg[e.id][dd] && ctx.isWeekendShift(dd, asg[e.id][dd]));
    let applied = 0;

    function exchange(e, f, w1, w2) {
      const ch = [];
      for (const w of [w1, w2]) for (const dd of weekendDays(w)) {
        const se = asg[e.id][dd], sf = asg[f.id][dd];
        if (se === sf) continue;
        if (dd % 7 === 4) {
          const ne = se && ctx.shiftById[se].isNight, nf = sf && ctx.shiftById[sf].isNight;
          if (!ne && !nf) continue;
          if ((se && !ne) || (sf && !nf)) return null;
        }
        if (se && !canTake(f, se)) return null; if (sf && !canTake(e, sf)) return null;
        ch.push({ e: e.id, d: dd, from: se, to: sf }, { e: f.id, d: dd, from: sf, to: se });
      }
      return ch.length ? ch : null;
    }
    function evalDelta(ch, P, Q) {
      for (const c of ch) asg[c.e][c.d] = c.to;
      let hard = 0, soft = 0;
      for (const id of new Set(ch.map(c => c.e))) { const np = evalEmployee(ctx, ctx.empById[id], asg[id]); hard += np.hard.length - P[id].hard.length; soft += np.softSum - P[id].softSum; }
      for (const k of new Set(ch.flatMap(c => [c.from && (c.d + ':' + c.from), c.to && (c.d + ':' + c.to)]).filter(Boolean))) { const [ds, s] = k.split(':'); const nq = evalSlot(ctx, +ds, s, asg); hard += nq.hard.length - Q[k].hard.length; soft += nq.softSum - Q[k].softSum; }
      for (const c of ch) asg[c.e][c.d] = c.from;
      return { hard, soft };
    }

    for (let round = 0; round < 40; round++) {
      if (Date.now() - t0 > budget) break;
      const P = {}, Q = {};
      for (const e of emps) P[e.id] = evalEmployee(ctx, e, asg[e.id]);
      for (let d = 0; d < ctx.days; d++) for (const s of shiftIds) Q[d + ':' + s] = evalSlot(ctx, d, s, asg);
      const moves = [];
      // weekend-rule violations -> weekend exchanges
      for (const e of emps) {
        if (!P[e.id].hard.some(v => v.code === 'weekendFreq')) continue;
        for (let w1 = 0; w1 < ctx.weeks; w1++) {
          if (!worksWeekend(e, w1)) continue;
          for (const f of emps) {
            if (f === e || worksWeekend(f, w1)) continue;
            for (let w2 = 0; w2 < ctx.weeks; w2++) {
              if (w2 === w1 || worksWeekend(e, w2)) continue;
              const ch = exchange(e, f, w1, w2); if (ch) moves.push(ch);
            }
          }
        }
      }
      // other employee-level violations -> drop the shift and hand it to someone free, or exchange days
      for (const e of emps) {
        for (const v of P[e.id].hard) {
          if (v.code === 'weekendFreq' || v.d == null || v.d < 0) continue;
          for (let dd = Math.max(0, v.d - 1); dd <= Math.min(ctx.days - 1, v.d); dd++) {
            const s = asg[e.id][dd]; if (!s) continue;
            for (const f of emps) {
              if (f === e || asg[f.id][dd] || !canTake(f, s)) continue;
              moves.push([{ e: e.id, d: dd, from: s, to: null }, { e: f.id, d: dd, from: null, to: s }]);
            }
          }
        }
      }
      // slot violations -> direct fill, or f takes the slot and hands one of their same-type shifts to someone free
      for (const k in Q) {
        if (!Q[k].hard.some(v => v.code !== 'over')) continue;
        const [ds, s] = k.split(':'); const d = +ds;
        for (const f of emps) {
          if (asg[f.id][d] || !canTake(f, s)) continue;
          moves.push([{ e: f.id, d, from: null, to: s }]);
          for (let d2 = Math.max(0, d - 21); d2 <= Math.min(ctx.days - 1, d + 21); d2++) {
            if (d2 === d || asg[f.id][d2] !== s) continue;
            for (const e of emps) {
              if (e === f || asg[e.id][d2] || !canTake(e, s)) continue;
              moves.push([{ e: f.id, d: d2, from: s, to: null }, { e: f.id, d, from: null, to: s }, { e: e.id, d: d2, from: null, to: s }]);
            }
          }
        }
        // or: swap f (on another type that day, overstaffed) into s, someone free takes f's old type
        for (const f of emps) {
          const s2 = asg[f.id][d]; if (!s2 || s2 === s || !canTake(f, s)) continue;
          for (const e of emps) {
            if (e === f || asg[e.id][d] || !canTake(e, s2)) continue;
            moves.push([{ e: f.id, d, from: s2, to: s }, { e: e.id, d, from: null, to: s2 }]);
          }
        }
      }
      if (!moves.length) break;
      let best = null, bestKey = null;
      for (const ch of moves) {
        if (Date.now() - t0 > budget) break;
        const dl = evalDelta(ch, P, Q);
        if (dl.hard >= 0) continue;
        const key = [dl.hard, dl.soft];
        if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = ch; bestKey = key; }
      }
      if (!best) {
        // Two steps: a weekend exchange that fixes e but passes the problem to f, followed by one that fixes f.
        const pair = twoStepWeekendFix(P, Q);
        if (!pair) break;
        for (const ch of pair) for (const c of ch) asg[c.e][c.d] = c.to;
        applied++;
        continue;
      }
      for (const c of best) asg[c.e][c.d] = c.to;
      applied++;
    }

    function twoStepWeekendFix(P, Q) {
      for (const e of emps) {
        if (!P[e.id].hard.some(v => v.code === 'weekendFreq')) continue;
        const firsts = [];
        for (let w1 = 0; w1 < ctx.weeks; w1++) {
          if (!worksWeekend(e, w1)) continue;
          for (const f of emps) {
            if (f === e || worksWeekend(f, w1)) continue;
            for (let w2 = 0; w2 < ctx.weeks; w2++) {
              if (w2 === w1 || worksWeekend(e, w2)) continue;
              const ch = exchange(e, f, w1, w2); if (!ch) continue;
              const dl = evalDelta(ch, P, Q);
              if (dl.hard !== 0) continue;
              // does it fix e?
              for (const c of ch) asg[c.e][c.d] = c.to;
              const pe = evalEmployee(ctx, e, asg[e.id]);
              for (const c of ch) asg[c.e][c.d] = c.from;
              if (pe.hard.length < P[e.id].hard.length) firsts.push({ ch, f, soft: dl.soft });
            }
          }
        }
        firsts.sort((a, b) => a.soft - b.soft);
        for (const first of firsts.slice(0, 60)) {
          if (Date.now() - t0 > budget) return null;
          for (const c of first.ch) asg[c.e][c.d] = c.to;
          const P2 = {}, Q2 = {};
          for (const x of emps) P2[x.id] = evalEmployee(ctx, x, asg[x.id]);
          for (let d = 0; d < ctx.days; d++) for (const s of shiftIds) Q2[d + ':' + s] = evalSlot(ctx, d, s, asg);
          const f = first.f;
          let bestSecond = null, bestKey = null;
          for (let w1 = 0; w1 < ctx.weeks; w1++) {
            if (!worksWeekend(f, w1)) continue;
            for (const g of emps) {
              if (g === f || worksWeekend(g, w1)) continue;
              for (let w2 = 0; w2 < ctx.weeks; w2++) {
                if (w2 === w1 || worksWeekend(f, w2)) continue;
                const ch = exchange(f, g, w1, w2); if (!ch) continue;
                const dl = evalDelta(ch, P2, Q2);
                if (dl.hard >= 0) continue;
                if (!bestSecond || dl.hard < bestKey.hard || (dl.hard === bestKey.hard && dl.soft < bestKey.soft)) { bestSecond = ch; bestKey = dl; }
              }
            }
          }
          for (const c of first.ch) asg[c.e][c.d] = c.from;
          if (bestSecond) return [first.ch, bestSecond];
        }
      }
      return null;
    }
    return { applied, elapsedMs: Date.now() - t0 };
  }

  // ------------------------------------------------------------------ repair
  function uncoveredSlots(model, asg) {
    const ctx = buildCtx(model);
    const out = [];
    for (let d = 0; d < ctx.days; d++) for (const s of ctx.shifts) {
      const r = evalSlot(ctx, d, s.id, asg);
      const problems = r.hard.filter(v => v.code !== 'over' && v.code !== 'notWith');
      if (problems.length) out.push({ d, s: s.id, iso: ctx.dayInfo[d].iso, problems: problems.map(p => p.msg), present: r.present.map(e => e.id), demand: r.demand });
    }
    return out;
  }

  // Cost of extra hours: part-timers up to full time = "merarbeid" (ordinary pay),
  // beyond that (or anyone at 100 %) = overtime (+50 %).
  function extraHoursCost(ctx, emp, statsBefore, addHours) {
    const fullTime = ctx.rules.avgWeeklyHours * ctx.weeks;
    const after = statsBefore.hours + addHours;
    const overtime = Math.max(0, Math.min(addHours, after - Math.max(fullTime, statsBefore.target)));
    const mer = Math.max(0, addHours - overtime);
    const withinTarget = Math.max(0, Math.min(addHours, statsBefore.target - statsBefore.hours));
    return { overtime, merarbeid: mer, withinTarget, points: (mer - withinTarget) * 1.0 + overtime * 1.5 };
  }

  function findReplacements(model, asg, d, s, opts = {}) {
    const ctx = buildCtx(model);
    const st = ctx.shiftById[s];
    const slotBefore = evalSlot(ctx, d, s, asg);
    const candidates = [], excluded = [];
    const work = cloneAsg(asg);

    function hardFixedBy(chk) { return chk.fixedCount; }

    // 1) direct: someone who is free that day
    for (const e of ctx.employees) {
      if (work[e.id][d]) continue;
      const a = ctx.absAt[e.id] && ctx.absAt[e.id][d];
      if (a) { excluded.push({ employeeId: e.id, reasons: [`Har ${a.typeName}`] }); continue; }
      if (e.shifts && e.shifts[s] === false) { excluded.push({ employeeId: e.id, reasons: [`Jobber ikke ${st.name.toLowerCase()}vakt`] }); continue; }
      const chk = checkChange(ctx, work, e.id, d, s);
      if (!chk.ok) { excluded.push({ employeeId: e.id, reasons: chk.reasons }); continue; }
      const cost = extraHoursCost(ctx, e, chk.statsBefore, st.hours);
      let points = cost.points + chk.softDelta * 0.05 + 1;
      if (e.wantsExtra) points -= 1.5;
      const w = ctx.wishAt[e.id] && ctx.wishAt[e.id][d];
      if (w && w.kind === 'vakt') points -= 3;
      candidates.push({
        kind: 'direct', employeeId: e.id, changes: [{ e: e.id, d, from: null, to: s }],
        fixes: hardFixedBy(chk), cost, points, label: costLabel(cost, st.hours),
        softDelta: chk.softDelta,
      });
    }

    // 2) move within the same day from an overstaffed shift type
    for (const e of ctx.employees) {
      const s2 = work[e.id][d];
      if (!s2 || s2 === s) continue;
      const a = ctx.absAt[e.id] && ctx.absAt[e.id][d]; if (a) continue;
      if (e.shifts && e.shifts[s] === false) continue;
      const q2 = evalSlot(ctx, d, s2, work);
      if (q2.present.length - 1 < q2.demand.min) continue;      // would leave a hole
      const chk = checkChange(ctx, work, e.id, d, s);
      if (!chk.ok) continue;
      const diff = st.hours - ctx.shiftById[s2].hours;
      const cost = diff > 0 ? extraHoursCost(ctx, e, chk.statsBefore, diff) : { overtime: 0, merarbeid: 0, withinTarget: 0, points: 0 };
      candidates.push({
        kind: 'move', employeeId: e.id, changes: [{ e: e.id, d, from: s2, to: s }], fixes: hardFixedBy(chk),
        cost, points: cost.points + chk.softDelta * 0.05 + 0.5, label: `Flyttes fra ${ctx.shiftById[s2].name.toLowerCase()} (overtallig der)`, softDelta: chk.softDelta,
      });
    }

    // 3) two-step swap: e moves from s2 to s, and someone free takes s2
    if (opts.swaps !== false) {
      for (const e of ctx.employees) {
        const s2 = work[e.id][d];
        if (!s2 || s2 === s) continue;
        const a = ctx.absAt[e.id] && ctx.absAt[e.id][d]; if (a) continue;
        if (e.shifts && e.shifts[s] === false) continue;
        const chkE = checkChange(ctx, work, e.id, d, s);
        if (chkE.newHard.length) continue;                 // e cannot legally take s
        work[e.id][d] = s;
        let bestZ = null;
        for (const z of ctx.employees) {
          if (z.id === e.id || work[z.id][d]) continue;
          const az = ctx.absAt[z.id] && ctx.absAt[z.id][d]; if (az) continue;
          if (z.shifts && z.shifts[s2] === false) continue;
          const chkZ = checkChange(ctx, work, z.id, d, s2);
          if (!chkZ.ok) continue;
          const cost = extraHoursCost(ctx, z, chkZ.statsBefore, ctx.shiftById[s2].hours);
          const points = cost.points + (chkZ.softDelta + chkE.softDelta) * 0.05 + 2.5;
          if (!bestZ || points < bestZ.points) bestZ = { z, cost, points, softDelta: chkZ.softDelta + chkE.softDelta };
        }
        work[e.id][d] = s2;
        if (!bestZ) continue;
        // verify the slot s actually improves with e in it
        work[e.id][d] = s; const after = evalSlot(ctx, d, s, work); work[e.id][d] = s2;
        const fixes = diffSlot(after.hard, slotBefore.hard).length;
        if (!fixes) continue;
        candidates.push({
          kind: 'swap', employeeId: e.id, partnerId: bestZ.z.id,
          changes: [{ e: e.id, d, from: s2, to: s }, { e: bestZ.z.id, d, from: null, to: s2 }],
          fixes, cost: bestZ.cost, points: bestZ.points,
          label: `${e.name} flyttes fra ${ctx.shiftById[s2].name.toLowerCase()}, ${bestZ.z.name} tar ${ctx.shiftById[s2].name.toLowerCase()} (${costLabel(bestZ.cost, ctx.shiftById[s2].hours)})`,
          softDelta: bestZ.softDelta,
        });
      }
    }

    candidates.sort((a, b) => b.fixes - a.fixes || a.points - b.points || a.changes.length - b.changes.length);
    return { d, s, iso: ctx.dayInfo[d].iso, slot: slotBefore, candidates, excluded };
  }

  function costLabel(cost, hours) {
    const parts = [];
    if (cost.withinTarget > 0.01) parts.push(`${fmtHours(cost.withinTarget)} innenfor stillingen`);
    if (cost.merarbeid - cost.withinTarget > 0.01) parts.push(`${fmtHours(cost.merarbeid - cost.withinTarget)} merarbeid`);
    if (cost.overtime > 0.01) parts.push(`${fmtHours(cost.overtime)} overtid`);
    return parts.length ? parts.join(', ') : `${fmtHours(hours)} ekstra`;
  }

  // Apply the best candidate for every uncovered slot, in date order.
  function autoRepair(model, asg, opts = {}) {
    const work = cloneAsg(asg);
    const log = [];
    const unresolved = [];
    const slots = uncoveredSlots(model, work).filter(u => !opts.onlyDays || opts.onlyDays.has(u.d));
    for (const u of slots) {
      let guard = 0;
      while (guard++ < 4) {
        const r = findReplacements(model, work, u.d, u.s, { swaps: true });
        const slotNow = evalSlot(buildCtx(model), u.d, u.s, work);
        if (!slotNow.hard.filter(v => v.code !== 'over' && v.code !== 'notWith').length) break;
        const c = r.candidates[0];
        if (!c) { unresolved.push({ d: u.d, s: u.s, iso: u.iso, problems: slotNow.hard.map(v => v.msg) }); break; }
        for (const ch of c.changes) work[ch.e][ch.d] = ch.to;
        log.push({ d: u.d, s: u.s, iso: u.iso, candidate: c });
      }
    }
    return { asg: work, log, unresolved };
  }

  // ------------------------------------------------------------------ export
  function toCSV(model, asg, sep = ';') {
    const ctx = buildCtx(model);
    const head = ['Ansatt', 'Stilling %'].concat(ctx.dayInfo.map(di => `${WD_SHORT[di.wd]} ${di.iso}`));
    const rows = [head];
    for (const e of ctx.employees) {
      const row = asg[e.id] || [];
      rows.push([e.name, e.percent].concat(ctx.dayInfo.map(di => {
        const a = ctx.absAt[e.id] && ctx.absAt[e.id][di.d];
        if (a && a.planned) return a.type === 'ferie' ? 'FE' : 'P';
        if (a && !a.planned) return 'S';
        return row[di.d] || 'F';
      })));
    }
    return rows.map(r => r.map(v => `${v}`.includes(sep) ? `"${v}"` : v).join(sep)).join('\n');
  }

  return {
    HARD_W, WD_SHORT, WD_LONG,
    parseISO, toISO, addDays, weekdayOf, nextMonday, isoWeek, fmtDate, fmtDateWd, fmtH, fmtHours, toMin,
    defaultRules, defaultShiftTypes, emptyDemand,
    buildCtx, evalEmployee, evalSlot, evaluate, evaluateCtx, capacity, checkChange, presentIn,
    generate, improve, improveRoster, polish, construct, emptyAssignment, cloneAsg,
    uncoveredSlots, findReplacements, autoRepair, extraHoursCost, costLabel, toCSV, mulberry32,
  };
});
