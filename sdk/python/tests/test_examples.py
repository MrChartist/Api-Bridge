"""The data examples compile, and the ones that finish run against the fake Bridge."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from fake_data import bars  # noqa: E402

EXAMPLES = ROOT / "examples"
NEW = ["download_save.py", "collections_and_datasets.py", "record_chains.py", "events_listen.py", "webhook_receiver.py", "history_all.py"]


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


def run(fake, script, *args, cwd, extra_env=None):
    env = dict(os.environ, MCB_BRIDGE_URL=fake.url, MCB_API_KEY=KEY, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1", **(extra_env or {}))
    env.pop("HTTPS_PROXY", None)
    return subprocess.run([sys.executable, str(EXAMPLES / script), *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("name", NEW)
def test_example_compiles(name):
    compile((EXAMPLES / name).read_text(), name, "exec")


def test_download_save_runs(fake, tmp_path):
    r = run(fake, "download_save.py", str(tmp_path / "data"), cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert "saved" in r.stdout and "6 rows" in r.stdout
    assert (tmp_path / "data" / "manifest.json").exists()


def test_collections_and_datasets_runs(fake, tmp_path):
    fake.data.history_series["NSE:TCS"] = bars(1_760_000_000, 3)
    fake.data.local_range = (1_759_000_000, 1_770_000_000)
    r = run(fake, "collections_and_datasets.py", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert "43 symbols" in r.stdout and "ATM 26000" in r.stdout and "3 bars" in r.stdout


def test_record_chains_runs(fake, tmp_path):
    r = run(fake, "record_chains.py", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert "rule rule_" in r.stdout and "running" in r.stdout


def test_history_all_runs(fake, tmp_path):
    fake.data.history_series["NSE:RELIANCE"] = bars(1_760_000_000, 20)
    r = run(fake, "history_all.py", "NSE:RELIANCE", "5m", "2025-10-01", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert "20 candles" in r.stdout and "label: realtime" in r.stdout and r.stdout.count("time,open,high") == 1
