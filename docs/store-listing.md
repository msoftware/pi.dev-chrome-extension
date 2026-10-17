# Chrome Web Store – Texte zum Einfügen

Alles in diesem Dokument ist zum Kopieren in das Chrome-Web-Store-Dashboard gedacht (siehe `publish.md`, Abschnitt „Chrome Web Store“). Die Store-Listing-Texte sind auf Englisch (Hauptsprache), eine deutsche Variante steht darunter.

## Grunddaten

| Feld | Wert |
|---|---|
| Name | Browser Agent for pi |
| Kategorie | Developer Tools (Alternative: Productivity) |
| Sprache | English (zusätzlich Deutsch) |
| Kurzbeschreibung (max. 132 Zeichen) | `Lets your local pi coding agent see and operate Chrome – with per-site approvals, a Stop button and no cloud service of ours.` |
| Symbol | `extension/public/icons/icon-128.png` |
| Screenshots (1280×800) | `docs/images/store-1-working.png`, `store-2-approval.png`, `store-3-settings.png` |
| Kleine Werbekachel (440×280) | `docs/images/store-promo-small.png` |
| Datenschutzerklärung (URL) | `https://github.com/msoftware/pi.dev-chrome-extension/blob/main/docs/PRIVACY.md` |
| Homepage / Support | `https://github.com/msoftware/pi.dev-chrome-extension` / `…/issues` |

## Ausführliche Beschreibung (English)

```
Browser Agent is the "arm" of your local pi coding agent: it lets pi see and operate Chrome while the "brain" – planning, model calls, decisions – stays in pi on your own computer. There is no account, no cloud service of ours and no telemetry.

HOW IT WORKS
1. Install the free pi-browser-bridge in pi:  pi install npm:pi-browser-bridge
2. Run /browser pair in pi, click the extension icon, enter the 6-digit code.
3. Describe a task in the side panel or in the pi terminal. The agent looks at the page, clicks, types, scrolls, fills forms, reads text and works across tabs.

YOU STAY IN CONTROL
• The agent works only in its own orange tab group "Agent" – other tabs are never touched.
• It asks before it acts on a new website (once or always), always asks before typing into password or payment fields, and can follow an approved plan or run automatically with a second safety check.
• A glowing frame and a phantom cursor show when and where it works. The Stop button on the page stops it within a second.
• Block websites, mark banking/health/government sites as "always ask", review the activity log (30 days) and delete all data at any time.
• Enterprise policies (Chrome managed storage) can lock ports, domains, mode and the JavaScript tool.

FEATURES
• Streaming chat with Markdown, code highlighting, diagrams and formulas
• Screenshots and page structure with stable element references
• Batch actions in one call, form filling that works with React and other frameworks
• Console and network inspection, file uploads, GIF recordings of what the agent did
• Saved prompts ("shortcuts") with parameters and schedules
• English and German interface

PRIVACY
The extension talks only to a program on your own computer (127.0.0.1). The developer receives no data. What the agent sees leaves your computer only if you configured pi with a cloud model provider; with a local model nothing leaves it.

REQUIREMENTS
pi (https://pi.dev) with the pi-browser-bridge package, Chrome 116 or newer. Open source (MIT): https://github.com/msoftware/pi.dev-chrome-extension
```

## Beschreibung (Deutsch)

```
Browser-Agent ist der „Arm“ Ihres lokalen pi-Coding-Agenten: Er lässt pi Chrome sehen und bedienen, während das „Gehirn“ – Planung, Modellaufrufe, Entscheidungen – in pi auf Ihrem eigenen Rechner bleibt. Es gibt kein Konto, keinen Cloud-Dienst von uns und keine Telemetrie.

SO FUNKTIONIERT ES
1. Die kostenlose pi-browser-bridge in pi installieren:  pi install npm:pi-browser-bridge
2. In pi /browser pair eingeben, Erweiterungs-Icon klicken, 6-stelligen Code eingeben.
3. Aufgabe im Seitenpanel oder im pi-Terminal beschreiben. Der Agent betrachtet die Seite, klickt, tippt, scrollt, füllt Formulare aus, liest Texte und arbeitet über mehrere Tabs.

SIE BEHALTEN DIE KONTROLLE
• Der Agent arbeitet nur in seiner eigenen orangen Tab-Gruppe „Agent“ – andere Tabs bleiben unberührt.
• Er fragt, bevor er auf einer neuen Webseite handelt (einmal oder immer), fragt bei Passwort- und Zahlungsfeldern immer, und kann einem freigegebenen Plan folgen oder automatisch mit zweiter Sicherheitsprüfung arbeiten.
• Leuchtrahmen und Phantom-Cursor zeigen, wann und wo er arbeitet. Der Stopp-Button auf der Seite stoppt ihn binnen einer Sekunde.
• Webseiten sperren, Banking-/Gesundheits-/Behördenseiten auf „immer fragen“ setzen, Aktivitätsprotokoll (30 Tage) einsehen, alle Daten jederzeit löschen.
• Unternehmensrichtlinien (Chrome Managed Storage) können Port, Domains, Modus und das JavaScript-Werkzeug festlegen.

DATENSCHUTZ
Die Erweiterung spricht nur mit einem Programm auf Ihrem eigenen Rechner (127.0.0.1). Der Entwickler erhält keine Daten. Was der Agent sieht, verlässt Ihren Rechner nur, wenn Sie in pi einen Cloud-Modellanbieter eingerichtet haben.

VORAUSSETZUNGEN
pi (https://pi.dev) mit dem Paket pi-browser-bridge, Chrome 116 oder neuer. Open Source (MIT): https://github.com/msoftware/pi.dev-chrome-extension
```

