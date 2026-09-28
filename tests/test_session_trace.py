import json
import stat
import wave

from converse_code.session_trace import SessionTrace


def test_session_trace_writes_timestamped_jsonl_and_redacts_credentials(tmp_path):
    path = tmp_path / "session.jsonl"
    trace = SessionTrace(path)
    trace.record(
        "browser",
        "credential_received",
        api_key="ck_never-write-this",
        nested={"session_token": "secret-token", "command": "pwd"},
        url="http://127.0.0.1:8737/?t=local-secret",
        command=(
            "OPENAI_API_KEY=sk-inline-secret --token ghp_inline_secret "
            "--password do-not-write"
        ),
    )
    trace.close()

    entry = json.loads(path.read_text().strip())
    assert entry["source"] == "browser"
    assert entry["event"] == "credential_received"
    assert entry["timestamp"].endswith("Z")
    assert entry["session_id"]
    assert entry["data"]["api_key"] == "[REDACTED]"
    assert entry["data"]["nested"] == {
        "session_token": "[REDACTED]", "command": "pwd",
    }
    assert entry["data"]["url"] == "http://127.0.0.1:8737/?t=[REDACTED]"
    assert entry["data"]["command"] == (
        "OPENAI_API_KEY=[REDACTED] --token [REDACTED] --password [REDACTED]"
    )
    contents = path.read_text()
    assert "ck_never-write-this" not in contents
    assert "sk-inline-secret" not in contents
    assert "ghp_inline_secret" not in contents
    assert "do-not-write" not in contents
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_session_trace_redacts_dialt_and_legacy_keys_in_free_text(tmp_path):
    path = tmp_path / "session.jsonl"
    trace = SessionTrace(path)
    trace.record("host", "note", text="pasted dk_new-secret then ck_old-secret")
    trace.close()

    entry = json.loads(path.read_text().strip())
    assert entry["data"]["text"] == "pasted [REDACTED] then [REDACTED]"


def test_session_trace_appends_distinct_sessions(tmp_path):
    path = tmp_path / "session.jsonl"
    first = SessionTrace(path)
    first.record("host", "session_start")
    first.close()
    second = SessionTrace(path)
    second.record("host", "session_start")
    second.close()

    entries = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(entries) == 2
    assert entries[0]["session_id"] != entries[1]["session_id"]


def test_session_trace_saves_received_assistant_pcm_as_private_wav(tmp_path):
    path = tmp_path / "session.jsonl"
    trace = SessionTrace(path)

    audio_path = trace.record_audio("reply/unsafe", b"\x01\x00\x02\x00", sample_rate=16000)
    trace.close()

    assert audio_path.parent == tmp_path / "session.audio"
    assert "/" not in audio_path.name
    assert stat.S_IMODE(audio_path.stat().st_mode) == 0o600
    with wave.open(str(audio_path), "rb") as audio:
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getframerate() == 16000
        assert audio.readframes(2) == b"\x01\x00\x02\x00"
    event = json.loads(path.read_text().strip())
    assert event["event"] == "assistant_audio_saved"
    assert event["data"]["turn_id"] == "reply/unsafe"
    assert event["data"]["sample_count"] == 2
