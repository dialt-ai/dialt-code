"""Acknowledged controls between the Dialt Browser SDK and a local tool host."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, NamedTuple


@dataclass
class Connected:
    sent: set[int] = field(default_factory=set)


class ToolCall(NamedTuple):
    call_id: str
    name: str
    arguments: dict


class InteractionUpdateAck(NamedTuple):
    applied: bool
    reason: str | None


class DeferredAck(NamedTuple):
    accepted: bool
    reason: str | None


class BrowserBridge:
    """Keep outbound controls until browser JavaScript confirms SDK delivery."""

    def __init__(
        self,
        send_to_tab: Callable[[dict], Awaitable[bool]],
        trace: Callable[..., None],
    ) -> None:
        self._send_to_tab = send_to_tab
        self._pending: dict[int, dict] = {}
        self._deferred_waiters: dict[int, asyncio.Future[DeferredAck]] = {}
        self._interaction_waiters: dict[int, asyncio.Future[InteractionUpdateAck]] = {}
        self._next_seq = 1
        self._delivery: Connected | None = None
        self._lock = asyncio.Lock()
        self._trace_callback = trace

    def _trace(self, event: str, **data: Any) -> None:
        self._trace_callback("browser_bridge", event, **data)

    async def on_browser_disconnected(self) -> None:
        self._trace("disconnected")
        async with self._lock:
            self._delivery = None

    async def handle_browser_message(
        self,
        message: dict,
        *,
        on_tool_call: Callable[[ToolCall], Awaitable[None]],
        on_tool_cancel: Callable[[str], Awaitable[None]],
        on_deferred_resume: Callable[[str], Awaitable[None]],
        on_cancelled_interactions: Callable[[tuple[str, ...]], Awaitable[None]],
        on_session_end: Callable[[], Awaitable[None]],
    ) -> None:
        if message.get("type") != "local":
            return
        event = message.get("event")
        if event == "bridge_ready":
            self._trace("ready")
            async with self._lock:
                self._delivery = Connected()
            await self._flush()
        elif event == "bridge_ack":
            seq = message.get("seq")
            if isinstance(seq, int):
                frame = self._pending.get(seq, {})
                interaction_ack = None
                deferred_ack = None
                if frame.get("action") == "tool_interaction_update":
                    interaction_ack = self._parse_interaction_ack(message.get("detail"), frame)
                    if interaction_ack is None:
                        self._trace("invalid_interaction_ack", seq=seq)
                        return
                elif frame.get("action") == "tool_deferred":
                    deferred_ack = self._parse_deferred_ack(message.get("detail"), frame)
                    if deferred_ack is None:
                        self._trace("invalid_deferred_ack", seq=seq)
                        return
                self._trace(
                    "control_acknowledged", seq=seq, action=frame.get("action"),
                )
                async with self._lock:
                    self._pending.pop(seq, None)
                    if self._delivery is not None:
                        self._delivery.sent.discard(seq)
                    deferred_waiter = self._deferred_waiters.pop(seq, None)
                    waiter = self._interaction_waiters.pop(seq, None)
                if (
                    deferred_waiter is not None and deferred_ack is not None
                    and not deferred_waiter.done()
                ):
                    deferred_waiter.set_result(deferred_ack)
                if waiter is not None and interaction_ack is not None and not waiter.done():
                    waiter.set_result(interaction_ack)
        elif event == "tool_call":
            call = message.get("call")
            if isinstance(call, dict):
                call_id, name, arguments = call.get("id"), call.get("name"), call.get("args")
                if (
                    isinstance(call_id, str) and call_id
                    and isinstance(name, str) and name
                    and isinstance(arguments, dict)
                ):
                    await on_tool_call(ToolCall(call_id, name, arguments))
        elif event == "tool_cancel":
            call = message.get("call")
            call_id = call.get("id") if isinstance(call, dict) else None
            if isinstance(call_id, str) and call_id:
                await on_tool_cancel(call_id)
        elif event == "tool_deferred_resume":
            handle = message.get("handle")
            if isinstance(handle, str) and handle:
                await on_deferred_resume(handle)
        elif event == "interaction_cancelled":
            interaction_ids = message.get("interaction_ids")
            if (
                isinstance(interaction_ids, list) and interaction_ids
                and all(isinstance(item, str) and item for item in interaction_ids)
            ):
                await on_cancelled_interactions(tuple(interaction_ids))
        elif event == "session_end":
            code, reason = message.get("code"), message.get("reason")
            if type(code) is int and code == 1000 and isinstance(reason, str):
                self._trace("session_end", code=code, reason=reason)
                await on_session_end()
        elif event == "end_session":
            self._trace("session_end", initiator="user")
            await on_session_end()
        elif event == "debug_trace":
            name = message.get("name")
            data = message.get("data")
            if isinstance(name, str) and isinstance(data, dict):
                self._trace_callback("browser", name, **data)

    async def _control(
        self,
        action: str,
        *,
        deferred_waiter: asyncio.Future[DeferredAck] | None = None,
        interaction_waiter: asyncio.Future[InteractionUpdateAck] | None = None,
        **fields,
    ) -> int:
        async with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            self._pending[seq] = {
                "type": "local", "event": "bridge_control",
                "seq": seq, "action": action, **fields,
            }
            if interaction_waiter is not None:
                self._interaction_waiters[seq] = interaction_waiter
            if deferred_waiter is not None:
                self._deferred_waiters[seq] = deferred_waiter
            self._trace("control_queued", seq=seq, action=action, fields=fields)
        await self._flush()
        return seq

    @staticmethod
    def _parse_deferred_ack(detail: object, frame: dict) -> DeferredAck | None:
        if not isinstance(detail, dict):
            return None
        reason = detail.get("reason")
        accepted = detail.get("accepted")
        if not (
            detail.get("type") == "tool_deferred_ack"
            and detail.get("id") == frame.get("id")
            and isinstance(accepted, bool)
            and (reason is None or isinstance(reason, str))
            and (not accepted or detail.get("handle") == frame.get("handle"))
        ):
            return None
        return DeferredAck(accepted, reason)

    @staticmethod
    def _parse_interaction_ack(detail: object, frame: dict) -> InteractionUpdateAck | None:
        if not isinstance(detail, dict):
            return None
        reason = detail.get("reason")
        if not (
            detail.get("type") == "tool_interaction_update_ack"
            and detail.get("id") == frame.get("id")
            and detail.get("interaction_id") == frame.get("interaction_id")
            and detail.get("state") == frame.get("state")
            and isinstance(detail.get("applied"), bool)
            and (reason is None or isinstance(reason, str))
        ):
            return None
        return InteractionUpdateAck(detail["applied"], reason)

    async def _flush(self) -> None:
        async with self._lock:
            delivery = self._delivery
            if delivery is None:
                return
            for seq, frame in self._pending.items():
                if seq in delivery.sent:
                    continue
                if not await self._send_to_tab(frame):
                    self._trace("control_send_failed", seq=seq, action=frame.get("action"))
                    self._delivery = None
                    return
                delivery.sent.add(seq)
                self._trace("control_sent", seq=seq, action=frame.get("action"))

    async def send_tool_result(
        self, call_id: str, content: dict, *,
        outcome: str = "unknown", verified: bool = False,
    ) -> None:
        await self._control(
            "tool_result", id=call_id, content=content,
            outcome=outcome, verified=verified,
        )

    async def send_tool_deferred(
        self, call_id: str, handle: str, status_label: str,
    ) -> DeferredAck:
        waiter = asyncio.get_running_loop().create_future()
        seq = await self._control(
            "tool_deferred", deferred_waiter=waiter,
            id=call_id, handle=handle, status_label=status_label,
        )
        try:
            async with asyncio.timeout(15):
                return await waiter
        except TimeoutError:
            async with self._lock:
                self._deferred_waiters.pop(seq, None)
            self._trace("deferred_ack_timeout", seq=seq, id=call_id, handle=handle)
            return DeferredAck(False, "ack_timeout")

    async def send_tool_partial_result(
        self,
        call_id: str,
        content: dict,
        *,
        interaction: dict | None = None,
    ) -> None:
        fields = {"id": call_id, "content": content}
        if interaction is not None:
            fields["interaction"] = interaction
        await self._control("tool_partial_result", **fields)

    async def send_tool_interaction_update(
        self,
        call_id: str,
        interaction_id: str,
        state: str,
        *,
        note: str | None = None,
    ) -> InteractionUpdateAck:
        waiter = asyncio.get_running_loop().create_future()
        fields = {
            "id": call_id, "interaction_id": interaction_id, "state": state,
        }
        if note is not None:
            fields["note"] = note
        seq = await self._control(
            "tool_interaction_update", interaction_waiter=waiter, **fields,
        )
        try:
            async with asyncio.timeout(15):
                return await waiter
        except TimeoutError:
            async with self._lock:
                self._interaction_waiters.pop(seq, None)
            self._trace("interaction_ack_timeout", seq=seq, interaction_id=interaction_id)
            return InteractionUpdateAck(False, "ack_timeout")
