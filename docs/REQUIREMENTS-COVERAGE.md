# Anforderungs-Abdeckung

Jede ID des Anforderungsdokuments mit Umsetzung und Nachweis. **U** = Unit-Test (`tests/unit`), **E** = Playwright-Test (`tests/e2e`), **R** = Test gegen echtes pi (`real-pi.e2e.ts`), **M** = manuell (siehe README, „Bekannte Grenzen“).

## 3 HTTP-Schnittstelle (`packages/bridge`)

| ID | Stufe | Umsetzung | Nachweis |
|---|---|---|---|
| API-01 | MUSS | Bridge als pi-Extension, Prompts aus Terminal oder Panel | R |
| API-02 | SOLL | `packages/host` (SDK, `createAgentSessionRuntime`), Neustart der Sitzung aus dem Panel | R (`headless host`) |
| API-03 | MUSS | Start in `session_start`, idempotentes `session_shutdown` | U `bridge-server` (stop zweimal), R |
| API-04 | MUSS | `127.0.0.1`, Port 47823, `--browser-port`, `browser-bridge.json` | R (Flag), U |
| API-05 | MUSS | `/browser` (Status, Port, Pairing-Code) | R |
| API-06 | MUSS | Pairing-Code 6-stellig/5 min, 256-Bit-Token, `chrome.storage.local` | U, E `panel` |
| API-07 | MUSS | Bearer-Pflicht außer `/v1/health`, `/v1/pair`; 401 | U |
| API-08 | MUSS | Origin = feste Erweiterungs-ID, Host-Prüfung, 403, kein CORS | U, E AK-09 |
| API-09 | SOLL | `/browser revoke`, Geräteliste je Browserprofil | U |
| API-10 | MUSS | fortlaufende `id`, `Last-Event-ID`, 500 Ereignisse/5 min | U, E AK-08 |
| API-11 | MUSS | `tool_request` bis Ergebnis/Frist/Abbruch (120 s; `wait`/Batch länger), Duplikate verworfen | U |
| API-12 | MUSS | `content` 1:1, `details`, `ok:false` → Fehler | R (Bildblock im Transcript) |
| API-13 | MUSS | Ergebnis erst nach Nutzerentscheid, Ablehnung = `ok:false` | E `security` |
| API-14 | SOLL | `attachments`, `tabContext` als Systemhinweis | E `panel`, `picker` |
| API-15 | MUSS | Prompt-Abschnitt „Browser work“ über `before_agent_start` | R |
| API-16 | MUSS | `find` in der Bridge: `__get_tree` + `modelRegistry.streamSimple`, `usage` | Code; Hilfsmodell-Schritt M (kein API-Zugang) |
| API-17 | SOLL | MCP-Annotationen (`readOnlyHint`, `destructiveHint`) | Code |
| API-18 | KANN | `/browser tools off` via `setActiveTools` | R |

## 4 Grundgerüst

| ID | Stufe | Umsetzung | Nachweis |
|---|---|---|---|
| EXT-01…EXT-05, EXT-08, EXT-11 | MUSS | `extension/manifest.config.ts`, `public/managed-schema.json` | U `manifest` |
| EXT-06/07 | MUSS | Content-Scripts `all_frames`/`document_start`, Top-Frame/`document_idle` | U, E |
| EXT-09 | SOLL | keine `web_accessible_resources`, Scripts als IIFE | U `manifest` (gebautes Manifest) |
| EXT-10 | MUSS | `ensureContent` injiziert per `scripting.executeScript` | E `tools` |

## 5 Seitenpanel, Tab-Gruppen, Sitzungen

