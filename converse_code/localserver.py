"""Local server for the Browser SDK reference client.

  /ws     acknowledged Browser SDK controls
  /pi     semantic controls for the visible Pi TUI extension
  /session-credential  mints a scoped credential for the direct Browser SDK

Everything here is reachable from any web page the dev happens to have open —
browsers don't apply same-origin policy to WebSockets, and a simple-content-type
POST needs no preflight. So all private endpoints require a per-run secret token
(`?t=…`), the page is served only to a request carrying it, and WebSocket
upgrades additionally must come from our own origin. Without this, a background
ad frame could evict the real tab or listen to the conversation.
"""

import hmac
import json
import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar
from urllib.parse import urlparse

from aiohttp import WSMsgType, web

log = logging.getLogger(__name__)
WEB_DIR = Path(__file__).parent / "web"

JsonHandler = Callable[[dict], Awaitable[None]]
ClosedHandler = Callable[[], Awaitable[None]]
CredentialHandler = Callable[[str], Awaitable[dict]]
AudioHandler = Callable[[str, bytes], Awaitable[None]]


@dataclass(frozen=True)
class ServerHandlers:
    tab_message: JsonHandler
    tab_closed: ClosedHandler
    pi_message: JsonHandler
    pi_connected: ClosedHandler
    pi_closed: ClosedHandler
    session_credential: CredentialHandler
    audio_capture: AudioHandler


@dataclass(frozen=True)
class StoppedServer:
    pass


@dataclass(frozen=True)
class RunningServer:
    runner: web.AppRunner
    port: int


