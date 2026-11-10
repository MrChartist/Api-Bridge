"""The API key must not show up when an object is dumped by a logger, vars(), asdict, copy or pickle; plain http to another
computer is warned about; login --key says it is visible (audit F13)."""

from __future__ import annotations

import copy
import dataclasses
import io
import pickle
import sys
import warnings
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from mrchartist_bridge import __main__ as cli  # noqa: E402
from mrchartist_bridge.client import BridgeClient  # noqa: E402
from mrchartist_bridge.discovery import discover, is_loopback_url, normalize_url  # noqa: E402
from mrchartist_bridge.secret import SecretStr  # noqa: E402

KEY = "mcb_live_SECRETSECRET0123456789abcdefghijklmnop"


def test_client_attributes_do_not_hold_the_key_in_readable_form():
    c = BridgeClient("http://127.0.0.1:4300", api_key=KEY)
    assert KEY not in repr(vars(c))
    assert KEY not in repr(c)
    assert KEY not in repr(copy.deepcopy({k: v for k, v in vars(c).items() if k != '_opener'}))
    assert c.has_api_key


def test_the_key_still_builds_the_authorization_header():
    c = BridgeClient("http://127.0.0.1:4300", api_key=KEY)
    assert "Bearer " + c._BridgeClient__api_key == "Bearer " + KEY


def test_settings_asdict_repr_copy_and_pickle_are_masked():
    s = discover("http://127.0.0.1:4300", KEY, env={}, home=Path("/nonexistent-home"), cwd=Path("/nonexistent-cwd"))
    assert str(s.api_key) == KEY  # the client needs the real text
    for dumped in (repr(s), repr(dataclasses.asdict(s)), repr(copy.copy(s)), repr(copy.deepcopy(s)), repr(pickle.loads(pickle.dumps(s)))):
        assert KEY not in dumped
        assert "SECRETSECRET" not in dumped


def test_secret_str_behaves_like_a_string():
    k = SecretStr(KEY)
    assert k == KEY and bool(k) and len(k) == len(KEY)
    assert not SecretStr("")
    assert "Bearer " + k == "Bearer " + KEY
    assert repr(k) == "'***'"


def test_plain_http_to_another_computer_warns_and_loopback_does_not():
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        assert normalize_url("http://127.0.0.1:4300/") == "http://127.0.0.1:4300"
        assert normalize_url("http://localhost:4300") == "http://localhost:4300"
        assert normalize_url("http://[::1]:4300") == "http://[::1]:4300"
        assert normalize_url("https://bridge.example.com") == "https://bridge.example.com"
        assert w == []
    with pytest.warns(UserWarning, match="without encryption"):
        assert normalize_url("http://192.168.1.20:4300") == "http://192.168.1.20:4300"
    with pytest.warns(UserWarning):
        normalize_url("http://127.0.0.1.evil.com")
    assert is_loopback_url("http://127.0.0.1:1") and not is_loopback_url("http://127.0.0.1.evil.com")


def test_login_with_key_on_the_command_line_says_it_is_visible(monkeypatch, tmp_path):
    err = io.StringIO()
    monkeypatch.setattr(sys, "stderr", err)
    monkeypatch.setenv("MCB_HOME", str(tmp_path))
    try:
        cli._cli(["login", "--key", KEY, "--url", "http://127.0.0.1:1"])
    except Exception:  # noqa: BLE001  (the ping after saving fails: nothing listens on port 1)
        pass
    assert "visible to other users of this computer" in err.getvalue()
    assert KEY not in err.getvalue()
