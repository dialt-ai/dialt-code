# Converse Code

A deliberately small voice remote for a normal, visible Pi terminal, and a reference
implementation for [Dialt](https://dialt.com) background tools and the Browser SDK.
Pi uses the user's ChatGPT Plus/Pro Codex subscription.

The example exposes the same small controls a person has over Pi:

1. `pi_request` sends the user's request to Pi. An idle Pi starts one deferred turn; a working Pi
   receives immediate steering.
2. `pi_approval` delivers an explicit decision for a pending approval ID.
3. `pi_cancel` aborts Pi's current turn without ending the voice session.
4. Pi tool events become structured, silent partials. A blocking approval becomes a persistent,
   ID-correlated Dialt `interaction` bound to the exact `pi_approval` resolver and choices.
5. Pi's `agent_settled` event resolves the one deferred turn exactly once.

The browser remains voice-only but mirrors the live speech transcript, assistant replies, and
coding activity. Pi retains the canonical coding transcript and model state. A bundled extension
injects voice requests with Pi's documented `sendUserMessage()` API and observes Pi's semantic
lifecycle events. There is no terminal emulation, screen scraping, key injection, model picker,
shell bypass, or hidden Pi process.

That same extension gates `bash`, `edit`, and `write` with ID-correlated semantic approval
requests. Dialt receives the approval ID, tool, target, and valid decisions as structured facts;
Pi accepts only an explicit response for the pending ID. Dialt owns the interaction's queued,
started, superseded, cancelled, or failed narration lifecycle, including when the voice floor is
busy. Once the user has heard the ask, Dialt constrains subsequent turns to resolve, clarify,
supersede, or cancel it; on resolution the broker constructs the exact approval call from the
host-declared mapping. Expiry and host-side supersession use acknowledged interaction updates, and
pending approvals are re-raised after a deferred-job reconnect. No terminal selection menu is
opened or navigated.

## Install

Install Pi, sign into the Codex provider, and install Converse Code:

```bash
npm install -g @earendil-works/pi-coding-agent
pi
# In Pi: /login → ChatGPT Plus/Pro (Codex)

uvx converse-code
```

`converse-code` opens the voice page and then starts a normal interactive Pi TUI as:

```bash
pi --provider openai-codex
```

Override that command when testing another Pi configuration:

```bash
converse-code --pi "pi --provider openai-codex --model gpt-5.6-codex"
```

To resume Pi's most recent session in the current directory, return to that directory and run:

```bash
uvx converse-code --continue
```

Converse Code passes Pi's native `--continue` flag through, so Pi retains ownership of the coding
session and transcript.

Run `converse-code login` to store a Dialt API key, or set `DIALT_API_KEY`. The persistent key
remains in Python; the browser receives only a short-lived session credential minted with
`POST https://api.dialt.com/v1/session-keys`.

| Variable | Default | Legacy fallback |
| --- | --- | --- |
| `DIALT_API_KEY` | saved `converse-code login` key | `CONVERSE_API_KEY` |
| `DIALT_URL` (`--broker-url`) | `wss://api.dialt.com/v1/realtime` | `CONVERSE_URL` |
| `DIALT_API_URL` (`--api-url`) | `https://api.dialt.com` | `CONVERSE_API_URL` |

The Dialt name wins when both are set. The `CONVERSE_*` names keep existing setups working.

For a recording or a session you may need to diagnose later, append an opt-in local trace:

```bash
uvx converse-code --debug-log ./converse-session.jsonl
```

The JSONL trace timestamps browser voice turns, received-audio chunk timing and continuity,
background-tool controls and acknowledgements, and Pi semantic events. Assistant audio received
by the browser is saved as per-turn WAV files in the sibling `converse-session.audio/` directory;
this lets a playback glitch be separated from an upstream TTS defect. It excludes microphone audio
and CLI arguments, uses owner-only permissions for new files, and applies targeted redaction to structured credential
fields, Dialt (`dk_`, legacy `ck_`) and common provider keys, bearer headers, inline secret assignments and flags,
and local session tokens. It intentionally retains spoken transcripts, tool arguments, paths, and
command summaries because those are needed to reconstruct a failure. Redaction cannot recognize
every possible secret format, so treat the trace and audio directory as project-sensitive and share
them deliberately.

## Reference architecture

```text
Dialt voice model
        │ tool call / cancellation
        ▼
Voice-only Browser SDK page
        │ acknowledged localhost controls
        ▼
PiControlRouter ── local semantic bridge ── visible Pi TUI ── Codex
        │
        └─ deferred / partial(interaction) / terminal result
```

The model-facing surface is limited to `pi_request` and `pi_cancel`. `pi_approval` is declared
`resolver_only`: Dialt calls it only from the caller's answer to a bound approval interaction.
Questions and requests about Pi, including model changes, are ordinary messages interpreted by Pi itself. See
[docs/DESIGN.md](docs/DESIGN.md) for the event mapping and evidence rules.

Session ending follows Dialt's native lifecycle. An intentional server close becomes the
Browser SDK's structured `session_end` event, which gracefully shuts down Pi. Converse Code does
not classify farewell phrases or expose a competing end tool.

## Test

```bash
uv sync
uv run pytest -q
uv run playwright install chromium
uv run scripts/browser_e2e.py
```

The deterministic suite exercises the Python bridge and the real TypeScript Pi extensions. The
browser suite drives the shipped voice-only page in Chromium and checks transcript streaming,
activity indicators, backgrounding, structured partials, completion, cancellation, native session
ending, and reconnect replay. Release testing also launches a real visible Pi TUI and injects a
bounded task through the semantic extension bridge.

## License

Apache-2.0. The vendored Dialt Browser SDK (`@dialt/sdk`, pinned in
`converse_code/web/vendor/dialt/UPSTREAM.json`) retains its own notices and third-party licenses.
