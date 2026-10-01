"""Exercise the installed console entry point and visible Pi launch contract."""

import asyncio
import json
import os
import socket
import subprocess
import sys

import websockets

ENTRY = [sys.executable, "-m", "converse_code.cli"]


def run(args, env_extra=None, timeout=30):
    env = {**os.environ, "DIALT_API_KEY": "dk_fake_for_test", **(env_extra or {})}
    return subprocess.run(
        ENTRY + args,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        check=False,
    )


def test_startup_checks_credentials_before_launching_pi():
    proc = run(["--no-browser", "--port", "0", "--broker-url", "ws://127.0.0.1:1"])
    assert proc.returncode == 1
    assert "Could not reach Dialt" in proc.stderr
    assert "Pi was not started" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_port_in_use_reports_cleanly():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    try:
        proc = run(["--no-browser", "--port", str(sock.getsockname()[1])])
        assert proc.returncode == 1
        assert "Could not start the voice session server" in proc.stderr
        assert "--port" in proc.stderr
        assert "Traceback" not in proc.stderr
    finally:
        sock.close()


def test_debug_log_retains_failed_startup_session_evidence(tmp_path):
    path = tmp_path / "trace.jsonl"
    proc = run([
        "--debug-log", str(path), "--no-browser", "--port", "0",
        "--broker-url", "ws://127.0.0.1:1",
    ])

    assert proc.returncode == 1
    entries = [json.loads(line) for line in path.read_text().splitlines()]
    assert [entry["event"] for entry in entries] == ["session_start", "session_end"]
    assert "argv" not in entries[0]["data"]
    assert entries[-1]["data"]["exit_code"] == 1


async def test_successful_start_launches_pi_with_continuation_and_semantic_extension(tmp_path):
    async def accept_key(websocket):
        await websocket.recv()
        await websocket.send(json.dumps({"type": "ok"}))

    args_path = tmp_path / "pi-args"
    fake_pi = tmp_path / "pi"
    fake_pi.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CONVERSE_CODE_TEST_PI_ARGS\"\n"
    )
    fake_pi.chmod(0o755)
    server = await websockets.serve(accept_key, "127.0.0.1", 0)
    broker_url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    environment = {
        **os.environ,
        "DIALT_API_KEY": "dk_fake_for_test",
        "CONVERSE_CODE_TEST_PI_ARGS": str(args_path),
    }
    try:
        process = await asyncio.create_subprocess_exec(
            *ENTRY, "--no-browser", "--port", "0", "--broker-url", broker_url,
            "--pi", str(fake_pi), "--continue", env=environment,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
    finally:
        server.close()
        await server.wait_closed()

    assert process.returncode == 0, stderr.decode()
    launched_args = args_path.read_text().splitlines()
    assert "--continue" in launched_args
    extension_index = launched_args.index("-e")
    assert launched_args[extension_index + 1].endswith("/pi_bridge.ts")
