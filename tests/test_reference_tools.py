import asyncio

from support import wait_until

from converse_code.agent_tools import PiControlRouter, manifest
from converse_code.bridge import DeferredAck, ToolCall
from converse_code.pi_tui import PiTUIBridgeError


class FakePi:
    def __init__(self):
        self.commands = []
        self.router = None
        self.next_id = 1

    async def command(self, kind, **fields):
        self.commands.append((kind, fields))
        response = f"fake-{self.next_id}"
        self.next_id += 1
        return response

    async def emit(self, event):
        await self.router.on_event(event)


class FakeSender:
    def __init__(self):
        self.timeline = []
        self.deferred = []
        self.partials = []
        self.interaction_updates = []
        self.results = []
        self.deferred_ack = DeferredAck(True, None)

    async def send_tool_deferred(self, call_id, handle, status_label):
        self.timeline.append("deferred")
        self.deferred.append((call_id, handle, status_label))
        return self.deferred_ack

    async def send_tool_partial_result(self, call_id, content, *, interaction=None):
        self.timeline.append("partial")
        self.partials.append((call_id, content, interaction))

    async def send_tool_interaction_update(
        self, call_id, interaction_id, state, *, note=None,
    ):
        self.timeline.append("interaction_update")
        self.interaction_updates.append((call_id, interaction_id, state, note))
        return {"applied": True, "reason": None}

    async def send_tool_result(self, call_id, content, **metadata):
        self.timeline.append("result")
        self.results.append((call_id, content, metadata))


def make_router(pi, sender):
    router = PiControlRouter(pi, sender, handle="pi-turn")
    pi.router = router
    return router


def task_call(call_id="message-1", message="Fix it"):
    return ToolCall(call_id, "pi_request", {"user_request": message})


async def start_task(pi, sender, message="Fix it"):
    router = make_router(pi, sender)
    running = asyncio.create_task(router.handle_tool_call(task_call(message=message)))
    await wait_until(lambda: pi.commands,
                     describe=lambda: "the prompt command never reached Pi")
    await pi.emit({"type": "input_seen", "owner": "bridge", "commandId": "fake-1"})
    return router, running


def test_manifest_exposes_only_human_equivalent_pi_controls():
    tools = {tool["name"]: tool for tool in manifest()}
    assert set(tools) == {"pi_request", "pi_approval", "pi_cancel"}
    assert tools["pi_request"]["deferred"] is True
    assert tools["pi_request"]["notify_on_complete"] is True
    assert set(tools["pi_request"]["parameters"]["properties"]) == {"user_request"}
    assert tools["pi_approval"]["resolver_only"] is True
    assert tools["pi_cancel"]["expected_duration"] == "instant"
    assert not any("wait_for_tool" in tool for tool in tools.values())
    assert tools["pi_approval"]["parameters"]["properties"]["decision"]["enum"] == [
        "allow_once", "allow_session", "block",
    ]
    approval_help = " ".join([
        tools["pi_approval"]["description"],
        tools["pi_approval"]["parameters"]["properties"]["decision"]["description"],
    ]).lower()
    assert "unqualified" in approval_help
    assert "allow_once" in approval_help
    assert "explicit" in approval_help
    assert "allow_session" in approval_help


async def test_idle_pi_message_owns_one_deferred_pi_episode_until_settlement():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender, "Open the game")

    assert pi.commands == [("prompt", {"message": "Open the game"})]
    assert sender.deferred == [("message-1", "pi-turn", "Pi")]

    await pi.emit({"type": "message_end", "message": {
        "role": "assistant", "content": [{"type": "text", "text": "Opened the game."}],
    }})
    await pi.emit({"type": "agent_settled"})
    await running

    assert sender.results == [(
        "message-1",
        {"event": "pi_settled", "pi_response": "Opened the game.", "handle": "pi-turn"},
        {"outcome": "succeeded", "verified": True},
    )]
    assert router.active_call_id is None


