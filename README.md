# Vaktflyt

**Turnus som går opp.** Prototype av et kriteriestyrt turnussystem for døgninstitusjoner i helse, psykiatri og barnevern: lederen beskriver kriteriene, Vaktflyt legger kabalen – og legger den på nytt når noen blir syke.

Kjør den her: **https://jobendik.github.io/Vaktflyt/**
(demo-innlogging `erik` / `vaktflyt`)

Alt kjører i nettleseren. Ingenting sendes til en server; data lagres lokalt i nettleseren du bruker.

## Hva prototypen gjør

1. **Beskriv kriteriene**
   - Ansatte med stillingsprosent, kjønn, hvilke vakttyper de kan gå, kompetanse (frie merkelapper som «medikament», «erfaren»), helgefrekvens, helgestilling, faste dager de ikke kan jobbe, hvem de ikke skal jobbe sammen med, hvem de jobber godt sammen med.
   - Ferie, permisjon, kurs, innvilget fri og ønsker (fri / vakt).
   - Bemanningskrav per vakttype for hverdag og helg: min/maks antall, kompetansekrav, kjønnssammensetning.
   - Regler fra lov og tariff, med forklaring og lenke til paragraf: 11 t daglig hvile, 35 t ukentlig fri, maks timer per uke, maks dager og netter på rad, helgefrekvens, gjennomsnittlig ukentlig arbeidstid.
   - Prioriteringer når alt ikke kan oppfylles (treffe stillingsprosent, hele helger, nattblokker, ønsker, gode team …).

2. **Generer turnus**
   - Helgene legges først (den knappe ressursen), så ukedagene. Deretter forbedres planen i noen sekunder, og de siste bruddene søkes bort med målrettede bytter.
   - Resultatet vises som et rutenett med fargekode etter tid på døgnet, timer per ansatt mot stilling, netter og helger per ansatt, bemanning per vakt nederst.
   - Alle brudd på harde regler listes klikkbart; avvik fra ønsker og preferanser vises for seg.
   - Klikk på en celle: hvorfor den er som den er, endre vakt (med forklaring hvis endringen bryter regler), og «hvem kan ta denne vakten i stedet?».

3. **Reparer ved sykdom**
   - Meld fravær. Vaktflyt finner vaktene som må dekkes og rangerer lovlige løsninger: hvem som er kvalifisert og tilgjengelig, hva det koster (innenfor stillingen / merarbeid / overtid), og om løsningen krever én eller to endringer.
   - For hver som *ikke* kan, står det hvorfor: «Bare 9,5 t hvile mellom kveld man. og dag tir. (krav 11 t)», «Har ferie», «Uke 46: lengste sammenhengende fritid er 33,5 t», «Jobber ikke nattvakt».
   - «Løs alle automatisk» tar beste forslag for hvert hull og sier fra om det som ikke lar seg løse lovlig.
   - Endringslogg og angre.

4. **Eksport**: kopier tabellen til utklippstavlen (lim rett inn i Excel/Gat), CSV, utskrift, sikkerhetskopi som JSON.

## Sette opp nettsiden (GitHub Pages)

1. Gå til repoets **Settings → Pages**.
2. Under *Build and deployment* velg **Source: Deploy from a branch**, branch **main**, mappe **/ (root)**. Lagre.
3. Etter et minutt er siden oppe på `https://jobendik.github.io/Vaktflyt/`.

Siden er statisk (ingen byggesteg), så hvert push til `main` oppdaterer den.

## Filene

| Fil | Innhold |
|---|---|
| `index.html` | Sidestruktur, innlogging |
| `styles.css` | Design |
| `app.js` | Brukergrensesnittet (visninger, redigering, reparasjon, eksport, lagring i nettleseren) |
| `engine.js` | Regelmotor og generator. Ren logikk uten DOM – kjører i nettleser, Web Worker og Node |
| `worker.js` | Kjører generatoren i bakgrunnen så siden ikke fryser |
| `demo.js` | Demodata: fiktiv døgnavdeling med 19 ansatte |

Motoren kan testes uten nettleser:

```bash
node -e "
const VF = require('./engine.js'); const { demoModel } = require('./demo.js');
const r = VF.generate(demoModel(), { seed: 42, timeBudgetMs: 3000 });
console.log('brudd:', r.report.hardCount, 'dekning:', r.report.coverage);"
```

## Hvordan den løser kabalen

- **Harde regler** (brytes aldri av generatoren): bemanning, kompetanse og kjønn per vakt; daglig og ukentlig hvile; maks timer per uke; dager og netter på rad; helgefrekvens; planlagt fravær; innvilget fri; hvem som kan gå hvilke vakttyper; hvem som ikke skal jobbe sammen.
- **Myke regler** (vektes): avvik fra stillingsprosent, ønsker, hele helger, netter i blokker, stabile vakttyper, enkeltstående fri-/arbeidsdager, rettferdig fordeling av netter og helger, foretrukne kolleger.
- **Algoritme**: grådig konstruksjon med helger først (knapphetsbevisst, så eneste medikamentkompetente ikke brukes på en vakt som ikke trenger det), deretter simulert nedkjøling over bytter (flytt, bytt, bytt dager, bytt helger, slå sammen netter), og til slutt en deterministisk opprydding som søker etter ett eller to bytter som fjerner gjenværende brudd. Et nytt forsøk startes automatisk hvis det første ikke går helt opp.

## Dette er en prototype

- Innloggingen er kun en demo. Flere brukere, roller og ekte pålogging krever en backend.
- Reglene er et utgangspunkt. Tariff (KS, Spekter, Virke) og lokale avtaler må legges inn og kvalitetssikres av noen som kan dem. Turnus skal uansett drøftes med tillitsvalgte (AML § 10-3) – Vaktflyt lager forslag med regelsjekk, den «godkjenner» ingenting.
- Ingen integrasjon mot Gat eller andre systemer; eksporten er laget for å limes inn manuelt.
- Fravær og begrensninger er personopplysninger. Før dette brukes med ekte data trengs databehandleravtale, risikovurdering og en server med skikkelig tilgangsstyring.

## Veien videre

- Prøve prototypen på en ekte, anonymisert grunnturnus og de siste ti sykefraværs-kabalene fra en avdeling – det er testsettet den skal slå.
- Medleverturnus og langvakter (egen forskrift), flere vakttyper per dag, delte vakter.
- Backend med pålogging, flere avdelinger, historikk og revisjonsspor.
- Bedre forklaringer: «hvorfor fikk Kari fire helger og Per tre?»
