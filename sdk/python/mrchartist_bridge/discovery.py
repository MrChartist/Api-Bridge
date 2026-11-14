"""Where is the Bridge, and which API key should this script use? (standard library only)

``discover()`` looks, in this order, and remembers where each answer came from (``Settings.url_source`` and
``Settings.key_source``), so an error can say what to fix:

URL
    1. the ``base_url`` argument
    2. ``MCB_BRIDGE_URL``
    3. ``server.host`` / ``server.port`` of a ``bridge.config.json`` (``MCB_CONFIG``, then ``./bridge.config.json``,
       then the per-user folder: ``MCB_HOME``, else ``%APPDATA%\\MrChartist\\Bridge`` on Windows, else ``~/.mc-bridge``).
       Only a loopback host is taken from these files (a config file in some folder cannot send your key elsewhere); for a
       Bridge on another computer set ``MCB_BRIDGE_URL`` or ``base_url``, or write it to ``client.json``.
    4. ``http://127.0.0.1:4300``

API key
    1. the ``api_key`` argument
    2. ``MCB_API_KEY``
    3. the file named by ``MCB_API_KEY_FILE``
    4. ``client.json`` in the per-user folder (``{"baseUrl": ..., "apiKey": ...}``), written by
       ``python -m mrchartist_bridge login`` with owner-only permissions

It never reads the Bridge's data folder, its encrypted secrets or its control token: those are the Bridge's own, and
the control token is an admin credential that a script should not borrow. Keys are created with
``mc-bridge keys create``; the Bridge shows a key once, so save it with ``login`` or in your environment.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, Optional
from urllib.parse import urlsplit

from .secret import SecretStr

DEFAULT_BASE_URL = "http://127.0.0.1:4300"
CLIENT_FILE = "client.json"
CONFIG_FILE = "bridge.config.json"


@dataclass(frozen=True)
class Settings:
    base_url: str
    api_key: Optional[str]  # a SecretStr: repr, vars, copy, pickle and dataclasses.asdict show *** (str(key) is the real key)
    url_source: str
    key_source: str
    account: Optional[str] = None

    def __repr__(self) -> str:
        return "Settings(base_url=%r, api_key=%s, url_source=%r, key_source=%r)" % (self.base_url, "set" if self.api_key else "unset", self.url_source, self.key_source)


def home_dir(env: Optional[Mapping[str, str]] = None, platform: Optional[str] = None) -> Path:
    """The per-user Bridge folder (the same rule the Bridge itself uses)."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    if env.get("MCB_HOME"):
        return Path(env["MCB_HOME"]).expanduser().resolve()
    if platform.startswith("win") and env.get("APPDATA"):
        return Path(env["APPDATA"]) / "MrChartist" / "Bridge"
    return Path(env.get("HOME") or env.get("USERPROFILE") or str(Path.home())) / ".mc-bridge"


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _url_from_config(cfg: Mapping[str, Any]) -> Optional[str]:
    server = cfg.get("server")
    if not isinstance(server, Mapping):
        return None
    host = server.get("host") or "127.0.0.1"
    port = server.get("port") or 4300
    if not isinstance(host, str) or not isinstance(port, int) or isinstance(port, bool):
        return None
    if host in ("0.0.0.0", ""):
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    if host.strip("[]").lower() not in ("127.0.0.1", "localhost", "::1"):
        # A config file in the current folder must not be able to point your key at another computer.
        return None
    if ":" in host and not host.startswith("["):
        host = "[%s]" % host
    return "http://%s:%d" % (host, port)


def normalize_url(url: str) -> str:
    """Trim whitespace and a trailing slash; require http:// or https://. Raises ``ValueError`` with a fix."""
    u = url.strip().rstrip("/")
    if not u.lower().startswith(("http://", "https://")):
        raise ValueError("The Bridge URL must start with http:// or https:// (got %r). The default is %s." % (url, DEFAULT_BASE_URL))
    if u.lower().startswith("http://") and not is_loopback_url(u):
        warnings.warn(
            "The Bridge URL %s is plain http on another computer: your API key is sent without encryption. Use https://, or reach the Bridge through an SSH tunnel or a VPN." % u,
            UserWarning,
            stacklevel=3,
        )
    return u


def is_loopback_url(url: str) -> bool:
    """True for http(s)://127.x.x.x, localhost and [::1] (any port): the Bridge on this same computer."""
    host = (urlsplit(url).hostname or "").lower()
    return host == "localhost" or host == "::1" or re.fullmatch(r"127(\.\d{1,3}){3}", host) is not None


def discover(
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    *,
    account: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    cwd: Optional[Path] = None,
    home: Optional[Path] = None,
) -> Settings:
    """Work out the Bridge URL and API key (see the module docstring for the order)."""
    env = os.environ if env is None else env
    cwd = cwd or Path.cwd()
    home = home or home_dir(env)
    client = _read_json(home / CLIENT_FILE) or {}

    # URL
    url: Optional[str] = None
    url_source = "default"
    if base_url:
        url, url_source = base_url, "argument"
    elif env.get("MCB_BRIDGE_URL"):
        url, url_source = env["MCB_BRIDGE_URL"], "MCB_BRIDGE_URL"
    else:
        candidates = []
        if env.get("MCB_CONFIG"):
            candidates.append(Path(env["MCB_CONFIG"]))
        candidates += [cwd / CONFIG_FILE, home / CONFIG_FILE]
        for p in candidates:
            cfg = _read_json(p)
            found = _url_from_config(cfg) if cfg else None
            if found:
                url, url_source = found, str(p)
                break
        if url is None and isinstance(client.get("baseUrl"), str) and client["baseUrl"]:
            url, url_source = client["baseUrl"], str(home / CLIENT_FILE)
    url = normalize_url(url or DEFAULT_BASE_URL)

    # key
    key: Optional[str] = None
    key_source = "none"
    if api_key:
        key, key_source = api_key.strip(), "argument"
    elif env.get("MCB_API_KEY"):
        key, key_source = env["MCB_API_KEY"].strip(), "MCB_API_KEY"
    elif env.get("MCB_API_KEY_FILE"):
        try:
            key = Path(env["MCB_API_KEY_FILE"]).read_text(encoding="utf-8").strip() or None
        except OSError:
            key = None
        key_source = "MCB_API_KEY_FILE" if key else "none"
    if key is None and isinstance(client.get("apiKey"), str) and client["apiKey"]:
        key, key_source = client["apiKey"].strip(), str(home / CLIENT_FILE)

    acct = account or env.get("MCB_ACCOUNT") or (client.get("account") if isinstance(client.get("account"), str) else None)
    return Settings(url, SecretStr(key) if key else None, url_source, key_source, acct)


def save_credentials(base_url: Optional[str], api_key: str, *, account: Optional[str] = None, home: Optional[Path] = None) -> Path:
    """Write ``client.json`` in the per-user folder, readable by you only (mode 600 on Linux and macOS).

    Anyone who can read this file can use the key, exactly as with an environment variable in a shell profile: give it a
    read or paper scope, never ``live`` or ``admin``.
    """
    home = home or home_dir()
    home.mkdir(parents=True, exist_ok=True)
    path = home / CLIENT_FILE
    data: Dict[str, Any] = {"apiKey": api_key.strip()}
    if base_url:
        data["baseUrl"] = normalize_url(base_url)
    if account:
        data["account"] = account
    tmp = path.with_suffix(".tmp")
    try:
        tmp.unlink()  # a leftover file could have wider permissions than the ones set below
    except OSError:
        pass
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:  # Windows
        pass
    os.replace(str(tmp), str(path))
    return path