async def test_each_root_pi_episode_has_a_fresh_deferred_handle():
    pi, sender = FakePi(), FakeSender()
    router, first = await start_task(pi, sender, "First task")
    await pi.emit({"type": "message_end", "message": {
        "role": "assistant", "content": [{"type": "text", "text": "First done"}],
    }})
    await pi.emit({"type": "agent_settled"})
    await first

    second = asyncio.create_task(router.handle_tool_call(task_call("message-2", "Second task")))
    await wait_until(
        lambda: len(pi.commands) == 2,
        describe=lambda: "the second prompt never reached Pi",
    )
    await pi.emit({"type": "input_seen", "owner": "bridge", "commandId": "fake-2"})
    await pi.emit({"type": "message_end", "message": {
        "role": "assistant", "content": [{"type": "text", "text": "Second done"}],
    }})
    await pi.emit({"type": "agent_settled"})
    await second

    first_handle = sender.deferred[0][1]
    second_handle = sender.deferred[1][1]
    assert first_handle != second_handle
    assert sender.results[0][1]["handle"] == first_handle
    assert sender.results[1][1]["handle"] == second_handle


async def test_rejected_defer_aborts_pi_and_fails_the_parent_call():
    pi, sender = FakePi(), FakeSender()
    sender.deferred_ack = DeferredAck(False, "handle_in_use")
    router = make_router(pi, sender)

    await router.handle_tool_call(task_call())

    assert pi.commands == [
        ("prompt", {"message": "Fix it"}),
        ("abort", {}),
    ]
    assert sender.results == [(
        "message-1",
        {"event": "pi_defer_rejected", "reason": "handle_in_use"},
        {"outcome": "failed", "verified": False},
    )]
    assert router.active_call_id is None


