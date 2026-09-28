"""Use the Dialt browser page as voice control for a visible Pi terminal."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import os
import shlex
import sys
import webbrowser
from pathlib import Path

from . import agent_tools, config, converse
from .agent_tools import PiControlRouter
from .bridge import BrowserBridge, ToolCall
from .localserver import LocalServer, ServerHandlers
from .pi_tui import PiTUIBridge, PiTUIBridgeError
from .session_trace import NullTrace, SessionTrace

DEFAULT_PORT = 8737
DEFAULT_PI_CMD = "pi --provider openai-codex"


def _session_handle() -> str:
    project = "".join(c if c.isalnum() else "-" for c in Path.cwd().name)[:32].strip("-")
    return f"code-{project or 'project'}-{os.urandom(3).hex()}"


def _ensure_api_key() -> str | None:
    key = config.get_api_key()
    if key:
        return key
    print("No Dialt API key found. Set DIALT_API_KEY or get one from the dialt.com dashboard.")
    key = getpass.getpass("Paste your API key (dk_…): ").strip()
    if key:
        config.save_api_key(key)
        print(f"Saved to {config.CONFIG_PATH}.")
    return key or None


async def _login(url: str) -> int:
    key = getpass.getpass("Paste your Dialt API key (dk_…): ").strip()
    if not key:
        print("No key given.")
        return 1
    if await converse.validate_key(key, url=url):
        config.save_api_key(key)
        print(f"Key is valid. Saved to {config.CONFIG_PATH}.")
        return 0
    print("That key was not accepted by the Dialt API.")
    return 1


async def _run(args, trace: SessionTrace | NullTrace) -> int:
    api_key = _ensure_api_key()
    if not api_key:
        print("Cannot start without an API key. Run: converse-code login", file=sys.stderr)
        return 1

    stopped = asyncio.Event()
    tool_tasks: set[asyncio.Task] = set()

    async def issue_credential(session_id: str) -> dict:
        credential = await converse.mint_session_credential(
            api_key, session_id, api_url=args.api_url,
        )
        return {
            **credential.as_payload(),
            "ws_url": args.broker_url,
            "tools": agent_tools.manifest(),
            "audio_diagnostics": trace.path is not None,
        }

    async def save_audio(turn_id: str, pcm16: bytes) -> None:
        trace.record_audio(turn_id, pcm16, sample_rate=16000)

    async def spawn_tool(call: ToolCall) -> None:
        trace.record("host", "tool_call_received", call={
            "id": call.call_id, "name": call.name, "args": call.arguments,
        })
        task = asyncio.create_task(router.handle_tool_call(call))
        tool_tasks.add(task)
        task.add_done_callback(tool_tasks.discard)

    async def handle_tab_message(frame: dict) -> None:
        await bridge.handle_browser_message(
            frame, on_tool_call=spawn_tool, on_tool_cancel=router.handle_tool_cancel,
            on_deferred_resume=router.handle_deferred_resume,
            on_cancelled_interactions=router.handle_cancelled_interactions,
            on_session_end=handle_native_session_end,
        )

    async def handle_pi_message(frame: dict) -> None:
        trace.record("pi", "event_received", frame=frame)
        event = await pi.handle_message(frame)
        if event is not None:
            await router.on_event(event)

    async def pi_connected() -> None:
        trace.record("pi_bridge", "connected")
        event = pi.connect()
        if event is not None:
            await router.on_event(event)

    async def pi_disconnected() -> None:
        trace.record("pi_bridge", "disconnected")
        await router.on_event(pi.disconnect())

    async def bridge_disconnected() -> None:
        await bridge.on_browser_disconnected()

    server = LocalServer(ServerHandlers(
        tab_message=handle_tab_message,
        tab_closed=bridge_disconnected,
        pi_message=handle_pi_message,
        pi_connected=pi_connected,
        pi_closed=pi_disconnected,
        session_credential=issue_credential,
        audio_capture=save_audio,
    ))
    bridge = BrowserBridge(server.send_json_to_tab, trace=trace.record)
    async def send_to_pi(frame: dict) -> bool:
        trace.record("pi_bridge", "command_sent", frame=frame)
        sent = await server.send_json_to_pi(frame)
        trace.record("pi_bridge", "command_delivery", id=frame.get("id"), sent=sent)
        return sent

    pi = PiTUIBridge(send_to_pi)
    async def handle_native_session_end() -> None:
        trace.record("host", "native_session_end")
        stopped.set()

    router = PiControlRouter(pi, bridge, handle=_session_handle())

    try:
        await server.start(port=args.port)
    except OSError as exc:
        print(
            f"Could not start the voice session server on port {args.port}: {exc}\n"
            "Another instance may be running; stop it or pass --port 0.",
            file=sys.stderr,
        )
        return 1
    try:
        if not await converse.validate_key(api_key, url=args.broker_url):
            await server.stop()
            print("Dialt rejected that API key. Run: converse-code login", file=sys.stderr)
            return 1
    except Exception as exc:  # noqa: BLE001 - normalize broker failures at the CLI boundary
        await server.stop()
        print(f"Could not reach Dialt ({exc}). Pi was not started.", file=sys.stderr)
        return 1

    environment = {**os.environ, "CONVERSE_CODE_PI_BRIDGE_URL": server.pi_url}
    try:
        pi_command = [*shlex.split(args.pi)]
        if args.continue_session:
            pi_command.append("--continue")
        pi_command.extend(["-e", str(Path(__file__).with_name("pi_bridge.ts"))])
        process = await asyncio.create_subprocess_exec(*pi_command, env=environment)
    except FileNotFoundError:
        await server.stop()
        print("Could not launch Pi. Install it first, then run converse-code again.", file=sys.stderr)
        return 1

    print(f"Dialt voice control: {server.url}")
    if trace.path is not None:
        print(f"Debug trace: {trace.path}")
        print(f"Debug audio: {trace.path.with_suffix('.audio')}")
    if not args.no_browser:
        webbrowser.open(server.url)
    process_wait = asyncio.create_task(process.wait())
    stop_wait = asyncio.create_task(stopped.wait())
    completed = set()
    try:
        completed, _ = await asyncio.wait(
            {process_wait, stop_wait}, return_when=asyncio.FIRST_COMPLETED,
        )
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if process_wait in completed and router.active_call_id:
            await router.on_event({"type": "process_exit", "status": process.returncode})
        elif router.active_call_id:
            await router.handle_tool_cancel(router.active_call_id)
        if tool_tasks:
            await asyncio.wait(tool_tasks, timeout=2)
        if process.returncode is None:
            try:
                await pi.command("shutdown")
                await asyncio.wait_for(process.wait(), timeout=5)
            except (PiTUIBridgeError, TimeoutError):
                process.terminate()
                await process.wait()
        for task in (process_wait, stop_wait):
            if not task.done():
                task.cancel()
        await asyncio.gather(process_wait, stop_wait, return_exceptions=True)
        await server.stop()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="converse-code",
        description=(
            "Minimal Dialt voice control for the visible Pi terminal. "
            "Reads the API key from DIALT_API_KEY (legacy CONVERSE_API_KEY) "
            "or the saved login."
        ),
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--pi", default=os.environ.get("CONVERSE_CODE_PI_CMD", DEFAULT_PI_CMD),
        help="Visible Pi TUI command",
    )
    parser.add_argument(
        "--broker-url",
        default=config.env("DIALT_URL", "CONVERSE_URL", converse.DEFAULT_WS_URL),
        help="Dialt realtime WebSocket URL (env DIALT_URL; legacy CONVERSE_URL)",
    )
    parser.add_argument(
        "--api-url",
        default=config.env("DIALT_API_URL", "CONVERSE_API_URL", converse.DEFAULT_API_URL),
        help="Dialt API origin for session keys (env DIALT_API_URL; legacy CONVERSE_API_URL)",
    )
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument(
        "--continue", dest="continue_session", action="store_true",
        help="continue Pi's most recent session in the current directory",
    )
    parser.add_argument(
        "--debug-log", metavar="PATH",
        help="append a sensitive, locally redacted JSONL session trace for debugging",
    )
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("login", help="store and validate a Dialt API key")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    trace = SessionTrace(args.debug_log) if args.debug_log else NullTrace()
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    exit_code = 1
    try:
        try:
            cwd = str(Path.cwd())
        except OSError:      # the launch directory can vanish under the shell (cleaned worktree)
            cwd = None
        trace.record("host", "session_start", cwd=cwd)
        if args.cmd == "login":
            exit_code = asyncio.run(_login(args.broker_url))
        else:
            exit_code = asyncio.run(_run(args, trace))
        trace.record("host", "session_end", exit_code=exit_code)
    finally:
        trace.close()
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
