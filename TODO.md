# TODO — Ökonomisches Modell des Energiewende-Rechners fair & praxistauglich machen

Analyse des vorhandenen Wirtschaftlichkeitsmodells (`src/calc/*`), abgeglichen mit
bekannten Online-Rechnern (Stiftung Warentest / test.de, IBC Solar
Wirtschaftlichkeitsrechner, pv-berechnung.de, solar.red, 1KOMMA5°,
Finanztip, HTW-Berlin Unabhängigkeits-/Speicherrechner) und der wissenschaftlichen
Literatur (NREL PVLCOE, LCOE/NPV/IRR-Reviews in *Renew. Sust. Energy Rev.* und
*J. Energy Storage*; HTW Stromspeicher-Inspektion; SFV / Verbraucherzentrale NRW).

Kernbefund: Der Rechner ist ein sehr sauberer, deterministischer **Ein-Jahres-,
undiskontierter, degradationsfreier** Simulator. Genau das ist die größte Lücke
gegenüber allen ernstzunehmenden Referenzen. Die Physik / der Dispatch sind gut;
die **Investitionsrechnung** ist zu einfach und an mehreren Stellen unfair
(zugunsten *und* zulasten der Anlage).

Legende der Priorität: **P0** = verfälscht Kernaussage (Amortisation/Rendite),
**P1** = wichtig für Fairness/Vergleichbarkeit, **P2** = Verfeinerung/Nice-to-have.

---

## 1. Mehrjahres-Cashflow statt Ein-Jahres-Momentaufnahme

### 1.1 [P0] Lebensdauer-Cashflow-Modell einführen
**Problem:** `amortisation.ts` rechnet `payback = Investition / Jahresersparnis`
mit *einer* konstanten Jahresersparnis. Kein Betrachtungszeitraum, keine
Diskontierung, keine Preissteigerung, keine Degradation. Jeder Referenzrechner
(test.de, IBC, pv-berechnung.de, solar.red) rechnet einen **kumulierten Cashflow
über 20–25 Jahre**; die Amortisation ist das Jahr, in dem der kumulierte Cashflow
positiv wird.

**Aktion:** Neues Modul `src/calc/cashflow.ts`. Jahr-für-Jahr-Projektion über
`horizonYears` (Default 20, konfigurierbar bis 30). Pro Jahr `t`:
- PV-Ertrag = Basisertrag × (1 − degradationRate)^t
- Strompreis (Bezug) = Basispreis × (1 + priceEscalation)^t
- Einspeisevergütung: 20 Jahre fix (EEG), danach 0 bzw. Marktwert
- Betriebskosten (siehe 2.1) mit Inflation
- Ersatzinvestitionen (Wechselrichter, Speicher — siehe 2.2)

**Erwartete Kennzahlen (neu im `SimReport`):**
- `simplePaybackYears` (wie bisher, als schnelle Näherung behalten)
- `discountedPaybackYears`
- `npvEUR` (Kapitalwert bei Diskontsatz `d`)
- `irrPercent` (interner Zinsfuß)
- `lcoeCtPerKWh` (Stromgestehungskosten, siehe 1.4)
- `cumulativeCashflow[t]` (für die Cashflow-Kurve im Chart)

**Beispiel-Plausibilität (10 kWp, kein Speicher, ~9.000 € Investition,
1.000 kWh/kWp, 30 % Eigenverbrauch, 30 ct Bezug, 8 ct Einspeisung):**
- einfacher Payback ≈ 10–12 Jahre
- NPV (20 J, d=3 %) deutlich positiv
- IRR ≈ 4–7 % p.a. (Literatur/Praxis: PV ohne Speicher 3–8 %)
- LCOE ≈ 8–12 ct/kWh
→ Testen: `tests/cashflow.test.ts`.

### 1.2 [P0] Diskontsatz / Kalkulationszins
**Problem:** Ein heute gesparter Euro wird gleich einem in 20 Jahren gesparten
gewertet. Ohne Diskontierung ist die Amortisation systematisch zu optimistisch
und NPV/IRR fehlen ganz.

**Aktion:** Parameter `discountRatePct` (Default 3 %; UI-Slider 0–8 %). Als
Opportunitätskosten des Kapitals dokumentieren (Alternativanlage / Finanzierungszins).
NREL-PVLCOE und die NPV/IRR-Literatur behandeln den Diskontsatz als *den*
dominierenden Hebel — er gehört sichtbar in die UI.

