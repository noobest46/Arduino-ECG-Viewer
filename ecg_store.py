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
    return str(_coll.insert_one(doc).inserted_id)


def list_studies(limit=200):
    """Metadata only (no waveform) for the History list, newest first."""
    if _coll is None:
        return []
    import pymongo
    out = []
    for d in _coll.find({}, {"samples": 0}).sort("created", pymongo.DESCENDING).limit(limit):
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
