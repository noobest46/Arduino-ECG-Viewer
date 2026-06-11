# Standalone ECG archive viewer.
#
# Serves the SAME dashboard UI (History + replay) but reads saved studies from the
# same MongoDB Atlas database the board writes to — independent of the Arduino.
# Deploy anywhere (Render/Railway/...); set the MONGODB_URI environment variable to
# the same connection string the board uses. Read-only: no save/delete endpoints.

import os
from flask import Flask, jsonify, send_from_directory

import ecg_store  # storage layer — reads MONGODB_URI env var (or a local db_config.py)

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

# 24-bit LSB size in microvolts (Vref 2.4 V, gain 6) — matches the board.
LSB_UV = (2 * 2.4 / 6) / (1 << 24) * 1e6

app = Flask(__name__, static_folder=None)


@app.get("/")
def index():
    return send_from_directory(ASSETS, "index.html")


@app.get("/meta")
def meta():
    return jsonify({"n_channels": 8, "lsb_uv": LSB_UV})


@app.get("/studies")
def studies():
    return jsonify(ecg_store.list_studies())


@app.get("/study/<study_id>")
def study(study_id):
    return jsonify(ecg_store.get_study(study_id) or {"error": "not found"})


@app.get("/<path:path>")
def static_assets(path):
    return send_from_directory(ASSETS, path)


if __name__ == "__main__":
    # Local testing only. In production use a WSGI server: gunicorn viewer:app
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port)