### 1.3 [P0] Strompreissteigerung (Bezug) und Einspeise-Auslauf
**Problem:** Bezugspreis ist statisch. Reale Rechner nutzen 2–4 %/Jahr
Steigerung; das ist der Haupttreiber der PV-Rendite. Zusätzlich fehlt, dass die
**feste EEG-Einspeisevergütung nach 20 Jahren endet**.

**Aktion:**
- `priceEscalationPct` (Default 2,0 %/Jahr; UI 0–6 %).
- EEG-Vergütung nur Jahre 1..20 ansetzen; ab Jahr 21 auf Marktwert bzw. 0 fallen
  lassen (Hinweis in der UI).
- Für `dynamic`/`dynamic14a`: Spot-Basis ebenfalls eskalieren (gleicher Faktor
  oder eigener `spotEscalationPct`).

**Erwartet:** Höhere `priceEscalationPct` → kürzere Amortisation, höherer NPV.
Sensitivitätstest ergänzen.

### 1.4 [P1] LCOE (Stromgestehungskosten) ausweisen
**Problem:** Es gibt kein technologieneutrales Vergleichsmaß. LCOE ist die
Standard-Kennzahl der gesamten Literatur (NREL PVLCOE, Branker et al. Review).

**Aktion:** `LCOE = Σ (Kosten_t / (1+d)^t) / Σ (kWh_t / (1+d)^t)` über die
Lebensdauer (Investition + O&M + Ersatz im Zähler; erzeugte, degradierte kWh im
Nenner). Als „dein Solarstrom kostet dich X ct/kWh vs. Y ct/kWh aus dem Netz"
darstellen — das ist die intuitivste Fairness-Aussage.
**Plausibilität DE-Dach 2025:** 8–14 ct/kWh ohne Speicher; mit Speicher höher.

---

## 2. Kostenseite vollständig und fair machen

### 2.1 [P0] Laufende Betriebskosten (O&M)
**Problem:** `amortisation.ts` kennt nur die Einmalinvestition. Versicherung,
Wartung, Zählergebühr, Rücklagen fehlen komplett → Rendite/Payback zu optimistisch.
Referenzwerte (echtsolar, 1KOMMA5°): **1–2 %/Jahr der Investition** ohne Speicher,
**2,2–2,5 %** mit Speicher; absolut ~190–570 €/Jahr für 5–15 kWp.

**Aktion:** Parameter `omPercentPerYear` (Default 1,5 %) **oder** absolute
`omEURPerYear`; im Cashflow mit Inflation fortschreiben. Aufschlüsseln:
Versicherung (~65–195 €), Wartung (~90–115 €), Zähler (~20 €), Rücklage.
UI: ein einziger „Betriebskosten"-Slider mit sinnvollem Default genügt zunächst.

### 2.2 [P0] Ersatzinvestitionen (Wechselrichter + Speicher)
**Problem:** Weder Wechselrichter- noch Speichertausch werden berücksichtigt. Das
ist der größte *versteckte* Fehler zugunsten der Anlage — insbesondere beim
Speicher (siehe Abschnitt 3).
- Wechselrichter: Lebensdauer ~10–15 Jahre, Tausch 1.000–2.000 €.
- Speicher: reale kalendarische Lebensdauer **10–15 Jahre** (Verbraucherzentrale
  konservativ; LFP-Premium 15–20 J). Bei 20-Jahres-Horizont ist ein Speichertausch
  quasi unvermeidlich.

**Aktion:** Im Cashflow diskrete Ersatzkosten in Jahr `inverterLifetimeYears`
(Default 13) und `batteryLifetimeYears` (Default 13) einplanen; Kosten
konfigurierbar. Restwert am Ende des Horizonts optional gutschreiben.

**Erwartet:** Payback eines Speicher-Szenarios verlängert sich deutlich; der
„Speicher verkürzt die Amortisation"-Effekt aus dem README relativiert sich.

