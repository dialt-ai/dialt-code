import json
from contextlib import asynccontextmanager

import pytest
import websockets
from aiohttp import web

from converse_code.converse import (
    CredentialError,
    mint_session_credential,
    validate_key,
)


@asynccontextmanager
async def credential_endpoint(issue):
    app = web.Application()
    app.router.add_post("/v1/session-keys", issue)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


async def test_validate_key_uses_non_billable_auth_frame():
    async def handler(ws):
        request = json.loads(await ws.recv())
        accepted = request.get("api_key") == "ck_good"
        await ws.send(json.dumps({"type": "ok" if accepted else "error"}))

    server = await websockets.serve(handler, "127.0.0.1", 0)
    url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    try:
        assert await validate_key("ck_good", url=url) is True
        assert await validate_key("bad", url=url) is False
    finally:
        server.close()
        await server.wait_closed()


async def test_mint_session_credential_keeps_persistent_key_server_side():
    seen = {}

    async def issue(request):
        seen["authorization"] = request.headers.get("Authorization")
        seen["body"] = await request.json()
        return web.json_response({
            "api_key": "csk_scoped", "session_id": seen["body"]["session_id"],
            "expires_in": 600,
        }, status=201)

    async with credential_endpoint(issue) as base:
        credential = await mint_session_credential("ck_persistent", "browser-session", base)

    assert seen == {
        "authorization": "Bearer ck_persistent",
        "body": {"session_id": "browser-session"},
    }
    assert credential.as_payload() == {
        "api_key": "csk_scoped", "session_id": "browser-session", "expires_in": 600,
    }


async def test_mint_session_credential_rejects_bad_upstream_response():
    async def issue(_request):
        return web.json_response({"error": "unauthorized"}, status=401)

    async with credential_endpoint(issue) as base:
        with pytest.raises(CredentialError, match="401"):
            await mint_session_credential("bad", "browser-session", base)


@pytest.mark.parametrize("invalid", [
    {"expires_in": True},
    {"expires_in": 0},
    {"api_key": ""},
    {"session_id": "someone-else"},
])
async def test_mint_session_credential_rejects_invalid_upstream_payloads(invalid):
    valid = {"api_key": "csk_scoped", "session_id": "browser-session", "expires_in": 600}

    async def issue(_request):
        return web.json_response({**valid, **invalid}, status=201)

    async with credential_endpoint(issue) as base:
        with pytest.raises(CredentialError, match="invalid response"):
            await mint_session_credential("key", "browser-session", base)
