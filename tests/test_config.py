import json

from converse_code import cli, config, converse


def test_non_object_or_non_string_config_never_becomes_an_api_key(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    monkeypatch.delenv("DIALT_API_KEY", raising=False)
    monkeypatch.delenv("CONVERSE_API_KEY", raising=False)

    for value in ([], {"api_key": 42}, {"api_key": ""}):
        path.write_text(json.dumps(value))
        assert config.get_api_key() is None


def test_saving_over_non_object_config_produces_a_valid_private_config(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    path.write_text("[]")
    monkeypatch.setattr(config, "CONFIG_PATH", path)

    config.save_api_key("ck_valid")

    assert json.loads(path.read_text()) == {"api_key": "ck_valid"}
    assert path.stat().st_mode & 0o777 == 0o600


def test_dialt_api_key_wins_and_converse_api_key_remains_a_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "missing.json")
    monkeypatch.setenv("CONVERSE_API_KEY", "ck_legacy")
    monkeypatch.delenv("DIALT_API_KEY", raising=False)
    assert config.get_api_key() == "ck_legacy"

    monkeypatch.setenv("DIALT_API_KEY", "dk_current")
    assert config.get_api_key() == "dk_current"


def test_dialt_env_names_win_over_converse_fallbacks(monkeypatch):
    monkeypatch.delenv("DIALT_URL", raising=False)
    monkeypatch.delenv("CONVERSE_URL", raising=False)
    assert config.env("DIALT_URL", "CONVERSE_URL", "wss://default") == "wss://default"

    monkeypatch.setenv("CONVERSE_URL", "wss://legacy")
    assert config.env("DIALT_URL", "CONVERSE_URL", "wss://default") == "wss://legacy"

    monkeypatch.setenv("DIALT_URL", "wss://current")
    assert config.env("DIALT_URL", "CONVERSE_URL", "wss://default") == "wss://current"


def test_cli_urls_read_dialt_names_then_converse_fallbacks(monkeypatch):
    for name in ("DIALT_URL", "CONVERSE_URL", "DIALT_API_URL", "CONVERSE_API_URL"):
        monkeypatch.delenv(name, raising=False)
    args = cli.build_parser().parse_args([])
    assert args.broker_url == converse.DEFAULT_WS_URL == "wss://api.dialt.com/v1/realtime"
    assert args.api_url == converse.DEFAULT_API_URL == "https://api.dialt.com"

    monkeypatch.setenv("CONVERSE_URL", "ws://legacy/ws")
    monkeypatch.setenv("CONVERSE_API_URL", "http://legacy")
    args = cli.build_parser().parse_args([])
    assert (args.broker_url, args.api_url) == ("ws://legacy/ws", "http://legacy")

    monkeypatch.setenv("DIALT_URL", "ws://current/v1/realtime")
    monkeypatch.setenv("DIALT_API_URL", "http://current")
    args = cli.build_parser().parse_args([])
    assert (args.broker_url, args.api_url) == ("ws://current/v1/realtime", "http://current")
