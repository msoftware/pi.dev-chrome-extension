# Veröffentlichen – Schritt für Schritt

Diese Anleitung beschreibt alles, was nötig ist, um **Browser Agent** zu veröffentlichen:

| Artefakt | Wohin | Ergebnis |
|---|---|---|
| `pi-browser-bridge` | npm → automatisch in der Galerie [pi.dev/packages](https://pi.dev/packages) | `pi install npm:pi-browser-bridge` |
| `pi-browser-host` (optional) | npm | `npm i -g pi-browser-host` |
| Chrome-Erweiterung | Chrome Web Store (+ Zip im GitHub Release) | Installation per Klick |

Was im Repository bereits vorbereitet ist (musst du nicht mehr bauen):

* `scripts/build-npm-packages.mjs` erzeugt aus den Monorepo-Paketen **eigenständige** npm-Pakete in `release/npm/` (gebündelt, ohne Workspace-Abhängigkeiten, pi-Pakete als `peerDependencies`, Keyword `pi-package`, Vorschaubild `pi.image`).
* `scripts/pack-extension.mjs` erzeugt zwei Zips: **`…-store.zip`** (Manifest *ohne* `key`, für den Store) und **`…-unpacked.zip`** (mit festem `key`, für Sideloading/GitHub).
* `scripts/set-version.mjs` setzt eine Version in allen Paketen, `scripts/release-check.mjs` prüft das Ergebnis.
* `.github/workflows/release.yml` macht dasselbe automatisch, sobald du einen Tag `vX.Y.Z` pushst.
* Texte und Bilder für den Store: `docs/store-listing.md`, `docs/PRIVACY.md`, `docs/images/`.

Reihenfolge, die sich bewährt: **(1) Konten → (2) Release vorbereiten → (3) npm → (4) GitHub Release → (5) Chrome Web Store → (6) Store-ID nachtragen → (7) Prüfen.**

---

## 1. Konten und einmalige Voraussetzungen

### npm
1. Konto auf <https://www.npmjs.com/signup>, E-Mail bestätigen.
2. **Zwei-Faktor-Authentifizierung** aktivieren (Account → Two-Factor Authentication, „Authorization and publishing“). Ohne 2FA lässt npm das Veröffentlichen neuer Pakete nicht zu.
3. Lokal anmelden: `npm login` (öffnet den Browser). Prüfen: `npm whoami`.
4. **Paketnamen prüfen** (am 17.10.2026 waren beide frei):
   ```bash
   npm view pi-browser-bridge version     # E404 = frei
   npm view pi-browser-host version
   ```
   Möchtest du Namensräume: `@msoftware/pi-browser-bridge` – dann in `scripts/build-npm-packages.mjs` den Namen ändern und überall `pi install npm:@msoftware/pi-browser-bridge` verwenden (README der Pakete, `docs/store-listing.md`, `README.md`).

### GitHub
* Repository `msoftware/pi.dev-chrome-extension` (vorhanden). Für den automatischen Weg: *Settings → Secrets and variables → Actions* (siehe Abschnitt 8).
* Optional die GitHub CLI (`gh`) für Releases von der Kommandozeile; ohne `gh` geht alles auch im Browser.

### Chrome Web Store
1. Mit einem Google-Konto auf <https://chrome.google.com/webstore/devconsole> anmelden. Für das Konto muss **2-Schritt-Verifizierung** aktiv sein.
2. **Entwicklerkonto registrieren:** einmalig **5 US-Dollar** Registrierungsgebühr, Entwickler-Name und E-Mail angeben, E-Mail verifizieren.
3. **Händler-Status (EU, Digital Services Act):** Das Dashboard fragt, ob du als *Trader* (gewerblich) oder *Non-trader* auftrittst. Bei „Trader“ werden Name, Adresse und Kontaktdaten öffentlich im Store gezeigt. Ehrlich beantworten; bei einem kostenlosen Hobby-/Open-Source-Projekt ist meist *Non-trader* zutreffend.
4. Die Kontakt-E-Mail ist öffentlich sichtbar – ggf. eine eigene Projektadresse verwenden.

---

## 2. Release vorbereiten

```bash
git checkout main && git pull
npm ci
npm run test:all                      # Typecheck, Build, Unit- und E2E-Tests (ca. 4 Minuten)
```

**Version festlegen** (SemVer; alle Pakete bekommen dieselbe Nummer, auch die Manifest-Version der Erweiterung):

```bash
npm run version:set 0.1.0             # bei einem Folge-Release z. B. 0.1.1 / 0.2.0
```
Dann in `CHANGELOG.md` einen Abschnitt `## [0.1.0] - <Datum>` mit den Änderungen schreiben (der Release-Check und die GitHub-Release-Notizen lesen ihn) und die Lockfile aktualisieren: `npm install`.

**Bilder aktualisieren** (nur wenn sich die Oberfläche geändert hat; erzeugt die Store-Screenshots und das Galerie-Bild neu):

```bash
npm run build
MAKE_ASSETS=1 npx playwright test assets
git add docs/images && git commit -m "Update store images"
```
`docs/images/gallery.png` wird im npm-Paket als `pi.image` verlinkt (`raw.githubusercontent.com/…/main/docs/images/gallery.png`) – die Datei muss also **auf `main` liegen**, bevor die Galerie sie anzeigen kann.

**Alles bauen und prüfen:**

```bash
npm run build           # Erweiterung -> extension/dist
npm run build:npm       # -> release/npm/pi-browser-bridge, release/npm/pi-browser-host
npm run pack:extension  # -> release/extension/browser-agent-<v>-store.zip und -unpacked.zip
npm run release:check   # Versionen, Changelog, Manifest, Zips, Tarball-Inhalt, sauberer Git-Stand
```
`release:check` muss mit „All checks passed.“ enden. Er prüft u. a., dass in den npm-Paketen keine Workspace-Abhängigkeiten stehen, dass im Store-Zip **kein `key`** im Manifest ist und dass die Tarballs nur `dist/`, README, LICENSE und `package.json` enthalten.

**Release committen:**
```bash
git add -A
git commit -m "Release 0.1.0"
git push origin main
```

---

## 3. npm veröffentlichen

### 3.1 Probelauf und Probeinstallation (empfohlen)

```bash
npm publish release/npm/pi-browser-bridge --dry-run     # zeigt, was veröffentlicht würde
npm pack release/npm/pi-browser-bridge --pack-destination /tmp/probe
```
Probeinstallation in einem leeren Ordner, wie ein Nutzer es täte:

```bash
mkdir /tmp/probe-install && cd /tmp/probe-install && npm init -y
npm i /tmp/probe/pi-browser-bridge-0.1.0.tgz @earendil-works/pi-coding-agent typebox
npx pi --mode rpc --no-session -e ./node_modules/pi-browser-bridge   # stdin schließen/Strg+D; pi darf nicht abstürzen
```
In pi (interaktiv `npx pi -e ./node_modules/pi-browser-bridge`) muss `/browser` existieren.

### 3.2 Wirklich veröffentlichen

Zuerst die Bridge, dann der Host:

```bash
npm publish release/npm/pi-browser-bridge       # fragt nach dem 2FA-Code (OTP)
npm publish release/npm/pi-browser-host
```
(`publishConfig.access = public` ist gesetzt, `--access public` ist nur bei `@scope`-Namen nötig und steht ohnehin im `package.json`.)

> **npm-Veröffentlichungen sind endgültig.** Eine Version lässt sich nie überschreiben; `npm unpublish` ist nur in den ersten 72 Stunden (und nur wenn niemand davon abhängt) möglich. Deshalb immer erst Abschnitt 3.1.

### 3.3 Prüfen, ob es installierbar ist

```bash
npm view pi-browser-bridge          # Version, Beschreibung, Keywords (muss „pi-package“ enthalten)
pi install npm:pi-browser-bridge    # in einer frischen Umgebung / einem anderen Rechner
pi list
```

### 3.4 Listung auf pi.dev/packages

Laut pi-Dokumentation (`docs/packages.md`) reicht das **Keyword `pi-package`** in der `package.json` des npm-Pakets, damit es für die [Paket-Galerie](https://pi.dev/packages) infrage kommt. Es gibt keinen Antrag und keine Anmeldung – das Paket muss nur auf npm öffentlich sein. Das Keyword und das Vorschaubild (`pi.image`) setzt `build-npm-packages.mjs` automatisch.

* Die Aufnahme geschieht über den npm-Index der Galerie und kann **etwas dauern**; wie lange genau, steht nicht in der Doku. Prüfe nach einigen Stunden: <https://pi.dev/packages> → nach „pi-browser-bridge“ suchen.
* Taucht es nach ein bis zwei Tagen nicht auf: Keyword in `npm view pi-browser-bridge keywords` kontrollieren, dann im pi-Projekt (Issues/Discord, siehe pi.dev) nachfragen.
* Ein Vorschauvideo geht zusätzlich über `pi.video` in `scripts/build-npm-packages.mjs` (URL zu einer öffentlichen Videodatei).
* Zum Aktualisieren der Galerie-Einträge einfach eine neue Version veröffentlichen.

---

## 4. GitHub Release (Zips für Sideloading)

Mit Tag und `gh`:
```bash
git tag v0.1.0 && git push origin v0.1.0        # löst auch release.yml aus (siehe Abschnitt 8)
gh release create v0.1.0 release/extension/browser-agent-0.1.0-unpacked.zip release/extension/browser-agent-0.1.0-store.zip \
  --title "Browser Agent 0.1.0" --notes-file <(awk '/^## \[0.1.0\]/{f=1;next} /^## /&&f{exit} f' CHANGELOG.md)
```
Im Browser: *Releases → Draft a new release →* Tag `v0.1.0` wählen → Notizen aus dem Changelog einfügen → beide Zips anhängen → *Publish release*.

Nutzer ohne Store laden `…-unpacked.zip`: entpacken, `chrome://extensions` → Entwicklermodus → *Entpackte Erweiterung laden*. Diese Variante hat die **feste ID** `omfoefeoobddgdfoichknkcidfoippih` und funktioniert mit der Bridge ohne weitere Einstellung.

> Hast du den automatischen Weg aus Abschnitt 8 eingerichtet, erledigt der Tag-Push 3 (npm) und 4 (GitHub Release) von selbst – dann diese Abschnitte nur lesen.

---

## 5. Chrome Web Store

Alle Texte zum Kopieren stehen in [`docs/store-listing.md`](docs/store-listing.md).

### 5.1 Erste Einreichung (manuell im Dashboard)

1. <https://chrome.google.com/webstore/devconsole> → **Add new item** (Neuer Artikel) → `release/extension/browser-agent-<version>-store.zip` hochladen. (Die Zip-Datei **mit `-store`** – ohne `key`. Ein Manifest mit `key` wird vom Store nicht gewünscht.)
2. **Store listing** (Eintrag):
   * Beschreibung (Englisch, optional zusätzlich Deutsch), Kategorie *Developer Tools*, Sprache.
   * Symbol 128×128: `extension/public/icons/icon-128.png`.
   * Screenshots **1280×800**: `docs/images/store-1-working.png`, `store-2-approval.png`, `store-3-settings.png` (mindestens 1, höchstens 5).
   * Kleine Werbekachel **440×280**: `docs/images/store-promo-small.png`.
   * Homepage-URL, Support-URL (GitHub Issues).
3. **Privacy** (Datenschutzpraktiken) – hier fallen die meisten Rückfragen an:
   * *Single purpose* und die **Begründung für jede Berechtigung** (`debugger`, `<all_urls>`, `tabs`, `tabGroups`, `activeTab`, `scripting`, `webNavigation`, `sidePanel`, `storage`, `unlimitedStorage`, `alarms`, `notifications`, `offscreen`, `downloads`) – fertige Texte in `docs/store-listing.md`.
   * *Remote code*: **Nein**.
   * *Data usage*: wie in `docs/store-listing.md` beschrieben (Website-Inhalte werden verarbeitet, nur lokal an das Programm des Nutzers übertragen) und alle drei Bestätigungen setzen.
   * *Privacy policy URL*: `https://github.com/msoftware/pi.dev-chrome-extension/blob/main/docs/PRIVACY.md` (muss öffentlich erreichbar sein – Repository öffentlich schalten oder die Datei per GitHub Pages hosten).
   * *Test instructions* (Hinweise für Prüfer; je nach Dashboard-Version auf diesem Reiter oder unter „Distribution“): Text aus `docs/store-listing.md` einfügen. Sie sind entscheidend, weil die Erweiterung ein lokales Programm braucht.
4. **Distribution** (Verbreitung):
   * *Visibility*: **Unlisted** (nur per Link installierbar; empfohlen für den Start, weil `debugger` streng geprüft wird) oder **Public**. *Private/Trusted testers* gehen für eine Testgruppe.
   * Regionen: alle (oder einschränken). Preis: kostenlos.
5. Oben rechts **Submit for review**. Wähle, ob nach der Freigabe **automatisch veröffentlicht** wird oder du das später selbst auslöst („Defer publishing“) – für den ersten Release ist „später selbst“ sinnvoll, siehe 6.

### 5.2 Prüfung durch Google

* Dauer: oft Tage, bei Erweiterungen mit **`debugger` und Zugriff auf alle Webseiten** kann eine vertiefte Prüfung Wochen dauern. Der Status steht im Dashboard; Rückfragen kommen per E-Mail.
* Häufige Beanstandungen und Gegenmittel:
  * *Berechtigung nicht begründet / zu breit* → die ausführlichen Begründungen aus `docs/store-listing.md` verwenden; erklären, dass der Debugger nur an Tabs der Agent-Gruppe hängt und nach der Aufgabe gelöst wird (`detachAll`).
  * *Prüfer kann die Funktion nicht testen* → die Testanleitung (Fake-Modell, kein API-Key) beilegen; ein kurzes Demovideo (YouTube „nicht gelistet“) und den Link in die Testhinweise schreiben hilft erfahrungsgemäß.
  * *Datenschutzerklärung fehlt oder passt nicht zu den Angaben* → URL erreichbar? Angaben im Reiter *Privacy* decken sich mit `docs/PRIVACY.md`?
  * *Irreführender Name/Marke* → der Name darf keine fremden Marken suggerieren („Claude in Chrome“ o. Ä. nicht verwenden; der Name „Browser Agent for pi“ nimmt Bezug auf pi, das ist in der Beschreibung als Kompatibilität erklärt).
* Wird abgelehnt: Begründung lesen, Fehler beheben, **Version erhöhen** (Abschnitt 9) und erneut einreichen. Jede Einreichung braucht eine höhere Manifest-Version als die vorige.

### 5.3 Alternativen, falls der Store nicht passt

* **Nur GitHub-Zip** (Abschnitt 4) – kein Review, Nutzer laden „entpackt“.
* **Unternehmensverteilung:** Chrome-Richtlinie `ExtensionInstallForcelist` mit einem Update-Manifest (selbst gehostete `.crx`) – die Erweiterung unterstützt Richtlinien per `managed_schema` (Port, Domains, Modus, JS-Werkzeug). Das `.crx` signierst du mit einem **eigenen privaten Schlüssel**; dessen ID ersetzt dann `EXTENSION_ID` bzw. wird als `extensionIds` eingetragen (Abschnitt 6).
* **Microsoft Edge Add-ons:** dasselbe Manifest-V3-Paket lässt sich im Partner Center hochladen (eigenes Konto, eigene ID → ebenfalls Abschnitt 6).

---

## 6. Wichtig nach der ersten Store-Freigabe: die Store-ID eintragen

Der Store entfernt den `key` und vergibt eine **eigene Erweiterungs-ID** (32 Buchstaben a–p, sichtbar in der Store-URL und im Dashboard). Die Bridge akzeptiert aus Sicherheitsgründen nur **bekannte** IDs (API-08). Ohne diesen Schritt kann sich die Store-Version **nicht** mit der Bridge verbinden.

**Variante A – für alle Nutzer (empfohlen):** ID im Code eintragen und ein Patch-Release veröffentlichen.

1. In `packages/shared/src/extension-id.ts`:
   ```ts
   export const STORE_EXTENSION_IDS: string[] = ["<ID aus dem Store>"];
   ```
2. `npm run version:set 0.1.1`, Changelog („Bridge accepts the Chrome Web Store build“), Abschnitt 2 und 3 wiederholen (nur die Bridge ändert sich inhaltlich; die Erweiterung muss nicht neu eingereicht werden, wenn du sie nicht änderst – die Versionsnummern bleiben aber synchron, bei Bedarf trotzdem alle veröffentlichen).
3. Das Tag-Release aus Abschnitt 8 erledigt das in einem Schritt.

**Variante B – sofort, pro Nutzer:** in `~/.pi/agent/browser-bridge.json`
```json
{ "extensionIds": ["<ID aus dem Store>"] }
```
(Das Panel zeigt sonst „Getrennt“, `~/.pi/agent/logs/browser-bridge.log` mit `"debug": true` zeigt `Origin not allowed`.)

Dann die Erweiterung im Dashboard veröffentlichen (falls „Defer publishing“ gewählt war) und die Store-URL in `README.md` (Abschnitt „Installation für Endnutzer“) und `packages/bridge/README.md` eintragen.

---

## 7. Abschlusstest wie ein Nutzer

Auf einem Rechner/Profil ohne Entwicklungsumgebung:

1. `pi install npm:pi-browser-bridge`, `pi`, `/browser` → zeigt Port und Status.
2. Erweiterung aus dem Store (oder Zip) installieren, Icon klicken, `/browser pair` → Code eingeben → „Verbunden“.
3. Auftrag geben (z. B. aus `test.md`, Weg 3); Freigabedialog, Stopp-Button, Einstellungen prüfen.
4. `pi.dev/packages` nach dem Paket durchsuchen; Link zum GitHub-Release und zum Store prüfen.

---

## 8. Automatisch veröffentlichen mit GitHub Actions

`.github/workflows/release.yml` läuft bei jedem Tag `v*`: Typecheck → Build → Unit- und E2E-Tests → npm-Pakete bauen → Store-Zip bauen → Release-Check, danach parallel: **npm publish** (mit Herkunftsnachweis/Provenance), **GitHub Release** (Notizen aus dem Changelog, Zips angehängt) und **Chrome-Web-Store-Upload**. Manuell auslösen: *Actions → Release → Run workflow* (ohne Haken „publish“ ist es ein reiner Probelauf der Prüfungen).

### 8.1 Secrets anlegen (*Settings → Secrets and variables → Actions → New repository secret*)

**npm**
1. <https://www.npmjs.com> → Profilbild → *Access Tokens* → *Generate New Token* → **Granular Access Token**.
2. Berechtigung *Read and write* für Pakete; für den **allerersten** Release „All packages“ (die Pakete existieren noch nicht), später auf `pi-browser-bridge` und `pi-browser-host` einschränken. Ablaufdatum setzen. Wenn dein Konto 2FA für das Veröffentlichen verlangt, muss das Token dafür freigegeben sein („Bypass two-factor authentication“ für Automatisierung).
3. Als Secret **`NPM_TOKEN`** speichern.
(Alternative ohne langlebiges Token: npm *Trusted Publishing* (OIDC) in den Paket-Einstellungen mit dem Workflow `release.yml` verknüpfen; dann entfällt `NPM_TOKEN`, und der Workflow braucht nur `id-token: write`, das bereits gesetzt ist.)

**Chrome Web Store** (erst nach der ersten manuellen Einreichung aus Abschnitt 5, denn die Erweiterung muss existieren)
1. <https://console.cloud.google.com> → neues Projekt → **Chrome Web Store API** aktivieren.
2. *APIs & Services → OAuth consent screen* (extern, Testnutzer = dein Google-Konto) und *Credentials → Create credentials → OAuth client ID* (Typ *Desktop app*). Notiere Client-ID und Client-Secret.
3. Einen **Refresh-Token** erzeugen (einmalig im Browser, Scope `https://www.googleapis.com/auth/chromewebstore`); Schritt-für-Schritt-Anleitung in der Dokumentation des verwendeten Werkzeugs `chrome-webstore-upload-cli` („How to generate Google API keys“).
4. Secrets anlegen: **`CWS_EXTENSION_ID`** (ID aus dem Dashboard), **`CWS_CLIENT_ID`**, **`CWS_CLIENT_SECRET`**, **`CWS_REFRESH_TOKEN`**.
Solange diese Secrets fehlen, überspringt der Workflow den Store-Schritt und meldet das im Log.

> Der Upload reicht die neue Version **zur Prüfung ein** (`--auto-publish`); sie erscheint erst nach Googles Freigabe. Möchtest du vorher selbst entscheiden, entferne `--auto-publish` aus dem Workflow – dann bleibt es ein Entwurf im Dashboard.

### 8.2 Ein Release auslösen

```bash
npm run version:set 0.1.1
# CHANGELOG.md ergänzen, npm install, committen:
git add -A && git commit -m "Release 0.1.1" && git push origin main
git tag v0.1.1 && git push origin v0.1.1
```
Der Workflow bricht ab, wenn der Tag nicht zur Version in `package.json` passt. Läuft ein Teilschritt fehl (z. B. npm-Token), kann er über *Re-run failed jobs* wiederholt werden; bereits veröffentlichte npm-Versionen werden dabei nicht erneut veröffentlicht (der Schritt schlägt dann mit „cannot publish over existing version“ fehl – bei Bedarf Version erhöhen).

---

## 9. Folge-Releases

* **Version erhöhen**: Fehlerkorrektur `0.1.1`, neue Funktion `0.2.0`; vor 1.0.0 gelten Minor-Sprünge als möglicherweise inkompatibel. Der Store verlangt für jede Einreichung eine **höhere** Manifest-Version.
* **Kompatibilität Bridge ↔ Erweiterung**: Beide sprechen dasselbe HTTP-Protokoll (`/v1/…`). Bei Protokolländerungen immer **beide** Teile gemeinsam veröffentlichen und im Changelog vermerken; `/v1/health` meldet beide Versionen (`bridgeVersion`, `piVersion`), das Panel zeigt sie bei Verbindungsproblemen.
* **Ablauf**: Abschnitt 2 → Tag (Abschnitt 8.2) oder 3–5 manuell.

## 10. Rücknahme und Notfälle

| Situation | Maßnahme |
|---|---|
| Fehlerhafte npm-Version | `npm deprecate pi-browser-bridge@0.1.0 "Bug, use 0.1.1"`; sofort fixen und `0.1.1` veröffentlichen. `npm unpublish pi-browser-bridge@0.1.0` nur in den ersten 72 h. |
| Fehlerhafte Store-Version | Im Dashboard die vorige Version weiter angeboten lassen / neue Version mit Fix einreichen (Express-Prüfung gibt es nicht, aber Fixes werden meist schneller geprüft). Bei Sicherheitsproblem: Eintrag im Dashboard **Unpublish**. |
| Geheimnis (npm-Token, Google-Refresh-Token) veröffentlicht | Token sofort widerrufen (npm: Access Tokens → Revoke; Google: Konto → Sicherheit → Drittanbieter-Zugriff), neues erzeugen, Secret ersetzen. |
| Private Schlüssel für ein eigenes `.crx` | Nie ins Repository einchecken; sicher aufbewahren (geht er verloren, ändert sich die ID). Der Schlüssel im Repository-Manifest (`key`) ist ein **öffentlicher** Schlüssel und unkritisch. |

---

## Kurz-Checkliste

- [ ] npm-Konto mit 2FA, `npm login`, Namen geprüft
- [ ] Chrome-Web-Store-Entwicklerkonto (5 USD), 2-Schritt-Verifizierung, Händler-Status angegeben
- [ ] Repository öffentlich (Datenschutzerklärung und `gallery.png` müssen erreichbar sein)
- [ ] `npm run test:all` grün
- [ ] `npm run version:set X`, `CHANGELOG.md`, `npm install`
- [ ] `npm run build && npm run build:npm && npm run pack:extension && npm run release:check` → „All checks passed.“
- [ ] Probeinstallation aus dem Tarball
- [ ] `npm publish` Bridge, dann Host
- [ ] GitHub Release mit beiden Zips
- [ ] Store: Zip `-store`, Listing, Privacy-Begründungen, Datenschutz-URL, Testhinweise, Einreichen
- [ ] Nach Freigabe: Store-ID in `STORE_EXTENSION_IDS` + Patch-Release (oder `extensionIds` in der Konfiguration)
- [ ] Abschlusstest wie ein Nutzer, Galerie pi.dev/packages prüfen
