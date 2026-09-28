"""Fixtures for actual Chromium tests of the shipped browser application."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

import pytest
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import async_playwright

from converse_code.localserver import LocalServer, ServerHandlers

FAKE_SDK = Path(__file__).with_name("fake_dialt.js")
ARTIFACTS = Path("test-results/browser")


def pytest_runtest_makereport(item, call):
    if call.when == "call":
        item._browser_e2e_failed = call.excinfo is not None


@pytest.fixture
async def browser_server():
    if os.environ.get("CONVERSE_CODE_BROWSER_E2E") != "1":
        pytest.skip("run real Chromium scenarios with: uv run scripts/browser_e2e.py")
    credentials = []
    tab_frames = []

    async def credential(session_id):
        credentials.append(session_id)
        return {
            "api_key": "browser-e2e-key",
            "session_id": session_id,
            "ws_url": "wss://invalid.browser-e2e.test/ws",
            "tools": [],
            "audio_diagnostics": True,
        }

    async def tab_frame(frame):
        tab_frames.append(frame)

    async def audio_capture(turn_id, pcm16):
        tab_frames.append({
            "event": "audio_capture", "turn_id": turn_id, "pcm16": pcm16,
        })

    async def ignore(*_args):
        pass

    server = LocalServer(ServerHandlers(
        tab_message=tab_frame, tab_closed=ignore,
        pi_message=ignore, pi_connected=ignore, pi_closed=ignore,
        session_credential=credential, audio_capture=audio_capture,
    ))
    await server.start(port=0)
    try:
        yield server, credentials, tab_frames
    finally:
        await server.stop()


@pytest.fixture
async def browser_page(request, browser_server):
    if os.environ.get("CONVERSE_CODE_BROWSER_E2E") != "1":
        pytest.skip("run real Chromium scenarios with: uv run scripts/browser_e2e.py")
    server, _, _ = browser_server
    test_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", request.node.nodeid)
    artifact_dir = ARTIFACTS / test_name
    wav_path = Path(os.environ["CONVERSE_CODE_TEST_WAV"]).resolve()
    errors = []

    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(
                headless=True,
                args=[
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    f"--use-file-for-fake-audio-capture={wav_path}%noloop",
                    "--autoplay-policy=no-user-gesture-required",
                ],
            )
        except PlaywrightError as exc:
            pytest.fail(f"Playwright Chromium could not launch; run playwright install chromium: {exc}")

        context = None
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 900})
            await context.grant_permissions(
                ["microphone"], origin=f"http://127.0.0.1:{server.port}"
            )
            await context.tracing.start(screenshots=True, snapshots=True, sources=True)
            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: errors.append(f"console.{message.type}: {message.text}")
                if message.type == "error"
                else None,
            )
            await page.add_init_script("globalThis.__fakeDialt = {}")
            await page.route(
                "**/vendor/dialt/index.js",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/javascript",
                    body=FAKE_SDK.read_text(),
                ),
            )
            await page.goto(server.url)
            await page.locator("#status").get_by_text("idle", exact=True).wait_for()
            try:
                yield page, errors
            finally:
                failed = getattr(request.node, "_browser_e2e_failed", False) or bool(errors)
                shutil.rmtree(artifact_dir, ignore_errors=True)
                if failed:
                    artifact_dir.mkdir(parents=True)
                    await page.screenshot(path=artifact_dir / "failure.png", full_page=True)
                    await context.tracing.stop(path=artifact_dir / "trace.zip")
                else:
                    await context.tracing.stop()
        finally:
            if context is not None:
                await context.close()
            await browser.close()
        if errors:
            pytest.fail("\n".join(errors))
