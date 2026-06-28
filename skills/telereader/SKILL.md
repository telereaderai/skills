---
name: telereader
description: Turn any text, article, URL, or document into a narrated audiobook the user can open in a browser and listen to, with the words lit up in sync. Use when the user wants text "read aloud", an audiobook / listenable version, or to send a reading to themselves. Works from a shell; pasting text is never paywalled (URL/document import is a paid feature — fall back to passing the text).
homepage: https://telereader.ai
license: MIT
---

> **Script paths below are relative to THIS file's directory.** Resolve the
> absolute path to this `SKILL.md`'s parent directory first, then prefix script
> paths with it (e.g. `<skill_dir>/scripts/onboard`). Do NOT assume the working
> directory is the skill folder.

# Telereader — text → narrated audiobook

Telereader turns text into a narrated reading the user can **open in a browser and
listen to** — the words light up in sync with the voice. Pasting text is **never**
dead-ended: you always get back an openable URL. (Importing a URL or document is a
paid feature; on the free tier, fall back to fetching the text and passing it.)

You can submit **text, a URL, or a file** — Telereader fetches, extracts, and
cleans URLs/documents server-side, so **don't fetch or clean content yourself.**
The reader URL is **openable immediately** (progressive render) — hand it over
right away and **offer** to open it; don't poll, and don't auto-open.

Base URL: `https://telereader.ai`

## When to use this

- The user asks to "listen to" / "read aloud" / "make an audiobook of" / "narrate"
  some text, an article, a chapter, or a document.
- You want to hand the user a link they can open and hear.

## Two ways to reach Telereader

This skill is the path for **coding / terminal agents** — you have a shell, you
authenticate with a device-grant token, and you call the REST API (below). There is
also a **hosted MCP server** for chat assistants and MCP clients:

- **MCP server — `https://telereader.ai/api/mcp`** (Streamable HTTP, OAuth). In an
  MCP client (Claude or ChatGPT connectors, Cursor, VS Code, Cline, Goose, …) it
  exposes a **`generate_audiobook`** tool. **If you are already connected to the
  Telereader MCP server, just call that tool** with the text — same account, same
  reader URL — and skip the curl flow below.
- **This skill (REST + device grant)** — best when you have a shell and no MCP
  connector wired up. Continue below.

Both submit to the same API and return the same openable reader URL. See
<https://telereader.ai/docs/api/agents> for the connector setup.

## Step 0 — onboard once (device grant, RFC 8628)

Run the helper. It requests a device code, prints a browser approval link for the
**human to approve once**, polls for the token, and saves it (mode `0600`) to
`~/.config/telereader/token`:

```bash
<skill_dir>/scripts/onboard
```