| ID | Stufe | Umsetzung | Nachweis |
|---|---|---|---|
| UI-01 | MUSS | `action.onClicked`: `setOptions` + `open` ohne `await` | M |
| UI-02 | MUSS | `tab-groups.openForTab` (neu/übernehmen/eigene) | E `smoke` |
| UI-03 | MUSS | Befehl `toggle-side-panel`, Panel-Registry, `close_side_panel` | M (Tastenkürzel), U Manifest |
| UI-04 | MUSS | Systembenachrichtigung bei fehlender API | Code, M |
| UI-05…UI-08 | MUSS | Gruppe „Agent“/orange, Haupt-/Nebentabs, Gruppen-Prüfung, Tab-Kontext-Hinweis | E `smoke`, `tools`, `robust` |
| UI-09 | SOLL | animierte Punkte/Häkchen im Gruppentitel | E `misc` |
| UI-10 | MUSS | Sitzung↔Gruppe in `chrome.storage.local`, Wiederherstellung | E AK-08 |
| UI-11…UI-14 | MUSS | Eingabe, Markdown, Werkzeugzeilen, Modell-/Denkstufen-Auswahl, Status + Pairing | E `panel` |
| UI-15 | SOLL | Shiki (JS-Engine), Mermaid, KaTeX, jeweils nachgeladen | E `panel` |
| UI-16 | SOLL | Bereichs- und Element-Picker | E `picker` |
| UI-17 | SOLL | Terminal-Prompts und -Werkzeugaufrufe im Panel | E `panel`, R |
| UI-18 | MUSS | Sitzungsliste aus `/v1/sessions`, Screenshots lokal | E `panel` |
| UI-19 | MUSS | Systembenachrichtigung + Ton, Klick fokussiert den Tab | E `misc` |
| UI-20 | SOLL | 25-MB-Grenze je Sitzung, Platzhalter | U `idb` |
| UI-21/22 | KANN | Shortcuts mit Parametern, `chrome.alarms`, Workflow-Aufzeichnung | U `shortcuts`, E `misc` |

## 6 Werkzeugkatalog (`packages/shared/src/tools.ts`, `extension/src/background`)

| ID | Stufe | Umsetzung | Nachweis |
|---|---|---|---|
| 20 Werkzeuge | MUSS/SOLL/KANN | Namen/Parameter wie gefordert, Beschreibungen neu | R (Modell sieht alle 20), E `tools` |
| TOOL-01…03 | MUSS | `computer`: Ref-Klicks scrollen, Neuer-Tab-Hinweis, kurze Texte | E `tools` |
| TOOL-04…06 | MUSS | `browser_batch`: Reihenfolge, Abbruch + Zähler, Screenshots gesammelt | E `tools`, R |
| TOOL-07/08 | SOLL | `tool-progress`, Batch-Empfehlung im Prompt, Abschalten per Konfiguration | E `tools` |
| TOOL-09 | MUSS | Sonderseiten: nur `navigate` | E `tools` |

## 7 Eingabe-Engine · 8 Screenshots · 9 Baum · 10 JavaScript

| ID | Stufe | Umsetzung | Nachweis |
|---|---|---|---|
| INP-01…04 | MUSS | `cdp.ts` (5 s Timeout, Fehlerursachen, `detachAll`, zentraler Handler) | E `robust` (AK-07) |
| INP-05…07 | MUSS | Maustasten, Modifier-Bitmaske, hover/drag/scroll | U `keys`, E `tools` |
| INP-08…10 | MUSS | `keyDown/keyUp`, `insertText`, `rawKeyDown` + `commands` | U `keys`, E `tools` |
| INP-11 | SOLL | `cmd`↔`ctrl` je Plattform | U, E |
| INP-12/13 | MUSS | Phantom-Cursor (fixed, 180 ms, ausgeblendet bei Screenshots) | E |
| SHOT-01…09 | MUSS | Zielgröße/Kachelbudget, JPEG 0,75…0,1, Fallback `OffscreenCanvas`, Skalierungskontext | U `scaling`, E AK-10 |
| SHOT-10/11 | MUSS | `ss_`+9 Zeichen in IndexedDB, `zoom` ändert den Kontext nicht | E `tools` |
| SHOT-12 | SOLL | Hintergrund-Tabs: erzwungener Frame | E `misc` |
| TREE-01…15 | MUSS | `content/tree-core.ts`, `a11y-tree.ts` (`generateTree`, Ref-Maps in der isolierten Welt) | U `tree`, `tree-snapshots`; E |
| TREE-16 | SOLL | offene Shadow-Roots (inkl. Slots) | U, E |
| JS-01…06 | MUSS | `page-tools.ts` (Block → async-Wrapper, 30 s, Filter) | E `tools` |
| JS-07 | SOLL | Werte sensibler Felder vorab lesen und schwärzen | E AK-06 |
| JS-08 | MUSS | Heuristik dokumentiert | README |

## 11 Sicherheit · 12 Indikatoren · 13 Hilfsfunktionen

