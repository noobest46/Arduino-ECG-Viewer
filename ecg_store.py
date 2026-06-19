# MongoDB (Atlas) storage for ECG studies — discrete snapshots.
# Graceful: if no connection string or the DB is unreachable, every function
# no-ops and the dashboard keeps running without persistence.
#
# Connection string (mongodb+srv://...) is read from:
#   1. env var MONGODB_URI, else
#   2. python/db_config.py  ->  MONGODB_URI = "mongodb+srv://user:pass@cluster/..."
# Keep db_config.py OUT of git/sharing — it holds your DB password.

import os
import time
import struct
import logging

log = logging.getLogger("ecg-store")

_URI = os.environ.get("MONGODB_URI")
if not _URI:
    try:
        from db_config import MONGODB_URI as _URI       # local, gitignored
    except Exception:
        _URI = None

_coll = None
if _URI:
    try:
        from pymongo import MongoClient
        _client = MongoClient(_URI, serverSelectionTimeoutMS=4000)
        _client.admin.command("ping")                  # verify we can actually reach it
        _coll = _client["ecg"]["studies"]
        log.info("MongoDB connected (ecg.studies)")
    except Exception as e:
        log.warning(f"MongoDB disabled ({e})")
        _coll = None
else:
    log.info("MongoDB disabled (no MONGODB_URI / db_config.py)")


def available():
    return _coll is not None


# ---- EDF+ writer (pure Python; mirrors assets/app.js buildEDF) ----------------
_LEAD_LABELS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]
_MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def _edf_field(s, n):
    s = str(s)[:n]
    return s + " " * (n - len(s))


def _derive12(c):
    """8 measured channels -> 12 standard leads (same mapping as the dashboard)."""
    i, ii = c[1], c[2]
    return [i, ii, ii - i, -(i + ii) / 2, i - ii / 2, ii - i / 2,
            c[7], c[3], c[4], c[5], c[6], c[0]]


def build_edf(rows, fs, lsb_uv, patient="X", created=None):
    """Raw 12-lead EDF+ (uV, int16) from [c0..c7] count rows. Returns bytes."""
    rows = list(rows)
    N, ns, spr, ANN = len(rows), 12, int(fs), 128
    ann_spr, nrec = ANN // 2, max(1, (N + int(fs) - 1) // int(fs))
    derived = [_derive12(c) for c in rows]
    leads = [[derived[i][li] * lsb_uv for i in range(N)] for li in range(ns)]
    # Fixed +/-16 mV physical range on every file (NOT the recording's own min/max), so the uV<->digital
    # calibration is identical across all studies: EDFbrowser shows the same amplitude every time and a
    # saved montage applies to any file. +/-16 mV covers ECG + electrode-offset headroom; ~0.49 uV/LSB.
    glo, ghi = -16000, 16000
    pmin = [int(glo)] * ns
    pmax = [int(ghi)] * ns
    sig = ns + 1
    header_len = 256 * (sig + 1)
    d = time.localtime(created if created else time.time())
    pid = str(patient).replace(" ", "_") or "X"
    h = _edf_field("0", 8)
    h += _edf_field(pid + " X X X", 80)
    h += _edf_field("Startdate %02d-%s-%04d X UNOQ-ECG raw_12lead_%dHz"
                    % (d.tm_mday, _MON[d.tm_mon - 1], d.tm_year, fs), 80)
    h += _edf_field("%02d.%02d.%02d" % (d.tm_mday, d.tm_mon, d.tm_year % 100), 8)
    h += _edf_field("%02d.%02d.%02d" % (d.tm_hour, d.tm_min, d.tm_sec), 8)
    h += _edf_field(str(header_len), 8)
    h += _edf_field("EDF+C", 44)
    h += _edf_field(str(nrec), 8)
    h += _edf_field("1", 8)
    h += _edf_field(str(sig), 4)
    labels = ["ECG " + lbl for lbl in _LEAD_LABELS] + ["EDF Annotations"]
    cols = [[], [], [], [], [], [], [], [], [], []]
    for c in range(sig):
        ann = c == ns
        cols[0].append(_edf_field(labels[c], 16))
        cols[1].append(_edf_field("", 80))
        cols[2].append(_edf_field("" if ann else "uV", 8))
        cols[3].append(_edf_field("-1" if ann else str(pmin[c]), 8))
        cols[4].append(_edf_field("1" if ann else str(pmax[c]), 8))
        cols[5].append(_edf_field("-32768", 8))
        cols[6].append(_edf_field("32767", 8))
        cols[7].append(_edf_field("", 80))
        cols[8].append(_edf_field(str(ann_spr if ann else spr), 8))
        cols[9].append(_edf_field("", 32))
    for col in cols:
        h += "".join(col)
    out = bytearray(header_len + nrec * (ns * spr * 2 + ANN))
    out[:header_len] = h.encode("latin1")
    off = header_len
    for r in range(nrec):
        for c in range(ns):
            arr, lo, span = leads[c], pmin[c], pmax[c] - pmin[c]
            for k in range(spr):
                idx = r * spr + k
                v = arr[idx] if idx < N else (arr[N - 1] if N else 0)
                q = int(round((v - lo) / span * 65535 - 32768))
                q = -32768 if q < -32768 else (32767 if q > 32767 else q)
                struct.pack_into("<h", out, off, q)
                off += 2
        tal = "+%d\x14\x14\x00" % r
        if r == 0:
            tal += "+0\x14%s | raw 12-lead @ %d Hz\x14\x00" % (pid, fs)
        tb = tal.encode("latin1")
        for b in range(ANN):
            out[off + b] = tb[b] if b < len(tb) else 0
        off += ANN
    return bytes(out)


