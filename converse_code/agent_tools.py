"""Minimal Dialt voice controls for one visible Pi session."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import NamedTuple

from .bridge import ToolCall
from .pi_tui import PiTUIBridgeError

TOOL_TIMEOUT_S = 30
DEFERRED_TIMEOUT_S = 7200
class Decision(Enum):
    ALLOW_ONCE = "allow_once"
    ALLOW_SESSION = "allow_session"
    BLOCK = "block"


class InteractionClosure(Enum):
    SUPERSEDED = (
        "superseded", "The user changed course; the Pi approval was blocked.",
    )
    EXPIRED = ("cancelled", "The Pi approval expired unanswered.")
    RESOLVED_FOR_SESSION = (
        "resolved", "Pi allowed protected actions for this session.",
    )

    @property
    def state(self) -> str:
        return self.value[0]

    @property
    def note(self) -> str:
        return self.value[1]


DECISION_LABELS = {
    Decision.ALLOW_ONCE: "Allow once",
    Decision.ALLOW_SESSION: "Allow for this session",
    Decision.BLOCK: "Block",
}

APPROVAL_SCOPE_RULE = (
    "An unqualified approval means allow_once; allow_session requires an explicit "
    "request for session-wide approval."
)


class Failure(Enum):
    INVALID_EVENT = "invalid_pi_event"
    SESSION_LOST = "pi_session_lost"
    PROCESS_EXITED = "pi_process_exited"
    INPUT_MISMATCH = "pi_input_mismatch"
    UNRELATED_INPUT = "unrelated_pi_input"
    MESSAGE_FAILED = "pi_message_failed"
    OWNERSHIP_UNCONFIRMED = "pi_ownership_unconfirmed"
    DEFER_REJECTED = "pi_defer_rejected"


def manifest() -> list[dict]:
    def tool(name, description, props=None, required=None, **flags):
        return {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object", "properties": props or {}, "required": required or [],
            },
            **flags,
        }

    request = {
        "user_request": {
            "type": "string",
            "description": (
                "The user's request or question for Pi, preserving their intent. This must be "
                "an instruction or question for Pi—not assistant narration, an inferred answer, "
                "or a claim that the requested work already happened."
            ),
        },
    }
    return [
        tool(
            "pi_request",
            (
                "Interact with the user's connected Pi coding session: hand it any actionable "
                "coding, repository, or environment request, and ask it anything you need to know "
                "about the session itself, including what model and configuration it is running. "
                "Forward the user's request faithfully and let Pi inspect or act; never substitute "
                "your own progress narration or unsupported answer. While Pi is working, this "
                "steers that same turn and supersedes any pending approval."
            ),
            request,
            ["user_request"],
            timeout=TOOL_TIMEOUT_S,
            deferred=True,
            deferred_timeout=DEFERRED_TIMEOUT_S,
            notify_on_complete=True,
            status_label="Pi",
        ),
        tool(
            "pi_approval",
            (
                "Submit the user's explicit decision for a pending Pi approval using its "
                f"supplied ID. {APPROVAL_SCOPE_RULE}"
            ),
            {
                "approval_id": {"type": "string", "description": "The pending approval ID."},
                "decision": {
                    "type": "string",
                    "enum": [item.value for item in Decision],
                    "description": APPROVAL_SCOPE_RULE,
                },
            },
            ["approval_id", "decision"],
            timeout=15,
            # Dialt calls this only from the caller's answer to a bound approval interaction;
            # the model never sees it and cannot construct its arguments.
            resolver_only=True,
        ),
        tool(
            "pi_cancel",
            "Cancel Pi's current turn without ending the voice session.",
            timeout=15,
            expected_duration="instant",
        ),
    ]


class Succeeded(NamedTuple):
    message: str


class Failed(NamedTuple):
    event: Failure
    message: str = ""


@dataclass(frozen=True)
class Cancelled:
    pass


TerminalResult = Succeeded | Failed | Cancelled


class OwnedInput(NamedTuple):
    command_id: str


class Signal(Enum):
    FOREIGN_INPUT = auto()
    SESSION_LOST = auto()
    AGENT_SETTLED = auto()


class ProcessExited(NamedTuple):
    status: int


class ToolStarted(NamedTuple):
    name: str
    arguments: dict


class ApprovalRequested(NamedTuple):
    approval_id: str
    tool: str
    summary: str


class ApprovalExpired(NamedTuple):
    approval_id: str


class AssistantMessage(NamedTuple):
    text: str


class MessageFailed(NamedTuple):
    error: str


PiEvent = (
    OwnedInput | Signal | ProcessExited | ToolStarted | ApprovalRequested | ApprovalExpired
    | AssistantMessage | MessageFailed
)


@dataclass
class AwaitingAcknowledgement:
    call_id: str
    result: asyncio.Future[TerminalResult]
    handle: str
    events: list[PiEvent] = field(default_factory=list)


@dataclass
class AwaitingOwnership:
    call_id: str
    result: asyncio.Future[TerminalResult]
    command_id: str
    handle: str


@dataclass
class RunningTurn:
    call_id: str
    result: asyncio.Future[TerminalResult]
    handle: str
    assistant_text: str = ""
    approvals: dict[str, ApprovalRequested] = field(default_factory=dict)


@dataclass(frozen=True)
class CancellingTurn:
    call_id: str
    result: asyncio.Future[TerminalResult]
    handle: str


@dataclass(frozen=True)
class SettledTurn:
    """The result is set; the owning pi_request coroutine has not yet returned to idle. New
    requests are refused ("pi_turn_settling") and events are ignored. Deliberately carries no
    data -- nothing may key off a settled turn's identity."""


