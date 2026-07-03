# google-flow-mcp

MCP server that generates **images and video on [Google Flow](https://labs.google/flow)**
through browser automation, so you can use your own **Google AI Pro** subscription
instead of paying per-credit services. Ships with a Claude Code skill.

Validated end-to-end: images (Nano Banana / Imagen) and video (Veo 3.1 / Omni Flash)
are generated in a real Flow project and downloaded to disk.

> Adapted and hardened for the current agent-first Flow UI (and Windows) from
> [TMSSS05/google-flow-browser-mcp](https://github.com/TMSSS05/google-flow-browser-mcp).

## What it does

Playwright connects over the Chrome DevTools Protocol to a dedicated Chrome that is
logged into your Google account. It drives Flow's agent to generate media and
downloads the result through the authenticated session. **No API keys, no password
handling** — it uses your existing browser session.

Tools (17): `flow_connect`, `flow_status`, `flow_account_check`, `flow_discover_ui`,
`flow_generate_image`, `flow_generate_video`, `flow_download_latest`, character/scene
tools, `flow_use_grid_architect`, `flow_screenshot`, `flow_queue_status`, …

## ⚠️ Terms of Service

This is **unofficial browser automation**. There is no official Google API for Flow.
The launcher starts Chrome directly so `navigator.webdriver` is false, which is an
explicit anti-bot measure. Automating Google properties can violate Google's Terms of
Service and may put your account at risk. **Use at your own risk, on your own account.**

## Requirements

- Node.js ≥ 18
- Google Chrome (Chrome 149+ needs Playwright ≥ 1.61.1, already pinned)
- A Google account with access to Flow (Google AI Pro recommended)

## Setup

```bash
npm install
cp config/flow.config.example.json config/flow.config.json
# edit config/flow.config.json → set expectedAccount and chromeUserDataDir
```

Start the dedicated Chrome (idempotent — launches only if needed):

```powershell
powershell -File scripts/ensure-flow-chrome.ps1
```

First run: in that Chrome window, sign in to your Google account **and** click
**"Sign in to Flow"** on labs.google (Flow uses a separate sign-in). The session is
saved in the dedicated profile and reused.

Register the server with your MCP client (Claude Code, etc.):

```json
{
  "mcpServers": {
    "google-flow": { "type": "stdio", "command": "node", "args": ["<path>/src/index.js"] }
  }
}
```

Restart the client afterwards (the server loads into memory at startup).

## Notes that matter

- **Images are effectively free** against the monthly Flow credit pool; **video
  consumes credits** (Veo 3.1 Lite ~10, Fast ~20, Quality ~100; Omni Flash ~15-30 of
  ~1000/month). Video shows a credit-confirmation dialog which the server approves.
- **Model/duration must be a valid combo** or Flow's agent asks for clarification and
  nothing generates (e.g. Veo 3.1 Lite is 8s-only on the Pro plan; Omni Flash 4-10s).
- Flow is **agent-first**: prompts are wrapped imperatively so the agent generates
  directly instead of asking questions.
- The UI language follows your Google account; navigation selectors cover IT/FR/EN.

## Claude Code skill

`skill/SKILL.md` is a ready-to-use skill: drop it in `~/.claude/skills/google-flow-generate/`
and Claude will pick the right tool, handle Chrome startup and fallbacks automatically.

## License

MIT — see [LICENSE](./LICENSE).
