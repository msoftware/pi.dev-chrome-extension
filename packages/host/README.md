# pi-browser-host

Headless host for the **Browser Agent**: starts one [pi](https://pi.dev) session through the SDK with the browser bridge ([`pi-browser-bridge`](https://www.npmjs.com/package/pi-browser-bridge), bundled) loaded. No terminal UI – the Chrome side panel is the only surface ("panel-led mode"). Sessions can be started from the panel ("＋").

## Use

```bash
npm install -g pi-browser-host @earendil-works/pi-coding-agent
pi-browser-host --cwd ~/project            # prints a pairing code at start
pi-browser-host --provider anthropic --model <model-id> --browser-port 47824
```

Options: `--cwd`, `--browser-port`, `--provider`, `--model`, `-e <extension.ts>` (extra pi extensions, repeatable), `--no-session`. Credentials and settings come from your normal pi configuration (`~/.pi/agent`).

Then open the Browser Agent side panel in Chrome and enter the printed 6-digit code. See the project README for the Chrome extension: <https://github.com/msoftware/pi.dev-chrome-extension>.

License: MIT
