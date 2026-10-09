"""The `bgls.v1` binary frame header and the one binary message this SDK
sends: `UPLOAD_CHUNK`.

Mirrors `packages/protocol/src/wire/binary.ts`. Only encoding is
implemented (this client sends upload chunks; it never needs to decode a
`FRAME`/`AUDIO`/`CURSOR_BITMAP` binary frame, since it drives no video
stream). Decoding is a straightforward mirror of the same 20-byte layout
if a future caller needs it.
"""

from __future__ import annotations

import struct

HEADER_BYTES = 20

MSG_TYPE_UPLOAD_CHUNK = 0x03

PAYLOAD_CODEC_NONE = 0x00

UPLOAD_CHUNK_ID_BYTES = 16

# offset: 0    2    3    4         6         10        14    15    16      18
# field:  BG   ver  type streamId  seq       tsDelta   codec flags gen16   reserved
_HEADER_STRUCT = struct.Struct("<2sBBHIIBBHH")


def encode_binary_header(
    *,
    version: int,
    msg_type: int,
    stream_id: int,
    seq: int,
    ts_delta_ms: int,
    payload_codec: int,
    flags: int,
    gen16: int,
) -> bytes:
    """Encodes a 20-byte little-endian binary frame header. ``reserved`` is
    always written as 0, matching the TypeScript encoder."""
    return _HEADER_STRUCT.pack(
        b"BG",
        version & 0xFF,
        msg_type & 0xFF,
        stream_id & 0xFFFF,
        seq & 0xFFFFFFFF,
        ts_delta_ms & 0xFFFFFFFF,
        payload_codec & 0xFF,
        flags & 0xFF,
        gen16 & 0xFFFF,
        0,
    )


def encode_upload_chunk_payload(upload_id: bytes, chunk: bytes) -> bytes:
    """Builds an ``UPLOAD_CHUNK`` payload from a 16-byte upload id and the
    chunk bytes."""
    if len(upload_id) != UPLOAD_CHUNK_ID_BYTES:
        raise ValueError(f"uploadId must be exactly {UPLOAD_CHUNK_ID_BYTES} bytes, got {len(upload_id)}")
    return upload_id + chunk
