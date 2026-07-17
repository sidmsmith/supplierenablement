#!/usr/bin/env python3
"""Shared MAWM API client for supplier enablement scripts."""

import os
import re
from decimal import Decimal
from typing import Dict, List, Optional, Tuple, Union

import requests
import urllib3
from requests.auth import HTTPBasicAuth

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HOST = "https://salep.sce.manh.com"
AUTH_HOST = os.getenv("MANHATTAN_AUTH_HOST", "salep-auth.sce.manh.com")

PO_SEARCH_URL = f"{HOST}/receiving/api/receiving/purchaseOrder/search"
PO_LINE_SEARCH_URL = f"{HOST}/receiving/api/receiving/purchaseOrderLine/search"
ASN_SEARCH_URL = f"{HOST}/receiving/api/receiving/asn/search"
ASN_SAVE_URL = f"{HOST}/receiving/api/receiving/asn/save"
ASN_BULK_IMPORT_URL = f"{HOST}/receiving/api/receiving/asn/bulkImport"
ASN_LPN_CREATE_URL = f"{HOST}/receiving/api/receiving/ui/lpn/create"
NEXTUP_URL = f"{HOST}/receiving/api/nextup/getNextupNumbersByCounterType"
ITEM_SEARCH_URL = f"{HOST}/item-master/api/item-master/item/search"
ILPN_SEARCH_URL = f"{HOST}/dcinventory/api/dcinventory/ilpn/search"
APPOINTMENT_CALENDAR_URL = f"{HOST}/appointment/api/appointment/calendarData"
APPOINTMENT_SCHEDULE_URL = f"{HOST}/appointment/api/appointment/scheduleAppointment"

# schedule_app defaults (v1 parity)
DEFAULT_APPT_RESOURCE_GROUPS = [
    {
        "ResourceGroupName": "Dock",
        "ResourceUnits": [{"ResourceId": "Dock 1"}],
    }
]

USERNAME_BASE = os.getenv("MANHATTAN_USERNAME_BASE", "sdtadmin@")
CLIENT_ID = os.getenv("MANHATTAN_CLIENT_ID", "omnicomponent.1.0.0")
REQUEST_TIMEOUT = 60

_session = requests.Session()
_session.trust_env = False
_NO_PROXY = {"http": None, "https": None}

# PurchaseOrderStatus → label (mawm_api_library/_conventions/statuses.md)
PO_STATUS_LABELS = {
    "0000": "Open",
    "1000": "Created",
    "1500": "Partially Shipped",
    "2000": "Shipped",
    "3000": "In Receiving",
    "9000": "Canceled",
    "10000": "Closed",
}

# AsnStatus — mawm_api_library/_conventions/statuses.md#asn
ASN_STATUS_LABELS = {
    "0000": "Planning",
    "0500": "Open",
    "1000": "In Transit",
    "3000": "In Receiving",
    "8000": "Verified",
    "9000": "Canceled",
}


def _get(url: str, **kwargs) -> requests.Response:
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    kwargs.setdefault("verify", False)
    kwargs.setdefault("proxies", _NO_PROXY)
    return _session.get(url, **kwargs)


def _post(url: str, **kwargs) -> requests.Response:
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    kwargs.setdefault("verify", False)
    kwargs.setdefault("proxies", _NO_PROXY)
    return _session.post(url, **kwargs)


def normalize_token(token: str) -> str:
    """Clean pasted tokens: strip whitespace, quotes, and redundant Bearer prefix."""
    token = (token or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ('"', "'"):
        token = token[1:-1].strip()
    return token


def resolve_location(org: str, location: str = None, default_suffix: str = "DM1") -> str:
    """Resolve full facility id for selectedLocation / DestinationFacilityId."""
    org = org.upper()
    if location and str(location).strip():
        loc = str(location).strip().upper()
        if loc.startswith(org):
            return loc
        if "-" in loc:
            return loc
        return f"{org}-{loc}"
    return f"{org}-{default_suffix}"


def build_receiving_headers(
    token: str, org: str, facility_suffix: str = "DM1", location: str = None
) -> dict:
    org = org.upper()
    loc = resolve_location(org, location, facility_suffix)
    token = normalize_token(token)
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "selectedOrganization": org,
        "selectedLocation": loc,
    }


