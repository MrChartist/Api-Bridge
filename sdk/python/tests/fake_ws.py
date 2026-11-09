"""A tiny fake of the Bridge's stream endpoint for tests (standard library only).

``POST /v1/stream/token`` returns a token; ``GET /v1/stream?token=...`` upgrades to a WebSocket and plays a script.
``FakeStream(script)`` takes one script per connection (the first connection plays ``script[0]``, the second
``script[1]`` and so on; the last one repeats). A script is a list of steps:

    {"type": "tick", ...}      a JSON message, sent as a text frame (``seq`` is added unless you give one)
    ("wait_op", "subscribe")   block until the client sent an op of that kind
    ("sleep", 0.05)
    "close"                    close the connection (the client should reconnect)

Every op the client sent is kept in ``received`` (a list per connection).
"""

from __future__ import annotations

import base64
import hashlib
import json
import socket
import struct
import threading
import time
from typing import Any, Dict, List, Optional

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
KEY = "mcb_test_stream_key"


def _read_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def _send_frame(sock: socket.socket, opcode: int, payload: bytes) -> None:
    n = len(payload)
    head = bytearray([0x80 | opcode])
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += struct.pack("!H", n)
    else:
        head.append(127)
        head += struct.pack("!Q", n)
    sock.sendall(bytes(head) + payload)


def _read_frame(sock: socket.socket) -> Optional[bytes]:
    b1, b2 = _read_exact(sock, 2)
    opcode, n = b1 & 0x0F, b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", _read_exact(sock, 2))[0]
    elif n == 127:
        n = struct.unpack("!Q", _read_exact(sock, 8))[0]
    mask = _read_exact(sock, 4) if b2 & 0x80 else b"\0\0\0\0"
    data = bytes(b ^ mask[i % 4] for i, b in enumerate(_read_exact(sock, n)))
    if opcode == 0x8:
        return None
    return data


class FakeStream:
    def __init__(self, script: List[List[Any]]) -> None:
        self.script = script
        self.received: List[List[Dict[str, Any]]] = []
        self.tokens: List[str] = []
        self.connections = 0
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(8)
        self.url = "http://127.0.0.1:%d" % self._srv.getsockname()[1]
        self._stop = False
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop = True
        try:
            self._srv.close()
        except OSError:
            pass

    def _accept(self) -> None:
        while not self._stop:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        try:
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
            head, _, rest = buf.partition(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers = {l.split(":", 1)[0].strip().lower(): l.split(":", 1)[1].strip() for l in lines[1:] if ":" in l}
            if method == "POST" and target.startswith("/v1/stream/token"):
                n = int(headers.get("content-length") or 0)
                if n:
                    _read_exact(conn, max(0, n - len(rest)))
                tok = "tok_%d" % (len(self.tokens) + 1)
                self.tokens.append(tok)
                body = json.dumps({"data": {"token": tok, "expiresAt": "2026-10-30T10:01:00+05:30"}, "meta": {}}).encode()
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
                return
            if method == "GET" and target.startswith("/v1/stream") and "websocket" in headers.get("upgrade", "").lower():
                accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
                conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
                self._play(conn)
                return
            conn.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _play(self, conn: socket.socket) -> None:
        idx = self.connections
        self.connections += 1
        ops: List[Dict[str, Any]] = []
        self.received.append(ops)

        def reader() -> None:
            try:
                while True:
                    data = _read_frame(conn)
                    if data is None:
                        return
                    ops.append(json.loads(data))
            except (ConnectionError, OSError, ValueError):
                return

        threading.Thread(target=reader, daemon=True).start()
        steps = self.script[min(idx, len(self.script) - 1)]
        seq = 0
        for step in steps:
            if step == "close":
                try:
                    _send_frame(conn, 0x8, struct.pack("!H", 1001))
                except OSError:
                    pass
                return
            if isinstance(step, tuple):
                if step[0] == "sleep":
                    time.sleep(step[1])
                elif step[0] == "wait_op":
                    end = time.time() + 3
                    while time.time() < end and not any(o.get("op") == step[1] for o in ops):
                        time.sleep(0.01)
                continue
            seq += 1
            msg = dict(step)
            msg.setdefault("seq", seq)
            _send_frame(conn, 0x1, json.dumps(msg).encode())
        time.sleep(0.2)
