from __future__ import annotations

import struct

import pytest

from browserglass.binary import (
    HEADER_BYTES,
    MSG_TYPE_UPLOAD_CHUNK,
    PAYLOAD_CODEC_NONE,
    UPLOAD_CHUNK_ID_BYTES,
    encode_binary_header,
    encode_upload_chunk_payload,
)
from browserglass.errors import AutomationError

from conftest import connect_client, control_granted_handler


def test_encode_binary_header_matches_the_20_byte_layout():
    header = encode_binary_header(version=1, msg_type=MSG_TYPE_UPLOAD_CHUNK, stream_id=0, seq=7, ts_delta_ms=0, payload_codec=PAYLOAD_CODEC_NONE, flags=0, gen16=0)
    assert len(header) == HEADER_BYTES == 20
    assert header[0:2] == b"BG"
    assert header[2] == 1  # version
    assert header[3] == MSG_TYPE_UPLOAD_CHUNK
    stream_id, seq, ts_delta = struct.unpack_from("<HII", header, 4)
    assert stream_id == 0
    assert seq == 7
    assert ts_delta == 0
    assert header[14] == PAYLOAD_CODEC_NONE
    assert header[15] == 0  # flags
    gen16, reserved = struct.unpack_from("<HH", header, 16)
    assert gen16 == 0
    assert reserved == 0  # MUST be 0 on send


def test_encode_upload_chunk_payload_prefixes_the_16_byte_id():
    upload_id = bytes(range(16))
    payload = encode_upload_chunk_payload(upload_id, b"hello")
    assert payload[:16] == upload_id
    assert payload[16:] == b"hello"


def test_encode_upload_chunk_payload_rejects_wrong_id_length():
    with pytest.raises(ValueError):
        encode_upload_chunk_payload(b"short", b"data")


def upload_handlers(chunk_bytes=256 * 1024):
    binary_id_hex = "00112233445566778899aabbccddeeff"[:32]

    def on_begin(msg):
        return {"t": "upload.accepted", "uploadId": msg["uploadId"], "chunkBytes": chunk_bytes, "maxInFlight": 4, "binaryId": binary_id_hex}

    def on_complete(msg):
        return {"t": "upload.done", "uploadId": msg["uploadId"], "path": f"bgls-upload://{msg['uploadId']}/report.pdf", "sizeBytes": 5}

    def on_files_set(msg):
        return {"t": "files.set.result", "targetId": msg["targetId"], "selector": msg["selector"], "files": ["report.pdf"]}

    return {"upload.begin": on_begin, "upload.complete": on_complete, "files.set": on_files_set}, binary_id_hex


@pytest.mark.asyncio
async def test_set_input_files_stages_and_attaches_one_file():
    from browserglass.types import UploadFileInput

    handlers, binary_id_hex = upload_handlers()
    client, socket = await connect_client(handlers)
    try:
        names = await client.set_input_files("#attachment", UploadFileInput(name="report.pdf", data=b"hello"))
        assert names == ["report.pdf"]

        begin = [m for m in socket.sent_json_messages() if m["t"] == "upload.begin"][0]
        assert begin["name"] == "report.pdf"
        assert begin["sizeBytes"] == 5
        assert begin["purpose"] == "input"

        binary_frames = [d for d in socket.sent if isinstance(d, (bytes, bytearray))]
        assert len(binary_frames) == 1
        frame = binary_frames[0]
        assert frame[:2] == b"BG"
        assert frame[3] == MSG_TYPE_UPLOAD_CHUNK
        expected_id = bytes.fromhex(binary_id_hex)
        assert frame[HEADER_BYTES : HEADER_BYTES + 16] == expected_id
        assert frame[HEADER_BYTES + 16 :] == b"hello"

        files_set = [m for m in socket.sent_json_messages() if m["t"] == "files.set"][0]
        assert files_set["selector"] == "#attachment"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_set_input_files_needs_no_control_lease():
    """Attaching a file sends no `input.*` message, so it is gated on
    `upload` alone, not on a held ControlLease."""
    from browserglass.types import UploadFileInput

    handlers, _ = upload_handlers()
    client, socket = await connect_client(handlers)
    try:
        await client.set_input_files("#attachment", UploadFileInput(name="a.txt", data=b"x"))
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_set_input_files_cancels_staged_uploads_on_failure():
    from browserglass.types import UploadFileInput

    handlers, _ = upload_handlers()

    def on_files_set_fail(msg):
        return {"t": "error", "code": "bgls.error.probe.no_element", "category": "probe", "message": "no such selector"}

    handlers["files.set"] = on_files_set_fail
    client, socket = await connect_client(handlers)
    try:
        with pytest.raises(AutomationError):
            await client.set_input_files("#nope", UploadFileInput(name="a.txt", data=b"x"))
        cancels = [m for m in socket.sent_json_messages() if m["t"] == "upload.cancel"]
        assert len(cancels) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_set_input_files_needs_at_least_one_file():
    handlers, _ = upload_handlers()
    client, socket = await connect_client(handlers)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.set_input_files("#attachment", [])
        assert excinfo.value.code == "INVALID_ARGUMENT"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_set_input_files_chunks_large_files():
    from browserglass.types import UploadFileInput

    handlers, _ = upload_handlers(chunk_bytes=4)
    client, socket = await connect_client(handlers)
    try:
        await client.set_input_files("#attachment", UploadFileInput(name="big.bin", data=b"0123456789"))
        binary_frames = [d for d in socket.sent if isinstance(d, (bytes, bytearray))]
        # 10 bytes at 4-byte chunks: 4 + 4 + 2 = three chunks.
        assert len(binary_frames) == 3
        assert binary_frames[0][HEADER_BYTES + 16 :] == b"0123"
        assert binary_frames[1][HEADER_BYTES + 16 :] == b"4567"
        assert binary_frames[2][HEADER_BYTES + 16 :] == b"89"
        seqs = [struct.unpack_from("<I", f, 6)[0] for f in binary_frames]
        assert seqs == [0, 1, 2]
    finally:
        await client.close()
