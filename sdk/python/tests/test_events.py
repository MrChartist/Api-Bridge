"""Event subscription (SSE with reconnect and cursor) and webhook signature verification, against the fake Bridge."""

from __future__ import annotations

import hashlib
import hmac
import sys
import threading
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from mrchartist_bridge import Bridge, SignatureInvalid, Unauthenticated, sign_payload, verify_request, verify_signature  # noqa: E402
from mrchartist_bridge.events import _event_from, parse_sse, topic_matches  # noqa: E402

SECRET = "a-long-enough-secret-value"


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


@pytest.fixture()
def bridge(fake):
    waits = []
    b = Bridge(fake.url, KEY, account="paper", sleep=waits.append)
    b.waits = waits
    return b


def take(sub, n):
    out = []
    for ev in sub:
        out.append(ev)
        if len(out) >= n:
            sub.close()
    return out


# ── signatures ──


def test_a_signature_made_by_the_sender_verifies():
    body = b'{"topic":"download.done","data":{"id":"dl_1"}}'
    header = sign_payload(SECRET, body, 1_800_000_000)
    assert header.startswith("t=1800000000,v1=") and len(header) == len("t=1800000000,v1=") + 64
    # the documented construction: HMAC-SHA256(secret, "<t>." + raw body)
    want = hmac.new(SECRET.encode(), b"1800000000." + body, hashlib.sha256).hexdigest()
    assert header.endswith(want)
    assert verify_signature(SECRET, body, header, now=1_800_000_100) is True
    assert verify_signature(SECRET.encode(), body.decode(), header, now=1_800_000_100) is True  # text or bytes, secret as text or bytes


def test_a_changed_body_secret_or_timestamp_fails():
    body = b'{"x":1}'
    h = sign_payload(SECRET, body, 1_800_000_000)
    assert not verify_signature(SECRET, b'{"x":2}', h, now=1_800_000_000)
    assert not verify_signature("another-secret-value", body, h, now=1_800_000_000)
    forged = h.replace("t=1800000000", "t=1800000001")
    assert not verify_signature(SECRET, body, forged, now=1_800_000_001)
    # whitespace changes the raw bytes: re-serialised JSON must not verify
    assert not verify_signature(SECRET, b'{"x": 1}', h, now=1_800_000_000)


def test_old_and_future_timestamps_are_refused_but_the_window_is_adjustable():
    body = b"{}"
    h = sign_payload(SECRET, body, 1_800_000_000)
    assert verify_signature(SECRET, body, h, now=1_800_000_300)
    assert not verify_signature(SECRET, body, h, now=1_800_000_301)
    assert not verify_signature(SECRET, body, h, now=1_799_999_600)
    assert verify_signature(SECRET, body, h, now=1_800_000_900, tolerance_sec=1000)


def test_missing_or_malformed_headers_and_the_reason():
    for header, reason in ((None, "missing_header"), ("", "missing_header"), ("garbage", "malformed_header"), ("t=abc,v1=" + "0" * 64, "malformed_header"), ("t=1800000000", "malformed_header"),
                           ("t=1800000000,v1=short", "malformed_header"), ("t=1800000000,v1=" + "0" * 64, "signature_mismatch")):
        assert verify_signature(SECRET, b"{}", header, now=1_800_000_000) is False
        with pytest.raises(SignatureInvalid) as e:
            verify_signature(SECRET, b"{}", header, now=1_800_000_000, raise_on_fail=True)
        assert e.value.reason == reason
    with pytest.raises(SignatureInvalid) as e:
        verify_signature(SECRET, b"{}", sign_payload(SECRET, b"{}", 1), now=1_800_000_000, raise_on_fail=True)
    assert e.value.reason == "timestamp_out_of_range"


def test_secret_rotation_either_side():
    body = b"{}"
    old, new = "old-secret-old-secret", "new-secret-new-secret"
    both = "t=1800000000,v1=%s,v1=%s" % (hmac.new(old.encode(), b"1800000000." + body, hashlib.sha256).hexdigest(), hmac.new(new.encode(), b"1800000000." + body, hashlib.sha256).hexdigest())
    assert verify_signature(new, body, both, now=1_800_000_000) and verify_signature(old, body, both, now=1_800_000_000)
    assert verify_signature([new, old], body, sign_payload(old, body, 1_800_000_000), now=1_800_000_000)
    assert not verify_signature([new], body, sign_payload(old, body, 1_800_000_000), now=1_800_000_000)


def test_verify_request_reads_the_header_in_any_case():
    body = b'{"a":1}'
    h = sign_payload(SECRET, body)
    assert verify_request(SECRET, {"x-mcb-signature": h, "Content-Type": "application/json"}, body)
    assert verify_request(SECRET, {"X-MCB-SIGNATURE": h}, body)
    assert not verify_request(SECRET, {"Content-Type": "application/json"}, body)


# ── parsing ──


def test_parse_sse_frames_comments_and_multiline_data():
    raw = [b": hello\n", b"\n", b"id: 7\n", b"event: download.done\n", b'data: {"a":\n', b"data: 1}\n", b"\n", b"retry: 2500\n", b"data: x\n", b"\n"]
    frames = list(parse_sse(iter(raw)))
    assert frames[0] == ("7", "download.done", '{"a":\n1}', None)
    assert frames[1][2] == "x" and frames[1][3] == 2500


