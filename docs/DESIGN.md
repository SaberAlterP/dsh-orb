# dsh-orb design

Goal: DeepSeek Orb 0.1.7's desktop agent on DeepSeek Harness 0.2 **without patching the kernel**, behaving the
same for the user: the floating ball, its compact chat, Computer Use, the background `code_agent`, the observation frame, and
the Orb settings. (Orb's selection toolbar is intentionally not carried over.)

## What Orb was made of

| Orb 0.1.7 piece | Where it lived | dsh-orb |
| --- | --- | --- |
| `computer-use` agent preset (persona prompt that decides GUI vs `code_agent`) | `resources/computer-use/cordis.patch.yml` | `cordis.patch.yml`, byte-identical except package names |
| Computer Use tools, `code_agent` / `code_agent_status` / `code_agent_stop` | `@deepseek-ai/dsh-experimental-tool-computer-use` | `lib/computer-use/` (Orb code + local auto-archive fix) |
| Overlay guard, Orb permission, coordinate mode, code_agent model | `@deepseek-ai/dsh-desktop-host` (Orb build) | `lib/host/` |
| Preferences pushed by the Electron shell | Orb `lib/main.js` IPC | `lib/host/orb-prefs.js` reads the same profile files |
| Floating ball, compact chat panel, observation frame | Orb Electron main + `renderer/` | `orb-shell` companion (Rust + WebView2) + Orb's renderer files |
| Compact Chat transcript (`?surface=overlay`) | `@deepseek-ai/dsh-client-ui-overlay-chat` + kernel overlay hooks | plugin client UI (overlay helpers inlined) |
| Orb settings page | `@deepseek-ai/dsh-client-ui-settings-orb` | plugin client UI |

Harness 0.2 removed all of the right-hand column's Orb sources, including the overlay hooks inside kernel client
packages (`dsh-api-session-controller/client` overlay helpers, chat/layout/workspace/user-questions overlay branches).

## Companion (`orb-shell`)

```
Harness Host process ── dsh-orb host plugin ──spawn──> orb-shell.exe (Rust, WebView2)
        │  ctx.connection.authenticatedUrl()  ── one-time login URL ──>  WebView2 gets the Host cookie
        │  ctx.webServer: /.dsh/orb/*  (Orb renderer files, prefs API, remote stream)
        │  stdin/stdout JSON lines: overlay-guard / observation-frame / prefs / quit
```

- Renderer documents are served by the plugin from the Host web server, so `/api/*`, `/.dsh/remote-stream` and the
  `?surface=overlay` iframe are same-origin with the cookie the login URL minted. No CORS, no extra auth.
- `window.dshDesktop.floating.*` (Orb `lib/preload.cjs`) is recreated by an injected shim over
  `chrome.webview.postMessage`; window operations go to Rust, preference reads/writes to the plugin routes.
- Rust owns only what needs the OS: transparent always-on-top windows, drag/dock/expand/resize geometry (ported from
  Orb's `moveFloatingBall`/`clampFloatingWindow`/dock helpers), the native context menu, `WDA_EXCLUDEFROMCAPTURE`,
  click-through during GUI input, and the observation frame window.
- Focusing the main window uses `dsh://open` (Harness handles it with `focusPrimaryWindow()`).

## Status

1. Host side: preset, tools, code_agent, prefs — verified on 0.2.0-rc.2.
2. `orb-shell` floating ball, compact chat, history / new conversation, resizable panel, context menu — verified.
3. Orb settings page — verified.
4. Session log compatibility: no unknown events written; `scripts/repair-session-logs.mjs` for Orb-era logs.

## Changes to Orb's renderer files

`renderer/` keeps Orb 0.1.7's files (with the local floating-ball patches ②⑤⑥⑨⑩⑪⑫) byte-identical, except:

- `floating.js` `renderHistory`: blank (never used) conversations are hidden from the history list, except the
  one currently open.

Everything else Harness 0.2 needs is added around them: `orb-bridge.js` (preload replacement, context menu,
panel resize handles) and serve-time origin rewriting in `lib/host/shell.js`.