async def test_pi_request_while_working_is_immediate_steering_not_another_background_job():
    class InputEchoPi(FakePi):
        async def command(self, kind, **fields):
            command_id = await super().command(kind, **fields)
            if kind == "steer":
                await self.emit({
                    "type": "input_seen", "owner": "bridge", "commandId": command_id,
                })
            return command_id

    pi, sender = InputEchoPi(), FakeSender()
    router, running = await start_task(pi, sender, "Build the game")

    await router.handle_tool_call(task_call("message-2", "Make it an airplane game"))

    assert pi.commands[-1] == ("steer", {"message": "Make it an airplane game"})
    assert len(sender.deferred) == 1
    assert sender.results[-1] == (
        "message-2",
        {"event": "pi_message_delivered", "mode": "steer", "task_status": "running"},
        {"outcome": "succeeded", "verified": True},
    )
    await pi.emit({"type": "message_end", "message": {
        "role": "assistant", "content": "Built the airplane game.",
    }})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_pi_request_before_initial_ownership_is_not_misrepresented_as_steering():
    pi, sender = FakePi(), FakeSender()
    router = make_router(pi, sender)
    running = asyncio.create_task(router.handle_tool_call(task_call()))
    await asyncio.sleep(0)

    await router.handle_tool_call(task_call("message-2", "Change direction"))

    assert pi.commands == [("prompt", {"message": "Fix it"})]
    assert sender.results[-1][0] == "message-2"
    assert sender.results[-1][1]["event"] == "pi_turn_starting"
    await pi.emit({"type": "input_seen", "owner": "bridge", "commandId": "fake-1"})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_approval_surfaces_as_a_queued_user_interaction():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender)

    await pi.emit({
        "type": "approval_request", "approvalId": "approval-7",
        "toolName": "bash", "summary": "uv run pytest -q",
    })

    assert sender.partials[-1] == (
        "message-1",
        {
            "event": "pi_approval_required", "approval_id": "approval-7",
            "tool": "bash", "summary": "uv run pytest -q",
            "decisions": ["allow_once", "allow_session", "block"],
            "handle": "pi-turn",
        },
        {
            "id": "approval-7",
            "prompt": (
                "Pi wants to run bash: uv run pytest -q. Ask the user to allow once, "
                "allow for this session, or block. An unqualified approval means allow once; "
                "session-wide approval must be explicit."
            ),
            "options": ["Allow once", "Allow for this session", "Block"],
            "resolver": {
                "tool": "pi_approval",
                "args": {"approval_id": "approval-7"},
                "option_args": {
                    "Allow once": {"decision": "allow_once"},
                    "Allow for this session": {"decision": "allow_session"},
                    "Block": {"decision": "block"},
                },
            },
        },
    )
    assert "speak" not in sender.partials[-1][1]

    await router.handle_tool_call(ToolCall(
        "approval-call", "pi_approval",
        {"approval_id": "approval-7", "decision": "allow_once"},
    ))
    assert pi.commands[-1] == (
        "approval_response", {"approvalId": "approval-7", "decision": "allow_once"},
    )
    assert sender.results[-1] == (
        "approval-call",
        {
            "control": "approval", "status": "applied",
            "approval_id": "approval-7", "decision": "allow_once",
            "pi_task_status": "running", "task_result_available": False,
        },
        {"outcome": "succeeded", "verified": True},
    )
    await pi.emit({"type": "message_end", "message": {"role": "assistant", "content": "Done"}})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_change_of_course_blocks_pending_approval_before_steering():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender, "Open the game")
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "open index.html",
    })

    await router.handle_tool_call(task_call("message-2", "Use a local server instead"))

    assert pi.commands[-2:] == [
        ("approval_response", {"approvalId": "approval-1", "decision": "block"}),
        ("steer", {"message": "Use a local server instead"}),
    ]
    assert sender.interaction_updates == [(
        "message-1", "approval-1", "superseded",
        "The user changed course; the Pi approval was blocked.",
    )]
    await router.handle_tool_call(ToolCall(
        "stale", "pi_approval",
        {"approval_id": "approval-1", "decision": "allow_once"},
    ))
    assert sender.results[-1][2]["outcome"] == "failed"
    await pi.emit({"type": "message_end", "message": {"role": "assistant", "content": "Done"}})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_steer_survives_an_approval_the_extension_already_resolved():
    class StaleApprovalPi(FakePi):
        async def command(self, kind, **fields):
            if kind == "approval_response":
                raise PiTUIBridgeError("approval is no longer pending")
            return await super().command(kind, **fields)

    pi, sender = StaleApprovalPi(), FakeSender()
    router, running = await start_task(pi, sender, "Open the game")
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "open index.html",
    })

    await router.handle_tool_call(task_call("message-2", "Use a local server instead"))

    assert pi.commands[-1] == ("steer", {"message": "Use a local server instead"})
    assert sender.interaction_updates[-1][2] == "superseded"
    assert sender.results[-1] == (
        "message-2",
        {"event": "pi_message_delivered", "mode": "steer", "task_status": "running"},
        {"outcome": "succeeded", "verified": True},
    )
    await pi.emit({"type": "message_end", "message": {"role": "assistant", "content": "Done"}})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_expired_approval_is_retracted_and_cannot_be_answered():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender)
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "uv run pytest -q",
    })

    await pi.emit({"type": "approval_expired", "approvalId": "approval-1"})

    assert sender.interaction_updates == [(
        "message-1", "approval-1", "cancelled",
        "The Pi approval expired unanswered.",
    )]

    await router.handle_tool_call(ToolCall(
        "late-answer", "pi_approval",
        {"approval_id": "approval-1", "decision": "allow_once"},
    ))
    assert sender.results[-1][0] == "late-answer"
    assert sender.results[-1][1]["event"] == "approval_not_pending"
    assert not any(kind == "approval_response" for kind, _ in pi.commands)

    await router.handle_tool_call(task_call("message-2", "Try lint instead"))
    assert pi.commands[-1] == ("steer", {"message": "Try lint instead"})
    await pi.emit({"type": "message_end", "message": {"role": "assistant", "content": "Done"}})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_deferred_resume_re_raises_each_still_pending_bound_approval():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender)
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "uv run pytest -q",
    })
    sender.partials.clear()

    await router.handle_deferred_resume("pi-turn")

    assert sender.partials == [(
        "message-1",
        {
            "event": "pi_approval_required", "approval_id": "approval-1",
            "tool": "bash", "summary": "uv run pytest -q",
            "decisions": ["allow_once", "allow_session", "block"],
            "handle": "pi-turn",
        },
        {
            "id": "approval-1",
            "prompt": (
                "Pi wants to run bash: uv run pytest -q. Ask the user to allow once, "
                "allow for this session, or block. An unqualified approval means allow once; "
                "session-wide approval must be explicit."
            ),
            "options": ["Allow once", "Allow for this session", "Block"],
            "resolver": {
                "tool": "pi_approval",
                "args": {"approval_id": "approval-1"},
                "option_args": {
                    "Allow once": {"decision": "allow_once"},
                    "Allow for this session": {"decision": "allow_session"},
                    "Block": {"decision": "block"},
                },
            },
        },
    )]
    await pi.emit({"type": "agent_settled"})
    await running