The token is reading-scoped and long-lived — reuse it; you only re-onboard if it
expires. (You cannot approve on the human's behalf — hand them the link.)

<details><summary>By hand, without the helper</summary>

```bash
# (a) request a code
curl -s -X POST https://telereader.ai/api/auth/device/code \
  -H 'content-type: application/json' -d '{"client_id":"tlread"}'
# → {"device_code":"…","user_code":"WXYZ-1234",
#    "verification_uri_complete":"https://telereader.ai/device?user_code=WXYZ-1234",
#    "interval":5,"expires_in":900}

# (b) tell the human: open verification_uri_complete and approve (sign in if asked)

# (c) poll every `interval` seconds until approved
curl -s -X POST https://telereader.ai/api/auth/device/token \
  -H 'content-type: application/json' \
  -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"tlread"}'
# pending  → {"error":"authorization_pending"}   (keep polling)
# approved → {"access_token":"<TOKEN>","token_type":"Bearer",...}
```
</details>

## Step 1 — read something aloud → get an openable URL

You can pass **text, a URL, or a file** — Telereader does the fetching, extraction,
and cleaning itself. **Do NOT fetch or clean the content yourself.**

```bash
<skill_dir>/scripts/read "Some text to read aloud."        # literal text
<skill_dir>/scripts/read https://example.com/article       # a URL — Telereader fetches + cleans it
<skill_dir>/scripts/read article.md --title "My article"   # a readable local file
pbpaste | <skill_dir>/scripts/read -                       # stdin
```

It prints the **readUrl** to stdout (and a short `(mode; request-id …)` line to
stderr so you have a trace id). It **does not** auto-open — pass `--open` if you
actually want it opened.

The readUrl is **openable immediately** — Telereader renders progressively, so the
human can open it and start listening while the rest generates. **Do not poll or
wait for generation to finish before handing over the link.**

**Hand the human the readUrl right away, and offer to open it** — don't open it
silently. For example:

> Here's your audiobook: `https://telereader.ai/r/…`
> Want me to open it for you? (`open <url>` on macOS) If not, the URL above plays
> it: text on screen, lit up in sync with the narration.

**URL / document import is a paid feature.** If the caller is on the free tier, a
URL or file import returns **`402`** and the helper prints a clear fallback. In
that case, **fetch the page/document text yourself and pass it as text** instead —
text is never paywalled.

If a call fails (e.g. a `5xx`), the helper prints the **request id** (`x-request-id`
/ `cf-ray`) on stderr — surface that id to the human and **offer to file a bug
report**.

<details><summary>By hand, without the helper</summary>

```bash
# text / markdown:
curl -sS -D - -X POST https://telereader.ai/api/v1/readings \
  -H "Authorization: Bearer <TOKEN>" -H 'content-type: application/json' \
  -d '{"source":{"kind":"markdown","body":"# Title\n\nThe text to read aloud."}}'

# a URL (Telereader fetches + extracts + cleans it — don't pre-fetch it yourself):
curl -sS -D - -X POST https://telereader.ai/api/v1/readings \
  -H "Authorization: Bearer <TOKEN>" -H 'content-type: application/json' \
  -d '{"source":{"kind":"url","url":"https://example.com/article"}}'
```

`-D -` dumps the response headers — keep `x-request-id` / `cf-ray` so you have a
trace id to report on failure.

Returns **`202` immediately**:
- `{"mode":"browser","readUrl":"…"}` — free / over-cap: the URL generates the audio
  **in the browser**. Hand it to the human / `open` it.
- `{"mode":"server","readingId":"…","readUrl":"…","pollUrl":"…"}` — paid: poll
  `pollUrl` until `status:"complete"`, then open `readUrl` (the readUrl is openable
  immediately either way).

Poll (server mode):
```bash
curl -s https://telereader.ai/api/v1/readings/<readingId> -H "Authorization: Bearer <TOKEN>"
# → {"status":"queued|generating|complete|partial|failed","progress":{…},"readUrl":"…"}
```
</details>

## Request body

`source` is the only required field:
- `{"kind":"text","body":"…"}` or `{"kind":"markdown","body":"…"}` (≤ 1,000,000 chars)
- `{"kind":"url","url":"https://…"}` or `{"kind":"upload",…}` — **URL / document
  import**: Telereader fetches, extracts, and cleans it server-side, so don't
  pre-fetch it yourself. This is a **paid** feature — a free-tier caller gets a
  `402` (fall back to passing the text). If extraction itself fails you get a
  `422 extraction_failed`; submit the text directly.

Optional: `voice`, `title`, `ephemeral` (bool), `idempotencyKey`. Re-submitting the
same content + key is idempotent (one reading). You can also pass the key as a
header: `-H "Idempotency-Key: <key>"`.

## Errors — always `{ "error": <code>, "message": … }`

| HTTP | code | what to do |
|---|---|---|
| 401 | `unauthorized` | onboard (Step 0) and send the Bearer token |
| 400 | `validation_failed` | fix the body (carries `zodError`) |
| 402 | `payment_required` | URL / document **import** is paid — fetch the text yourself and submit it as text |
| 429 | `rate_limited` | wait `Retry-After` seconds, then retry |
| 422 | `extraction_failed` | url/upload import failed — submit the text directly |

A free caller is **never paywalled for text** — text always yields a browser
`readUrl`. Only **URL / document import** is paid; a free caller importing a URL
gets `402`, so fall back to fetching the text and passing it as text. On any
failure, the helper prints the response's `x-request-id` / `cf-ray` — surface that
id and offer to file a bug report.

## Machine spec

`GET https://telereader.ai/api/v1/openapi.json` — a complete OpenAPI 3.0 doc
(onboard + submit + poll + delete). Generate a client from it; don't hand-roll.