class LocalServer:
    """One browser tab at a time (last authenticated connection wins)."""

    def __init__(self, handlers: ServerHandlers) -> None:
        self.token = secrets.token_urlsafe(24)
        self.handlers = handlers
        self._tab: web.WebSocketResponse | None = None
        self._pi: web.WebSocketResponse | None = None
        self._host = "127.0.0.1"
        self._runtime: StoppedServer | RunningServer = StoppedServer()

    async def start(self, port: int = 0) -> int:
        app = web.Application()
        app.router.add_get("/", self._index)
        app.router.add_get("/ws", self._ws)
        app.router.add_get("/pi", self._pi_ws)
        app.router.add_post("/session-credential", self._session_credential)
        app.router.add_post("/audio-diagnostic", self._audio_diagnostic)
        app.router.add_get("/vendor/dialt/{name}", self._vendor)
        if isinstance(self._runtime, RunningServer):
            raise RuntimeError("local server is already running")
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, self._host, port)
        await site.start()
        runtime = RunningServer(runner, runner.addresses[0][1])
        self._runtime = runtime
        return runtime.port

    @property
    def port(self) -> int:
        if isinstance(self._runtime, StoppedServer):
            raise RuntimeError("local server is not running")
        return self._runtime.port

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self.port}/?t={self.token}"

    @property
    def pi_url(self) -> str:
        return f"ws://{self._host}:{self.port}/pi?t={self.token}"

    async def stop(self) -> None:
        if self._tab is not None and not self._tab.closed:
            await self._tab.close()
        if self._pi is not None and not self._pi.closed:
            await self._pi.close()
        if isinstance(self._runtime, RunningServer):
            await self._runtime.runner.cleanup()
            self._runtime = StoppedServer()

    # -- auth --------------------------------------------------------------

    def _authorized(self, request: web.Request) -> bool:
        return hmac.compare_digest(request.query.get("t", ""), self.token)

    def _same_origin(self, request: web.Request) -> bool:
        """WebSocket upgrades must come from the page we served (or a non-browser
        client, which sends no Origin at all)."""
        origin = request.headers.get("Origin")
        if origin is None:
            return True
        try:
            parsed = urlparse(origin)
            return (
                parsed.scheme == "http"
                and parsed.hostname in {"127.0.0.1", "localhost"}
                and parsed.port == self.port
            )
        except ValueError:
            return False

    # -- outbound to the tab ---------------------------------------------

    async def send_json_to_tab(self, msg: dict) -> bool:
        return await self._send(self._tab, msg)

    async def send_json_to_pi(self, msg: dict) -> bool:
        return await self._send(self._pi, msg)

    @staticmethod
    async def _send(socket: web.WebSocketResponse | None, msg: dict) -> bool:
        if socket is not None and not socket.closed:
            try:
                await socket.send_str(json.dumps(msg))
                return True
            except ConnectionError:
                pass
        return False

    # -- handlers ----------------------------------------------------------

    # A cached page is indistinguishable from a fixed one, which has already cost
    # a debugging round — never let the browser keep these.
    NO_STORE: ClassVar[dict[str, str]] = {
        "Cache-Control": "no-store, must-revalidate",
        "Pragma": "no-cache",
    }

    async def _index(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            return web.Response(status=403, text="missing or bad token")
        return web.FileResponse(WEB_DIR / "index.html", headers=self.NO_STORE)

    async def _vendor(self, request: web.Request) -> web.StreamResponse:
        """Serve the vendored @dialt/sdk modules to the page.

        Deliberately not token-gated: an ES module's own static imports can't
        carry a query string, and these are bundled Apache-licensed client modules
        containing no secrets. The token still guards the page and socket.
        """
        name = request.match_info["name"]
        if not name.endswith(".js") or "/" in name or ".." in name:
            return web.Response(status=404, text="not found")
        path = WEB_DIR / "vendor" / "dialt" / name
        if not path.is_file():
            return web.Response(status=404, text="not found")
        return web.FileResponse(
            path, headers={**self.NO_STORE, "Content-Type": "application/javascript"}
        )

    async def _ws(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            # Usually a stale tab from a previous run retrying with an old token,
            # not an attack — hence debug, not warning.
            log.debug("rejected websocket with bad token")
            return web.Response(status=403, text="stale or missing token — reopen the printed URL")
        if not self._same_origin(request):
            log.warning("rejected websocket from foreign origin %r", request.headers.get("Origin"))
            return web.Response(status=403, text="forbidden")
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        previous = self._tab
        self._tab = ws
        if previous is not None and not previous.closed:
            await previous.close()
        log.info("browser tab connected")
        await self._receive_json(ws, self.handlers.tab_message, "tab")
        if self._tab is ws:
            self._tab = None
            await self.handlers.tab_closed()
        return ws

    async def _pi_ws(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request) or not self._same_origin(request):
            return web.Response(status=403, text="forbidden")
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        previous = self._pi
        self._pi = ws
        if previous is not None and not previous.closed:
            await previous.close()
        await self.handlers.pi_connected()
        await self._receive_json(ws, self.handlers.pi_message, "Pi extension")
        if self._pi is ws:
            self._pi = None
            await self.handlers.pi_closed()
        return ws

    @staticmethod
    async def _receive_json(
        socket: web.WebSocketResponse, handler: JsonHandler, source: str,
    ) -> None:
        async for message in socket:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                parsed = json.loads(message.data)
            except json.JSONDecodeError:
                log.warning("bad JSON from %s: %.100s", source, message.data)
                continue
            if not isinstance(parsed, dict):
                log.warning("non-object JSON from %s", source)
                continue
            await handler(parsed)

    async def _session_credential(self, request: web.Request) -> web.Response:
        if not self._authorized(request) or not self._same_origin(request):
            return web.json_response({"error": "forbidden"}, status=403)
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "invalid JSON object"}, status=400)
        session_id = body.get("session_id")
        if not isinstance(session_id, str) or not re.fullmatch(
            r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}", session_id,
        ):
            return web.json_response({"error": "invalid session_id"}, status=400)
        try:
            credential = await self.handlers.session_credential(session_id)
        except Exception:
            log.exception("could not mint browser session credential")
            return web.json_response({"error": "could not reach Dialt"}, status=502)
        return web.json_response(credential, status=201)

    async def _audio_diagnostic(self, request: web.Request) -> web.Response:
        if not self._authorized(request) or not self._same_origin(request):
            return web.json_response({"error": "forbidden"}, status=403)
        turn_id = request.headers.get("X-Turn-Id", "")
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", turn_id):
            return web.json_response({"error": "invalid turn id"}, status=400)
        body = bytearray()
        async for chunk in request.content.iter_chunked(64 * 1024):
            body.extend(chunk)
            if len(body) > 16 * 1024 * 1024:
                return web.json_response({"error": "audio capture too large"}, status=413)
        if not body or len(body) % 2:
            return web.json_response({"error": "invalid PCM16 payload"}, status=400)
        await self.handlers.audio_capture(turn_id, bytes(body))
        return web.json_response({"saved": True}, status=201)