### 2.3 [P1] Investition realistisch nach Größe (optional, statt reinem Einzel-Slider)
**Problem:** `investmentEUR` ist ein einziger Betrag, entkoppelt von kWp/kWh. Das
war eine *bewusste* Design-Entscheidung (README), um das Amortisations-Artefakt
der gekoppelten Kosten zu vermeiden — aber es macht Voreinstellungen unrealistisch
(Default 32.000 € für 22 kWp/19 kWh ist plausibel, aber der User muss es selbst
wissen). Referenzrechner leiten Kosten aus €/kWp + €/kWh ab.

**Aktion (nicht das alte Artefakt zurückholen!):** `investmentEUR` bleibt die
maßgebliche Größe, aber ein **Auto-Schätzer** füllt ihn vor:
`≈ kWp × costPerKWp (Default ~1.300 €/kWp, degressiv) + kWh × costPerKWh
(~500–700 €/kWh)`. Der User kann überschreiben. Das Amortisations-Artefakt wird
vermieden, weil die Ersparnis-Seite (Abschnitt 2.2) jetzt die echten Speicherkosten
inkl. Ersatz trägt.

### 2.4 [P2] Steuern / MwSt-Klarstellung
**Problem:** Nullsteuersatz (§12 Abs. 3 UStG) für Privatanlagen ist implizit;
Bezugspreise mischen ggf. brutto/netto. Bei Bezugspreis ist relevant, dass nur
der **Arbeitspreis** (nicht der Grundpreis) durch PV gespart wird (SFV-Hinweis).

**Aktion:** UI-Label „Strompreis (Arbeitspreis, brutto)" + Tooltip; sicherstellen,
dass baseline nur den Arbeitspreis nutzt (Grundpreis fällt weiter an).

---

## 3. Speicher-Wirtschaftlichkeit ehrlich abbilden

### 3.1 [P0] Batterie-Degradation im Dispatch
**Problem:** `simulation.ts` nutzt konstante `capacityKWh` über alle Jahre.
Reale Kapazität sinkt **1–2 %/Jahr** (nach 20 J ~85 % bei gutem LFP). Ohne
Degradation ist der Speicherbeitrag über die Lebensdauer zu hoch.

**Aktion:** Im Mehrjahres-Cashflow (1.1) nutzbare Kapazität pro Jahr skalieren:
`capUsable_t = capacityKWh × (1 − batteryDegradationPct)^t`. Optional
Wirkungsgrad-Alterung (Round-Trip fällt leicht).

### 3.2 [P1] Speicher-Standby-/Eigenverbrauch berücksichtigen
**Problem:** HTW-Inspektion/SFV: ~20 % Systemverluste beim Ein-/Ausspeichern und
zusätzlicher Standby-/Netzbezug (bis ~100 kWh/Jahr). Aktuell nur Round-Trip
`efficiency` (0,95) — zu optimistisch (real oft 0,85–0,90 System-SPI).

**Aktion:** Default `efficiency` realistischer (0,90). Optionaler
`standbyWattage`/`annualStandbyKWh`, der als Netzbezug gebucht wird.

### 3.3 [P1] „Rechnet sich der Speicher?"-Vergleich explizit ausweisen
**Problem:** Der Speicher ist derzeit fest im Szenario. Nutzer sehen nicht den
*marginalen* Beitrag des Speichers. SFV/Verbraucherzentrale: Speicher ist oft der
Punkt, an dem PV *unwirtschaftlich* wird.

**Aktion:** Immer zwei Läufe rechnen (mit/ohne Speicher, gleiche PV) und die
**Speicher-eigene Amortisation / NPV** separat ausgeben: `ΔNPV_Speicher`,
`payback_Speicher = Speicherinvest / jährliche Zusatzersparnis`.

### 3.4 [P2] Auslegungshinweis (Faustregel)
**Aktion:** Sanfter Hinweis, wenn `capacityKWh` > `verbrauch/1000` (VZ-NRW-Regel:
max. ~1 kWh Speicher je 1.000 kWh Verbrauch) bzw. wenn Speicher/kWp stark
überdimensioniert ist. Nur Hinweis, keine harte Grenze.

---

## 4. Ertrags- und Autarkie-Modell schärfen

### 4.1 [P1] Eigenverbrauchs- und Autarkiegrad als Kernkennzahl
**Problem:** `selfConsumptionKWh` existiert, aber Eigenverbrauchs-**quote** und
**Autarkiegrad** (Self-Sufficiency Rate) werden nicht prominent ausgewiesen. Alle
Referenzrechner und die PV-BESS-Literatur (SCR/SSR) stellen diese in den
Mittelpunkt; sie sind der Haupttreiber der Rendite.

