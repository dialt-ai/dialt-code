"""Server-side authentication helpers for direct Browser SDK sessions."""

import asyncio
import json
from dataclasses import asdict, dataclass

import aiohttp
import websockets

DEFAULT_WS_URL = "wss://api.dialt.com/v1/realtime"
DEFAULT_API_URL = "https://api.dialt.com"


class CredentialError(RuntimeError):
    pass


@dataclass(frozen=True)
class SessionCredential:
    api_key: str
    session_id: str
    expires_in: int

    def as_payload(self) -> dict:
        return asdict(self)


async def validate_key(api_key: str, url: str = DEFAULT_WS_URL) -> bool:
    """Check a persistent key with the broker's non-billable auth frame."""
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "auth", "api_key": api_key}))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        return isinstance(reply, dict) and reply.get("type") == "ok"


async def mint_session_credential(
    api_key: str,
    session_id: str,
    api_url: str = DEFAULT_API_URL,
) -> SessionCredential:
    """Exchange the server-held key for one browser-safe scoped credential."""
    endpoint = f"{api_url.rstrip('/')}/v1/session-keys"
    async with (
        aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session,
        session.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"session_id": session_id},
            allow_redirects=False,
        ) as response,
    ):
        try:
            body = await response.json()
        except (aiohttp.ContentTypeError, ValueError) as exc:
            raise CredentialError(
                f"Dialt credential endpoint returned HTTP {response.status}"
            ) from exc
        if response.status != 201:
            raise CredentialError(
                f"Dialt credential endpoint returned HTTP {response.status}"
            )
    if (
        not isinstance(body, dict)
        or not isinstance(body.get("api_key"), str)
        or not body["api_key"]
        or body.get("session_id") != session_id
        or type(body.get("expires_in")) is not int
        or body["expires_in"] <= 0
    ):
        raise CredentialError("Dialt credential endpoint returned an invalid response")
    return SessionCredential(body["api_key"], body["session_id"], body["expires_in"])
