"""Bounded compressed UDP messages; peer traffic and telemetry use separate sockets."""
import base64
import json
import time
import uuid
import zlib

MAX_BYTES = 4 * 1024 * 1024


def packets(message):
    raw = zlib.compress(json.dumps(message, allow_nan=False, separators=(",", ":")).encode())
    if len(raw) > MAX_BYTES:
        raise ValueError("checkpoint exceeds wire limit")
    parts = [raw[i:i + 4000] for i in range(0, len(raw), 4000)]
    key = uuid.uuid4().hex
    return [json.dumps(dict(id=key, i=i, n=len(parts), d=base64.b64encode(data).decode())).encode()
            for i, data in enumerate(parts)]


class Receiver:
    def __init__(self):
        self.pending = {}

    def receive(self, raw, source):
        now = time.monotonic()
        self.pending = {k: v for k, v in self.pending.items() if now - v[0] < 4}
        p = json.loads(raw)
        if not (isinstance(p, dict) and isinstance(p.get("id"), str) and
                isinstance(p.get("i"), int) and isinstance(p.get("n"), int) and 0 <= p["i"] < p["n"] <= 1050):
            raise ValueError("invalid chunk")
        key = (source, p["id"])
        if key not in self.pending:
            if len(self.pending) >= 64:
                self.pending.pop(next(iter(self.pending)))
            self.pending[key] = [now, p["n"], {}]
        _, total, parts = self.pending[key]
        if p["n"] != total:
            raise ValueError("inconsistent chunks")
        parts[p["i"]] = base64.b64decode(p["d"], validate=True)
        if len(parts) != total:
            return None
        self.pending.pop(key)
        compressed = b"".join(parts[i] for i in range(total))
        decoder = zlib.decompressobj()
        plain = decoder.decompress(compressed, MAX_BYTES + 1)
        if len(plain) > MAX_BYTES or decoder.unconsumed_tail:
            raise ValueError("oversized message")
        return json.loads(plain)
