"""API key storage: DIALT_API_KEY env var, else ~/.config/converse-code/config.json.

CONVERSE_API_KEY is still read as a fallback for existing setups.
"""

import json
import os
from pathlib import Path

CONFIG_PATH = Path("~/.config/converse-code").expanduser() / "config.json"
API_KEY_ENV = ("DIALT_API_KEY", "CONVERSE_API_KEY")


def env(name: str, legacy: str, default: str) -> str:
    """Read a Dialt environment variable, falling back to its Converse-era name."""
    return os.environ.get(name) or os.environ.get(legacy) or default


def get_api_key() -> str | None:
    for name in API_KEY_ENV:
        key = os.environ.get(name)
        if key:
            return key
    try:
        loaded = json.loads(CONFIG_PATH.read_text())
        data = loaded if isinstance(loaded, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    stored = data.get("api_key")
    return stored if isinstance(stored, str) and stored else None


def save_api_key(key: str) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Create with 0600 up front — writing first and chmod-ing after would leave
    # the key world-readable for a moment on a shared machine.
    fd = os.open(CONFIG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps({"api_key": key}, indent=2) + "\n")
    CONFIG_PATH.chmod(0o600)
