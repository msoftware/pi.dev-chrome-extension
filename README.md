# Browser Agent für Chrome mit lokalem pi-Agent

Eine Chrome-Erweiterung („der Arm“), die einen lokal laufenden [pi](https://pi.dev)-Coding-Agenten („das Gehirn“) den Browser sehen und bedienen lässt – im Verhalten und Bedienerlebnis wie „Claude in Chrome“, aber ohne Anthropic-Backend: Modellaufrufe, Planung und Entscheidung liegen vollständig in pi. Umgesetzt nach dem *Anforderungsdokument: Browser-Agent-Erweiterung für Chrome mit lokalem pi-Agent* (16. Okt. 2026).

> **Clean-Room.** Nachgebaut wurde beobachtbares Verhalten, nicht Code. Quelltext, Systemprompts, Werkzeugbeschreibungen, Icons und Texte sind eigene Arbeit (MIT, siehe [LICENSE](LICENSE) und [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Es gibt keine Telemetrie und keine Verbindung außer zur lokalen Bridge.

```
 Chrome-Erweiterung                          pi-Prozess (lokal)
┌────────────────────────┐                  ┌──────────────────────────────┐
│ Seitenpanel (React)    │                  │ pi-browser-bridge (Extension) │
│  Chat, Freigaben       │                  │  HTTP-Server 127.0.0.1:47823  │
│        ▲ chrome.runtime│   HTTP + SSE     │  20 Browser-Werkzeuge         │
│ Service Worker  ◄──────┼──────────────────┼─►  find per Hilfsmodell       │
│  Tab-Gruppen, CDP,     │                  │        ▲                      │
│  Berechtigungen        │                  │ pi-Agent (Agenten-Schleife)   │
│        ▼ CDP/Scripting │                  └──────────────┬───────────────┘
│ Webseite: A11y-Baum,   │                                 ▼ Modellaufrufe
│  Rahmen, Stopp-Button  │                          Anbieter / lokales Modell
└────────────────────────┘
```

## Inhalt des Repositories

| Pfad | Zweck |
|---|---|
| `extension/` | Die Chrome-Erweiterung (Manifest V3, TypeScript, Vite + CRXJS, React) |
| `packages/bridge/` | **pi-browser-bridge**: pi-Extension mit HTTP/SSE-Server, 20 Werkzeugen, `/browser`-Befehl |
| `packages/host/` | **pi-browser-host**: Headless-Host (pi per SDK, „Panel-geführt“, API-02) |
| `packages/shared/` | Gemeinsames TypeScript-Paket: Werkzeugdefinitionen, Protokoll, Skalierung, Tastentabelle, Ausgabefilter, Berechtigungslogik (NFA-15) |
| `tests/` | Unit-Tests (Vitest) und End-to-End-Tests (Playwright, auch gegen ein **echtes pi**) |
| `scripts/` | Build-, Release- und Hilfsskripte (`build-npm-packages`, `pack-extension`, `release-check`, `set-version`) |
| `docs/` | [Datenschutzerklärung](docs/PRIVACY.md), [Store-Texte](docs/store-listing.md), [Anforderungs-Abdeckung](docs/REQUIREMENTS-COVERAGE.md), [Offene Punkte & Entscheidungen](docs/DECISIONS.md) |

## Installation für Endnutzer

```bash
pi install npm:pi-browser-bridge          # pi-Seite (Paket auf https://pi.dev/packages)
```
Chrome-Erweiterung: aus dem Chrome Web Store (Link folgt nach Veröffentlichung) oder den Zip `browser-agent-<version>-unpacked.zip` aus den [GitHub Releases](https://github.com/msoftware/pi.dev-chrome-extension/releases) entpacken und unter `chrome://extensions` → „Entpackte Erweiterung laden“. Danach in pi `/browser pair`.
Wer die Veröffentlichung selbst durchführt, findet alles in [publish.md](publish.md).

## Schnellstart

Voraussetzungen: Node ≥ 20, Chrome ≥ 116 (Windows, macOS, Linux), pi ≥ 1.0 (`@earendil-works/pi-coding-agent`).

```bash
npm install
npm run build            # baut extension/dist
npm run bundle:bridge    # optional: packages/bridge/dist/index.js (eigenständig, ohne Monorepo nutzbar)
```

1. **Erweiterung laden:** `chrome://extensions` → Entwicklermodus → „Entpackte Erweiterung laden“ → `extension/dist`.
   Die Erweiterungs-ID ist durch den festen `key` im Manifest immer `omfoefeoobddgdfoichknkcidfoippih` (EXT-04); die Bridge prüft genau diese ID.
2. **Terminal-geführt (API-01, empfohlen):** pi mit geladener Bridge starten

   ```bash
   pi -e ./packages/bridge/src/index.ts          # oder: pi -e ./packages/bridge/dist/index.js
   # dauerhaft:  pi install ./packages/bridge
   ```
   Prompts können aus dem Terminal **oder** aus dem Seitenpanel kommen; beide sehen denselben Verlauf.
3. **Panel-geführt (API-02):** pi läuft unsichtbar, das Seitenpanel ist die einzige Oberfläche

   ```bash
   node packages/host/bin/pi-browser-host.mjs --cwd ~/projekt          # gibt beim Start den Kopplungscode aus
   ```
4. **Koppeln (API-06):** In pi `/browser pair` eingeben (der Host druckt den Code selbst), auf einem Tab das Erweiterungs-Icon anklicken, im Seitenpanel den 6-stelligen Code eingeben. Die Bridge tauscht ihn gegen ein zufälliges 256-Bit-Token, das nur in `chrome.storage.local` liegt.
5. **Arbeiten:** Icon klicken (oder `Ctrl+E` / `Cmd+E`) → Panel öffnet für diesen Tab, der Tab kommt in die orange Gruppe „Agent“ → Auftrag eingeben. Während der Agent arbeitet: Leuchtrahmen, Phantom-Cursor, **Stopp-Button** unten mittig.

### Befehle in pi

| Befehl | Wirkung |
|---|---|
| `/browser` | Status: Port, Verbindung, gekoppelte Browser, Pairing-Code |
| `/browser pair` | Neuer 6-stelliger Code (5 Minuten gültig) |
| `/browser revoke [id]` | Token widerrufen (alle oder ein Gerät) |
| `/browser tools on\|off` | Browser-Werkzeuge aktivieren/deaktivieren, ohne die Verbindung zu trennen (API-18) |
| `/browser new` | Neue Sitzung (im Panel: „＋“) |

Konfiguration der Bridge: Flag `--browser-port`, Datei `~/.pi/agent/browser-bridge.json` (`port`, `helperModel`, `disabledTools`, `uploadRoots`, `extensionId`, `debug`). Log: `~/.pi/agent/logs/browser-bridge.log` (nur mit `debug`, NFA-14).

## Bedienung im Überblick

* **Tab-Gruppen:** Die Gruppe ist der Arbeitsbereich des Agenten. Werkzeuge akzeptieren nur `tabId`s aus der Gruppe der Sitzung; Tabs außerhalb bleiben unberührt (UI-07). Nutzer können Tabs in die Gruppe ziehen.
* **Berechtigungen (Abschnitt 11):** Modi *Fragen* (Standard: je Berechtigungstyp und Domain), *Plan befolgen* (`update_plan`) und *Automatisch* (jede Aktion wird von einem zweiten Modellaufruf gegen die Aufgabe geprüft). Freigaben „einmal“ (an den Werkzeugaufruf gebunden) oder „immer“ pro registrierbarer Domain. Domainlisten: gesperrt, immer fragen (mitgelieferte Startliste: Banking, Zahlungen, Behörden, Gesundheit, Passwortmanager), erlaubt. Passwort-/Kartenfelder verlangen **immer** eine Einmal-Freigabe (SEC-10).
* **Sicherheitsprüfung (SEC-08):** Vor jeder verändernden Aktion und jedem Screenshot wird der Tab erneut geprüft. Ist er seit der Freigabe auf eine andere Domain gewechselt (auch per Weiterleitung während eines Klicks), geschieht nichts.
* **Prompt-Injection (SEC-11/12):** Seiteninhalte stehen in `<page_content source="…">`; der Prompt-Abschnitt der Bridge sagt dem Modell, dass sie Daten sind, und verlangt Rückfrage bei Käufen, Zahlungen, Nachrichten, Löschen und Bedingungen.
* **Protokoll (SEC-14):** Jeder Werkzeugaufruf wird lokal protokolliert (30 Tage), Ansicht und Export (JSON/CSV) in den Einstellungen.
* **Datenschutz (NFA-07/08/09):** Nichts verlässt den Rechner außer an die lokale Bridge; Modellaufrufe macht ausschließlich pi mit dem dort konfigurierten Anbieter. „Alle Daten löschen“ in den Einstellungen.

### `javascript_tool` – Ausgabefilter sind nur Heuristik (JS-08)

Das Werkzeug führt beliebigen Code im Seitenkontext aus und ist deshalb abschaltbar (Einstellungen, Unternehmensrichtlinie `javascriptToolEnabled`, Bridge-Konfiguration `disabledTools`). Ist es abgeschaltet, bietet die Bridge es pi gar nicht erst an; ruft das Modell es trotzdem auf (auch in `browser_batch`), erhält es einen Fehler mit Verweis auf `read_page`, `get_page_text`, `find`, `form_input`, `computer`. Der Ausgabefilter (sensible Schlüssel, Cookies, JWT, Base64, Hex, Tiefe 5, 1000 Zeichen/String, 100 Array-Einträge, 51 200 Zeichen gesamt) und das Schwärzen der aktuellen Werte sensibler Felder (JS-07) **ersetzen die Berechtigungsprüfung nicht**.

### Unternehmensrichtlinien (EXT-05)

`storage.managed_schema` erlaubt per Chrome-Richtlinie: `bridgePort`, `blockedDomains`, `allowedDomains`, `alwaysAskDomains`, `permissionMode`, `javascriptToolEnabled`. Richtlinien gehen Nutzereinstellungen vor; die Einstellungsseite zeigt gesperrte Felder an.

## Entwicklung und Tests

```bash
npm run typecheck        # tsc für alle Pakete
npm test                 # Vitest: knapp 100 Unit-Tests (Skalierung, Tastentabelle, Filter, Baum-Snapshots, Berechtigungen, Bridge-Server, GIF, i18n, Manifest, …)
npm run build && npm run test:e2e   # Playwright: lädt Chrome mit der Erweiterung
npm run test:all         # alles
```

End-to-End (TEST-03) läuft deterministisch ohne echtes Modell: eine **Mock-Bridge** (`FakePi`, derselbe `BridgeServer`-Code wie in pi) schickt festgelegte Werkzeugaufträge. Zusätzlich gibt es Tests gegen einen **echten pi-Prozess** (RPC-Modus bzw. SDK-Host) mit einem skriptgesteuerten „Modell“ (`tests/e2e/fixtures/fake-llm.ts`), die die komplette Kette prüfen: pi → Bridge → Service Worker → Seite und zurück. Die lokale Fixture-Website (TEST-01) enthält native und React-Formulare, iframes, Shadow-DOM, Listen mit > 10 000 Elementen, Dialoge, Datei-Inputs, `target="_blank"`-Links und Prompt-Injection-Texte.

* Chrome wird über `CHROME_PATH` oder `/opt/pw-browsers/chromium` gefunden, sonst nutzt Playwright sein Chromium (läuft mit `--headless=new`).
* **TEST-04** (wöchentlich, echte Sitzung): `PI_ACCEPTANCE=1 npm run test:acceptance` (Anbieter über `PI_PROVIDER`/`PI_MODEL` und die üblichen API-Key-Variablen); Erfolgsquote und Dauer landen in `acceptance-results/`. Siehe `.github/workflows/weekly-acceptance.yml`.
* Gemessen (lokale Referenzmaschine): Bridge→Erweiterung→Bridge ≈ 8 ms Median (Ziel < 50 ms, NFA-01), Screenshot 1920×1080 ≈ 130 ms (Ziel < 400 ms, NFA-02), `read_page interactive` auf 5000 Knoten ≈ 50 ms (Ziel < 300 ms, NFA-03).

Die vollständige Zuordnung Anforderung → Umsetzung → Test steht in [docs/REQUIREMENTS-COVERAGE.md](docs/REQUIREMENTS-COVERAGE.md); die Antworten auf die „Offenen Punkte“ (Abschnitt 16) in [docs/DECISIONS.md](docs/DECISIONS.md).

## Bekannte Grenzen

* Elemente in **Cross-Origin-iframes** werden im Baum gelistet und lassen sich per Ref-ID ansprechen, ihre Koordinaten werden aber nur für Same-Origin-Frames in Viewport-Koordinaten umgerechnet.
* `file_upload` setzt Dateien über `DOM.setFileInputFiles`; `<input type="file">` innerhalb von Shadow-Roots wird nicht gefunden.
* Das Tastenkürzel `Ctrl+E` belegt Chrome standardmäßig für die Adressleistensuche; Erweiterungs-Kürzel haben Vorrang, sind aber unter `chrome://extensions/shortcuts` änderbar (siehe DECISIONS).
* `debugger` ist eine Berechtigung, die der Chrome Web Store streng prüft; empfohlen ist Verteilung als nicht gelistete Erweiterung oder per Unternehmensrichtlinie.
* Manuell zu prüfen (nicht automatisierbar in Headless-Chrome): Tastenkürzel-Umschalter (AK-02), minimiertes Fenster (AUX-07), Edge/Brave (NFA-11), Wikipedia-Szenario mit echtem Modell (AK-03).

---

## Installation ohne Chrome Web Store (Schritt für Schritt)

Dieser Abschnitt erklärt, wie du **die Chrome-Erweiterung ohne den Store** installierst und die beiden npm-Pakete [`pi-browser-bridge`](https://www.npmjs.com/package/pi-browser-bridge) und [`pi-browser-host`](https://www.npmjs.com/package/pi-browser-host) in [pi](https://pi.dev) benutzt. Die Befehle laufen in PowerShell (Windows), Terminal (macOS) und Bash (Linux) gleich, Abweichungen sind vermerkt.

Du brauchst zwei Teile, die zusammenarbeiten:

| Teil | Wo es läuft | Was es tut |
|---|---|---|
| **Chrome-Erweiterung** „Browser Agent“ | in Chrome | der „Arm“: sieht und bedient den Browser, zeigt Chat und Freigaben |
| **`pi-browser-bridge`** (oder **`pi-browser-host`**) | in/neben pi, auf deinem Rechner | das „Gehirn“-Ende: stellt pi die 20 Browser-Werkzeuge bereit |

Voraussetzungen: **Google Chrome ab Version 116** (oder Chromium/Edge/Brave, die Erweiterungen aus Ordnern laden), **Node.js ab Version 20** und **pi** mit eingerichtetem Modellanbieter.

### 1. Chrome-Erweiterung ohne Store installieren

1. Lade das Zip **`browser-agent-<version>-unpacked.zip`** von der Seite [Releases](https://github.com/msoftware/pi.dev-chrome-extension/releases) herunter. (Nicht das `-store.zip`; das ist für den Chrome Web Store.)
2. **Entpacke** das Zip in einen Ordner, der **dauerhaft bleibt**, z. B. `C:\Tools\browser-agent` oder `~/browser-agent`. Chrome liest die Dateien aus diesem Ordner bei jedem Start; wird er gelöscht oder verschoben, verschwindet die Erweiterung. Im Ordner muss direkt die Datei `manifest.json` liegen (nicht noch ein Unterordner).
3. Öffne in Chrome die Adresse **`chrome://extensions`**.
4. Schalte oben rechts den **Entwicklermodus** ein.
5. Klicke auf **„Entpackte Erweiterung laden“** und wähle den entpackten Ordner.
6. Die Erweiterung „Browser Agent“ erscheint in der Liste. Ihre **ID ist `omfoefeoobddgdfoichknkcidfoippih`** – sie bleibt bei jeder Installation aus diesem Zip gleich, daher akzeptiert die Bridge sie ohne weitere Einstellung.
7. Hefte sie an die Symbolleiste: Puzzle-Symbol → Stecknadel neben „Browser Agent“.

Chrome zeigt bei Erweiterungen im Entwicklermodus eventuell die Meldung „Erweiterungen im Entwicklermodus deaktivieren“ beim Start; sie lässt sich wegklicken, die Erweiterung bleibt aktiv.

**Aktualisieren:** neues Zip herunterladen, **in denselben Ordner** entpacken (Dateien ersetzen), dann auf `chrome://extensions` beim „Browser Agent“ das Symbol **⟳ (Neu laden)** klicken.

**Alternative: aus dem Quellcode bauen** (wenn du kein Release-Zip hast):

```bash
git clone https://github.com/msoftware/pi.dev-chrome-extension
cd pi.dev-chrome-extension
npm install
npm run build          # erzeugt extension/dist
```
Dann bei Schritt 5 den Ordner `extension/dist` auswählen.

### 2. `pi-browser-bridge` installieren und in pi nutzen (empfohlen)

Die Bridge ist ein **pi-Paket**. Installation (einmalig):

```bash
pi install npm:pi-browser-bridge
pi list                      # zeigt die installierten Pakete; pi-browser-bridge muss erscheinen
```

*Nur ausprobieren, ohne zu installieren:* `pi -e npm:pi-browser-bridge`.

**Benutzen:**

1. Starte pi wie gewohnt: `pi`. Beim Start lädt pi die Bridge; unten erscheint der Status `browser :47823 (not paired)`.
2. Tippe in pi **`/browser pair`**. pi zeigt einen **6-stelligen Code** (5 Minuten gültig).
3. Öffne in Chrome die Seite, auf der der Agent arbeiten soll, und klicke auf das **Browser-Agent-Symbol**. Das Seitenpanel öffnet sich, der Tab kommt in die orange Gruppe „Agent“.
4. Gib den Code im Panel ein → Status **„Verbunden“**. Die Kopplung bleibt bestehen; sie ist nur beim ersten Mal nötig.
5. Gib einen Auftrag **im Panel oder im pi-Terminal** ein, z. B. „Suche auf Wikipedia nach Chrome DevTools Protocol“. Beide sehen denselben Verlauf.
6. Beim ersten Zugriff auf eine neue Webseite fragt die Erweiterung um Erlaubnis. Mit dem **Stopp-Button** unten auf der Seite (oder durch Schließen des Panels) brichst du jederzeit ab.

Nützliche pi-Befehle:

| Befehl | Wirkung |
|---|---|
| `/browser` | Status: Port, Verbindung, gekoppelte Browser |
| `/browser pair` | neuer Kopplungscode |
| `/browser revoke` | Kopplung widerrufen |
| `/browser tools off` / `on` | Browser-Werkzeuge aus- bzw. einschalten |

Einstellungen (optional): Port ändern mit `pi --browser-port 47824` (dann in den Einstellungen der Erweiterung denselben Port eintragen) oder dauerhaft in `~/.pi/agent/browser-bridge.json` (unter Windows `%USERPROFILE%\.pi\agent\browser-bridge.json`):

```json
{ "port": 47823, "helperModel": "anbieter/modell-id", "disabledTools": ["javascript_tool"] }
```

**Aktualisieren:** `pi update --extensions` (oder `pi install npm:pi-browser-bridge` erneut).

### 3. `pi-browser-host` installieren und nutzen (ohne pi-Terminal)

Der Host startet pi **unsichtbar im Hintergrund**; das Chrome-Seitenpanel ist dann die einzige Oberfläche. Praktisch, wenn du nie im Terminal arbeiten willst. Die Bridge ist im Host bereits enthalten – du brauchst `pi-browser-bridge` dafür **nicht** zusätzlich.

```bash
npm install -g pi-browser-host @earendil-works/pi-coding-agent
```
(`@earendil-works/pi-coding-agent` ist pi selbst; ist es schon global installiert, genügt `npm install -g pi-browser-host`.)

Starten:

```bash
pi-browser-host --cwd ~/mein-projekt
```
Der Host druckt beim Start einen **Kopplungscode** (`Pairing code: 123456`) und läuft, bis du ihn mit **Strg+C** beendest. Dann wie oben: Browser-Agent-Symbol klicken, Code im Panel eingeben, Auftrag erteilen. Eine neue Unterhaltung startest du im Panel mit **＋**.

Optionen:

| Option | Bedeutung |
|---|---|
| `--cwd <ordner>` | Arbeitsverzeichnis für pi (Standard: aktueller Ordner) |
| `--browser-port <port>` | Port (Standard 47823) |
| `--provider <anbieter> --model <modell>` | Modell festlegen (sonst pi-Standard aus `~/.pi/agent`) |
| `-e <datei.ts>` | zusätzliche pi-Extensions laden (mehrfach möglich) |
| `--no-session` | Unterhaltung nicht auf der Festplatte speichern |

Anbieter, API-Schlüssel und Einstellungen kommen aus deiner normalen pi-Konfiguration; melde dich vorher einmal mit `pi` an bzw. richte den Anbieter dort ein.

Ohne globale Installation: `npx pi-browser-host --cwd .` (benötigt, dass `@earendil-works/pi-coding-agent` im Projekt oder global installiert ist).

> Nutze **entweder** die Bridge in deinem normalen pi **oder** den Host. Beide gleichzeitig würden denselben Port belegen; für zwei Instanzen gib dem zweiten `--browser-port 47824` und trage den Port in der Erweiterung ein.

### 4. Typische Probleme

| Symptom | Ursache und Lösung |
|---|---|
| Panel zeigt **„Getrennt“** | pi bzw. der Host läuft nicht, oder der Port stimmt nicht. In pi `/browser` prüfen; Port in den Einstellungen der Erweiterung (⚙ im Panel) vergleichen. |
| **„Kopplung nötig“** bleibt stehen | Code abgelaufen oder falsch (5 Minuten, 5 Versuche). In pi `/browser pair` erneut ausführen. |
| Panel zeigt „Getrennt“, obwohl pi läuft, und die Erweiterung stammt **nicht** aus dem Zip (z. B. andere ID) | Die Bridge kennt die ID nicht. Ihre ID von `chrome://extensions` kopieren und in `~/.pi/agent/browser-bridge.json` eintragen: `{ "extensionIds": ["<die-ID>"] }`. |
| `pi: command not found` / `gh`, `npm` unbekannt | Programm nicht installiert oder Terminal nach der Installation nicht neu gestartet. Node: <https://nodejs.org>; pi: <https://pi.dev>. |
| Windows: `npm install -g` meldet „Execution Policy“ | PowerShell einmalig mit `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` freigeben oder `cmd` benutzen. |
| Erweiterung ist nach Chrome-Neustart weg | Der entpackte Ordner wurde gelöscht/verschoben. Zip erneut entpacken und die Erweiterung neu laden (Schritt 1). |
| Es soll nichts den Rechner verlassen | Ein **lokales Modell** in pi einrichten (z. B. llama.cpp/Ollama); die Erweiterung selbst sendet nie Daten an Dritte (siehe [Datenschutzerklärung](docs/PRIVACY.md)). |

Mehr zum Testen: [test.md](test.md) · zum Veröffentlichen: [publish.md](publish.md).
