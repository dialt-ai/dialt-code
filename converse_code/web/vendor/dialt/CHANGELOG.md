# Changelog

## 0.48.1

- Document `sendToolResult` `outcome` and `verified`: send them whenever the host can establish
  them. No behaviour changes.

## 0.48.0

- Breaking alpha cleanup: remove flow, ambience, vendor relay and research controls,
  deprecated Converse names, `mode.kind="converse"`, `brain="genius"` and `wait_for_tool`.
  Use Dialt names and `expected_duration`. New eval requests reject `dialt-genius`; use
  `dialt-smart`. Historical runs remain readable.
- See the [alpha migration guide](https://dialt.com/docs/api/migration/) before upgrading.
- Reset starts a new logical conversation and recording identity with retained configuration.
- Remove implementation exports `EchoCanceller`, `needsSdkAec`, `MicCapture`,
  `TrackFeeder`, `WebRtcSession` and `UPLINK_CHANNEL_RAW`; use `DialtClient` for capture and transport.
- Browser reset preserves microphone capture where possible; pending old operations fail.

- The `turn` frame no longer carries `endpoint_source`. It was undocumented, named an internal
  pipeline component, and no SDK code read it; the session recording keeps it for Dialt support.
  Nothing in the SDK changes.

## 0.47.0

- Stop restarting the microphone when the permission grant reveals the device inventory. WebKit
  fires `devicechange` as labels appear, and the SDK read it as a default-device change,
  releasing and reopening capture on every fresh Safari page load.
- `listening` now means capture is live, not just that a frame arrived. On WebKit's raw capture
  (SDK AEC3) it waits for a frame that is not digital silence, because Safari can hand over
  silent frames while the device starts; after `captureSignalTimeoutMs` (default 5000) of silence
  it fires with `signal_unverified: true`. `startMic()` still resolves on the first frame.
- Mid-call, `recovering` reports `capture_stall` (no frames for 300 ms) or `capture_silent`
  (300 ms of raw digital silence on WebKit), and `listening` fires again when audio returns.
- Worklet capture timestamps stay on page time across audio-thread stalls: the SDK re-anchors
  them and emits `capture_stall` with the lost `stall_ms`. Recordings show the stall as a gap
  instead of pulling later audio earlier, which inflated aligned latency by the stall length.

## 0.46.0

Retire the genius tier: `mode.brain` is `"fast"` (default) or `"smart"`. `"genius"` is still
accepted as a deprecated alias: the SDK logs a `console.warn` and sends `"smart"`, which is how
the server runs, bills and records it.

## 0.45.0

Accept `mode.brain: "genius"`, the strongest and slowest tier, billed at the genius rate.

## 0.44.0

Accept `mode.brain`: `"fast"` (default) or `"smart"`. Smart is a stronger, slower model billed
at the smart rate.

## 0.43.0

Reject blank voice keys and retain only server-confirmed voice switches for reconnect.
Unknown or retired voices produce `invalid_voice`; use `GET /v1/voices` for current keys.

## 0.42.0

- Remove public `turn_end_threshold` and `temperature` tuning. Dialt owns these settings;
  callers must omit them. Unsupported fields are rejected before session setup.

## 0.41.0

- Stamp microphone frames on the audio thread and tag every WebSocket uplink with
  `capture_clock_v1`, so recordings keep source capture timing. Servers without the
  capability keep recording by arrival time.

## 0.40.0

- Default new browser clients to `wss://api.dialt.com/v1/realtime` and export
  `DEFAULT_REALTIME_URL`. Existing explicit URLs, including temporary legacy `/ws`, remain
  accepted during the migration.

## 0.39.0

- Expose `client.sessionUuid`, the server-minted logical session identifier from `ready`. Null
  until the first `ready`; stable across successful resumes and broker transfers; freshly minted
  for a new dialogue even when `sessionId` is reused. Older servers that omit it leave it null.

## 0.38.0

- Remove the previous policy action and tool-restriction configuration. Policies use
  conditions and actions with optional agent instructions and quiet background guidance.
- Validate policy text and identifier limits before connecting.

## 0.37.0

- Define policy conditions and actions once, with independent agent instructions and
  quiet background guidance. Existing action configurations remain accepted during migration.

## 0.36.0

- Policy rules can invoke a configured client tool with fixed arguments. Quiet guidance remains
  `next_turn`; existing `speak_now` rules retain their behavior.
- Policy tool results use ordinary permissions, deferral and completion handling.


## 0.35.0

- Accept opt-in policy occurrence, correction, batching and tool-restriction controls.

## 0.34.0

- Add `handoffAgent(...)`, an atomic, acknowledged same-session agent handoff. It waits through
  an optional queued acknowledgement for the final correlated applied or rejected result, updates
  reconnect replay mode only after application, and never retries an uncertain disconnect.

## 0.33.0

- Add `setInstructions(instructions, {newSpeaker})`: replace the session instructions mid-call,
  from the next reply on. `newSpeaker: true` declares that a different agent takes the call from
  here; the server folds everything said so far into a transcript the new agent holds, so it never
  reads the previous agent's lines as its own. With `setTools()` and `setVoice()` this is the
  same-session hand-off between agents; the tool-result note alone was not enough.

## 0.32.0

- `mode.policy` declares a policy agent beside the call: rules the broker's judge watches the
  transcript for, each with the instruction it injects when the rule applies and whether the
  agent replies at once (`speak_now`) or at its next turn (`next_turn`). Each raised rule
  arrives as a `policy_flag` event. Shape validation here; the server applies the size limits.

## 0.31.0

- Add `setTools(tools)`: replace the client tool manifest mid-session for an agent whose
  capabilities change by call phase (an intake persona declaring only a hand-off tool, then the
  specialist's tools once the hand-off lands). Managed tools ride the swap; `tool_choice` resets
  to `"auto"`. Pairs with `setVoice()` for a same-session persona hand-off.

## 0.30.0

- Add `resolveToolPermission(id, decision)` for host-managed application approval.
  Declare `permission_source: "application"` with `requires_permission: true` and listen for
  `permission_pending` and `permission_resolution` to integrate your approval application.
  This release uses `caller` and `application` as the only permission sources; the old
  `conversation` and `external` values are no longer accepted.

## 0.28.0

- WebSocket voice playback supports capability-negotiated provisional holds after a possible
  interruption. Matching recovery resumes retained audio; cancellation discards it with accurate
  playback accounting. WebRTC and custom players without hold support keep existing behavior.

## 0.27.2

- Session openers now use the ordinary assistant-turn lifecycle: they can be interrupted, and
  only the heard prefix remains in conversation context after a barge-in.

## 0.27.1

- Make the public Browser SDK guide the single source for setup, AudioWorklets, microphone lifecycle, and input selection; keep this package README as a concise install entry point.

## 0.27.0

- Deprecated `ConverseClient` and `mode.kind: 'converse'` now emit one console warning per
  page while remaining source compatible. Use `DialtClient` and `mode.kind: 'dialt'`.

## 0.26.0

- `mode.end_call` also accepts `{ when: '<ending condition>' }`: the host states when the agent
  may end the call, declared to the agent as part of the managed `end_call` tool. `true` keeps
  Dialt's default (the caller asks you to end the call).

## 0.25.0

- Voice sessions may set `mode.turn_end_threshold` from 0.05 to 0.5 to override the shared
  endpoint operating point for that session. Omit it to retain the deployment default.

## 0.24.0

- `DialtClient` is now the canonical browser client name; `ConverseClient` remains as a deprecated source-compatible alias.
- New sessions send `mode.kind: 'dialt'`; legacy `converse` input is still accepted and normalized.

## 0.23.0

- The package is now published as `@dialt/sdk`; `@trelis/converse` is deprecated.
- Package metadata and documentation now point to Dialt and
  [`dialt-ai/dialt`](https://github.com/dialt-ai/dialt).
- The runtime API and wire protocol are unchanged.

## 0.22.1

- `startMic()` and the WebRTC track feeder retry their packaged source worklet when a CDN-transformed
  SDK entry cannot load its sibling asset. This fixes esm.sh imports, where the transformed entry
  lives under `es2022/` while the worklets remain under `es2022/src/`.

## 0.22.0

- Playback-health telemetry: the player counts mid-reply underruns (queue drained at the
  speaker) and, at each reply's `done`, the client sends
  `{"type":"client_event","event":"playback_report", underruns, starved_ms, max_gap_ms, turn_id}`
  over WebSocket transports. No behaviour change: buffering is untouched; the report is
  record-only on the server and sizes the jitter buffer from real sessions. Not sent over
  WebRTC, where the browser owns the jitter buffer.

## 0.21.1

- Removed `playAcknowledgements` and the `ack` frame handler: the server does not send assistant
  backchannel clips yet (roadmap, not shipped), so the option was a no-op and the docs overstated
  it. Passing the old option is still silently accepted.

## 0.21.0 - 2026-08-30

- `mode.end_call` (default `false`) declares the managed `end_call(farewell)` tool so the agent can
  end the session. When it calls the tool, Dialt speaks only the farewell, sends
  `session_end_requested` with that `farewell`, and closes after a short grace unless the user
  speaks. Without the flag the agent cannot end the session; the host ends it with `wrap_up` or by
  closing. While enabled, the name `end_call` is reserved, like `web_search` (`invalid_tools`). Pass-through only:
  validation and the default are the only client changes.

## 0.20.0 - 2026-08-28

- `mode.modality` selects `"voice"` (the default) or `"text"`. Text sessions use the same
  instructions, tools, history and event lifecycle without microphone or playback setup.
- `sendText(text)` commits one `input_text` user turn in text mode and returns whether it was
  written to the live connection. In voice sessions `sendText` is unchanged: still the user-role
  `injectContext` shorthand returning the acknowledgement promise, so existing voice
  integrations keep working. Text rejects microphone capture and the WebRTC transport so
  integrations cannot accidentally open an unused media pipeline.

## 0.19.1 - 2026-08-22

- Tool declarations: `expected_duration` (`"instant"` / `"seconds"` / `"long"`) replaces
  `wait_for_tool` in the docs. It says what the caller should hear on a tool turn (the answer
  directly, or an acknowledgement first); left out, Dialt learns from observed results.
  `wait_for_tool: true` still passes through as a deprecated alias of `"instant"` during alpha and
  will be removed at beta. Pass-through only: no client code changed.

## 0.19.0 - 2026-08-22

- `ambience` constructor option (`'thinking'` DEFAULT; `'off'`, `'continuous'`; or an object with
  `mode` plus `afterS`/`fadeInS`/`fadeOutS`/`level`) and `client.setAmbience(mode)`: a soft
  generative bed rendered in the SDK and mixed THROUGH the SDK player, so it sits in the echo
  canceller's far-end reference on every transport and on WebKit/iOS (where the old playground
  bed on its own AudioContext had to be disabled). `'continuous'` plays it under the whole call
  from the first reply; `'thinking'` plays it only while Dialt is blocking on a tool result with
  nothing to say - fading in after ~1.5 s of silence and out again under the reply's first
  syllables, a real crossfade - so a caller waiting on a slow backend hears "still working"
  instead of dead air. The thinking sound is ON BY DEFAULT from this release (it plays nothing
  unless a tool wait runs long); pass `ambience: 'off'` to keep the old silence. Bed-only audio
  is never queued ahead of a reply and never counts toward
  barge `discarded_ms`. Same musical design and constants as the server-mixed WebRTC
  `background_audio` bed (the two renderers share the score, not the samples). WebSocket
  transport only: over webrtc the SDK player is not in the audio path, so the local ambience
  stays silent and `mode.background_audio` is the option there.
- New server event `working` (`active: true|false`): Dialt is blocking on a tool result
  (client tools, web_search, think_deeply) with nothing audible, or that wait ended. Drives the
  thinking sound; also usable for a "working..." UI state.
- `StreamingPlayer.setUnderlay(bed)` / `resumeUnderlay()`: the underlay path the ambience uses.
  Audio is now resampled at schedule time rather than at enqueue (no wire or API change).

## 0.18.0 - 2026-08-18

- `mode.background_audio` (default `false`): a server-mixed background underscore that plays for
  the whole call, so the silence between turns feels connected. **Requires
  `transport: 'webrtc'`** — the bed rides the server's playout track, the only downlink that runs
  continuously between turns. The SDK drops the field with a console warning rather than sending
  it on any non-WebRTC session, which matters because WebKit downgrades `webrtc` to `ws` for you;
  without that, asking for both would cost the whole session on iOS instead of just the music.

## 0.17.0 - 2026-08-17

- **Breaking (inert):** removed the reversible-playback protocol. The broker stopped sending
  `playback_pause`/`playback_resume` when the old barge fallback was deleted, so this
  client half has been dead code since. `StreamingPlayer.pause()`, `.resume()` and `.paused` are
  gone, custom players no longer need them, and start frames no longer advertise
  `playback_pause_v1` (`client.capabilities` is now always `[]`). Barge handling is unchanged:
  `interrupted` still fade-clears and reports `discarded_ms`/`remaining_ms`.

## 0.16.0 - 2026-08-16

- Interactions accept a `resolver` binding (`{tool, args, option_args, answer_arg}`): once the ask
  has been voiced, subsequent user turns are constrained to an explicit transition
  (resolve / clarify / supersede / cancel) via the broker-managed `interaction_transition` tool,
  and `resolve` executes the bound client tool with host-declared arguments — the model picks the
  option, never the arguments. See docs/client-tool-protocol.md §3a.

## 0.15.0 - 2026-08-16

- `tool_choice` lands in `ConverseMode` and as `setToolChoice(choice, { oneShot })` — the familiar
  OpenAI/Gemini restriction vocabulary (`"auto"` | `"none"` | `"required"` | `{allowed: [...]}` |
  `{tool: "..."}`). `required`/`allowed`/`tool` constrain the first planning round of each user
  turn; `none` withholds declared client tools while broker protocol tools stay available;
  `oneShot` reverts after the next user turn. Unknown names are rejected server-side with the new
  `invalid_tool_choice` error code; `setTools` resets the choice to `"auto"`.
## 0.14.1 - 2026-08-16

- `sendToolInteractionUpdate` normalizes whitespace-padded interaction ids the same way the server
  does, so the ack (which echoes the stripped id) correlates instead of surfacing as a timeout;
  ack correlation is additionally state-matched, so a server answer arriving after a client-side
  timeout can no longer be handed to the next same-id caller.

## 0.14.0 - 2026-08-16

- Interactions now carry a stable identity: pass `interaction.id` in `sendToolPartialResult` (or
  read the broker-derived id from `tool_job_narration.interaction_ids`), then close an ask without
  completing its parent call via `sendToolInteractionUpdate(id, interactionId, state, { note })`
  (`state`: `resolved` | `cancelled` | `superseded`). Queued or actively-speaking narration for it
  stops, the model is told not to act on it, and the returned promise resolves with the server's
  deterministic `tool_interaction_update_ack` (late/duplicate/unknown updates come back
  `applied: false` with a stable `reason`). Add `interactionState(interactionId)`; narration and
  interaction state caches now reset on connection loss (a resumed session implicitly supersedes
  any open interaction — re-raise it if still needed).

## 0.13.1 - 2026-08-15

- `sendToolPartialResult(id, content, { interaction })` marks a partial as needing a user decision
  (docs/client-tool-protocol.md §3a): unlike `reply: true` alone, it is never silently dropped when
  the floor is busy — it queues and preempts pending completion narration, with a far more
  persistent delivery retry. Add `narrationState(jobId)` and `waitForNarrationState(jobId, states,
  { timeoutMs })` to track its queued/started/superseded/cancelled lifecycle via the new
  `tool_job_narration` server frame.

## 0.13.0 - 2026-08-13

- `startMic()` now resolves only after the first AudioWorklet frame. If an opened capture produces
  no frames within the bounded startup window, the SDK fully releases it and reacquires once; a
  repeated stall rejects with the structured `capture_stalled` error. Silent frames remain valid.
- Add `warming_up`, `listening`, `recovering`, and `failed` capture lifecycle events so host apps can
  render status without implementing their own retry or readiness fallback.
- Add audio-input enumeration and selection with `getInputDevices()`, `setInputDevice(deviceId)`,
  the `inputDeviceId` option/property, `devices_changed`, and `input_device_changed`. Active capture
  follows relevant `devicechange` events through guarded track restart.
- Make `stopMic()` a cancellation barrier and harden stop/retry, overlapping device-switch, and
  delayed WebRTC track-replacement races without leaking tracks, worklets, or AudioContexts.

## 0.12.3 - 2026-08-11

- Tool result, progress, deferred, partial-result, and cancellation methods now return whether a
  live transport accepted the frame, allowing durable bridges to retain controls across reconnects.

## 0.12.2 - 2026-08-11

- Keep a newer successful connection authoritative when an older failed WebSocket delivers its
  close event late, so explicit capacity retries cannot clear the live transport.

## 0.12.1 - 2026-08-11

- Bound correlated injection acknowledgement waits and reject with cleanup when an older or
  mismatched broker never returns `inject_context_ack`.

## 0.12.0 - 2026-08-11

- `injectContext(text, {messageId, role, reply})` now returns the broker's authoritative
  accepted/rejected acknowledgement. The client-generated ID and `input_source: "text"` are
  echoed on the canonical final `asr` event; spoken transcripts carry `input_source: "voice"`.
- `sendText(text, {messageId})` exposes the same correlation and acknowledgement contract.

## 0.11.0 - 2026-08-11

- Add `sendText(text)` as the concise alias for a typed user turn that should receive a reply.
  Typed and spoken turns use the same `asr` event contract, including a stable `turn_id`.

## 0.10.0 - 2026-08-10

- Add a supported, versioned Browser SDK resume-state API for full page reloads:
  `resumeState`, `exportResumeState()`, `importResumeState()`, and the `resume_state` event. The
  state rotates with each server token and clears on terminal or rejected sessions, so apps can
  safely keep a tab-scoped `sessionStorage` copy without reading private SDK fields.
- Add `injectContext(text, {role, reply})` as the supported Browser SDK surface for the existing
  `inject_context` protocol frame, including proactive host announcements with `reply: true`.

## 0.9.0 - 2026-08-09

- Add `mode.silence_nudge_s` / `mode.silence_end_s` to override the broker's two-stage idle
  policy (check-in nudge, then sign-off + end) per session — useful for benchmark harnesses or
  flows with long think-time. Both default to the broker's env-configured values (10s/20s) when
  omitted; the broker also falls back to those defaults if either value is non-positive or
  `silence_end_s` does not exceed `silence_nudge_s`.

## 0.8.0 - 2026-08-08

- License Dialt-authored Browser SDK code under Apache 2.0; bundled AEC components remain under
  the third-party terms reproduced in the package.
- Keep assistant playback on the browser's unity-gain path, with no SDK limiter, software boost,
  output-route switch, or `navigator.audioSession` manipulation.
- Document that device volume, physical routing, and mobile full-duplex attenuation are controlled
  by the browser and operating system; native integration is required for routing guarantees.
- Document the Browser SDK support matrix across Chromium, Brave, Firefox and Safari, including
  the automatic WebKit fallback from experimental WebRTC to WebSocket.

## 0.7.0 - 2026-08-07

- Add `sendToolDeferred(id, {handle, statusLabel})` for jobs that outlive their originating voice
  turn. Eligible tools opt in with `deferred`, `deferred_timeout`, and `notify_on_complete`.
- Deferred jobs remain addressable by their original call ID or host handle for progress,
  cancellation, and exactly one terminal result. The SDK forwards `tool_deferred_ack` and
  `tool_deferred_resume` events through the normal typed and catch-all event APIs.
- Tool interruption is unchanged: barge-in never cancels deferred work; explicit cancellation does.

## 0.6.0 - 2026-08-06

- **Hidden-tab playback fix.** Browsers throttle `setInterval` to ~1 Hz in hidden tabs while the
  AudioContext keeps running, so the player's 0.2 s scheduling horizon starved playback into
  0.2 s bursts with ~0.8 s gaps whenever the user wasn't looking at the page. The player now
  commits a 2.5 s horizon while `document.visibilityState === 'hidden'` (and tops up immediately
  on `visibilitychange`), keeping playback gapless; the short barge-friendly horizon is unchanged
  in visible tabs, and barge/clear still stops committed-but-unplayed sources at any horizon.
- **Tool replies from anywhere.** `ConverseClient` gains `sendToolResult(id, content)`,
  `sendToolProgress(id, note)`, `sendToolPartialResult(id, content, {reply})` and
  `sendToolCancel(id)`, mirroring the Python SDK. Listen for `tool_call` events and answer them
  from the page or relay them to a backend — no raw-socket sidecar needed.
- `binaryToFloat32` and `toWebSocketUrl` are re-exported from the package root for raw-socket
  integrations.
- Server-side (deployed independently): the per-tool `timeout` ceiling rises from 120 s to 600 s
  for long-running agentic tools.

## 0.5.0 - 2026-08-06

- **Downlink audio is PCM16 on the wire — required update.** The server's downlink default
  changed from Float32 to PCM16 (bandwidth-halving negotiation, `start.audio.output_encoding`).
  0.4.5 and earlier decode the downlink as Float32 and therefore produce noise or decode errors
  against current servers. This release requests `output_encoding: "pcm16"` explicitly in the
  start frame, decodes Int16, and fails `connect()` loudly if the server's `ready.audio` field
  announces a format other than pcm16 at 16 kHz instead of playing garbage.
- `transport: 'webrtc'` option (experimental): carries the session over a WebRTC peer connection
  with a native remote audio track; the WS protocol remains the default and recommended path.
  Includes bounded ICE gathering, the `webrtc_connect_failed` error, and mic dropout/resampler
  fixes from the field-test rounds.

## 0.4.5 - 2026-07-30

- **Remove the speaker/earpiece output option entirely (`audioOutputMode`, `setAudioOutputMode`,
  and the 0.4.1 `<audio>`-element sink)** — settled by an 11-configuration on-device experiment
  (iPhone 17, Chrome + Safari): modern iOS routes web audio to the loudspeakers in every reachable
  configuration, "earpiece AND speaker at once" is normal iPhone stereo playback (the receiver is
  the second stereo speaker), and no configuration reaches earpiece-only. Web pages have no output
  routing to control, so the SDK ships none: playback is a plain
  `AudioContext` → master gain → `destination` path on every platform. The
  never-touch-`navigator.audioSession` regression guard remains.

## 0.4.4 - 2026-07-30

- **Revert 0.4.3's `navigator.audioSession` usage — field-falsified on real iPhones (Chrome and
  Safari).** Setting `type = 'playback'` (speaker mode) before capture made `getUserMedia` fail
  with a mic-permission error — a broken mic in the DEFAULT mode — and `'play-and-record'`
  (earpiece mode) still produced earpiece+loudspeaker dual output. Speaker routing is back on the
  0.4.2 `<audio>`-element sink (mic works; known-imperfect dual output remains the open bug). A
  regression test now pins that the SDK never touches `navigator.audioSession`.
  `setAudioOutputMode()` (live switching) and the speaker/earpiece option remain.

## 0.4.3 - 2026-07-30

- `ConverseClient.setAudioOutputMode(mode)`: the 0.4.2 speaker/earpiece choice is now live-switchable
  mid-session (previously took effect on the next `Start` only) — re-wires `StreamingPlayer`'s output
  route and, on WebKit, sets `navigator.audioSession.type` (`'playback'` for speaker, `'play-and-record'`
  for earpiece; Safari 16.4+, feature-detected, a no-op elsewhere). This directly targets the
  documented WebKit routing decision the `<audio>`-element sink workaround (0.4.1) could only work
  around indirectly — field testing on iPhone showed the 0.4.1 fix alone produced simultaneous
  earpiece + loudspeaker output rather than a clean switch, and `navigator.audioSession.type` is the
  platform's own API for this exact "mic is live, but I want loudspeaker anyway" case.
- The two mechanisms are mutually exclusive, not stacked: where `navigator.audioSession` exists
  (Safari 16.4+), the 0.4.1 `<audio>`-element sink route is skipped entirely (`hasAudioSessionApi()`
  in `aec.js`) — running both at once would leave two live output paths fighting over the same
  routing decision, the same shape that produced the dual-output field result. The element sink
  remains only as the pre-16.4 WebKit fallback.

## 0.4.2 - 2026-07-30

- Add the `audioOutputMode` (`'speaker' | 'earpiece'`, default `'speaker'`) `StreamingPlayer`
  constructor option so apps can explicitly choose between the loudspeaker route (0.4.1) and the
  platform's own call-audio/earpiece routing on iOS/WebKit, instead of only ever getting one. No
  effect on platforms without that fork (desktop, Android).

## 0.4.1 - 2026-07-30

- Route assistant playback through a sink `<audio>` element (instead of `AudioContext.destination`
  directly) on iOS/WebKit, to avoid the call-audio session routing playback to the earpiece
  receiver instead of the loudspeaker while a mic stream is active (WebKit bug 218012). Pending
  on-device confirmation.

## 0.4.0 - 2026-07-29

- Publish the package publicly on npm with installation and authentication guidance.

- Advertise reversible playback only for players that implement pause and resume, and report the
  actual SDK-owned microphone/AEC frontend across reconnects for echo diagnostics.
- Make web search opt-in by default.
- Add `setMicEnabled(enabled)` to gate SDK-owned microphone tracks without reopening capture.
- Add the default-on `playAcknowledgements` constructor option so half-duplex integrations can
  suppress automatic backchannel playback while retaining `ack` and `audio` event dispatch.
- Add `setVoice(voice)` to switch character voice from the next reply and reassert it on reconnect.
- Add `sendAmbienceState(active)` to report the client's ambience state on the session timeline.

## 0.3.1 - 2026-07-16

- Enable web search by default while preserving an explicit `webSearch: false` opt-out.

## 0.3.0 - 2026-07-16

- Add the opt-in `webSearch` session capability.

## 0.2.1 - 2026-07-15

- Gate `playback_pause_v1` to desktop Chromium and Firefox until physical WebKit validation.

## 0.2.0 - 2026-07-15

- Add synchronized processed/raw uplink framing for raw-assisted barge detection.
- Keep WebKit on one physical raw capture teed through SDK WASM AEC.
- Add reversible `playback_pause` / `playback_resume` handling for backchannels.
- Add AEC configuration plumbing and explicit desktop/WebKit engine controls.
- Fail closed to processed-only audio when raw capture or classification is unavailable.

## 0.1.0

- Initial browser SDK extracted from the Dialt web client.