ActiveTurn = (
    AwaitingAcknowledgement | AwaitingOwnership | RunningTurn | CancellingTurn | SettledTurn
)


class PiControlRouter:
    """Map Dialt's human-like controls onto one attributable Pi turn."""

    def __init__(self, pi, sender, *, handle: str) -> None:
        self.pi = pi
        self.sender = sender
        self._handle_prefix = handle
        self._handle_sequence = 0
        self._turn: ActiveTurn | None = None

    def _next_handle(self) -> str:
        self._handle_sequence += 1
        if self._handle_sequence == 1:
            return self._handle_prefix
        return f"{self._handle_prefix}-{self._handle_sequence}"

    @property
    def active_call_id(self) -> str | None:
        return (
            self._turn.call_id
            if isinstance(
                self._turn,
                (AwaitingAcknowledgement, AwaitingOwnership, RunningTurn, CancellingTurn),
            )
            else None
        )

    async def handle_tool_call(self, call: ToolCall) -> None:
        if call.name == "pi_request":
            request = self._text(call.arguments.get("user_request"))
            if request is None:
                await self._error(call.call_id, "user_request_required")
                return
            await self._pi_request(call.call_id, request)
        elif call.name == "pi_approval":
            approval_id = self._text(call.arguments.get("approval_id"))
            try:
                decision = Decision(call.arguments.get("decision"))
            except ValueError:
                decision = None
            if approval_id is None or decision is None:
                await self._error(call.call_id, "approval_not_pending")
                return
            await self._pi_approval(call.call_id, approval_id, decision)
        elif call.name == "pi_cancel":
            await self._pi_cancel(call.call_id)
        else:
            await self._error(call.call_id, "unknown_tool")

    async def handle_tool_cancel(self, call_id: str) -> None:
        if call_id != self.active_call_id:
            return
        await self._request_cancel()

    async def handle_deferred_resume(self, handle: str) -> None:
        turn = self._turn
        if not isinstance(turn, RunningTurn) or handle != turn.handle:
            return
        for approval in tuple(turn.approvals.values()):
            if turn.approvals.get(approval.approval_id) is not approval:
                continue
            await self._send_approval(turn, approval)

    async def handle_cancelled_interactions(self, interaction_ids: tuple[str, ...]) -> None:
        turn = self._turn
        if not isinstance(turn, RunningTurn):
            return
        for approval_id in interaction_ids:
            if approval_id not in turn.approvals:
                continue
            turn.approvals.pop(approval_id)
            try:
                await self.pi.command(
                    "approval_response", approvalId=approval_id, decision="block",
                )
            except PiTUIBridgeError:
                pass

    async def on_event(self, event: dict) -> None:
        try:
            parsed = self._parse_event(event)
        except ValueError as exc:
            if self._turn is not None:
                self._complete(Failed(Failure.INVALID_EVENT, str(exc)))
            return
        if parsed is None:
            return
        if isinstance(self._turn, AwaitingAcknowledgement):
            self._turn.events.append(parsed)
            return
        await self._handle_event(parsed)

    async def _pi_request(self, call_id: str, request: str) -> None:
        if isinstance(self._turn, RunningTurn):
            await self._steer(call_id, request)
            return
        if isinstance(self._turn, (AwaitingAcknowledgement, AwaitingOwnership)):
            await self._error(call_id, "pi_turn_starting")
            return
        if self._turn is not None:
            await self._error(call_id, "pi_turn_settling")
            return

        result = asyncio.get_running_loop().create_future()
        handle = self._next_handle()
        self._turn = AwaitingAcknowledgement(call_id, result, handle)
        try:
            command_id = await self.pi.command("prompt", message=request)
        except PiTUIBridgeError as exc:
            await self._error(call_id, "pi_rejected_message", reason=str(exc))
            self._turn = None
            return

        deferred = await self.sender.send_tool_deferred(
            call_id, handle, status_label="Pi",
        )
        if not deferred.accepted:
            self._turn = None
            try:
                await self.pi.command("abort")
            except PiTUIBridgeError:
                pass
            await self._error(
                call_id, Failure.DEFER_REJECTED.value,
                reason=deferred.reason or "rejected",
            )
            return
        if isinstance(self._turn, AwaitingAcknowledgement):
            early_events = tuple(self._turn.events)
            self._turn = AwaitingOwnership(call_id, result, command_id, handle)
            for event in early_events:
                await self._handle_event(event)
        outcome = await result
        if isinstance(outcome, Succeeded):
            result_name, event, message = "succeeded", "pi_settled", outcome.message
        elif isinstance(outcome, Failed):
            result_name, event, message = "failed", outcome.event.value, outcome.message
        else:
            result_name, event, message = "cancelled", "pi_turn_cancelled", ""
        content = {"event": event, "pi_response": message, "handle": handle}
        await self.sender.send_tool_result(
            call_id, content, outcome=result_name, verified=isinstance(outcome, Succeeded),
        )
        self._turn = None

    async def _steer(self, call_id: str, message: str) -> None:
        turn = self._turn
        if isinstance(turn, RunningTurn):
            for approval_id in tuple(turn.approvals):
                if turn.approvals.pop(approval_id, None) is None:
                    continue
                try:
                    await self.pi.command(
                        "approval_response", approvalId=approval_id, decision="block",
                    )
                except PiTUIBridgeError:
                    # The extension already resolved it (timeout, session grant, loss).
                    # Either way it no longer gates Pi; the steer decides the outcome.
                    pass
                await self._close_interaction(
                    turn.call_id, approval_id, InteractionClosure.SUPERSEDED,
                )
        try:
            await self.pi.command("steer", message=message)
        except PiTUIBridgeError as exc:
            await self._error(call_id, "pi_rejected_message", reason=str(exc))
            return
        await self._result(
            call_id,
            {"event": "pi_message_delivered", "mode": "steer", "task_status": "running"},
            verified=True,
        )

    async def _pi_approval(
        self, call_id: str, approval_id: str, decision: Decision,
    ) -> None:
        turn = self._turn
        if not isinstance(turn, RunningTurn) or approval_id not in turn.approvals:
            await self._error(call_id, "approval_not_pending")
            return
        turn.approvals.pop(approval_id)
        try:
            await self.pi.command(
                "approval_response", approvalId=approval_id, decision=decision.value,
            )
        except PiTUIBridgeError as exc:
            await self._close_interaction(
                turn.call_id, approval_id, InteractionClosure.EXPIRED,
            )
            await self._error(call_id, "pi_rejected_approval", reason=str(exc))
            return
        if decision is Decision.ALLOW_SESSION:
            other_approvals = tuple(
                pending_id for pending_id in turn.approvals if pending_id != approval_id
            )
            turn.approvals.clear()
            for pending_id in other_approvals:
                await self._close_interaction(
                    turn.call_id, pending_id, InteractionClosure.RESOLVED_FOR_SESSION,
                )
        await self._result(
            call_id,
            {
                "control": "approval", "status": "applied",
                "approval_id": approval_id, "decision": decision.value,
                "pi_task_status": "running", "task_result_available": False,
            },
            verified=True,
        )

    async def _pi_cancel(self, call_id: str) -> None:
        if not isinstance(
            self._turn, (AwaitingAcknowledgement, AwaitingOwnership, RunningTurn),
        ):
            await self._error(call_id, "no_active_pi_turn")
            return
        await self._request_cancel()
        await self._result(
            call_id,
            {
                "control": "cancellation", "status": "requested",
                "pi_task_status": "cancelling", "task_result_available": False,
            },
            verified=True,
        )

    async def _request_cancel(self) -> None:
        turn = self._turn
        if not isinstance(turn, (AwaitingAcknowledgement, AwaitingOwnership, RunningTurn)):
            return
        self._turn = CancellingTurn(turn.call_id, turn.result, turn.handle)
        try:
            await self.pi.command("abort")
        except PiTUIBridgeError:
            self._complete(Cancelled())

    async def _handle_event(self, event: PiEvent) -> None:
        turn = self._turn
        if turn is None or isinstance(turn, SettledTurn):
            return
        if isinstance(turn, CancellingTurn):
            if (
                event is Signal.AGENT_SETTLED or event is Signal.SESSION_LOST
                or isinstance(event, ProcessExited)
            ):
                self._complete(Cancelled())
            return
        if event is Signal.SESSION_LOST:
            self._complete(Failed(Failure.SESSION_LOST))
            return
        if isinstance(event, ProcessExited):
            self._complete(Failed(Failure.PROCESS_EXITED, str(event.status)))
            return
        if isinstance(turn, AwaitingOwnership):
            if isinstance(event, OwnedInput) and event.command_id == turn.command_id:
                self._turn = RunningTurn(turn.call_id, turn.result, turn.handle)
            elif isinstance(event, OwnedInput):
                self._complete(Failed(Failure.INPUT_MISMATCH))
            elif event is Signal.FOREIGN_INPUT:
                self._complete(Failed(Failure.UNRELATED_INPUT))
            else:
                self._complete(Failed(Failure.OWNERSHIP_UNCONFIRMED))
            return
        if not isinstance(turn, RunningTurn):
            return
        if event is Signal.FOREIGN_INPUT:
            self._complete(Failed(Failure.UNRELATED_INPUT))
        elif isinstance(event, OwnedInput):
            pass  # Pi emits another owned input when a later voice turn steers this episode.
        elif isinstance(event, ToolStarted):
            await self.sender.send_tool_partial_result(
                turn.call_id,
                {
                    "event": "pi_tool_started", "tool": event.name,
                    "arguments": event.arguments, "handle": turn.handle,
                },
            )
        elif isinstance(event, ApprovalRequested):
            if event.approval_id in turn.approvals:
                return
            turn.approvals[event.approval_id] = event
            await self._send_approval(turn, event)
        elif isinstance(event, ApprovalExpired):
            if event.approval_id in turn.approvals:
                turn.approvals.pop(event.approval_id)
                await self._close_interaction(
                    turn.call_id, event.approval_id, InteractionClosure.EXPIRED,
                )
        elif isinstance(event, MessageFailed):
            self._complete(Failed(Failure.MESSAGE_FAILED, event.error))
        elif isinstance(event, AssistantMessage):
            if event.text:
                turn.assistant_text = event.text
        elif event is Signal.AGENT_SETTLED:
            self._complete(Succeeded(turn.assistant_text))

    async def _send_approval(
        self, turn: RunningTurn, approval: ApprovalRequested,
    ) -> None:
        options = list(DECISION_LABELS.values())
        await self.sender.send_tool_partial_result(
            turn.call_id,
            {
                "event": "pi_approval_required", "approval_id": approval.approval_id,
                "tool": approval.tool, "summary": approval.summary,
                "decisions": [item.value for item in Decision], "handle": turn.handle,
            },
            interaction={
                "id": approval.approval_id,
                "prompt": (
                    f"Pi wants to run {approval.tool}: {approval.summary}. Ask the user to "
                    "allow once, allow for this session, or block. An unqualified approval "
                    "means allow once; session-wide approval must be explicit."
                ),
                "options": options,
                "resolver": {
                    "tool": "pi_approval",
                    "args": {"approval_id": approval.approval_id},
                    "option_args": {
                        label: {"decision": decision.value}
                        for decision, label in DECISION_LABELS.items()
                    },
                },
            },
        )

    async def _close_interaction(
        self,
        task_call_id: str,
        approval_id: str,
        closure: InteractionClosure,
    ) -> None:
        await self.sender.send_tool_interaction_update(
            task_call_id, approval_id, closure.state, note=closure.note,
        )

    def _complete(self, outcome: TerminalResult) -> None:
        turn = self._turn
        if turn is None or isinstance(turn, SettledTurn):
            return
        if not turn.result.done():
            turn.result.set_result(outcome)
        self._turn = SettledTurn()

    async def _result(
        self, call_id: str, content: dict, *, outcome: str = "succeeded",
        verified: bool = False,
    ) -> None:
        await self.sender.send_tool_result(
            call_id, content, outcome=outcome, verified=verified,
        )

    async def _error(self, call_id: str, event: str, **data) -> None:
        await self._result(call_id, {"event": event, **data}, outcome="failed")

    @staticmethod
    def _text(value) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None

    @classmethod
    def _parse_event(cls, event) -> PiEvent | None:
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            raise ValueError("malformed Pi event")
        kind = event["type"]
        if kind == "input_seen":
            owner, command_id = event.get("owner"), event.get("commandId")
            if owner == "bridge":
                parsed_id = cls._text(command_id)
                if parsed_id is None:
                    raise ValueError("malformed input ownership")
                return OwnedInput(parsed_id)
            if owner not in {"bridge", "interactive", "other"}:
                raise ValueError("malformed input ownership")
            return Signal.FOREIGN_INPUT
        if kind in {"session_shutdown", "bridge_disconnect", "bridge_replaced"}:
            return Signal.SESSION_LOST
        if kind == "process_exit":
            status = event.get("status")
            if type(status) is not int:
                raise ValueError("malformed process exit")
            return ProcessExited(status)
        if kind == "tool_execution_start":
            name, arguments = cls._text(event.get("toolName")), event.get("args")
            if name is None or not isinstance(arguments, dict):
                raise ValueError("malformed tool event")
            return ToolStarted(name, arguments)
        if kind == "approval_request":
            values = tuple(cls._text(event.get(key)) for key in ("approvalId", "toolName", "summary"))
            if not all(value is not None for value in values):
                raise ValueError("malformed approval request")
            return ApprovalRequested(*values)
        if kind == "approval_expired":
            approval_id = cls._text(event.get("approvalId"))
            if approval_id is None:
                raise ValueError("malformed approval expiry")
            return ApprovalExpired(approval_id)
        if kind == "message_end":
            message = event.get("message")
            if not isinstance(message, dict):
                raise ValueError("malformed terminal message")
            if message.get("stopReason") in {"error", "aborted"}:
                error = cls._text(message.get("errorMessage")) or "Pi stopped with an error."
                return MessageFailed(error)
            return AssistantMessage(cls._message_text(message))
        if kind == "agent_settled":
            return Signal.AGENT_SETTLED
        if kind == "extension_error":
            raise ValueError(cls._text(event.get("error")) or "unknown extension error")
        return None

    @staticmethod
    def _message_text(message: dict) -> str:
        if message.get("role") != "assistant":
            return ""
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if not isinstance(content, list):
            return ""
        return "\n".join(
            item["text"].strip()
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
            and isinstance(item.get("text"), str) and item["text"].strip()
        )