async def test_cancelled_bound_interaction_blocks_the_matching_pi_approval():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender)
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "open index.html",
    })

    await router.handle_cancelled_interactions(("approval-1",))

    assert pi.commands[-1] == (
        "approval_response", {"approvalId": "approval-1", "decision": "block"},
    )
    await router.handle_tool_call(ToolCall(
        "late-answer", "pi_approval",
        {"approval_id": "approval-1", "decision": "allow_once"},
    ))
    assert sender.results[-1][1]["event"] == "approval_not_pending"
    await pi.emit({"type": "agent_settled"})
    await running


async def test_expiry_during_an_acknowledged_approval_command_cannot_drop_its_result():
    class HeldApprovalPi(FakePi):
        def __init__(self):
            super().__init__()
            self.approval_started = asyncio.Event()
            self.release_approval = asyncio.Event()

        async def command(self, kind, **fields):
            response = await super().command(kind, **fields)
            if kind == "approval_response":
                self.approval_started.set()
                await self.release_approval.wait()
            return response

    pi, sender = HeldApprovalPi(), FakeSender()
    router, running = await start_task(pi, sender)
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "pwd",
    })
    approving = asyncio.create_task(router.handle_tool_call(ToolCall(
        "approval-call", "pi_approval",
        {"approval_id": "approval-1", "decision": "allow_once"},
    )))
    await pi.approval_started.wait()

    await pi.emit({"type": "approval_expired", "approvalId": "approval-1"})
    pi.release_approval.set()
    await approving

    assert sender.results[-1] == (
        "approval-call",
        {
            "control": "approval", "status": "applied",
            "approval_id": "approval-1", "decision": "allow_once",
            "pi_task_status": "running", "task_result_available": False,
        },
        {"outcome": "succeeded", "verified": True},
    )
    await pi.emit({"type": "agent_settled"})
    await running


async def test_expiry_during_approval_block_for_steer_cannot_drop_the_steer_result():
    class HeldBlockPi(FakePi):
        def __init__(self):
            super().__init__()
            self.block_started = asyncio.Event()
            self.release_block = asyncio.Event()

        async def command(self, kind, **fields):
            response = await super().command(kind, **fields)
            if kind == "approval_response":
                self.block_started.set()
                await self.release_block.wait()
            return response

    pi, sender = HeldBlockPi(), FakeSender()
    router, running = await start_task(pi, sender)
    await pi.emit({
        "type": "approval_request", "approvalId": "approval-1",
        "toolName": "bash", "summary": "pwd",
    })
    steering = asyncio.create_task(
        router.handle_tool_call(task_call("steer-call", "Use a different approach")),
    )
    await pi.block_started.wait()

    await pi.emit({"type": "approval_expired", "approvalId": "approval-1"})
    pi.release_block.set()
    await steering

    assert sender.results[-1] == (
        "steer-call",
        {"event": "pi_message_delivered", "mode": "steer", "task_status": "running"},
        {"outcome": "succeeded", "verified": True},
    )
    await pi.emit({"type": "agent_settled"})
    await running


async def test_approval_expiry_during_deferred_resume_does_not_mutate_iteration():
    class ExpiringSender(FakeSender):
        def __init__(self):
            super().__init__()
            self.router = None
            self.expired = False

        async def send_tool_partial_result(self, call_id, content, *, interaction=None):
            await super().send_tool_partial_result(
                call_id, content, interaction=interaction,
            )
            if self.expired or content.get("event") != "pi_approval_required":
                return
            self.expired = True
            await self.router.on_event({
                "type": "approval_expired", "approvalId": content["approval_id"],
            })

    pi, sender = FakePi(), ExpiringSender()
    router, running = await start_task(pi, sender)
    sender.router = router
    for approval_id in ("approval-1", "approval-2"):
        await pi.emit({
            "type": "approval_request", "approvalId": approval_id,
            "toolName": "bash", "summary": approval_id,
        })
    sender.expired = False
    sender.partials.clear()

    await router.handle_deferred_resume("pi-turn")

    assert any(
        interaction and interaction["id"] == "approval-2"
        for _call_id, _content, interaction in sender.partials
    )
    await pi.emit({"type": "agent_settled"})
    await running


async def test_allow_for_session_closes_other_approvals_resolved_out_of_band():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender)
    for approval_id, summary in (("approval-1", "pwd"), ("approval-2", "git status")):
        await pi.emit({
            "type": "approval_request", "approvalId": approval_id,
            "toolName": "bash", "summary": summary,
        })

    await router.handle_tool_call(ToolCall(
        "approval-call", "pi_approval",
        {"approval_id": "approval-1", "decision": "allow_session"},
    ))

    assert sender.interaction_updates == [(
        "message-1", "approval-2", "resolved",
        "Pi allowed protected actions for this session.",
    )]
    await router.handle_tool_call(ToolCall(
        "late-answer", "pi_approval",
        {"approval_id": "approval-2", "decision": "block"},
    ))
    assert sender.results[-1][1]["event"] == "approval_not_pending"
    await pi.emit({"type": "agent_settled"})
    await running