| ID | Stufe | Umsetzung | Nachweis |
|---|---|---|---|
| SEC-01…06 | MUSS | `permissions.ts` + `shared/permissions.ts` (Typen, einmal/immer, PSL, Dialog, Domain-Übergang, Listen, 5-min-Cache) | U `permissions`, E `security` |
| SEC-07/08 | MUSS | Gruppen-Prüfung, `security.preCheck` (inkl. `pendingUrl`) | E AK-05 |
| SEC-09 | SOLL | Zweitprüfung über `/v1/review` | E `security` |
| SEC-10 | SOLL | Passwort-/Kartenfelder immer Einmal-Freigabe | E `security` |
| SEC-11/12 | MUSS | `<page_content>`-Begrenzer, Prompt-Abschnitt | E, R |
| SEC-13 | MUSS | Stopp-Button, Panel schließen, `/v1/abort`, Debugger lösen | E AK-07, `robust`; R |
| SEC-14 | MUSS | Audit-Log (IndexedDB, 30 Tage, Export) | E `security`, U `idb` |
| IND-01…04 | MUSS | `content/indicator.ts` (Nachrichten, Heartbeat 5 s, Shadow Root) | E `robust`, `picker` |
| AUX-01/02 | MUSS | Konsole (1000) / Netzwerk (500) je Tab, aktuelle Domain | E `tools` |
| AUX-03 | SOLL | POST-Daten bis 64 KB (aus), Header nie | E `misc` |
| AUX-04/05 | MUSS | `beforeunload` automatisch, `alert/confirm/prompt` melden und beantworten | E `tools` |
| AUX-06 | MUSS | `Emulation.setFocusEmulationEnabled`, Frame erzwingen, Ton stumm | E `misc` |
| AUX-07 | SOLL | `target=_blank`-Abfangen bei minimiertem Fenster | M |
| AUX-08/09 | MUSS/SOLL | `file_upload` per `DOM.setFileInputFiles`, Pfadprüfung in der Bridge | E `tools`, U |
| AUX-10 | SOLL | `upload_image` (File/DataTransfer, Drop) | E `tools` |
| AUX-11 | KANN | `gif_creator` (Worker im Offscreen-Dokument) | U `gif` (gegen PIL), E |

## 14 Nicht-funktionale Anforderungen

| ID | Ergebnis | Nachweis |
|---|---|---|
| NFA-01 | ≈ 8 ms Median (Ziel < 50) | E `robust` |
| NFA-02 | ≈ 130 ms Median bei 1920×1080 (Ziel < 400) | E `robust` |
| NFA-03 | ≈ 50 ms auf 5000 Knoten (Ziel < 300) | E `robust` |
| NFA-04/05/06 | Neustart, Backoff 1…30 s, nie hängende Aufträge | E AK-08, `panel` |
| NFA-07/08/09 | keine Telemetrie, nur lokale Speicher, Datenschutzhinweis | U `manifest`, E `panel`, `security` |
| NFA-10/11 | Chrome ≥ 116 / pi ≥ 1.0; Edge/Brave nicht getestet | E (Chromium 141), M |
| NFA-12 | Deutsch/Englisch über `chrome.i18n` | U `i18n`, E `misc` |
| NFA-13 | Tastaturbedienung, beschriftete Elemente, AA-Kontrast (Tokens) | E `panel` |
| NFA-14 | Debug-Log aus; Bridge-Log in Datei | E `misc` |
| NFA-15 | gemeinsames Paket `packages/shared` | – |
| NFA-16 | MIT, keine Fremdbestandteile, Lizenzliste | LICENSE, `THIRD_PARTY_NOTICES.md` |

## 15 Abnahmeszenarien

| ID | Nachweis |
|---|---|
| AK-01 | E `smoke` (Gruppe „Agent“, orange, „verbunden“) |
| AK-02 | M (Tastenkürzel) |
| AK-03 | M / TEST-04 (echtes Modell, Wikipedia) |
| AK-04 | E `tools` (React-Formular per `browser_batch`), R |
| AK-05 | E `security` |
| AK-06 | E `tools` |
| AK-07 | E `robust` (Klick auf den Stopp-Button) |
| AK-08 | E `robust` |
| AK-09 | E `robust` |
| AK-10 | E `robust` (Retina, ≤ 2 CSS-Pixel) |
| AK-11 | E `panel`, R |
| AK-12 | E `security` (Domain-Übergang ohne Freigabe nicht möglich), `tools` (Inhalt als Daten gerahmt) |
| TEST-01…03 | Fixture-Site, Unit-Tests inkl. Baum-Snapshots, Playwright mit Mock-Bridge |
| TEST-04 | `tests/e2e/acceptance.real.e2e.ts` + Workflow (nur mit API-Zugang ausführbar) |