**Aktion:** `SimSummary` um `selfConsumptionRatePct` (= Eigenverbrauch / PV) und
`selfSufficiencyPct` (= Eigenverbrauch / Last) erweitern und im UI zeigen.
**Plausibilität:** ohne Speicher 25–35 %, mit Speicher 60–75 % Autarkie
(solar.red / HTW). Als Plausibilitätstest verankern.

### 4.2 [P1] Ertrags-Kalibrierung dokumentieren/prüfen
**Problem:** `solar.ts` kalibriert auf `annualYieldPerKWp` (Hamburg 1000,
München 1100 …). Ost/West-Ratio 0,86, Nord 0,42. Werte sind plausibel, aber ohne
Quelle/Vergleich zu PVGIS.

**Aktion:** Gegen PVGIS / MaStR-Erfahrungswerte gegenchecken und im Code
referenzieren. Ost-West-Aufdachanlage real oft ~90 % einer Südanlage bei besserem
Eigenverbrauchsprofil — Ratio ggf. auf 0,88–0,90 anheben und Tilt-Sensitivität
testen.

### 4.3 [P2] Wetter-/Ertragsjahr-Streuung
**Problem:** Ein einziges deterministisches Ertragsjahr. Reale Jahresschwankung
±10 %.

**Aktion:** Optionaler „gutes/schlechtes Jahr"-Faktor (P90/P50/P10-Bänder) für
eine Bandbreite im Ergebnis, analog zur Preisjahr-Auswahl.

---

## 5. Preis- und Tarifmodell

### 5.1 [P1] Dynamische Tarife: Adder & Netzentgelt-Zeitreihe validieren
**Problem:** `tariff.ts` addiert fixe Komponenten (Stromsteuer 2,05; Konzession
1,1; Messung 0,5; Marge 1,5). §14a-Modul-3-Werte außerhalb Boizenburg sind grobe
Faktoren (0,3× / 1,7×). Das ist okay, aber undokumentiert unsicher.

**Aktion:** Adder-Quellen/Stand kommentieren; für Nicht-Boizenburg-Städte einen
Hinweis „approximiert" in die UI. Prüfen, ob MwSt auf dynamische Bezugskosten
konsistent zum `fixed`-Pfad ist.

### 5.2 [P2] Zukunfts-Spotpreise statt nur historischer Jahre
**Problem:** Cashflow über 20 Jahre braucht Preis-*Projektionen*; aktuell nur
2023–2026 real (2026 teils extrapoliert).

**Aktion:** Für Jahre > 2026 ein Referenz-Preisjahr mit `spotEscalationPct`
fortschreiben (siehe 1.3). Klar als Annahme kennzeichnen.

---

## 6. Opportunitätskosten (Wärmepumpe / E-Auto) fairer

