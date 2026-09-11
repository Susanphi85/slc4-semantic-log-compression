#!/usr/bin/env python3
"""
Universal Log Codec V4 - experimental, lossless semantic JSON codec.

Design goals:
  * no field-name-specific rules
  * infer record schemas from leaf paths
  * columnize values by leaf path
  * choose encoding per column from generic candidates using actual byte cost
  * encode schema-id stream using bit-pack or RLE, whichever is smaller
  * optional whole-archive ZSTD benchmark / output

Lossless semantics:
  decode(encode(records)) == records as Python JSON values, preserving record order,
  field values and JSON types. Insignificant input JSON whitespace and object-key order
  are not preserved.

Generic column candidates include:
  const, bool bitpack, integer varint/dictionary/delta/delta-of-delta/RLE,
  timestamp delta/delta-of-delta, decimal-string numeric template,
  IPv4 packed, fixed-width hex packed, string dictionary/RLE/common-prefix/front-coding/raw,
  and msgpack fallback for mixed/nested/list values.
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import ipaddress
import itertools
import json
import os
import re
import shutil
import struct
import subprocess
import time
from collections import Counter
from decimal import Decimal

try:
    import msgpack
except ImportError:
    raise SystemExit("Missing dependency: pip install msgpack")

MAGIC = b"SLC4"
SELECTION_MODE = "raw"
_ZSTD_EXE = shutil.which("zstd")
TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$")
DECIMAL_UINT_RE = re.compile(r"0|[1-9]\d*")
HEX_RE = re.compile(r"[0-9a-fA-F]+")
# Generic single-number template: optional literal prefix + numeric token + literal suffix.
NUM_TEMPLATE_RE = re.compile(r"^(.*?)([+-]?(?:\d+)(?:\.(\d+))?)([^\d]*)$")


def flatten_leaves(obj, prefix=()):
    if isinstance(obj, dict):
        # Preserve nested empty objects as values. A top-level empty record remains
        # an empty schema and is reconstructed as {} without a synthetic field.
        if not obj and prefix:
            return [(prefix, {})]
        out = []
        for k, v in obj.items():
            out.extend(flatten_leaves(v, prefix + (k,)))
        return out
    return [(prefix, obj)]


def set_nested(root, path, value):
    cur = root
    for key in path[:-1]:
        cur = cur.setdefault(key, {})
    cur[path[-1]] = value


def enc_uvarint(n: int) -> bytes:
    if n < 0:
        raise ValueError("uvarint requires non-negative integer")
    out = bytearray()
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


def dec_uvarint(buf: bytes, pos: int):
    shift = 0
    n = 0
    while True:
        b = buf[pos]
        pos += 1
        n |= (b & 0x7F) << shift
        if not (b & 0x80):
            return n, pos
        shift += 7


def zigzag(n: int) -> int:
    return n * 2 if n >= 0 else (-n) * 2 - 1


def unzigzag(z: int) -> int:
    return z // 2 if z % 2 == 0 else -(z // 2) - 1


def bitpack(values, bits: int) -> bytes:
    if not values:
        return b""
    out = bytearray((len(values) * bits + 7) // 8)
    bitpos = 0
    for value in values:
        for j in range(bits):
            if value & (1 << j):
                idx = bitpos + j
                out[idx // 8] |= 1 << (idx % 8)
        bitpos += bits
    return bytes(out)


def bitunpack(buf: bytes, n: int, bits: int):
    vals = []
    bitpos = 0
    for _ in range(n):
        v = 0
        for j in range(bits):
            idx = bitpos + j
            if buf[idx // 8] & (1 << (idx % 8)):
                v |= 1 << j
        vals.append(v)
        bitpos += bits
    return vals


def ts_to_ns(s: str):
    m = TS_RE.match(s)
    if not m:
        raise ValueError(s)
    y, mo, d, h, mi, sec = map(int, m.groups()[:6])
    frac = m.group(7) or ""
    epoch_sec = calendar.timegm((y, mo, d, h, mi, sec))
    ns = epoch_sec * 1_000_000_000 + int((frac + "0" * 9)[:9])
    return ns, len(frac)


def ns_to_ts(ns: int, precision: int):
    sec, nano = divmod(ns, 1_000_000_000)
    stamp = dt.datetime.fromtimestamp(sec, dt.timezone.utc)
    base = stamp.strftime("%Y-%m-%dT%H:%M:%S")
    if precision:
        return f"{base}.{nano:09d}"[: len(base) + 1 + precision] + "Z"
    return base + "Z"


def common_prefix(strings):
    return os.path.commonprefix(strings) if strings else ""


def hex_case_style(strings):
    """Return a reversible uniform HEX case style, or None for mixed-case strings."""
    if all(s == s.lower() for s in strings):
        return "lower"
    if all(s == s.upper() for s in strings):
        return "upper"
    return None


def candidate_cost(meta, blob):
    payload = msgpack.packb(meta, use_bin_type=True) + blob
    if SELECTION_MODE == "zstd" and _ZSTD_EXE:
        p = subprocess.run([_ZSTD_EXE, "-1", "--stdout", "--quiet"], input=payload,
                           stdout=subprocess.PIPE, check=True)
        return len(p.stdout)
    return len(payload)


def choose(cands):
    return min(cands, key=lambda x: candidate_cost(x[0], x[1]))

def encode_runs(values, value_encoder):
    """Return runs as count + encoded value bytes. value_encoder(v)->bytes."""
    out = bytearray()
    runs = 0
    i = 0
    while i < len(values):
        j = i + 1
        while j < len(values) and values[j] == values[i]:
            j += 1
        out += enc_uvarint(j - i)
        vb = value_encoder(values[i])
        out += enc_uvarint(len(vb)) + vb
        runs += 1
        i = j
    return runs, bytes(out)


def decode_runs(blob, runs, value_decoder):
    vals = []
    pos = 0
    for _ in range(runs):
        count, pos = dec_uvarint(blob, pos)
        ln, pos = dec_uvarint(blob, pos)
        vb = blob[pos:pos+ln]
        pos += ln
        vals.extend([value_decoder(vb)] * count)
    return vals


def int_varints(vals):
    return b"".join(enc_uvarint(zigzag(v)) for v in vals)


def int_deltas(vals):
    ds = [vals[0]] + [vals[i] - vals[i-1] for i in range(1, len(vals))]
    return int_varints(ds)


def int_delta2(vals):
    if len(vals) == 1:
        return int_varints(vals)
    d1 = [vals[i] - vals[i-1] for i in range(1, len(vals))]
    seq = [vals[0], d1[0]] + [d1[i] - d1[i-1] for i in range(1, len(d1))]
    return int_varints(seq)


def decode_int_stream(blob, n, mode):
    raw = []
    pos = 0
    while len(raw) < n:
        z, pos = dec_uvarint(blob, pos)
        raw.append(unzigzag(z))
    if mode == "ints":
        return raw
    if mode == "intdelta":
        out = [raw[0]]
        for d in raw[1:]:
            out.append(out[-1] + d)
        return out
    if mode == "intdelta2":
        if n == 1:
            return raw
        out = [raw[0]]
        d = raw[1]
        out.append(out[-1] + d)
        for dd in raw[2:]:
            d += dd
            out.append(out[-1] + d)
        return out
    raise ValueError(mode)


def encode_numeric_template_strings(ss):
    parsed = [NUM_TEMPLATE_RE.match(s) for s in ss]
    if not all(parsed):
        return None
    prefixes = [m.group(1) for m in parsed]
    suffixes = [m.group(4) for m in parsed]
    if len(set(prefixes)) != 1 or len(set(suffixes)) != 1:
        return None
    # Avoid stealing ordinary large arbitrary strings unless numeric token dominates.
    nums = [m.group(2) for m in parsed]
    if not nums or sum(len(x) for x in nums) < len(ss) * 1.2:
        return None
    # Keep this transform textually lossless: reject explicit plus signs,
    # negative zero, and integer parts with leading zeros that int() would erase.
    for num in nums:
        if num.startswith("+"):
            return None
        body = num[1:] if num.startswith("-") else num
        intpart = body.split(".", 1)[0]
        if len(intpart) > 1 and intpart.startswith("0"):
            return None
        try:
            if num.startswith("-") and Decimal(num) == 0:
                return None
        except Exception:
            return None
    scales = [len(m.group(3) or "") for m in parsed]
    mant = []
    for num, scale in zip(nums, scales):
        sign = -1 if num.startswith("-") else 1
        t = num.lstrip("+-").replace(".", "")
        mant.append(sign * int(t))
    # exact textual reconstruction requires scale; signs and digits are in mantissa.
    mcands = [
        ({"menc":"ints"}, int_varints(mant)),
        ({"menc":"intdelta"}, int_deltas(mant)),
        ({"menc":"intdelta2"}, int_delta2(mant)),
    ]
    mm, mb = choose(mcands)
    uniq_sc = list(dict.fromkeys(scales))
    if len(uniq_sc) <= 16:
        smap = {v:i for i,v in enumerate(uniq_sc)}
        bits = max(1, (len(uniq_sc)-1).bit_length())
        sb = bitpack([smap[x] for x in scales], bits)
        smeta = {"sdict":uniq_sc,"sbits":bits}
    else:
        sb = b"".join(enc_uvarint(x) for x in scales)
        smeta = {"svarint":True}
    blob = enc_uvarint(len(mb)) + mb + sb
    meta = {"enc":"numtemplate","n":len(ss),"prefix":prefixes[0],"suffix":suffixes[0], **mm, **smeta}
    return meta, blob


def decode_numeric_template(meta, blob):
    n = meta["n"]
    pos = 0
    mlen, pos = dec_uvarint(blob, pos)
    mb = blob[pos:pos+mlen]
    pos += mlen
    mant = decode_int_stream(mb, n, meta["menc"])
    if "sdict" in meta:
        idx = bitunpack(blob[pos:], n, meta["sbits"])
        scales = [meta["sdict"][i] for i in idx]
    else:
        scales=[]
        for _ in range(n):
            v,pos=dec_uvarint(blob,pos)
            scales.append(v)
    out=[]
    for m, sc in zip(mant, scales):
        sign = "-" if m < 0 else ""
        digs = str(abs(m))
        if sc:
            if len(digs) <= sc:
                digs = "0"*(sc+1-len(digs)) + digs
            num = sign + digs[:-sc] + "." + digs[-sc:]
        else:
            num = sign + digs
        out.append(meta["prefix"] + num + meta["suffix"])
    return out


def encode_front_strings(ss):
    out=bytearray()
    prev=""
    for s in ss:
        k=0
        m=min(len(prev),len(s))
        while k<m and prev[k]==s[k]:
            k+=1
        suffix=s[k:].encode("utf-8")
        out += enc_uvarint(k)+enc_uvarint(len(suffix))+suffix
        prev=s
    return bytes(out)


def decode_front_strings(blob,n):
    vals=[];pos=0;prev=""
    for _ in range(n):
        k,pos=dec_uvarint(blob,pos)
        ln,pos=dec_uvarint(blob,pos)
        suffix=blob[pos:pos+ln].decode("utf-8");pos+=ln
        s=prev[:k]+suffix
        vals.append(s);prev=s
    return vals



def encode_string_dict_values(ss):
    """Encode unique dictionary values without recursively using dictionary coding."""
    n=len(ss)
    c=[]
    raw=bytearray()
    for s in ss:
        b=s.encode("utf-8"); raw += enc_uvarint(len(b))+b
    c.append(({"denc":"raw","n":n},bytes(raw)))
    pref=common_prefix(ss)
    if pref:
        out=bytearray()
        for s in ss:
            b=s[len(pref):].encode("utf-8"); out += enc_uvarint(len(b))+b
        c.append(({"denc":"prefix","n":n,"prefix":pref},bytes(out)))
    c.append(({"denc":"front","n":n},encode_front_strings(ss)))
    hstyle = hex_case_style(ss) if ss else None
    if ss and hstyle and all(HEX_RE.fullmatch(x) for x in ss) and len({len(x) for x in ss})==1 and len(ss[0])%2==0 and len(ss[0])>=8:
        c.append(({"denc":"hex","n":n,"hexchars":len(ss[0]),"hcase":hstyle},b"".join(bytes.fromhex(x) for x in ss)))
    suffix=[x[len(pref):] for x in ss] if pref else []
    shstyle = hex_case_style(suffix) if suffix else None
    if pref and suffix and shstyle and all(HEX_RE.fullmatch(x or "") for x in suffix) and len({len(x) for x in suffix})==1 and len(suffix[0])%2==0 and len(suffix[0])>=8:
        c.append(({"denc":"prefix_hex","n":n,"prefix":pref,"hexchars":len(suffix[0]),"hcase":shstyle},b"".join(bytes.fromhex(x) for x in suffix)))
    return choose(c)


def decode_string_dict_values(meta,blob):
    enc=meta["denc"]; n=meta["n"]
    if enc=="raw":
        vals=[];pos=0
        for _ in range(n):
            ln,pos=dec_uvarint(blob,pos); vals.append(blob[pos:pos+ln].decode("utf-8"));pos+=ln
        return vals
    if enc=="prefix":
        vals=[];pos=0;p=meta["prefix"]
        for _ in range(n):
            ln,pos=dec_uvarint(blob,pos); vals.append(p+blob[pos:pos+ln].decode("utf-8"));pos+=ln
        return vals
    if enc=="front": return decode_front_strings(blob,n)
    if enc=="hex":
        w=meta["hexchars"]//2
        vals=[blob[i*w:(i+1)*w].hex() for i in range(n)]
        return [v.upper() for v in vals] if meta.get("hcase")=="upper" else vals
    if enc=="prefix_hex":
        w=meta["hexchars"]//2;p=meta["prefix"]
        vals=[blob[i*w:(i+1)*w].hex() for i in range(n)]
        if meta.get("hcase")=="upper": vals=[v.upper() for v in vals]
        return [p+v for v in vals]
    raise ValueError(enc)

def encode_column(vals):
    n=len(vals)
    if n==0:
        return {"enc":"empty","n":0},b""
    if all(v==vals[0] for v in vals):
        return {"enc":"const","value":vals[0],"n":n},b""

    types={type(v).__name__ for v in vals}

    if types=={"bool"}:
        return {"enc":"boolbits","n":n}, bitpack([int(v) for v in vals],1)

    if types=={"int"}:
        c=[]
        c.append(({"enc":"ints","n":n}, int_varints(vals)))
        c.append(({"enc":"intdelta","n":n}, int_deltas(vals)))
        c.append(({"enc":"intdelta2","n":n}, int_delta2(vals)))
        uniq=list(dict.fromkeys(vals))
        if len(uniq)<=65536:
            bits=max(1,(len(uniq)-1).bit_length())
            mp={v:i for i,v in enumerate(uniq)}
            db=int_varints(uniq)
            ib=bitpack([mp[v] for v in vals],bits)
            blob=enc_uvarint(len(db))+db+ib
            c.append(({"enc":"intdict","n":n,"dcount":len(uniq),"bits":bits}, blob))
        # Generic integer RLE.
        runs,rb=encode_runs(vals, lambda v: enc_uvarint(zigzag(v)))
        c.append(({"enc":"intrle","n":n,"runs":runs},rb))
        return choose(c)

    if types=={"str"}:
        ss=vals
        c=[]
        # Raw baseline.
        raw=bytearray()
        for s in ss:
            b=s.encode("utf-8"); raw += enc_uvarint(len(b))+b
        c.append(({"enc":"strraw","n":n},bytes(raw)))

        # Timestamp family (generic pattern, no key-name dependence).
        if all(TS_RE.match(s) and len((TS_RE.match(s).group(7) or "")) <= 9 for s in ss):
            parsed=[ts_to_ns(s) for s in ss]
            ns=[x[0] for x in parsed]; precisions=[x[1] for x in parsed]
            pcands=[({"tmode":"intdelta"},int_deltas(ns)),({"tmode":"intdelta2"},int_delta2(ns)),({"tmode":"ints"},int_varints(ns))]
            pm,pb=choose(pcands)
            puniq=list(dict.fromkeys(precisions))
            pbits=max(1,(len(puniq)-1).bit_length())
            pmap={v:i for i,v in enumerate(puniq)}
            precb=bitpack([pmap[x] for x in precisions],pbits)
            blob=enc_uvarint(len(pb))+pb+precb
            c.append(({"enc":"timestamp","n":n,**pm,"pdict":puniq,"pbits":pbits},blob))

        # Decimal integer strings.
        if all(DECIMAL_UINT_RE.fullmatch(s) for s in ss):
            ints=[int(s) for s in ss]
            modes=[({"umode":"ints"},int_varints(ints)),({"umode":"intdelta"},int_deltas(ints)),({"umode":"intdelta2"},int_delta2(ints))]
            mm,mb=choose(modes)
            c.append(({"enc":"uintstr","n":n,**mm},mb))

        nt=encode_numeric_template_strings(ss)
        if nt is not None:
            c.append(nt)

        # IPv4.
        try:
            ips=[ipaddress.ip_address(s) for s in ss]
            if all(ip.version==4 for ip in ips):
                c.append(({"enc":"ipv4","n":n},b"".join(ip.packed for ip in ips)))
        except ValueError:
            pass

        # Dictionary.
        uniq=list(dict.fromkeys(ss))
        if len(uniq)<=65536:
            bits=max(1,(len(uniq)-1).bit_length())
            mp={v:i for i,v in enumerate(uniq)}
            dm,db=encode_string_dict_values(uniq)
            ib=bitpack([mp[v] for v in ss],bits)
            blob=enc_uvarint(len(db))+db+ib
            c.append(({"enc":"strdict","n":n,"dcount":len(uniq),"bits":bits,"dmeta":dm},blob))

        # String RLE.
        runs,rb=encode_runs(ss, lambda s: s.encode("utf-8"))
        c.append(({"enc":"strrle","n":n,"runs":runs},rb))

        # Fixed-width hex and common-prefix + hex.
        hstyle = hex_case_style(ss)
        if hstyle and all(HEX_RE.fullmatch(s) for s in ss) and len({len(s) for s in ss})==1 and len(ss[0])%2==0 and len(ss[0])>=8:
            c.append(({"enc":"hex","n":n,"hexchars":len(ss[0]),"hcase":hstyle},b"".join(bytes.fromhex(s) for s in ss)))
        pref=common_prefix(ss)
        suffix=[s[len(pref):] for s in ss]
        shstyle = hex_case_style(suffix) if suffix else None
        if pref and suffix and shstyle and all(HEX_RE.fullmatch(x or "") for x in suffix) and len({len(x) for x in suffix})==1 and len(suffix[0])%2==0 and len(suffix[0])>=8:
            c.append(({"enc":"prefix_hex","n":n,"prefix":pref,"hexchars":len(suffix[0]),"hcase":shstyle},b"".join(bytes.fromhex(x) for x in suffix)))

        # Common prefix, useful for URLs / resource names / IDs but completely generic.
        if pref:
            out=bytearray()
            for s in ss:
                b=s[len(pref):].encode("utf-8"); out += enc_uvarint(len(b))+b
            c.append(({"enc":"prefix_raw","n":n,"prefix":pref},bytes(out)))

        # Front-coding against previous string, useful for locally clustered values.
        c.append(({"enc":"front","n":n},encode_front_strings(ss)))
        return choose(c)

    # Generic fallback for floats, nulls, lists, mixed types, nested arrays, etc.
    return {"enc":"msgpack","n":n}, msgpack.packb(vals,use_bin_type=True)


def decode_column(meta,blob):
    enc=meta["enc"]; n=meta["n"]
    if enc=="empty": return []
    if enc=="const": return [meta["value"]]*n
    if enc=="boolbits": return [bool(x) for x in bitunpack(blob,n,1)]
    if enc in ("ints","intdelta","intdelta2"):
        return decode_int_stream(blob,n,enc)
    if enc=="intdict":
        pos=0; dlen,pos=dec_uvarint(blob,pos); db=blob[pos:pos+dlen];pos+=dlen
        dvals=decode_int_stream(db,meta["dcount"],"ints")
        return [dvals[i] for i in bitunpack(blob[pos:],n,meta["bits"])]
    if enc=="intrle":
        return decode_runs(blob,meta["runs"],lambda b: unzigzag(dec_uvarint(b,0)[0]))
    if enc=="timestamp":
        pos=0; ln,pos=dec_uvarint(blob,pos); ib=blob[pos:pos+ln];pos+=ln
        ns=decode_int_stream(ib,n,meta["tmode"])
        idx=bitunpack(blob[pos:],n,meta["pbits"])
        prec=[meta["pdict"][i] for i in idx]
        return [ns_to_ts(x,p) for x,p in zip(ns,prec)]
    if enc=="uintstr":
        return [str(x) for x in decode_int_stream(blob,n,meta["umode"])]
    if enc=="numtemplate": return decode_numeric_template(meta,blob)
    if enc=="ipv4": return [str(ipaddress.ip_address(blob[i*4:(i+1)*4])) for i in range(n)]
    if enc=="strdict":
        pos=0; dlen,pos=dec_uvarint(blob,pos); db=blob[pos:pos+dlen];pos+=dlen
        dvals=decode_string_dict_values(meta["dmeta"],db)
        return [dvals[i] for i in bitunpack(blob[pos:],n,meta["bits"])]
    if enc=="strrle": return decode_runs(blob,meta["runs"],lambda b:b.decode("utf-8"))
    if enc=="hex":
        w=meta["hexchars"]//2
        vals=[blob[i*w:(i+1)*w].hex() for i in range(n)]
        return [v.upper() for v in vals] if meta.get("hcase")=="upper" else vals
    if enc=="prefix_hex":
        w=meta["hexchars"]//2; p=meta["prefix"]
        vals=[blob[i*w:(i+1)*w].hex() for i in range(n)]
        if meta.get("hcase")=="upper": vals=[v.upper() for v in vals]
        return [p+v for v in vals]
    if enc in ("prefix_raw","strraw"):
        vals=[];pos=0;p=meta.get("prefix","")
        for _ in range(n):
            ln,pos=dec_uvarint(blob,pos); vals.append(p+blob[pos:pos+ln].decode("utf-8"));pos+=ln
        return vals
    if enc=="front": return decode_front_strings(blob,n)
    if enc=="msgpack": return msgpack.unpackb(blob,raw=False)
    raise ValueError(f"unknown encoding {enc}")


def encode_schema_seq(schema_seq, schema_count):
    bits=max(1,(schema_count-1).bit_length())
    packed=bitpack(schema_seq,bits)
    c=[({"enc":"bitpack","bits":bits,"n":len(schema_seq)},packed)]
    runs,rb=encode_runs(schema_seq,lambda v:enc_uvarint(v))
    c.append(({"enc":"rle","runs":runs,"n":len(schema_seq)},rb))
    return choose(c)


def decode_schema_seq(meta,blob):
    if meta["enc"]=="bitpack": return bitunpack(blob,meta["n"],meta["bits"])
    if meta["enc"]=="rle": return decode_runs(blob,meta["runs"],lambda b:dec_uvarint(b,0)[0])
    raise ValueError(meta["enc"])


def encode(records):
    record_flat=[]; schema_map={}; schema_paths=[]; schema_seq=[]
    for rec in records:
        leaves=dict(flatten_leaves(rec));record_flat.append(leaves)
        sig=tuple(sorted(leaves))
        sid=schema_map.get(sig)
        if sid is None:
            sid=len(schema_paths);schema_map[sig]=sid;schema_paths.append(sig)
        schema_seq.append(sid)

    global_paths=sorted(set(itertools.chain.from_iterable(schema_paths)))
    path_id={p:i for i,p in enumerate(global_paths)}
    schemas=[[path_id[p] for p in sig] for sig in schema_paths]

    columns={p:[] for p in global_paths}
    for leaves in record_flat:
        for p,v in leaves.items(): columns[p].append(v)

    data=bytearray(); col_meta=[]; enc_counts=Counter()
    for p in global_paths:
        meta,blob=encode_column(columns[p]); enc_counts[meta["enc"]]+=1
        meta["offset"]=len(data);meta["length"]=len(blob)
        col_meta.append(meta);data+=blob

    smeta,sblob=encode_schema_seq(schema_seq,len(schema_paths))
    metadata={
        "version":4,"record_count":len(records),"paths":[list(p) for p in global_paths],
        "schemas":schemas,"schema_seq":smeta,"schema_seq_len":len(sblob),"columns":col_meta
    }
    mb=msgpack.packb(metadata,use_bin_type=True)
    return MAGIC+struct.pack(">I",len(mb))+mb+sblob+bytes(data),enc_counts


def decode(buf):
    if buf[:4]!=MAGIC: raise ValueError("Not SLC4")
    ml=struct.unpack(">I",buf[4:8])[0]
    meta=msgpack.unpackb(buf[8:8+ml],raw=False)
    pos=8+ml; sl=meta["schema_seq_len"]
    sblob=buf[pos:pos+sl];pos+=sl;data=buf[pos:]
    sseq=decode_schema_seq(meta["schema_seq"],sblob)
    paths=[tuple(p) for p in meta["paths"]]
    cols=[]
    for cm in meta["columns"]:
        off,ln=cm["offset"],cm["length"]
        cols.append(decode_column(cm,data[off:off+ln]))
    curs=[0]*len(paths);out=[]
    for sid in sseq:
        rec={}
        for pid in meta["schemas"][sid]:
            v=cols[pid][curs[pid]];curs[pid]+=1;set_nested(rec,paths[pid],v)
        out.append(rec)
    return out


def zstd_compress(data,level):
    exe=shutil.which("zstd")
    if not exe: raise RuntimeError("zstd executable not found")
    return subprocess.run([exe,f"-{level}","--stdout","--quiet"],input=data,stdout=subprocess.PIPE,check=True).stdout


def human(n):
    if n<1024:return f"{n} B"
    if n<1024**2:return f"{n/1024:.1f} KiB"
    return f"{n/1024**2:.2f} MiB"


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--write-prefix")
    ap.add_argument("--selection", choices=("raw","zstd"), default="raw", help="candidate selection objective")
    args=ap.parse_args()
    global SELECTION_MODE
    SELECTION_MODE=args.selection
    raw=open(args.input,"rb").read(); records=json.loads(raw)
    if not isinstance(records,list): raise SystemExit("Expected top-level JSON array")
    canonical=json.dumps(records,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()

    t=time.perf_counter(); sem,enc_counts=encode(records); et=time.perf_counter()-t
    t=time.perf_counter(); restored=decode(sem); dtm=time.perf_counter()-t
    if restored!=records: raise SystemExit("ERROR round-trip mismatch")

    leaf_schema=Counter(tuple(sorted(p for p,_ in flatten_leaves(x))) for x in records)
    print(f"Records: {len(records):,}; leaf schemas: {len(leaf_schema)}; selection={SELECTION_MODE}")
    print("Column encodings:",", ".join(f"{k}={v}" for k,v in enc_counts.most_common()))
    print(f"Round-trip: OK; encode={et:.3f}s decode={dtm:.3f}s")

    rows=[("original JSON",len(raw),None),("canonical JSON",len(canonical),None),("V4 semantic",len(sem),None)]
    comp={}
    for lev in (3,9,19):
        for name,payload in (("original",raw),("canonical",canonical),("v4",sem)):
            t=time.perf_counter(); c=zstd_compress(payload,lev);elapsed=time.perf_counter()-t
            comp[(name,lev)]=c;rows.append((f"{name}+zstd-{lev}",len(c),elapsed))
    print(f"\n{'Representation':26s} {'Size':>12s} {'% input':>10s} {'time':>9s}")
    print("-"*61)
    for name,n,tm in rows:
        print(f"{name:26s} {human(n):>12s} {100*n/len(raw):9.2f}% {('%.3fs'%tm) if tm is not None else '':>9s}")
    b=len(comp[("canonical",19)]);v=len(comp[("v4",19)])
    print(f"\nV4+ZSTD19 vs canonical+ZSTD19: {(1-v/b)*100:.1f}% smaller")
    print(f"Original -> V4+ZSTD19: {len(raw)/v:.1f}x reduction")
    if args.write_prefix:
        open(args.write_prefix+".slc4","wb").write(sem)
        open(args.write_prefix+".slc4.zst","wb").write(comp[("v4",19)])
        print(f"Wrote {args.write_prefix}.slc4 and {args.write_prefix}.slc4.zst")

if __name__=="__main__": main()
