# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com), versions: [SemVer](https://semver.org).

## [0.1.0] - 2026-10-17

First public release.

### Added
- **Chrome extension** (Manifest V3, side panel): chat UI with streaming Markdown, tool-call rows with screenshot previews, model/thinking/permission-mode controls, session history, German and English interface.
- 20 browser tools driven over the Chrome DevTools Protocol: `computer`, `navigate`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `browser_batch`, `tabs_*`, `update_plan`, console/network readers, uploads, `resize_window`, `gif_creator`, shortcuts.
- Permission model: ask / follow a plan / automatic (with a second model check), per-domain one-time or permanent approvals, blocked / always-ask / allowed domain lists, enterprise policy via `storage.managed_schema`, local audit log (30 days).
- On-page indicators: glow frame, Stop button, status bar, phantom cursor. Tab group named "Agent" with a blinking dot while the agent works.
- **pi-browser-bridge** (pi extension / pi package): HTTP + SSE bridge on `127.0.0.1:47823`, pairing with a 6-digit code, `/browser` command.
- **pi-browser-host**: headless host (pi through the SDK, panel-led mode).
- Test suite: ~100 unit tests, ~75 Playwright end-to-end tests including runs against a real pi process.