### 6.1 [P1] Konsistenz mit dem Cashflow-Zeithorizont
**Problem:** `report.ts` `financeableHeatpumpEUR = saving × pvPaybackYears` mischt
eine *undiskontierte* Ersparnis mit den PV-Payback-Jahren — methodisch schief
(nutzt gerundeten Payback als „Anzahl Jahre Ersparnis").

**Aktion:** Wärmepumpen-/EV-Ersparnis über denselben diskontierten Horizont wie
PV rechnen (`Σ saving_t/(1+d)^t`) und als „finanzierbares Budget (Barwert)"
ausgeben. Konsistente Preis-Eskalation für Gas/Öl/Diesel/Strom.

### 6.2 [P2] WP: JAZ-Realismus & Vergleichsbasis
**Problem:** JAZ Default 3 ist konservativ-fair; Gaspreis 11 ct, Öl 130 €/100 L.
Prüfen gegen aktuelle Werte; JAZ 3,0–3,5 bei Bestandsbau, 3,5–4,5 Neubau.

**Aktion:** Defaults dokumentieren + Tooltip zur JAZ-Bandbreite; CO2-Preis-Pfad
für Gas/Öl (nationaler/EU-ETS2) als optionaler Kostenpfad — macht den WP-Vergleich
über die Zeit fairer (fossil wird teurer).

### 6.3 [P2] EV/Diesel: Anschaffungs-Delta optional
**Problem:** Nur Betriebskosten verglichen; der EV-Mehrpreis in der Anschaffung
fehlt (fair, aber unvollständig).

**Aktion:** Optionaler `evPurchasePremiumEUR`, über Horizont gerechnet.

---

## 7. Transparenz, UX & Tests

### 7.1 [P1] Annahmen sichtbar machen
**Aktion:** Ein „Annahmen"-Panel/Report-Feld, das alle ökonomischen Defaults
zeigt (Diskontsatz, Preissteigerung, O&M, Degradation, Lebensdauern, Horizont).
Jeder seriöse Rechner nennt seine Annahmen (test.de, IBC: „unbeschattet, ideal
Süd" etc.). Erhöht Vertrauen und Fairness-Wahrnehmung.

### 7.2 [P1] Cashflow-Diagramm
**Aktion:** Neue SVG-Grafik: kumulierter (diskontierter) Cashflow über die Jahre
mit markiertem Break-even. Das ist die zentrale Ergebnisgrafik jedes
Referenzrechners und fehlt hier.

### 7.3 [P1] Sensitivitäts-/Szenario-Bänder
**Aktion:** Kleiner Tornado-/Bandbreiten-Block: Wie ändern sich NPV/Payback bei
±1 %-Pkt Diskontsatz, ±1 %-Pkt Preissteigerung, ±10 % Investition, ±10 % Ertrag?
Die Literatur (z. B. 27-Szenarien-Vergleich Türkiye-Studie) betont
Sensitivitätsanalyse als Best Practice.

### 7.4 [P0] Neue Invarianten-Tests
**Aktion (`tests/cashflow.test.ts`, Erweiterung `plausibility.test.ts`):**
- NPV monoton fallend mit steigendem Diskontsatz.
- IRR ist die Nullstelle des NPV (Konsistenzcheck).
- Höhere Preissteigerung → kürzerer diskontierter Payback.
- Speichertausch in Jahr N erzeugt sichtbaren Knick im Cashflow.
- LCOE < Bezugspreis ⇔ NPV > 0 (bei reinem Eigenverbrauch, grobe Konsistenz).
- Batterie-Degradation: nutzbare kWh Jahr 20 ≈ 0,85 × Jahr 1.
- Autarkie mit Speicher > ohne Speicher; SCR fällt bei sehr großer PV.

### 7.5 [P2] README/Doku aktualisieren
**Aktion:** Abschnitt „Amortisation" um NPV/IRR/LCOE/Degradation/O&M erweitern;
Grenzen des Modells klar benennen (kein Netzausbau-, kein volkswirtschaftliches
Energiewende-Modell, sondern Haushalts-Investitionsrechnung).

---

## 8. Zusammenfassung der wichtigsten Korrekturen (Reihenfolge)

1. **[P0]** Mehrjahres-Cashflow (`cashflow.ts`) mit Diskontsatz, Preissteigerung,
   Degradation, O&M, Ersatzinvestitionen → NPV, IRR, LCOE, disk. Payback (1.1–1.4,
   2.1, 2.2, 3.1).
2. **[P0]** Betriebskosten & Speicher-/Wechselrichter-Ersatz einbauen (2.1, 2.2) —
   behebt die unfaire Bevorzugung der Anlage.
3. **[P0]** Neue Invarianten-Tests (7.4).
4. **[P1]** Eigenverbrauchs-/Autarkiequote, Speicher-Marginalnutzen, Annahmen-Panel,
   Cashflow-Chart, Sensitivität (4.1, 3.3, 7.1–7.3).
5. **[P1/P2]** Opportunitätskosten konsistent diskontieren + CO2-Pfad (6.x),
   Tarif-/Preisprojektion (5.x), Ertrags-Feinschliff (4.2–4.3).

**Kernbotschaft:** Der Rechner ist technisch stark, aber ökonomisch ein
*Ein-Jahres*-Modell. Die Umstellung auf einen **diskontierten Lebensdauer-Cashflow
mit Betriebs-/Ersatzkosten und Degradation** ist die eine Änderung, die ihn von
„nett" zu „fair und praxistauglich" hebt — konform mit test.de/Finanztip/HTW und
der NPV/IRR/LCOE-Literatur.