def test_event_shapes():
    full = _event_from("9", "download.done", '{"cursor":"9","topic":"download.done","time":"2026-11-09T10:00:00+05:30","data":{"id":"dl_1"}}')
    assert (full.cursor, full.topic, full.data["id"], full.time.hour) == ("9", "download.done", "dl_1", 10)
    bare = _event_from("3", "order.update", '{"orderId":"o1"}')
    assert (bare.cursor, bare.topic, bare.data) == ("3", "order.update", {"orderId": "o1"})
    typed = _event_from(None, None, '{"type":"tick","symbol":"NSE:A"}')
    assert typed.topic == "tick"
    text = _event_from("1", "x", "not json")
    assert text.data == {"text": "not json"}


def test_topic_patterns():
    assert topic_matches("download.*", "download.done") and not topic_matches("download.*", "downloads.done") and topic_matches("*", "anything") and topic_matches("a.b", "a.b")
    assert not topic_matches("download.*", "download")


# ── subscribe ──


def test_subscribe_filters_topics_and_tracks_the_cursor(bridge, fake):
    d = fake.data
    d.emit("download.done", {"id": "a"})
    d.emit("recording.gap", {"id": "r"})
    d.emit("download.failed", {"id": "b"})
    evs = take(bridge.events.subscribe("download.*"), 2)
    assert [(e.topic, e.data["id"], e.cursor) for e in evs] == [("download.done", "a", "1"), ("download.failed", "b", "3")]
    req = fake.find("GET", "/v1/events/stream")[0]
    assert req["query"] == {"topics": "download.*"} and req["auth"] == "Bearer " + KEY


def test_a_dropped_connection_resumes_after_the_last_cursor(bridge, fake):
    d = fake.data
    d.sse_drop_after = 2  # the Bridge closes each connection after two events
    for i in range(1, 6):
        d.emit("download.progress", {"n": i})
    sub = bridge.events.subscribe(["download.progress"])
    evs = take(sub, 5)
    assert [e.data["n"] for e in evs] == [1, 2, 3, 4, 5]  # nothing lost, nothing repeated
    reqs = fake.find("GET", "/v1/events/stream")
    assert len(reqs) == 3 and sub.reconnects == 2
    assert [r["query"].get("since") for r in reqs] == [None, "2", "4"]
    assert fake.requests and bridge.waits and all(w >= 1.0 for w in bridge.waits)  # waited before each reconnect


def test_since_resumes_from_a_saved_cursor_and_sends_last_event_id(bridge, fake):
    for i in range(1, 5):
        fake.data.emit("recording.started", {"n": i})
    evs = take(bridge.events.subscribe(since="2"), 2)
    assert [e.data["n"] for e in evs] == [3, 4]
    assert fake.find("GET", "/v1/events/stream")[0]["query"]["since"] == "2"


def test_a_server_error_is_retried_with_backoff_but_a_wrong_key_is_raised(fake):
    waits = []
    b = Bridge(fake.url, KEY, account="paper", sleep=waits.append, max_retries=0)
    fake.data.sse_fail_first = 2
    fake.data.emit("download.done", {"id": "a"})
    evs = take(b.events.subscribe(), 1)
    assert evs[0].data["id"] == "a" and len(waits) == 2 and waits[1] > waits[0] * 1.5
    bad = Bridge(fake.url, "mcb_wrong_key_000000", account="paper", sleep=waits.append)
    with pytest.raises(Unauthenticated):
        next(iter(bad.events.subscribe()))


def test_reconnect_false_ends_instead_of_retrying(bridge, fake):
    fake.data.emit("download.done", {"id": "a"})
    sub = bridge.events.subscribe(reconnect=False)
    assert [e.data["id"] for e in sub] == ["a"]  # the connection ends, so does the iteration
    assert len(fake.find("GET", "/v1/events/stream")) == 1
    fake.data.sse_fail_first = 1
    with pytest.raises(Exception) as e:
        list(bridge.events.subscribe(reconnect=False))
    assert getattr(e.value, "status", 503) == 503


def test_max_reconnects_stops_a_quiet_stream(bridge, fake):
    sub = bridge.events.subscribe(max_reconnects=2)
    assert list(sub) == [] and sub.reconnects == 3 and len(fake.find("GET", "/v1/events/stream")) == 3


def test_close_from_another_thread_ends_the_iteration(fake):
    # a Bridge that keeps the stream open: serve one event, then hang until closed
    b = Bridge(fake.url, KEY, account="paper", sleep=lambda s: time.sleep(0.01))
    fake.data.emit("download.done", {"id": "a"})
    sub = b.events.subscribe(max_reconnects=1000)
    got = []

    def run():
        for ev in sub:
            got.append(ev)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    deadline = time.time() + 5
    while not got and time.time() < deadline:
        time.sleep(0.01)
    sub.close()
    t.join(5)
    assert not t.is_alive() and got[0].data["id"] == "a" and sub.closed


def test_wait_for_returns_the_matching_event_or_none(bridge, fake):
    fake.data.emit("download.progress", {"id": "a", "n": 1})
    fake.data.emit("download.done", {"id": "b"})
    ev = bridge.events.wait_for("download.done", timeout=5)
    assert ev is not None and ev.data["id"] == "b"
    assert bridge.events.wait_for("download.done", lambda e: e.data["id"] == "zzz", timeout=0.2) is None


def test_async_subscribe(fake):
    import asyncio

    from mrchartist_bridge import AsyncBridge

    fake.data.emit("download.done", {"id": "a"})

    async def main():
        async with AsyncBridge(fake.url, KEY, account="paper", sleep=lambda s: None) as b:
            async with b.events.subscribe("download.*") as s:
                async for ev in s:
                    return ev

    ev = asyncio.run(main())
    assert ev.topic == "download.done"
