# Design

Converse Code is a voice remote and reference implementation, not an agent framework. Pi owns the
visible coding session and terminal UI. Dialt owns speech and the background-tool lifecycle.

The [interactive lifecycle explorer](converse-code-state-machine.html) steps through normal turns,
approvals, interruptions, steering, cancellation, ownership failures, and session ending.

## Public surface

- `pi_request(user_request)` starts one deferred Pi turn while idle and semantically steers it while
  working.
- `pi_approval(approval_id, decision)` resolves only a matching pending approval. It is
  `resolver_only`: Dialt never offers it to the model and calls it only from a bound interaction.
- `pi_cancel()` calls Pi's documented extension `abort()` API without ending voice.

Ordinary committed user turns cannot bypass Pi: while idle, Dialt is constrained to
`pi_request`; while a Pi turn is active, it must choose `pi_request` (steer) or `pi_cancel`.
Resolver-bound approval interactions temporarily provide their narrower decision constraint.

## Boundary

```text
Dialt voice model
        │ background tool call / cancellation
        ▼
voice-only Browser SDK page
        │ acknowledged localhost controls
        ▼
Python lifecycle router
        │ ID-correlated local WebSocket
        ▼
Pi extension ── sendUserMessage / events ── visible Pi TUI ── Codex
```

Decoded JSON remains boundary data until it is parsed. Browser tool calls become a `ToolCall`
before reaching the lifecycle router; malformed calls never enter it. Pi events likewise become
typed ownership, activity, approval, message, settlement, or loss events before state transitions
run.

Pi is launched in its default interactive mode. The extension uses `sendUserMessage()` for a new
turn, `deliverAs: "steer"` for active guidance, `abort()` for cancellation, and `shutdown()` for
graceful exit. Model questions and changes go through the same natural-language Pi message as any
other request. A Pi-internal `pi_session_model` capability reads `ctx.model`/`modelRegistry` and
changes the session through `setModel()`; it is not a Dialt tool or a menu driver. The extension
emits explicit message, tool, and settled events. It never reads terminal rows, types keys, or
infers menu state.

## Event mapping

| Visible Pi extension evidence | Dialt control |
| --- | --- |
| acknowledged `sendUserMessage` command | `tool_deferred` |
| ordinary tool start | structured `tool_partial_result` without an interaction |
| approval request | structured `tool_partial_result` with a stable, resolver-bound interaction |
| `message_end` | authoritative final-text candidate |
| `agent_settled` | one terminal `tool_result` |
| cancellation | Pi extension `abort()` |

Early events are buffered until `tool_deferred` has been delivered. One bridge-origin task is
active at a time because Pi's visible-TUI extension API does not attach a caller ID to lifecycle
events. The extension therefore emits an ownership event for each matched `sendUserMessage()`
input. Manual terminal input, another extension's input, session replacement, or bridge loss while
a voice task is active fails that Dialt tool closed instead of attributing unrelated output.
Each root Pi turn owns a fresh host handle. Converse Code waits for the correlated
`tool_deferred_ack`; a rejected or missing acknowledgement aborts Pi and fails the parent call
instead of pretending the ordinary tool deadline was replaced.
The router represents acknowledgement, ownership, running, cancellation, and settlement as
separate states; only the owned running state can carry assistant output or pending approvals.

## Approvals

The bridge extension intercepts `bash`, `edit`, and `write` before execution, creates a unique
approval ID, and waits without opening a terminal menu. Dialt receives the ID, tool, target, and
valid decisions as a stable background-tool interaction whose resolver binds `pi_approval`, the
fixed approval ID, and each spoken option's exact decision argument. Dialt queues its narration
when the voice floor is busy and exposes the narration lifecycle. Once any of the ask was heard,
Dialt constrains the next user turn to an explicit resolve, clarify, supersede, or cancel
transition. Resolve executes the broker-constructed exact `pi_approval` call; the model never
constructs its arguments. A new `pi_request` first blocks any pending approval and then steers the
change of course. Stale IDs, malformed decisions, disconnects, cancellation, and timeouts fail
closed.

Approval scope is part of Converse Code's interaction contract: an unqualified affirmative permits
only the pending action, while session-wide approval requires an explicit request from the user.

An approval that closes without a user decision is retracted, not abandoned: the extension reports
its own timeout (`approval_expired`), and the router sends an acknowledged
`tool_interaction_update` on the parent deferred call. A change of course similarly blocks Pi
before closing the matching interaction as superseded. A broker-side cancel is reflected to the
host by its stable interaction ID and blocks the matching Pi hook. A decision arriving for a
closed approval fails deterministically with `approval_not_pending`, and an extension-side
rejection of a blocking command never blocks the steer it was clearing the way for. Dialt
closes open interactions on reconnect; `tool_deferred_resume` therefore causes the router to
re-raise every still-pending Pi approval from its retained typed request.

## Evidence and outcomes

Prompt acknowledgement proves only that Pi accepted the user message. A successful settled Pi
turn is the authoritative result of `pi_request`, so Dialt receives `outcome: succeeded` and
`verified: true` and may report Pi's answer. Failed and cancelled turns remain unverified and may
not be narrated as successful work.

## Browser boundary

Dialt owns conversational ending. Its intentional transport close is exposed by the Browser SDK
as `session_end`; the page forwards that structured lifecycle event and the host gracefully shuts
down Pi. Converse Code does not duplicate end intent with a phrase matcher or tool.

The page has microphone control but no text input. One tagged session state—idle, opening, live,
or ended—drives its controls; the delivery epoch and microphone exist only while live, and events
are accepted only from the instance the session owns. It mirrors Browser SDK speech, reply, and
tool lifecycle events; Pi remains the canonical coding transcript. Python holds the persistent Dialt
key and mints a short-lived browser credential. Controls are sequenced, acknowledged, retained
across disconnects, and replayed after reconnect.
