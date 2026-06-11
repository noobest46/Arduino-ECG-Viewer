# ECG archive viewer — deploy guide

A standalone web app that shows the **saved ECG studies** (History + replay) by reading
the same **MongoDB Atlas** database the board writes to. It does **not** need the Arduino —
people can open it and review past recordings with the board switched off.

## What's in this folder
- `viewer.py` — Flask server, read-only (`/studies`, `/study/<id>`, `/meta`)
- `ecg_store.py` — MongoDB reader (a copy of the board app's `python/ecg_store.py`)
- `assets/` — the dashboard UI in **viewer mode** (a copy of `uno_q_app/assets/`, with
  `window.ECG_VIEWER = true` set in `index.html`, so `app.js` skips the live stream and
  hides Save / REC / delete)
- `requirements.txt`, `Procfile`, `render.yaml` — for hosting

The connection string is read from the **`MONGODB_URI` environment variable** — never
commit it. It's the same string as the board's `db_config.py`.

## 1. Test locally first
```powershell
cd "G:\My Drive\University\FYP\Code\ecg-dashboard\viewer"
pip install -r requirements.txt
$env:MONGODB_URI = "mongodb+srv://USER:PASS@cluster0.gnzo17u.mongodb.net/?appName=Cluster0"
python viewer.py
```
Open <http://localhost:8000> — the studies list opens automatically; click one to replay.
(You can also drop a local `db_config.py` here instead of setting the env var.)

## 2. Deploy to Render (free, public URL)
1. Put this `viewer/` folder in a **GitHub repo** (whole repo or this subfolder).
2. On <https://render.com> → **New → Web Service** → connect the repo.
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn viewer:app`
   - (Or **New → Blueprint**, which reads `render.yaml` automatically.)
3. **Environment → Add Environment Variable**: `MONGODB_URI` = your Atlas string.
4. In Atlas, keep **Network Access** allowing `0.0.0.0/0` (Render's IPs aren't fixed).
5. Deploy → Render gives a public URL like `https://ecg-archive-viewer.onrender.com`.

Anyone with that link can review the recordings — board on or off.

## ⚠️ Privacy / security note (worth a line in your report)
This viewer is **public and unauthenticated** — anyone with the URL can see the ECGs.
Fine for an FYP demo; real patient data would need a login, and a locked-down Atlas IP
list. The viewer is **read-only** (no delete) to prevent accidental data loss. Free Render
services also **sleep when idle** and take ~30 s to wake on the first request.

> Note: `assets/app.js`, `assets/style.css` and `ecg_store.py` here are **copies** of the
> board app's files. If you change those on the board, re-copy them here to keep the viewer
> in sync.
