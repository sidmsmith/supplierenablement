# api/index.py
import os
import sys
from pathlib import Path

from flask import Flask, jsonify, request
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mawm_client import get_manhattan_token, normalize_token, validate_org  # noqa: E402
from se_service import (  # noqa: E402
    create_asn_from_staged,
    load_pos_detail,
    match_preload_entries,
    preload_po_index,
    preview_create_asn,
)

app = Flask(__name__)

PASSWORD = os.getenv("MANHATTAN_PASSWORD")
CLIENT_SECRET = os.getenv("MANHATTAN_SECRET")
USAGE_INGEST_URL = os.getenv("MANHATTAN_USAGE_INGEST_URL", "").strip()
APP_NAME = "supplierenablement-app"
APP_VERSION = "0.1.1"
DEFAULT_ORG = os.getenv("MANHATTAN_DEFAULT_ORG", "SS-DEMO").strip().upper() or "SS-DEMO"
TOKEN_FILE = ROOT / ".token"


def read_local_token_file() -> str:
    """Local-dev Bearer token from .token (gitignored). Empty on Vercel / missing file."""
    try:
        if not TOKEN_FILE.is_file():
            return ""
        return normalize_token(TOKEN_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[auth] Could not read .token: {e}")
        return ""


def resolve_bearer_token(org: str) -> tuple:
    """
    Resolve access token.
    Priority: project .token file > OAuth env vars.
    Returns (token, source) where source is 'token-file' | 'oauth' | None.
    """
    file_token = read_local_token_file()
    if file_token:
        return file_token, "token-file"
    oauth = get_manhattan_token(org)
    if oauth:
        return normalize_token(oauth), "oauth"
    return None, None


def _json():
    return request.get_json(silent=True) or {}


def forward_usage_event(payload):
    if not USAGE_INGEST_URL:
        return
    import requests

    try:
        requests.post(
            USAGE_INGEST_URL,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=8,
            verify=False,
        )
    except Exception as e:
        print(f"[usage] Forward failed: {e}")


def _require_auth_fields(data):
    org = (data.get("org") or "").strip().upper()
    token = (data.get("token") or "").strip()
    if not org or not token:
        return None, None, jsonify({"success": False, "error": "ORG and token required"})
    return org, token, None


@app.route("/api/app_opened", methods=["POST"])
def app_opened():
    forward_usage_event(
        {
            "app": APP_NAME,
            "version": APP_VERSION,
            "event": "app_opened",
            **(_json() or {}),
        }
    )
    return jsonify({"success": True})


@app.route("/api/auth", methods=["POST"])
def auth():
    data = _json()
    org = (data.get("org") or DEFAULT_ORG).strip().upper()
    if not org:
        return jsonify({"success": False, "error": "ORG required"})
    if not validate_org(org):
        return jsonify(
            {"success": False, "error": "Invalid ORG. Must end with -DEMO (e.g. SS-DEMO)."}
        )
    token, source = resolve_bearer_token(org)
    if token:
        forward_usage_event(
            {
                "app": APP_NAME,
                "version": APP_VERSION,
                "event": "auth_success",
                "org": org,
                "source": source,
            }
        )
        return jsonify(
            {
                "success": True,
                "token": token,
                "org": org,
                "source": source,
                "fromTokenFile": source == "token-file",
            }
        )
    forward_usage_event(
        {"app": APP_NAME, "version": APP_VERSION, "event": "auth_failed", "org": org}
    )
    has_oauth = bool(PASSWORD and CLIENT_SECRET)
    has_file = TOKEN_FILE.is_file()
    hint = (
        "Auth failed. Place a Bearer token in .token (local), "
        "or set MANHATTAN_PASSWORD / MANHATTAN_SECRET."
    )
    if has_file and not has_oauth:
        hint = "Auth failed reading .token (empty or invalid)."
    elif not has_file and not has_oauth:
        hint = "No .token file and MANHATTAN_PASSWORD / MANHATTAN_SECRET are not set."
    return jsonify({"success": False, "error": hint})


@app.route("/api/preload", methods=["POST"])
def preload():
    data = _json()
    org, token, err = _require_auth_fields(data)
    if err:
        return err
    location = (data.get("location") or data.get("facility") or "").strip() or None
    try:
        result = preload_po_index(token, org, location=location)
        return jsonify(result)
    except Exception as e:
        print(f"[PRELOAD] {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/load_pos", methods=["POST"])
def load_pos():
    data = _json()
    org, token, err = _require_auth_fields(data)
    if err:
        return err
    location = (data.get("location") or data.get("facility") or "").strip() or None
    po_ids = data.get("purchaseOrderIds") or data.get("poIds") or []
    criteria = (data.get("criteria") or "").strip()
    preload_entries = data.get("preloadEntries")

    try:
        if not po_ids and criteria and isinstance(preload_entries, list):
            matched = match_preload_entries(preload_entries, criteria)
            po_ids = [m["purchaseOrderId"] for m in matched]
        po_ids = [str(p).strip() for p in po_ids if str(p).strip()]
        # de-dupe preserve order
        seen = set()
        clean = []
        for p in po_ids:
            if p not in seen:
                seen.add(p)
                clean.append(p)
        if not clean:
            return jsonify({"success": False, "error": "No matching purchase orders"})
        result = load_pos_detail(token, org, clean, location=location)
        return jsonify(result)
    except Exception as e:
        print(f"[LOAD_POS] {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/preview_asn", methods=["POST"])
def preview_asn():
    data = _json()
    org, token, err = _require_auth_fields(data)
    if err:
        return err
    location = (data.get("location") or "").strip() or None
    facility = (data.get("facility") or "").strip() or None
    edd = (data.get("edd") or "").strip() or None
    staged = data.get("lines") or data.get("staged") or []
    try:
        result = preview_create_asn(
            token,
            org,
            staged,
            location=location,
            facility=facility,
            edd=edd,
        )
        return jsonify(result)
    except Exception as e:
        print(f"[PREVIEW_ASN] {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/create_asn", methods=["POST"])
def create_asn():
    data = _json()
    org, token, err = _require_auth_fields(data)
    if err:
        return err
    location = (data.get("location") or "").strip() or None
    facility = (data.get("facility") or "").strip() or None
    edd = (data.get("edd") or "").strip() or None
    asn_id = (data.get("asnId") or data.get("asn_id") or "").strip()
    staged = data.get("lines") or data.get("staged") or []
    skip_shell = bool(data.get("skipShell") or data.get("skip_shell"))
    try:
        result = create_asn_from_staged(
            token,
            org,
            staged,
            asn_id=asn_id,
            facility=facility,
            location=location,
            edd=edd,
            skip_shell=skip_shell,
        )
        forward_usage_event(
            {
                "app": APP_NAME,
                "version": APP_VERSION,
                "event": "create_asn_completed" if result.get("success") else "create_asn_failed",
                "org": org,
                "asnId": asn_id,
            }
        )
        return jsonify(result)
    except Exception as e:
        print(f"[CREATE_ASN] {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# Local Flask entry (vercel wraps the module)
if __name__ == "__main__":
    app.run(port=5000, debug=True)