## Tab „Privacy practices“

**Single purpose** (Einzelner Zweck):

```
Lets a coding agent that the user runs on their own computer (pi) see and operate the user's browser tabs on the user's behalf, with per-site user approvals.
```

**Begründung je Berechtigung** (jeweils in das passende Feld kopieren):

| Berechtigung | Begründung |
|---|---|
| `debugger` | Core function. The agent's mouse clicks, key presses, scrolling and screenshots are sent through the Chrome DevTools Protocol as trusted input events; there is no other API that can operate arbitrary pages like a user. It is attached only to tabs in the agent's own tab group, only while a task runs, and released afterwards. Chrome shows its standard "is debugging this browser" bar. |
| Host permission `<all_urls>` | The user decides which websites the agent works on, so any site may be needed. Used to read page structure, take screenshots, inject the helper scripts and show the on-page Stop button. Every new site requires the user's approval before the agent acts (configurable). |
| `tabs`, `tabGroups`, `activeTab` | The agent works inside its own tab group ("Agent"); the extension creates and manages that group and reads title and URL of the tabs in it, so it can restrict the agent to them and show the user what it is doing. |
| `scripting` | Injects the content script that builds the accessibility-style page outline into pages opened before installation, and runs small helper functions (form filling, element positions). |
| `webNavigation` | Detects when a page has finished loading or is navigating (e.g. after the agent opens a URL), and redirects blocked sites to a notice page. |
| `sidePanel` | The chat, approval dialogs and settings entry point are shown in Chrome's side panel. |
| `storage`, `unlimitedStorage` | Stores the pairing token, approvals, settings, saved prompts, the 30-day activity log and screenshots of the user's sessions (up to 25 MB per session) locally. |
| `alarms` | Keeps the connection to the local program alive (service worker wake-up every 30 s) and runs the user's scheduled saved prompts. |
| `notifications` | Tells the user when a task is finished or an approval is waiting while the panel is not in the foreground. |
| `offscreen` | Plays the notification sound and encodes GIF recordings in a web worker (service workers cannot do either). |
| `downloads` | Saves GIF recordings of the agent's work when the user exports them. |

**Remote code:** *No, I am not using remote code.* (All code is packaged; the content security policy allows only `'self'` scripts.)

**Data usage – what the extension handles:** tick **Website content** (page text, structure and screenshots are processed to let the agent work) and **Web history** only if the dashboard counts tab URLs shown to the agent; explain: *"Processed locally and sent only to a program the user runs on their own computer (127.0.0.1). Not transmitted to the developer or any third party by the extension."*

**Certifications (all three):** data is not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending.

## Feld „Test instructions“ für die Prüfer

```
The extension is the browser side of an open-source local agent, so it needs a local program. No account or credentials are required. To see it work without any AI provider:

1. git clone https://github.com/msoftware/pi.dev-chrome-extension && cd pi.dev-chrome-extension && npm install
2. Start the demo page:  python3 -m http.server 8000 --directory tests/e2e/fixtures
3. Start pi with a scripted demo model (no API key, no network):
   FAKE_LLM_SCENARIO=browse npx pi --provider fakellm --model script -e ./packages/bridge/src/index.ts -e ./tests/e2e/fixtures/fake-llm.ts
4. In pi type /browser pair. Open http://localhost:8000/index.html in Chrome, click the extension icon, enter the 6-digit code in the side panel, type any message and press Enter.
Expected: an orange frame appears, the agent reads the page and clicks the "Increment" button (counter becomes 1), the panel lists the tool calls. The permission mode "Automatic" in the panel skips the approval questions.
Detailed steps: test.md in the repository.
```