def get_manhattan_token(org: str) -> Optional[str]:
    """Obtain OAuth token using MANHATTAN_PASSWORD and MANHATTAN_SECRET env vars."""
    password = os.getenv("MANHATTAN_PASSWORD", "").strip()
    secret = os.getenv("MANHATTAN_SECRET", "").strip()
    if not password or not secret:
        return None

    url = f"https://{AUTH_HOST}/oauth/token"
    username = f"{USERNAME_BASE}{org.lower()}"
    data = {
        "grant_type": "password",
        "username": username,
        "password": password,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    auth = HTTPBasicAuth(CLIENT_ID, secret)
    try:
        response = _post(url, data=data, headers=headers, auth=auth)
        if response.status_code == 200:
            return response.json().get("access_token")
        print(f"OAuth failed ({response.status_code}): {response.text[:300]}")
    except requests.RequestException as exc:
        print(f"OAuth error: {exc}")
    return None


def verify_auth(token: str, org: str, location: str = None) -> Tuple[bool, str]:
    """Optional sanity check — confirms PO search works with this token."""
    token = normalize_token(token)
    payload = {"Query": "", "Page": 0, "Size": 1}
    response = _post(
        PO_SEARCH_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )
    if response.status_code in (401, 403):
        return False, (
            f"PO search rejected ({response.status_code}). "
            f"Token length={len(token)}. Response: {response.text[:300]}"
        )
    if response.status_code != 200:
        return False, f"PO search check failed ({response.status_code}): {response.text[:300]}"
    return True, "Token verified via PO search."


def validate_org(org: str) -> bool:
    return bool(re.match(r"^[A-Z0-9]+-DEMO$", org or ""))


def _response_data_list(body) -> List[dict]:
    if isinstance(body, list):
        return [row for row in body if isinstance(row, dict)]
    if not isinstance(body, dict):
        return []
    data = body.get("data") or body.get("Data") or []
    return data if isinstance(data, list) else []


def _dec(value) -> Optional[Decimal]:
    if value in (None, "", []):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def remaining_qty(line: dict) -> Decimal:
    """Unshipped / remaining quantity on a PO line."""
    unshipped = _dec(line.get("UnShippedQuantity"))
    if unshipped is not None:
        return max(unshipped, Decimal("0"))
    ordered = _dec(line.get("OrderQuantity")) or Decimal("0")
    shipped = _dec(line.get("ShippedQuantity")) or Decimal("0")
    return max(ordered - shipped, Decimal("0"))


def is_excluded_flag(value) -> bool:
    """True when Closed/Canceled is true or null (product Create-ASN-from-PO rule)."""
    if value is True:
        return True
    if value is None:
        return True
    if isinstance(value, str) and value.strip().lower() in ("true", "null", ""):
        return True
    return False


def line_excluded_by_flags(line: dict) -> bool:
    """Exclude when Closed/Canceled is present and true/null; missing keys are allowed."""
    for flag in ("Canceled", "Closed"):
        if flag not in line:
            continue
        if is_excluded_flag(line.get(flag)):
            return True
    return False


def po_status_label(status_id) -> str:
    """Status code with description, e.g. '1500 (Partially Shipped)'."""
    if status_id in (None, ""):
        return ""
    key = str(status_id).strip()
    label = PO_STATUS_LABELS.get(key)
    return f"{key} ({label})" if label else key


def po_status_description(status_id) -> str:
    """Human status only, e.g. 'Partially Shipped'."""
    if status_id in (None, ""):
        return ""
    key = str(status_id).strip()
    return PO_STATUS_LABELS.get(key) or key


def asn_status_description(status_id) -> str:
    """Human ASN status only, e.g. 'In Transit'."""
    if status_id in (None, ""):
        return ""
    key = str(status_id).strip()
    return ASN_STATUS_LABELS.get(key) or key


def _extract_nextup_number(body) -> Optional[str]:
    if isinstance(body, str) and body.strip():
        return body.strip()
    if isinstance(body, list) and body:
        first = body[0]
        if isinstance(first, str) and first.strip():
            return first.strip()
        if isinstance(first, dict):
            for key in ("AsnId", "NextNumber", "Number", "value", "Value"):
                if first.get(key):
                    return str(first[key]).strip()
            vals = [v for v in first.values() if v not in (None, "")]
            if len(vals) == 1:
                return str(vals[0]).strip()
        return str(first).strip()
    if isinstance(body, dict):
        raw = body.get("data")
        if raw is None:
            raw = body.get("Data")
        extracted = _extract_nextup_number(raw)
        if extracted:
            return extracted
        for key in ("AsnId", "NextNumber", "Number", "value", "Value"):
            if body.get(key):
                return str(body[key]).strip()
    return None


def get_next_asn_number(token: str, org: str, location: str = None) -> str:
    """GET next ASN number from receiving nextup (counterTypeId=AsnNumber)."""
    token = normalize_token(token)
    url = f"{NEXTUP_URL}?count=1&counterTypeId=AsnNumber"
    response = _get(url, headers=build_receiving_headers(token, org, location=location))
    if response.status_code != 200:
        raise RuntimeError(
            f"Nextup AsnNumber failed ({response.status_code}): {response.text[:500]}"
        )
    try:
        body = response.json() if response.text else {}
    except ValueError:
        body = response.text
    asn_id = _extract_nextup_number(body)
    if not asn_id:
        raise RuntimeError(f"Nextup returned no AsnNumber. Response: {response.text[:500]}")
    return asn_id


def create_shell_asn(
    asn_id: str,
    token: str,
    org: str,
    destination_facility_id: str,
    estimated_delivery_date: str,
    location: str = None,
) -> requests.Response:
    """Create In-Planning shell ASN header (Create ASN from PO parity)."""
    token = normalize_token(token)
    payload = {
        "AsnId": asn_id,
        "AsnLevelId": "ITEM",
        "AsnOriginTypeId": "P",
        "AsnStatus": "0000",
        "DestinationFacilityId": destination_facility_id,
        "EstimatedDeliveryDate": estimated_delivery_date,
    }
    return _post(
        ASN_SAVE_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )


def bulk_import_asn(
    payload: dict, token: str, org: str, location: str = None
) -> requests.Response:
    token = normalize_token(token)
    return _post(
        ASN_BULK_IMPORT_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )


def _flatten_purchase_orders(po_rows: List[dict]) -> Dict[Tuple[str, str], dict]:
    """Map (PurchaseOrderId, PurchaseOrderLineId) → line row enriched with header fields."""
    out: Dict[Tuple[str, str], dict] = {}
    for po in po_rows:
        po_id = str(po.get("PurchaseOrderId") or "").strip()
        po_status = po.get("PurchaseOrderStatus")
        vendor = po.get("VendorId")
        dest = po.get("DestinationFacilityId")
        for line in po.get("PurchaseOrderLine") or []:
            row = dict(line)
            row["PurchaseOrderId"] = str(row.get("PurchaseOrderId") or po_id).strip() or po_id
            status = row.get("PurchaseOrderStatus")
            nested = row.get("PurchaseOrder")
            if status in (None, "") and isinstance(nested, dict):
                status = nested.get("PurchaseOrderStatus")
            row["PurchaseOrderStatus"] = status if status not in (None, "") else po_status
            if vendor and not row.get("VendorId"):
                row["VendorId"] = vendor
            if dest and not row.get("DestinationFacilityId"):
                row["DestinationFacilityId"] = dest
            line_id = str(row.get("PurchaseOrderLineId") or "").strip()
            if not po_id or not line_id:
                continue
            out[(po_id, line_id)] = row
    return out


def _overlay_qty_and_status(line: dict, header_line: dict) -> dict:
    """Prefer purchaseOrder nested line for qty/status (authoritative for CLI display)."""
    merged = dict(line)
    for key in (
        "OrderQuantity",
        "ShippedQuantity",
        "UnShippedQuantity",
        "QuantityUomId",
        "Closed",
        "Canceled",
        "ItemId",
        "VendorId",
        "DestinationFacilityId",
    ):
        if key in header_line and header_line.get(key) is not None:
            merged[key] = header_line.get(key)
    if header_line.get("PurchaseOrderStatus") not in (None, ""):
        merged["PurchaseOrderStatus"] = header_line.get("PurchaseOrderStatus")
    elif not merged.get("PurchaseOrderStatus"):
        nested = merged.get("PurchaseOrder")
        if isinstance(nested, dict) and nested.get("PurchaseOrderStatus"):
            merged["PurchaseOrderStatus"] = nested.get("PurchaseOrderStatus")
    return merged


def search_purchase_order_lines(
    purchase_order_ids: List[str],
    token: str,
    org: str,
    location: str = None,
    size: int = 200,
) -> Tuple[List[dict], str]:
    """
    Search PO lines for Create-ASN-from-PO.

    Uses purchaseOrderLine/search when available, always overlays quantity + status
    from purchaseOrder/search nested lines (those fields are the WMS source of truth).
    """
    token = normalize_token(token)
    clean = [str(p).strip() for p in purchase_order_ids if str(p).strip()]
    if not clean:
        return [], "none"
    quoted = ", ".join(f"'{po.replace(chr(39), chr(39) + chr(39))}'" for po in clean)
    query = f"PurchaseOrderId IN ({quoted})"
    headers = build_receiving_headers(token, org, location=location)

    po_payload = {
        "Query": query,
        "Page": 0,
        "Size": max(size, len(clean)),
    }
    po_response = _post(PO_SEARCH_URL, headers=headers, json=po_payload)
    if po_response.status_code != 200:
        raise RuntimeError(
            f"PO search failed ({po_response.status_code}): {po_response.text[:500]}"
        )
    header_map = _flatten_purchase_orders(_response_data_list(po_response.json()))

    line_payload = {"Query": query, "Page": 0, "Size": max(size, len(clean) * 50)}
    line_response = _post(PO_LINE_SEARCH_URL, headers=headers, json=line_payload)
    line_rows: List[dict] = []
    if line_response.status_code == 200:
        line_rows = _response_data_list(line_response.json())

    if line_rows:
        merged_rows: List[dict] = []
        for line in line_rows:
            po_id = str(line.get("PurchaseOrderId") or "").strip()
            nested = line.get("PurchaseOrder")
            if not po_id and isinstance(nested, dict):
                po_id = str(nested.get("PurchaseOrderId") or "").strip()
            line_id = str(line.get("PurchaseOrderLineId") or "").strip()
            header_line = header_map.get((po_id, line_id))
            if header_line:
                merged_rows.append(_overlay_qty_and_status(line, header_line))
            else:
                # Still try status from nested PO stub
                row = dict(line)
                row["PurchaseOrderId"] = po_id
                if not row.get("PurchaseOrderStatus") and (po_id, line_id) in header_map:
                    row["PurchaseOrderStatus"] = header_map[(po_id, line_id)].get(
                        "PurchaseOrderStatus"
                    )
                merged_rows.append(row)
        return merged_rows, "purchaseOrderLine+purchaseOrder"

    if not header_map:
        return [], "purchaseOrder"
    return list(header_map.values()), "purchaseOrder"


def filter_eligible_po_lines(lines: List[dict]) -> List[dict]:
    """Exclude canceled/closed (true or null when present) and zero remaining qty."""
    eligible = []
    for line in lines:
        if line_excluded_by_flags(line):
            continue
        if remaining_qty(line) <= 0:
            continue
        eligible.append(line)
    return eligible


def search_items(
    item_ids: List[str], token: str, org: str, location: str = None
) -> Dict[str, dict]:
    clean = [str(i).strip() for i in item_ids if str(i).strip()]
    if not clean:
        return {}
    quoted = ", ".join(
        f"'{item_id.replace(chr(39), chr(39) + chr(39))}'" for item_id in clean
    )
    payload = {
        "Query": f"ItemId in ({quoted})",
        "Page": 0,
        "Size": max(len(clean), 50),
        "Template": {
            "ItemId": "",
            "Description": "",
            "ImageUrl": "",
        },
    }
    headers = build_receiving_headers(token, org, location=location)
    headers["FacilityId"] = resolve_location(org, location)
    try:
        response = _post(ITEM_SEARCH_URL, headers=headers, json=payload)
    except requests.RequestException as exc:
        print(f"Warning: item search failed: {exc}")
        return {}
    if response.status_code != 200:
        print(f"Warning: item search failed: {response.status_code}")
        return {}
    data = _response_data_list(response.json())
    return {str(item.get("ItemId")): item for item in data if item.get("ItemId")}


def search_asn(asn_id: str, token: str, org: str, location: str = None) -> Optional[dict]:
    token = normalize_token(token)
    payload = {
        "Query": f"AsnId ='{asn_id}'",
        "Size": 5,
        "Page": 0,
    }
    response = _post(
        ASN_SEARCH_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"ASN search failed: {response.status_code} {response.text[:500]}"
        )
    data = _response_data_list(response.json())
    return data[0] if data else None


def search_asns_by_purchase_order(
    purchase_order_id: str,
    token: str,
    org: str,
    location: str = None,
    size: int = 50,
) -> List[dict]:
    """ASNs that have at least one AsnLine for the PO (full AsnLine[] still returned).

    Nested Query path required — header PurchaseOrderId on ASN search returns 400.
    """
    po_id = str(purchase_order_id or "").strip()
    if not po_id:
        return []
    token = normalize_token(token)
    payload = {
        "Query": f"AsnLine.PurchaseOrderId ='{po_id}'",
        "Size": max(1, min(int(size or 50), 200)),
        "Page": 0,
    }
    response = _post(
        ASN_SEARCH_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"ASN search by PO failed: {response.status_code} {response.text[:500]}"
        )
    return _response_data_list(response.json())


def create_lpns(
    payload: List[dict], token: str, org: str, location: str = None
) -> requests.Response:
    """POST receiving UI LPN create. Body is an array of line cartonize rows."""
    token = normalize_token(token)
    return _post(
        ASN_LPN_CREATE_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )


def search_ilpns_by_asn(
    asn_id: str, token: str, org: str, location: str = None, size: int = 200
) -> List[dict]:
    token = normalize_token(token)
    payload = {
        "Query": f"AsnId ='{asn_id}'",
        "Size": size,
        "Page": 0,
    }
    response = _post(
        ILPN_SEARCH_URL,
        headers=build_receiving_headers(token, org, location=location),
        json=payload,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"iLPN search failed: {response.status_code} {response.text[:500]}"
        )
    return _response_data_list(response.json())


def search_purchase_orders(
    po_ids: List[str], token: str, org: str, location: str = None
) -> Dict[str, dict]:
    """Return map PurchaseOrderId -> PO header dict."""
    ids = [str(p).strip() for p in (po_ids or []) if str(p).strip()]
    if not ids:
        return {}
    token = normalize_token(token)
    headers = build_receiving_headers(token, org, location=location)
    out: Dict[str, dict] = {}
    # Batch OR query in chunks to keep Query reasonable
    chunk_size = 20
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i : i + chunk_size]
        if len(chunk) == 1:
            query = f"PurchaseOrderId ='{chunk[0]}'"
        else:
            quoted = ", ".join(f"'{pid}'" for pid in chunk)
            query = f"PurchaseOrderId in ({quoted})"
        response = _post(
            PO_SEARCH_URL,
            headers=headers,
            json={"Query": query, "Size": max(50, len(chunk)), "Page": 0},
        )
        if response.status_code != 200:
            print(f"Warning: PO search failed: {response.status_code}")
            continue
        for row in _response_data_list(response.json()):
            pid = str(row.get("PurchaseOrderId") or "")
            if pid:
                out[pid] = row
    return out


