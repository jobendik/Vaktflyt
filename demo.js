/*
 * Demo data for Vaktflyt — a fictional residential unit ("Enhet Nord").
 * All names are invented. Loaded in the browser (window.VF_DEMO) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VF_DEMO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAN = { D: true, A: true, N: true };
  const DA = { D: true, A: true, N: false };
  const N_ONLY = { D: false, A: false, N: true };

  function demoModel() {
    const employees = [
      { id: 'e01', name: 'Kari Haugland', title: 'Teamleder / vernepleier', percent: 100, gender: 'K', tags: ['medikament', 'erfaren', 'teamleder'], shifts: DA, notes: 'Teamleder. Går ikke natt.' },
      { id: 'e02', name: 'Per Nordvik', title: 'Miljøterapeut', percent: 100, gender: 'M', tags: ['erfaren'], shifts: DAN, preferWith: ['e06'] },
      { id: 'e03', name: 'Amina Yusuf', title: 'Sykepleier', percent: 100, gender: 'K', tags: ['medikament', 'erfaren'], shifts: DAN },
      { id: 'e04', name: 'Jonas Berge', title: 'Barnevernspedagog', percent: 100, gender: 'M', tags: ['erfaren'], shifts: DAN, preferWith: ['e13'] },
      { id: 'e05', name: 'Ingrid Sæther', title: 'Vernepleier', percent: 80, gender: 'K', tags: ['medikament'], shifts: DAN },
      { id: 'e06', name: 'Mats Lien', title: 'Miljøarbeider', percent: 100, gender: 'M', tags: [], shifts: DAN, preferWith: ['e02'] },
      { id: 'e07', name: 'Sofie Dahl', title: 'Miljøterapeut', percent: 80, gender: 'K', tags: ['erfaren'], shifts: DA, blockedWeekdays: [2], notes: 'Studerer – kan ikke jobbe onsdager.' },
      { id: 'e08', name: 'Tariq Hassan', title: 'Miljøterapeut', percent: 100, gender: 'M', tags: ['erfaren'], shifts: DAN, weekendEvery: 2, notes: 'Har avtalt å jobbe hver 2. helg.' },
      { id: 'e09', name: 'Linn Fosse', title: 'Sykepleier', percent: 60, gender: 'K', tags: ['medikament'], shifts: DAN, wantsExtra: true, weekendEvery: 2, notes: 'Ønsker ekstravakter og jobber hver 2. helg.' },
      { id: 'e10', name: 'Erlend Moe', title: 'Miljøarbeider (natt)', percent: 75, gender: 'M', tags: ['erfaren'], shifts: N_ONLY, notes: 'Fast nattstilling.' },
      { id: 'e11', name: 'Maria Solberg', title: 'Vernepleier', percent: 80, gender: 'K', tags: ['medikament', 'erfaren'], shifts: DAN, notWith: ['e12'] },
      { id: 'e12', name: 'Håkon Vik', title: 'Miljøarbeider', percent: 60, gender: 'M', tags: [], shifts: DAN, notWith: ['e11'], wantsExtra: true },
      { id: 'e13', name: 'Nora Eide', title: 'Barnevernspedagog', percent: 100, gender: 'K', tags: ['erfaren'], shifts: DAN, preferWith: ['e04'] },
      { id: 'e14', name: 'Omar Khalil', title: 'Miljøterapeut', percent: 75, gender: 'M', tags: [], shifts: DAN, weekendEvery: 2, wantsExtra: true },
      { id: 'e15', name: 'Silje Aas', title: 'Helgestilling (student)', percent: 20, gender: 'K', tags: [], shifts: DAN, onlyWeekends: true, weekendEvery: 2 },
      { id: 'e16', name: 'Henrik Lund', title: 'Helgestilling', percent: 20, gender: 'M', tags: [], shifts: DAN, onlyWeekends: true, weekendEvery: 2 },
      { id: 'e17', name: 'Thea Nygård', title: 'Helgestilling (student)', percent: 20, gender: 'K', tags: [], shifts: DAN, onlyWeekends: true, weekendEvery: 2 },
      { id: 'e18', name: 'Jakob Strand', title: 'Helgestilling (student)', percent: 20, gender: 'M', tags: [], shifts: DAN, onlyWeekends: true, weekendEvery: 2 },
      { id: 'e19', name: 'Emma Bakke', title: 'Sykepleier (helgestilling)', percent: 20, gender: 'K', tags: ['medikament', 'erfaren'], shifts: DA, onlyWeekends: true, weekendEvery: 2 },
    ];

    const demand = {
      weekday: {
        D: { min: 3, max: 4, tags: { erfaren: 1 }, minK: 0, minM: 0 },
        A: { min: 3, max: 4, tags: { medikament: 1, erfaren: 1 }, minK: 0, minM: 0 },
        N: { min: 2, max: 2, tags: {}, minK: 1, minM: 1 },
      },
      weekend: {
        D: { min: 2, max: 3, tags: { erfaren: 1 }, minK: 0, minM: 0 },
        A: { min: 2, max: 3, tags: { medikament: 1 }, minK: 0, minM: 0 },
        N: { min: 2, max: 2, tags: {}, minK: 1, minM: 1 },
      },
    };

    const absences = [
      { id: 'a1', employeeId: 'e04', from: '2026-11-09', to: '2026-11-15', type: 'ferie', note: 'Høstferie' },
      { id: 'a2', employeeId: 'e05', from: '2026-12-21', to: '2026-12-27', type: 'ferie', note: 'Jul' },
      { id: 'a3', employeeId: 'e09', from: '2026-12-14', to: '2026-12-15', type: 'kurs', note: 'Medikamentkurs' },
    ];

    const wishes = [
      { id: 'w1', employeeId: 'e02', date: '2026-11-20', kind: 'fri', hard: false, note: 'Bursdag' },
      { id: 'w2', employeeId: 'e07', date: '2026-11-14', kind: 'vakt', shift: 'D', note: 'Ønsker ekstra dagvakt' },
      { id: 'w3', employeeId: 'e13', date: '2026-12-04', kind: 'fri', hard: true, note: 'Innvilget fri – bryllup' },
      { id: 'w4', employeeId: 'e06', date: '2026-12-24', kind: 'fri', hard: false, note: 'Julaften' },
      { id: 'w5', employeeId: 'e03', date: '2026-12-24', kind: 'fri', hard: false, note: 'Julaften' },
      { id: 'w6', employeeId: 'e12', date: '2026-11-28', kind: 'vakt', shift: null, note: 'Vil gjerne jobbe' },
    ];

    return {
      version: 1,
      settings: {
        unitName: 'Enhet Nord – døgnavdeling',
        periodStart: '2026-11-02',
        weeks: 8,
        shiftTypes: [
          { id: 'D', name: 'Dag', start: '07:30', end: '15:00', color: '#F3C65B' },
          { id: 'A', name: 'Kveld', start: '14:30', end: '22:00', color: '#E9825E' },
          { id: 'N', name: 'Natt', start: '21:45', end: '07:45', color: '#4A5BA6' },
        ],
        tags: ['medikament', 'erfaren', 'teamleder'],
      },
      rules: null,          // null = engine defaults
      employees,
      demand,
      absences,
      wishes,
      roster: null,         // asg filled by the generator
      changelog: [],
    };
  }

  return { demoModel };
});
