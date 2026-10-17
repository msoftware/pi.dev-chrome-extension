# Privacy Policy – Browser Agent

*Last updated: 17 October 2026 · Datenschutzerklärung auf Deutsch weiter unten.*

**Browser Agent** is a Chrome extension that lets an AI coding agent (pi) that runs **on your own computer** see and operate your browser. This policy explains what the extension processes.

## Summary

* The extension has **no server of its own**. The developer receives **no data** – no page content, no browsing history, no analytics, no crash reports.
* The extension talks to **one place only: a program on your own computer** (`http://127.0.0.1`, the *pi-browser-bridge* you start yourself). It has no other network connections (its content security policy forbids them).
* What the agent sees of a web page leaves your computer only if **you** have configured pi with a cloud model provider; pi then sends it to *that* provider under *that* provider's terms. With a local model, nothing leaves your computer.

## What the extension processes

| Data | Why | Where it goes | How long |
|---|---|---|---|
| Content of tabs you let the agent work in: text, element structure, screenshots, form values (values of password and card fields are replaced by a placeholder) | So the agent can read and operate the page you asked it to | To your local pi process over loopback; from there to the model provider you configured in pi | Not stored by the extension beyond screenshots (below) |
| Your messages and the agent's answers | Chat | Local pi process | Stored by pi in its session files on your computer |
| Screenshots of the current session | Show previews in the chat, reuse them for uploads | Browser storage (IndexedDB) on your computer, capped at 25 MB per session | Until you delete them ("Delete all data" in the settings) |
| Pairing token, approvals ("always allow" for a domain), settings, saved shortcuts | Operation of the extension | `chrome.storage.local` on your computer | Until you remove them |
| Activity log (time, tool, action, domain, decision, result – **no page content**) | Traceability for you | Browser storage on your computer | 30 days, viewable and exportable in the settings |

## Permissions

The extension asks for broad browser permissions (including `debugger` and access to all sites) because operating arbitrary websites on your behalf requires it. Every permission and why it is needed is listed in `docs/store-listing.md`. The agent only works on tabs that are in its own tab group, asks before acting on a new website, always asks before typing into password or payment fields, and can be stopped at any time with the Stop button.

## Your control

* Stop the agent: Stop button on the page or in the panel, or close the side panel.
* Block websites, require confirmation for sensitive websites, revoke approvals, view the log: extension settings.
* Delete everything: "Delete all data" in the settings, or remove the extension.

## Children

The extension is not directed at children.

## Changes and contact

Changes to this policy are published in this file in the repository. Questions: <https://github.com/msoftware/pi.dev-chrome-extension/issues>

---

# Datenschutzerklärung – Browser-Agent (Deutsch)

**Kurz:** Die Erweiterung hat **keinen eigenen Server**; der Entwickler erhält **keinerlei Daten** (keine Seiteninhalte, kein Verlauf, keine Statistik). Sie verbindet sich ausschließlich mit einem Programm auf **Ihrem eigenen Rechner** (`http://127.0.0.1`, die von Ihnen gestartete *pi-browser-bridge*). Was der Agent von einer Webseite sieht, verlässt Ihren Rechner nur, wenn Sie in pi einen Cloud-Modellanbieter eingerichtet haben; dann sendet pi es an diesen Anbieter, es gelten dessen Bedingungen. Mit einem lokalen Modell bleibt alles auf dem Rechner.

**Verarbeitet werden:** Inhalte der Tabs, in denen Sie den Agenten arbeiten lassen (Werte von Passwort- und Kartenfeldern werden durch einen Platzhalter ersetzt), Ihre Nachrichten und Antworten (gespeichert von pi lokal), Screenshots der Sitzung (lokal im Browser, max. 25 MB je Sitzung), Kopplungstoken, Freigaben, Einstellungen und Shortcuts (lokal in `chrome.storage.local`) sowie ein Aktivitätsprotokoll ohne Seiteninhalte (30 Tage, lokal, exportierbar).

**Ihre Kontrolle:** Stopp-Button oder Schließen des Panels; Sperr-, Frage- und Erlaubt-Listen, Freigaben widerrufen und Protokoll in den Einstellungen; „Alle Daten löschen“ oder Erweiterung entfernen.

Kontakt: <https://github.com/msoftware/pi.dev-chrome-extension/issues>