def save_study(patient, fs, lsb_uv, n_channels, samples):
    """samples = list of [c0..c7] int rows. Returns the new study id (str) or None."""
    if _coll is None:
        return None
    doc = {
        "patient": (patient or "anon").strip()[:64],
        "created": time.time(),
        "fs": fs,
        "lsb_uv": lsb_uv,
        "n_channels": n_channels,
        "n_samples": len(samples),
        "samples": samples,
    }
    try:
        doc["edf"] = build_edf(samples, fs, lsb_uv, doc["patient"], doc["created"])  # raw data as EDF+
    except Exception as e:
        log.warning(f"EDF build failed: {e}")
    return str(_coll.insert_one(doc).inserted_id)


def list_studies(limit=200):
    """Metadata only (no waveform) for the History list, newest first."""
    if _coll is None:
        return []
    import pymongo
    out = []
    for d in _coll.find({}, {"samples": 0, "edf": 0}).sort("created", pymongo.DESCENDING).limit(limit):
        out.append({
            "id": str(d["_id"]),
            "patient": d.get("patient", "anon"),
            "created": d.get("created"),
            "n_samples": d.get("n_samples"),
            "fs": d.get("fs"),
        })
    return out


def get_study(study_id):
    """Full study (incl. samples) for replay, or None."""
    if _coll is None:
        return None
    from bson import ObjectId
    try:
        d = _coll.find_one({"_id": ObjectId(study_id)})
    except Exception:
        return None
    if not d:
        return None
    d.pop("edf", None)            # binary blob isn't JSON-serialisable; fetched via get_study_edf
    d["id"] = str(d.pop("_id"))
    return d


def delete_study(study_id):
    """Delete one study by id. Returns True if a document was removed."""
    if _coll is None:
        return False
    from bson import ObjectId
    try:
        return _coll.delete_one({"_id": ObjectId(study_id)}).deleted_count > 0
    except Exception:
        return False


def clear_studies():
    """Delete ALL studies. Returns the number removed."""
    if _coll is None:
        return 0
    return _coll.delete_many({}).deleted_count


def get_study_edf(study_id):
    """Raw EDF+ bytes for a study. Uses the stored blob, or builds it on the fly
    for older studies saved before EDF storage existed. Returns bytes or None."""
    if _coll is None:
        return None
    from bson import ObjectId
    try:
        d = _coll.find_one({"_id": ObjectId(study_id)})
    except Exception:
        return None
    if not d:
        return None
    if d.get("edf"):
        return bytes(d["edf"])
    if d.get("samples"):
        lsb = d.get("lsb_uv") or ((2 * 2.4 / 6) / (1 << 24) * 1e6)
        try:
            return build_edf(d["samples"], d.get("fs", 125), lsb, d.get("patient", "X"), d.get("created"))
        except Exception:
            return None
    return None