def fetch_appointment_calendar(
    token: str,
    org: str,
    calendar_date: str,
    location: str = None,
    resource_groups: List[dict] = None,
) -> dict:
    """POST appointment/calendarData for one calendar day (YYYY-MM-DD)."""
    date_only = str(calendar_date or "").strip()[:10]
    if not date_only:
        raise ValueError("calendar_date required (YYYY-MM-DD)")
    dest = resolve_location(org, location)
    payload = {
        "FacilityId": dest,
        "CalendarDate": f"{date_only}T05:00:00",
        "ResourceGroups": resource_groups or DEFAULT_APPT_RESOURCE_GROUPS,
    }
    response = _post(
        APPOINTMENT_CALENDAR_URL,
        headers=build_receiving_headers(token, org, location=dest),
        json=payload,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"calendarData failed: {response.status_code} {response.text[:500]}"
        )
    body = response.json()
    if isinstance(body, dict) and body.get("success") is False:
        raise RuntimeError(body.get("error") or body.get("message") or "calendarData failed")
    return body if isinstance(body, dict) else {"data": body}


def schedule_appointment(
    token: str,
    org: str,
    preferred_date_time: str,
    location: str = None,
    appointment_type_id: str = "DROP_UNLOAD",
    equipment_type_id: str = "48FT",
    duration: int = 60,
    appointment_status_id: str = "3000",
    asn_id: str = None,
) -> dict:
    """POST scheduleAppointment; optionally attach ASN (ContentType ASNs)."""
    preferred = str(preferred_date_time or "").strip()
    if not preferred:
        raise ValueError("PreferredDateTime required")
    dest = resolve_location(org, location)
    payload = {
        "AppointmentTypeId": appointment_type_id,
        "EquipmentTypeId": equipment_type_id,
        "PreferredDateTime": preferred,
        "Duration": int(duration or 60),
        "AppointmentStatusId": appointment_status_id,
    }
    asn = str(asn_id or "").strip()
    if asn:
        payload["ContentType"] = "ASNs"
        payload["AppointmentContents"] = [{"Asn": asn}]
        payload["Asn"] = [{"AsnId": asn, "DestinationFacilityId": dest}]
    response = _post(
        APPOINTMENT_SCHEDULE_URL,
        headers=build_receiving_headers(token, org, location=dest),
        json=payload,
    )
    try:
        body = response.json()
    except Exception:
        body = {"raw": response.text[:1200]}
    if response.status_code not in (200, 201):
        raise RuntimeError(
            f"scheduleAppointment failed: {response.status_code} {response.text[:500]}"
        )
    if isinstance(body, dict) and body.get("success") is False:
        raise RuntimeError(body.get("error") or body.get("message") or "scheduleAppointment failed")
    if isinstance(body, dict):
        body["_requestPayload"] = payload
    return body if isinstance(body, dict) else {"data": body, "_requestPayload": payload}


def render_zpl_labels_pdf(zpl: str, width_in: float = 4.0, height_in: float = 6.0) -> bytes:
    """Convert one or more ZPL labels to a multi-page PDF via Labelary."""
    url = (
        f"http://api.labelary.com/v1/printers/8dpmm/labels/"
        f"{width_in}x{height_in}/"
    )
    response = _post(
        url,
        headers={"Accept": "application/pdf"},
        data=zpl.encode("utf-8"),
        timeout=120,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"Labelary PDF failed ({response.status_code}): {response.text[:400]}"
        )
    return response.content


def qty_for_payload(value) -> Union[float, int]:
    dec = Decimal(str(value))
    if dec == dec.to_integral_value():
        return int(dec)
    return float(dec)