async def test_pi_cancel_aborts_only_the_active_pi_turn():
    pi, sender = FakePi(), FakeSender()
    router, running = await start_task(pi, sender)

    await router.handle_tool_call(ToolCall("cancel-1", "pi_cancel", {}))

    assert pi.commands[-1] == ("abort", {})
    assert sender.results[-1] == (
        "cancel-1", {
            "control": "cancellation", "status": "requested",
            "pi_task_status": "cancelling", "task_result_available": False,
        },
        {"outcome": "succeeded", "verified": True},
    )
    await pi.emit({"type": "agent_settled"})
    await running
    assert sender.results[-1][0] == "message-1"
    assert sender.results[-1][2] == {"outcome": "cancelled", "verified": False}


async def test_tool_activity_is_forwarded_as_generic_structured_partial():
    pi, sender = FakePi(), FakeSender()
    _, running = await start_task(pi, sender)

    await pi.emit({
        "type": "tool_execution_start", "toolCallId": "tool-1",
        "toolName": "custom_tool", "args": {"thing": "value"},
    })

    assert sender.partials[-1] == (
        "message-1",
        {
            "event": "pi_tool_started", "tool": "custom_tool",
            "arguments": {"thing": "value"}, "handle": "pi-turn",
        },
        None,
    )
    await pi.emit({"type": "message_end", "message": {"role": "assistant", "content": "Done"}})
    await pi.emit({"type": "agent_settled"})
    await running


async def test_malformed_arguments_and_stale_approvals_fail_before_side_effects():
    pi, sender = FakePi(), FakeSender()
    router = make_router(pi, sender)

    await router.handle_tool_call(ToolCall(
        "bad-message", "pi_request", {"user_request": ["Fix it"]},
    ))
    await router.handle_tool_call(ToolCall(
        "bad-approval", "pi_approval",
        {"approval_id": "missing", "decision": "allow_once"},
    ))

    assert pi.commands == []
    assert [result[2]["outcome"] for result in sender.results] == ["failed", "failed"]


async def test_unrelated_terminal_input_and_disconnect_fail_the_owned_episode_closed():
    for event in (
        {"type": "input_seen", "owner": "interactive"},
        {"type": "bridge_disconnect"},
        {"type": "process_exit", "status": 7},
    ):
        pi, sender = FakePi(), FakeSender()
        _, running = await start_task(pi, sender)
        await pi.emit(event)
        await running
        assert sender.results[-1][2]["outcome"] == "failed"


async def test_pi_activity_before_input_ownership_fails_without_leaking_a_partial():
    pi, sender = FakePi(), FakeSender()
    router = make_router(pi, sender)
    running = asyncio.create_task(router.handle_tool_call(task_call()))
    await asyncio.sleep(0)

    await pi.emit({
        "type": "tool_execution_start", "toolName": "bash", "args": {"command": "pwd"},
    })
    await running

    assert sender.partials == []
    assert sender.results[-1][1]["event"] == "pi_ownership_unconfirmed"
    assert sender.results[-1][2]["outcome"] == "failed"


async def test_events_racing_prompt_acknowledgement_are_delivered_after_deferred():
    class EagerPi(FakePi):
        async def command(self, kind, **fields):
            self.commands.append((kind, fields))
            if kind == "prompt":
                await self.emit({"type": "input_seen", "owner": "bridge", "commandId": "fake-1"})
                await self.emit({
                    "type": "tool_execution_start", "toolName": "edit",
                    "args": {"path": "raced.py"},
                })
                await self.emit({
                    "type": "message_end", "message": {
                        "role": "assistant", "content": "Done despite the race.",
                    },
                })
                await self.emit({"type": "agent_settled"})
                return "fake-1"
            return await super().command(kind, **fields)

    pi, sender = EagerPi(), FakeSender()
    router = make_router(pi, sender)
    await router.handle_tool_call(task_call())

    assert sender.timeline.index("deferred") < sender.timeline.index("partial")
    assert sender.timeline.index("deferred") < sender.timeline.index("result")
