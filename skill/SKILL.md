---
version: 1.0.0
name: google-flow-generate
description: |
  Generate images and video using a Google AI Pro subscription via Google Flow
  (labs.google/flow), driven by browser automation (the google-flow MCP server),
  to avoid paying per-credit services for what Google already covers. Use when the
  user asks to generate an image or video and no specific other service is named.
  Images are effectively free (they do not draw down the monthly Flow credit pool);
  video consumes credits.
allowed-tools: Bash, PowerShell
---

# Google Flow Generate

Runbook to generate images/video on Google Flow through the `google-flow` MCP server.
Set `FLOW_MCP_DIR` below to wherever you cloned this repo.

## STEP 0 — Ensure the dedicated Chrome is up (always run first)

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<FLOW_MCP_DIR>/scripts/ensure-flow-chrome.ps1"
```

- `READY` / `LAUNCHED` → proceed.
- `LAUNCHED`: if labs.google shows the marketing landing instead of the app, the user
  must click **"Sign in to Flow"** once in that Chrome window, then continue.
- `FAILED` → report; do not proceed.

If the `mcp__google-flow__*` tools are absent, the MCP server needs a client restart
(it loads into RAM at startup).

## STEP 1 — Connect

Call `flow_connect`:
- `status: connected` → go on.
- `status: oauth_required` → user signs in to Flow once, then retry.
- `WRONG_GOOGLE_ACCOUNT` → stop; setup mismatch.
- `flow_account_check` → `method:"assumed"` means unverified, not a green light.

## STEP 2 — Images (free)

`flow_generate_image` with `auto_confirm:true`. Models: `Nano Banana 2` (default),
`Nano Banana Pro`, `Imagen 4`. Params: `prompt`, `ratio`, `project_name`, `campaign`.
Result `files[]` = saved paths. (The `credits_consumed` flag is hardcoded; images are
free against the Flow pool.)

## STEP 3 — Video (⚠️ consumes credits)

`flow_generate_video` with `auto_confirm:true` submits, approves the credit dialog,
waits ~1 min and downloads the mp4.
- Credits: Veo 3.1 Lite ~10, Fast ~20, Quality ~100; Omni Flash ~15-30 of ~1000/month.
- **Valid model/duration combo required** (Veo 3.1 Lite = 8s-only on Pro; Omni Flash
  4-10s) — else the agent asks for clarification and nothing generates.
- Confirm with the user before spending credits if not already authorized.
- `auto_confirm:false` stages without spending.

## Fallback map (error → action)

| Error | Action |
|---|---|
| `oauth_required`, `MANUAL_VERIFICATION_REQUIRED` | STOP, user signs in / solves captcha |
| `WRONG_GOOGLE_ACCOUNT` | STOP, setup problem |
| `BROWSER_NOT_CONNECTED`, `NOT_LOGGED_IN`, `FLOW_PAGE_NOT_FOUND` | rerun STEP 0, then fall back |
| `GENERATION_BUTTON_DISABLED`, `GENERATION_TIMEOUT`, `UNKNOWN_UI_CHANGE` | fall back + `flow_discover_ui` |
| `GOOGLE_LIMIT_REACHED` | credits exhausted → fall back |
| `DOWNLOAD_FAILED` | don't regenerate (credits spent) — retry download |

Image fallback: Flow → Gemini API (`fallback/gemini_image_fallback.py`, needs
`GEMINI_API_KEY`) → any per-credit generator you use. Video fallback: Flow → your
per-credit generator directly.
