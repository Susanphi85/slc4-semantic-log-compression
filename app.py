from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import time
from collections import Counter
from pathlib import Path
from typing import Any

import msgpack
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import slc4_codec as codec

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
ARCHIVE_MAGIC = b"SLCZ1"
MAX_UPLOAD = int(os.getenv("SLC4_MAX_UPLOAD", str(128 * 1024 * 1024)))

app = FastAPI(title="SLC4 Semantic Log Packer", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def human(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024**2:
        return f"{n/1024:.1f} KiB"
    if n < 1024**3:
        return f"{n/1024**2:.2f} MiB"
    return f"{n/1024**3:.2f} GiB"


def safe_name(name: str) -> str:
    # HTTP header-safe basename; preserve readable ASCII and common filename chars.
    base = Path(name or "archive").name
    return "".join(c if (c.isalnum() or c in "._-") else "_" for c in base)[:180] or "archive"


def zstd_compress(data: bytes, level: int = 19) -> bytes:
    try:
        p = subprocess.run(
            ["zstd", f"-{level}", "--stdout", "--quiet"],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except FileNotFoundError as e:
        raise RuntimeError("zstd CLI is not installed") from e
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.stderr.decode("utf-8", "replace")) from e
    return p.stdout


def zstd_decompress(data: bytes) -> bytes:
    try:
        p = subprocess.run(
            ["zstd", "-d", "--stdout", "--quiet"],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except FileNotFoundError as e:
        raise RuntimeError("zstd CLI is not installed") from e
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.stderr.decode("utf-8", "replace")) from e
    return p.stdout


def parse_json_input(raw: bytes) -> tuple[list[dict[str, Any]], str]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ValueError("Input must be UTF-8 JSON or JSONL") from e

    stripped = text.strip()
    if not stripped:
        raise ValueError("Input is empty")

    # First try normal JSON.
    try:
        obj = json.loads(stripped)
        if isinstance(obj, list):
            if not all(isinstance(x, dict) for x in obj):
                raise ValueError("Top-level JSON array must contain objects")
            return obj, "json-array"
        if isinstance(obj, dict):
            return [obj], "json-object"
        raise ValueError("Expected a JSON object, an array of objects, or JSONL objects")
    except json.JSONDecodeError:
        pass

    # Then JSONL/NDJSON.
    records: list[dict[str, Any]] = []
    for line_no, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSONL at line {line_no}: {e.msg}") from e
        if not isinstance(item, dict):
            raise ValueError(f"JSONL line {line_no} is not a JSON object")
        records.append(item)
    if not records:
        raise ValueError("No JSONL records found")
    return records, "jsonl"


def serialize_records(records: list[dict[str, Any]], input_format: str, pretty: bool = True) -> bytes:
    if input_format == "jsonl":
        return ("\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in records) + "\n").encode("utf-8")
    if input_format == "json-object":
        obj: Any = records[0] if records else {}
    else:
        obj = records
    if pretty:
        return json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def make_archive(slc4: bytes, input_format: str, source_name: str, record_count: int, level: int) -> bytes:
    header = {
        "format": "SLC4Z",
        "version": 1,
        "codec": 4,
        "input_format": input_format,
        "source_name": source_name,
        "record_count": record_count,
        "zstd_level": level,
    }
    hb = msgpack.packb(header, use_bin_type=True)
    container = ARCHIVE_MAGIC + struct.pack(">I", len(hb)) + hb + slc4
    return zstd_compress(container, level)


def open_archive(blob: bytes) -> tuple[dict[str, Any], bytes]:
    raw = zstd_decompress(blob)
    if raw[:5] != ARCHIVE_MAGIC:
        raise ValueError("Not an SLC4Z archive")
    if len(raw) < 9:
        raise ValueError("Truncated SLC4Z archive")
    hlen = struct.unpack(">I", raw[5:9])[0]
    if len(raw) < 9 + hlen:
        raise ValueError("Truncated SLC4Z header")
    header = msgpack.unpackb(raw[9:9+hlen], raw=False)
    slc4 = raw[9+hlen:]
    if slc4[:4] != codec.MAGIC:
        raise ValueError("SLC4 payload missing")
    return header, slc4


def slc4_details(slc4: bytes) -> dict[str, Any]:
    ml = struct.unpack(">I", slc4[4:8])[0]
    meta = msgpack.unpackb(slc4[8:8+ml], raw=False)
    columns = []
    for path, cm in zip(meta["paths"], meta["columns"]):
        columns.append({
            "path": ".".join(path),
            "encoding": cm["enc"],
            "values": cm["n"],
            "bytes": cm["length"],
            "human": human(cm["length"]),
        })
    columns.sort(key=lambda x: x["bytes"], reverse=True)
    return {
        "record_count": meta["record_count"],
        "schema_count": len(meta["schemas"]),
        "field_count": len(meta["paths"]),
        "schema_encoding": meta["schema_seq"]["enc"],
        "columns": columns,
    }


def analyze_bytes(raw: bytes, filename: str, selection: str, zstd_level: int) -> tuple[dict[str, Any], bytes, bytes]:
    records, input_format = parse_json_input(raw)
    if not records:
        raise ValueError("No records")

    canonical = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    codec.SELECTION_MODE = selection

    t0 = time.perf_counter()
    slc4, enc_counts = codec.encode(records)
    encode_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    restored = codec.decode(slc4)
    decode_s = time.perf_counter() - t0
    if restored != records:
        raise RuntimeError("Round-trip verification failed")

    t0 = time.perf_counter()
    raw_z = zstd_compress(raw, zstd_level)
    raw_z_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    can_z = zstd_compress(canonical, zstd_level)
    can_z_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    archive = make_archive(slc4, input_format, filename, len(records), zstd_level)
    archive_z_s = time.perf_counter() - t0

    d = slc4_details(slc4)
    sizes = {
        "input": len(raw),
        "canonical": len(canonical),
        "slc4": len(slc4),
        "input_zstd": len(raw_z),
        "canonical_zstd": len(can_z),
        "slc4z": len(archive),
    }
    result = {
        "filename": filename,
        "input_format": input_format,
        "round_trip": True,
        "selection": selection,
        "zstd_level": zstd_level,
        "records": d["record_count"],
        "schemas": d["schema_count"],
        "fields": d["field_count"],
        "schema_encoding": d["schema_encoding"],
        "encodings": dict(enc_counts),
        "sizes": {k: {"bytes": v, "human": human(v), "pct_input": round(100*v/len(raw), 3)} for k, v in sizes.items()},
        "ratios": {
            "input_to_slc4z": round(len(raw) / len(archive), 3),
            "vs_canonical_zstd_smaller_pct": round((1 - len(archive)/len(can_z))*100, 3),
            "vs_input_zstd_smaller_pct": round((1 - len(archive)/len(raw_z))*100, 3),
        },
        "timings": {
            "encode_s": round(encode_s, 4),
            "decode_s": round(decode_s, 4),
            "input_zstd_s": round(raw_z_s, 4),
            "canonical_zstd_s": round(can_z_s, 4),
            "archive_zstd_s": round(archive_z_s, 4),
        },
        "columns": d["columns"][:50],
    }
    return result, slc4, archive


async def read_upload(file: UploadFile) -> bytes:
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, f"File too large; max {human(MAX_UPLOAD)}")
    return raw


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    return {"ok": True, "codec": 4, "max_upload": MAX_UPLOAD}


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    selection: str = Form("zstd"),
    zstd_level: int = Form(19),
):
    if selection not in {"raw", "zstd"}:
        raise HTTPException(400, "selection must be raw or zstd")
    if not 1 <= zstd_level <= 22:
        raise HTTPException(400, "zstd_level must be 1..22")
    raw = await read_upload(file)
    try:
        result, _, _ = analyze_bytes(raw, file.filename or "input.json", selection, zstd_level)
        return JSONResponse(result)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/pack")
async def pack(
    file: UploadFile = File(...),
    selection: str = Form("zstd"),
    zstd_level: int = Form(19),
):
    raw = await read_upload(file)
    try:
        result, _, archive = analyze_bytes(raw, file.filename or "input.json", selection, zstd_level)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e
    base = Path(safe_name(file.filename or "archive.json")).stem
    headers = {
        "Content-Disposition": f'attachment; filename="{base}.slc4z"',
        "X-SLC4-Ratio": str(result["ratios"]["input_to_slc4z"]),
        "X-SLC4-Records": str(result["records"]),
    }
    return Response(archive, media_type="application/octet-stream", headers=headers)


@app.post("/api/unpack")
async def unpack(file: UploadFile = File(...)):
    raw = await read_upload(file)
    try:
        header, slc4 = open_archive(raw)
        records = codec.decode(slc4)
        payload = serialize_records(records, header.get("input_format", "json-array"), pretty=True)
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as e:
        raise HTTPException(400, str(e)) from e
    original = Path(safe_name(header.get("source_name") or "unpacked.json"))
    if header.get("input_format") == "jsonl":
        suffix = ".jsonl"
    else:
        suffix = ".json"
    out_name = f"{original.stem}.unpacked{suffix}"
    headers = {
        "Content-Disposition": f'attachment; filename="{out_name}"',
        "X-SLC4-Records": str(len(records)),
    }
    media = "application/x-ndjson" if header.get("input_format") == "jsonl" else "application/json"
    return Response(payload, media_type=media, headers=headers)


@app.post("/api/inspect-archive")
async def inspect_archive(file: UploadFile = File(...)):
    raw = await read_upload(file)
    try:
        header, slc4 = open_archive(raw)
        details = slc4_details(slc4)
        restored = codec.decode(slc4)
        details.update({
            "header": header,
            "archive_bytes": len(raw),
            "archive_human": human(len(raw)),
            "round_trip_decodable": len(restored) == details["record_count"],
        })
        details["columns"] = details["columns"][:50]
        return details
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e
