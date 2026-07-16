#!/usr/bin/env python3
"""Supplier Enablement — shared service for CLI + web API."""

from __future__ import annotations

import base64
import math
import re
import time
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional, Set, Tuple

from mawm_client import (
    PO_SEARCH_URL,
    _post,
    _response_data_list,
    build_receiving_headers,
    bulk_import_asn,
    create_lpns,
    create_shell_asn,
    get_next_asn_number,
    line_excluded_by_flags,
    po_status_description,
    qty_for_payload,
    remaining_qty,
    render_zpl_labels_pdf,
    resolve_location,
    asn_status_description,
    search_asn,
    search_asns_by_purchase_order,
    search_ilpns_by_asn,
    search_items,
    search_purchase_order_lines,
    search_purchase_orders,
)


def _dec(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0))
    except Exception:
        return Decimal("0")


def _num(value):
    d = _dec(value)
    if d == d.to_integral_value():
        return int(d)
    return float(d)


def line_is_eligible(line: dict) -> bool:
    if line_excluded_by_flags(line):
        return False
    return remaining_qty(line) > 0


def line_is_fully_shipped(line: dict) -> bool:
    return remaining_qty(line) <= 0


def preload_po_index(
    token: str,
    org: str,
    location: str = None,
    page_size: int = 100,
    max_pages: int = 50,
) -> Dict[str, Any]:
    """
    Light PO index for typeahead: PO Id, Vendor, Item Ids (and descriptions when available).
    """
    headers = build_receiving_headers(token, org, location=location)
    entries: List[dict] = []
    item_ids: set = set()
    page = 0
    total = None

    while page < max_pages:
        payload = {
            "Query": "",
            "Page": page,
            "Size": page_size,
            "Template": {
                "PurchaseOrderId": None,
                "VendorId": None,
                "PurchaseOrderStatus": None,
                "Closed": None,
                "Canceled": None,
                "DestinationFacilityId": None,
                "PurchaseOrderLine": [
                    {
                        "PurchaseOrderLineId": None,
                        "ItemId": None,
                    }
                ],
            },
        }
        response = _post(PO_SEARCH_URL, headers=headers, json=payload)
        if response.status_code != 200:
            raise RuntimeError(
                f"PO preload failed ({response.status_code}): {response.text[:400]}"
            )
        body = response.json() if response.text else {}
        rows = _response_data_list(body)
        header = body.get("header") or body.get("Header") or {}
        if total is None:
            try:
                total = int(header.get("totalCount") or 0)
            except Exception:
                total = 0

        for po in rows:
            if po.get("Canceled") is True or po.get("Closed") is True:
                continue
            po_id = str(po.get("PurchaseOrderId") or "").strip()
            if not po_id:
                continue
            vendor = str(po.get("VendorId") or "").strip()
            dest = str(po.get("DestinationFacilityId") or "").strip()
            items = []
            for line in po.get("PurchaseOrderLine") or []:
                item_id = str(line.get("ItemId") or "").strip()
                if not item_id:
                    continue
                item_ids.add(item_id)
                items.append(
                    {
                        "itemId": item_id,
                        "lineId": str(line.get("PurchaseOrderLineId") or ""),
                    }
                )
            entries.append(
                {
                    "purchaseOrderId": po_id,
                    "vendorId": vendor,
                    "destinationFacilityId": dest,
                    "status": str(po.get("PurchaseOrderStatus") or ""),
                    "statusLabel": po_status_description(po.get("PurchaseOrderStatus")),
                    "items": items,
                }
            )

        if not rows:
            break
        fetched = (page + 1) * page_size
        if total and fetched >= total:
            break
        if len(rows) < page_size:
            break
        page += 1

    descriptions: Dict[str, str] = {}
    if item_ids:
        found = search_items(list(item_ids), token, org, location=location)
        for iid, item in found.items():
            desc = (item.get("Description") or "").strip()
            if desc:
                descriptions[iid] = desc
        for entry in entries:
            for it in entry["items"]:
                it["description"] = descriptions.get(it["itemId"], "")

    return {
        "success": True,
        "count": len(entries),
        "totalReported": total,
        "entries": entries,
        "itemDescriptions": descriptions,
    }


def _split_criteria_tokens(criteria: str) -> List[str]:
    """Split on comma, semicolon, or whitespace; drop empties."""
    parts = re.split(r"[,;\s]+", (criteria or "").strip())
    return [p for p in parts if p]


def match_preload_entries(entries: List[dict], criteria: str) -> List[dict]:
    """
    Match criteria against PO Id, Vendor Id, Item Id, or Item Description.

    Multiple tokens (comma / semicolon / space) are OR'd — a PO matches if any
    token hits any of those fields.
    """
    tokens = [t.lower() for t in _split_criteria_tokens(criteria)]
    if not tokens:
        return []
    matched = []
    seen = set()
    for entry in entries:
        haystacks = [
            str(entry.get("purchaseOrderId") or ""),
            str(entry.get("vendorId") or ""),
        ]
        for it in entry.get("items") or []:
            haystacks.append(str(it.get("itemId") or ""))
            haystacks.append(str(it.get("description") or ""))
        hay_l = [h.lower() for h in haystacks if h]
        if any(any(tok in h for h in hay_l) for tok in tokens):
            po_id = entry.get("purchaseOrderId")
            if po_id in seen:
                continue
            seen.add(po_id)
            matched.append(entry)
    return matched


def serialize_line(line: dict, items: Dict[str, dict]) -> dict:
    item_id = str(line.get("ItemId") or "")
    desc = ""
    for key in ("ItemDescription", "Description", "ItemDesc"):
        if line.get(key):
            desc = str(line.get(key)).strip()
            break
    if not desc and item_id in items:
        desc = str(items[item_id].get("Description") or "").strip()
    item_image_url = ""
    if item_id in items:
        item_image_url = str(
            items[item_id].get("ImageUrl") or items[item_id].get("imageUrl") or ""
        ).strip()
    rem = remaining_qty(line)
    eligible = line_is_eligible(line)
    return {
        "purchaseOrderId": str(line.get("PurchaseOrderId") or ""),
        "purchaseOrderLineId": str(line.get("PurchaseOrderLineId") or ""),
        "itemId": item_id,
        "description": desc,
        "itemImageUrl": item_image_url,
        "status": str(line.get("PurchaseOrderStatus") or ""),
        "statusLabel": po_status_description(line.get("PurchaseOrderStatus")),
        "destinationFacilityId": str(line.get("DestinationFacilityId") or ""),
        "orderQuantity": _num(line.get("OrderQuantity")),
        "shippedQuantity": _num(line.get("ShippedQuantity")),
        "unshippedQuantity": _num(rem),
        "quantityUomId": line.get("QuantityUomId") or "UNIT",
        "vendorId": str(line.get("VendorId") or ""),
        "canceled": bool(line.get("Canceled") is True),
        "closed": bool(line.get("Closed") is True),
        "eligible": eligible,
        "fullyShipped": line_is_fully_shipped(line),
        "disabledReason": _disabled_reason(line, eligible),
    }


def _disabled_reason(line: dict, eligible: bool) -> str:
    if eligible:
        return ""
    if line.get("Canceled") is True:
        return "Canceled"
    if line.get("Closed") is True:
        return "Closed"
    if line.get("Canceled") is None or line.get("Closed") is None:
        if line_excluded_by_flags(line):
            return "Canceled/Closed"
    if remaining_qty(line) <= 0:
        return "Fully shipped"
    return "Not eligible"


def build_po_summaries(lines: List[dict]) -> List[dict]:
    """Group serialized lines into PO header cards with aggregates."""
    by_po: Dict[str, List[dict]] = {}
    for line in lines:
        po_id = line["purchaseOrderId"]
        by_po.setdefault(po_id, []).append(line)

    summaries = []
    for po_id, po_lines in by_po.items():
        first = po_lines[0]
        total_order = sum(_dec(l["orderQuantity"]) for l in po_lines)
        total_shipped = sum(_dec(l["shippedQuantity"]) for l in po_lines)
        total_unshipped = sum(_dec(l["unshippedQuantity"]) for l in po_lines)
        eligible_count = sum(1 for l in po_lines if l["eligible"])
        summaries.append(
            {
                "purchaseOrderId": po_id,
                "status": first.get("status") or "",
                "statusLabel": first.get("statusLabel") or "",
                "vendorId": first.get("vendorId") or "",
                "destinationFacilityId": first.get("destinationFacilityId") or "",
                "lineCount": len(po_lines),
                "eligibleLineCount": eligible_count,
                "totalOrderQuantity": _num(total_order),
                "totalShippedQuantity": _num(total_shipped),
                "totalUnshippedQuantity": _num(total_unshipped),
                "lines": po_lines,
            }
        )
    summaries.sort(key=lambda r: r["purchaseOrderId"])
    return summaries


def load_pos_detail(
    token: str,
    org: str,
    purchase_order_ids: List[str],
    location: str = None,
) -> Dict[str, Any]:
    raw_lines, source = search_purchase_order_lines(
        purchase_order_ids, token, org, location=location
    )
    item_ids = [str(l.get("ItemId") or "") for l in raw_lines]
    items = search_items(item_ids, token, org, location=location)
    serialized = [serialize_line(l, items) for l in raw_lines]
    return {
        "success": True,
        "source": source,
        "purchaseOrders": build_po_summaries(serialized),
        "lineCount": len(serialized),
        "eligibleLineCount": len([l for l in serialized if l["eligible"]]),
    }


def build_bulk_payload(
    asn_id: str,
    destination_facility_id: str,
    estimated_delivery_date: str,
    staged: List[dict],
    vendor_id: str = None,
) -> dict:
    asn_lines = []
    for row in staged:
        asn_lines.append(
            {
                "ItemId": row["itemId"],
                "QuantityUomId": row.get("quantityUomId") or "UNIT",
                "ShippedQuantity": qty_for_payload(row["shippedQuantity"]),
                "PurchaseOrderId": row["purchaseOrderId"],
                "PurchaseOrderLineId": str(row["purchaseOrderLineId"]),
            }
        )
    header = {
        "AsnId": asn_id,
        "AsnLevelId": "ITEM",
        "AsnOriginTypeId": "P",
        "AsnStatus": "0000",
        "AsnType": "ASN",
        "DestinationFacilityId": destination_facility_id,
        "EstimatedDeliveryDate": estimated_delivery_date,
        "AsnLine": asn_lines,
    }
    if vendor_id:
        header["VendorId"] = vendor_id
    return {"Data": [header]}


def preview_create_asn(
    token: str,
    org: str,
    staged: List[dict],
    location: str = None,
    facility: str = None,
    edd: str = None,
) -> Dict[str, Any]:
    if not staged:
        return {"success": False, "error": "No lines selected"}
    dest = resolve_location(org, facility or location)
    edd_val = (edd or date.today().isoformat())[:10]
    asn_id = get_next_asn_number(token, org, location=dest)
    vendors = {str(s.get("vendorId") or "") for s in staged if s.get("vendorId")}
    vendor_id = next(iter(vendors), None) if len(vendors) == 1 else None
    bulk = build_bulk_payload(asn_id, dest, edd_val, staged, vendor_id=vendor_id)
    return {
        "success": True,
        "asnId": asn_id,
        "facility": dest,
        "edd": edd_val,
        "vendorId": vendor_id,
        "lineCount": len(staged),
        "totalQuantity": _num(sum(_dec(s["shippedQuantity"]) for s in staged)),
        "lines": staged,
        "bulkPayload": bulk,
        "shellPayload": {
            "AsnId": asn_id,
            "AsnLevelId": "ITEM",
            "AsnOriginTypeId": "P",
            "AsnStatus": "0000",
            "DestinationFacilityId": dest,
            "EstimatedDeliveryDate": edd_val,
        },
    }


def create_asn_from_staged(
    token: str,
    org: str,
    staged: List[dict],
    asn_id: str,
    facility: str = None,
    location: str = None,
    edd: str = None,
    skip_shell: bool = False,
) -> Dict[str, Any]:
    if not staged:
        return {"success": False, "error": "No lines selected"}
    if not asn_id:
        return {"success": False, "error": "AsnId required"}
    dest = resolve_location(org, facility or location)
    edd_val = (edd or date.today().isoformat())[:10]
    vendors = {str(s.get("vendorId") or "") for s in staged if s.get("vendorId")}
    vendor_id = next(iter(vendors), None) if len(vendors) == 1 else None

    result: Dict[str, Any] = {
        "success": False,
        "asnId": asn_id,
        "facility": dest,
        "edd": edd_val,
        "steps": [],
    }

    if not skip_shell:
        shell_resp = create_shell_asn(
            asn_id, token, org, dest, edd_val, location=dest
        )
        step = {
            "step": "shell",
            "statusCode": shell_resp.status_code,
            "ok": shell_resp.status_code in (200, 201),
            "response": shell_resp.text[:800],
        }
        result["steps"].append(step)
        if not step["ok"]:
            result["error"] = f"Shell ASN failed ({shell_resp.status_code})"
            return result

    bulk = build_bulk_payload(asn_id, dest, edd_val, staged, vendor_id=vendor_id)
    bulk_resp = bulk_import_asn(bulk, token, org, location=dest)
    step = {
        "step": "bulkImport",
        "statusCode": bulk_resp.status_code,
        "ok": bulk_resp.status_code in (200, 201),
        "response": bulk_resp.text[:1200],
    }
    result["steps"].append(step)
    result["success"] = step["ok"]
    if not step["ok"]:
        result["error"] = f"bulkImport failed ({bulk_resp.status_code})"
    else:
        result["message"] = f"ASN {asn_id} created successfully"
    result["lineCount"] = len(staged)
    result["totalQuantity"] = _num(sum(_dec(s["shippedQuantity"]) for s in staged))
    return result


def _asn_line_id(line: dict) -> str:
    for key in ("AsnLineId", "asnLineId", "PK", "Unique_Identifier"):
        val = line.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def list_asns_for_po(
    token: str,
    org: str,
    purchase_order_id: str,
    location: str = None,
) -> Dict[str, Any]:
    """Return ASNs linked to a PO via AsnLine.PurchaseOrderId (full line lists)."""
    po_id = str(purchase_order_id or "").strip()
    if not po_id:
        return {"success": False, "error": "PurchaseOrderId required"}
    dest = resolve_location(org, location)
    raw = search_asns_by_purchase_order(po_id, token, org, location=dest, size=50)

    item_ids: List[str] = []
    for asn in raw:
        for line in asn.get("AsnLine") or []:
            iid = str(line.get("ItemId") or "").strip()
            if iid:
                item_ids.append(iid)
    items = search_items(item_ids, token, org, location=dest) if item_ids else {}

    asns: List[dict] = []
    for asn in raw:
        asn_id = str(asn.get("AsnId") or "").strip()
        if not asn_id:
            continue
        lines_out: List[dict] = []
        linked = 0
        other = 0
        for line in asn.get("AsnLine") or []:
            line_po = str(line.get("PurchaseOrderId") or "").strip()
            item_id = str(line.get("ItemId") or "").strip()
            item = items.get(item_id) or {}
            linked_to_po = line_po == po_id
            if linked_to_po:
                linked += 1
            else:
                other += 1
            lines_out.append(
                {
                    "asnLineId": _asn_line_id(line),
                    "itemId": item_id,
                    "description": item.get("Description")
                    or item.get("ItemDescription")
                    or line.get("Description")
                    or "",
                    "itemImageUrl": item.get("ImageUrl")
                    or item.get("imageUrl")
                    or item.get("ImageURL")
                    or "",
                    "shippedQuantity": _num(line.get("ShippedQuantity")),
                    "quantityUomId": line.get("QuantityUomId") or "UNIT",
                    "purchaseOrderId": line_po,
                    "purchaseOrderLineId": str(
                        line.get("PurchaseOrderLineId") or ""
                    ).strip(),
                    "linkedToPo": linked_to_po,
                }
            )
        lpn_ids = []
        for lpn in asn.get("Lpn") or []:
            lid = lpn.get("LpnId") or lpn.get("IlpnId")
            if lid:
                lpn_ids.append(str(lid))
        status_code = str(asn.get("AsnStatus") or "").strip()
        edd_raw = asn.get("EstimatedDeliveryDate") or asn.get("estimatedDeliveryDate")
        asns.append(
            {
                "asnId": asn_id,
                "asnStatus": status_code,
                "statusLabel": asn_status_description(status_code),
                "estimatedDeliveryDate": edd_raw,
                "facilityId": asn.get("FacilityId")
                or asn.get("DestinationFacilityId")
                or dest,
                "vendorId": asn.get("VendorId") or "",
                "asnLevelId": asn.get("AsnLevelId") or "",
                "lineCount": len(lines_out),
                "linkedLineCount": linked,
                "otherPoLineCount": other,
                "existingLpnCount": len(lpn_ids),
                "existingLpnIds": lpn_ids,
                "lines": lines_out,
            }
        )

    asns.sort(key=lambda a: a.get("asnId") or "", reverse=True)
    return {
        "success": True,
        "purchaseOrderId": po_id,
        "facility": dest,
        "asnCount": len(asns),
        "asns": asns,
    }


def _asn_line_available_qty(line: dict) -> Decimal:
    for key in (
        "AvailableQtyForLpnCreation",
        "availableQtyForLpnCreation",
        "RemainingQuantity",
        "OpenQuantity",
        "ShippedQuantity",
    ):
        if key in line and line.get(key) is not None:
            return _dec(line.get(key))
    return _dec(line.get("ShippedQuantity"))


def load_asn_lines_for_lpn_creation(
    token: str,
    org: str,
    asn_id: str,
    location: str = None,
) -> Dict[str, Any]:
    if not asn_id:
        return {"success": False, "error": "AsnId required"}
    dest = resolve_location(org, location)
    asn = search_asn(asn_id, token, org, location=dest)
    if not asn:
        return {"success": False, "error": f"ASN {asn_id} not found"}

    raw_lines = asn.get("AsnLine") or []
    if not isinstance(raw_lines, list):
        raw_lines = []

    item_ids = [str(l.get("ItemId") or "") for l in raw_lines if l.get("ItemId")]
    items = search_items(item_ids, token, org, location=dest) if item_ids else {}

    lines: List[dict] = []
    for line in raw_lines:
        asn_line_id = _asn_line_id(line)
        item_id = str(line.get("ItemId") or "")
        shipped = _num(line.get("ShippedQuantity"))
        available = _num(_asn_line_available_qty(line))
        if not asn_line_id or not item_id:
            continue
        if _dec(available) <= 0:
            continue
        item = items.get(item_id) or {}
        lines.append(
            {
                "asnId": asn_id,
                "asnLineId": asn_line_id,
                "itemId": item_id,
                "description": item.get("Description")
                or item.get("ItemDescription")
                or line.get("Description")
                or "",
                "itemImageUrl": item.get("ImageUrl")
                or item.get("imageUrl")
                or item.get("ImageURL")
                or "",
                "quantityUomId": line.get("QuantityUomId") or "UNIT",
                "shippedQuantity": shipped,
                "availableQtyForLpnCreation": available,
                "quantityToCartonize": available,
                "standardIlpnQuantity": available,
                "purchaseOrderId": line.get("PurchaseOrderId") or "",
                "purchaseOrderLineId": line.get("PurchaseOrderLineId") or "",
            }
        )

    existing_lpns = []
    for lpn in asn.get("Lpn") or []:
        lpn_id = lpn.get("LpnId") or lpn.get("IlpnId")
        if lpn_id:
            existing_lpns.append(str(lpn_id))

    return {
        "success": True,
        "asnId": asn_id,
        "facility": dest,
        "asnStatus": asn.get("AsnStatus"),
        "lineCount": len(lines),
        "lines": lines,
        "existingLpnIds": existing_lpns,
        "existingLpnCount": len(existing_lpns),
    }


def _predicted_lpn_count(cartonize, standard) -> int:
    """WMS creates full std packs plus a residual LPN when qty does not divide evenly.

    Example: cartonize=10, standard=6 → 2 LPNs (6 + 4).
    """
    c = _dec(cartonize)
    s = _dec(standard)
    if s <= 0 or c <= 0:
        return 0
    return int(math.ceil(float(c) / float(s)))


def _snapshot_ilpn_ids(asn_id: str, token: str, org: str, location: str) -> Set[str]:
    ids: Set[str] = set()
    try:
        for row in search_ilpns_by_asn(asn_id, token, org, location=location):
            iid = row.get("IlpnId") or row.get("LpnId")
            if iid:
                ids.add(str(iid))
    except Exception:
        pass
    try:
        asn = search_asn(asn_id, token, org, location=location)
        for lpn in (asn or {}).get("Lpn") or []:
            iid = lpn.get("LpnId") or lpn.get("IlpnId")
            if iid:
                ids.add(str(iid))
    except Exception:
        pass
    return ids


def _collect_mapped_ilpns(asn_id: str, token: str, org: str, location: str) -> List[dict]:
    """Merge dcinventory iLPN search + ASN nested Lpn, de-duplicated with field fill."""
    by_id: Dict[str, dict] = {}
    try:
        for row in search_ilpns_by_asn(asn_id, token, org, location=location):
            mapped = _map_ilpn_row(row, asn_id=asn_id)
            if mapped:
                existing = by_id.get(mapped["ilpnId"])
                by_id[mapped["ilpnId"]] = (
                    _merge_mapped_lpn(existing, mapped) if existing else mapped
                )
    except Exception:
        pass
    try:
        asn = search_asn(asn_id, token, org, location=location)
        for lpn in (asn or {}).get("Lpn") or []:
            mapped = _map_ilpn_row(lpn, asn_id=asn_id, nested=True)
            if not mapped:
                continue
            existing = by_id.get(mapped["ilpnId"])
            by_id[mapped["ilpnId"]] = (
                _merge_mapped_lpn(existing, mapped) if existing else mapped
            )
    except Exception:
        pass
    return list(by_id.values())


def create_lpns_and_list(
    token: str,
    org: str,
    asn_id: str,
    lines: List[dict],
    location: str = None,
    poll_timeout_sec: float = 10.0,
    poll_interval_sec: float = 0.75,
) -> Dict[str, Any]:
    if not asn_id:
        return {"success": False, "error": "AsnId required"}
    if not lines:
        return {"success": False, "error": "No lines provided for LPN creation"}

    dest = resolve_location(org, location)
    payload: List[dict] = []
    expected_total = 0
    for row in lines:
        asn_line_id = str(row.get("asnLineId") or row.get("AsnLineId") or "").strip()
        item_id = str(row.get("itemId") or row.get("ItemId") or "").strip()
        available = qty_for_payload(
            row.get("availableQtyForLpnCreation")
            if row.get("availableQtyForLpnCreation") is not None
            else row.get("AvailableQtyForLpnCreation")
            if row.get("AvailableQtyForLpnCreation") is not None
            else row.get("shippedQuantity")
            if row.get("shippedQuantity") is not None
            else row.get("ShippedQuantity")
        )
        shipped = qty_for_payload(
            row.get("shippedQuantity")
            if row.get("shippedQuantity") is not None
            else row.get("ShippedQuantity")
            if row.get("ShippedQuantity") is not None
            else available
        )
        cartonize = qty_for_payload(
            row.get("quantityToCartonize")
            if row.get("quantityToCartonize") is not None
            else row.get("QuantityToCartonize")
        )
        standard = qty_for_payload(
            row.get("standardIlpnQuantity")
            if row.get("standardIlpnQuantity") is not None
            else row.get("StandardIlpnQuantity")
        )
        if not asn_line_id or not item_id:
            return {
                "success": False,
                "error": "Each line requires asnLineId and itemId",
            }
        if _dec(cartonize) <= 0 or _dec(standard) <= 0:
            return {
                "success": False,
                "error": f"Invalid quantities for item {item_id}",
            }
        if _dec(cartonize) > _dec(available):
            return {
                "success": False,
                "error": f"QuantityToCartonize exceeds available for item {item_id}",
            }
        if _dec(standard) > _dec(cartonize):
            return {
                "success": False,
                "error": f"StandardIlpnQuantity exceeds QuantityToCartonize for item {item_id}",
            }
        pred = _predicted_lpn_count(cartonize, standard)
        if pred <= 0:
            return {
                "success": False,
                "error": f"Could not compute LPN count for item {item_id}",
            }
        expected_total += pred
        payload.append(
            {
                "AvailableQtyForLpnCreation": available,
                "ShippedQuantity": shipped,
                "AsnLineId": asn_line_id,
                "ItemId": item_id,
                "QuantityToCartonize": cartonize,
                "StandardIlpnQuantity": standard,
                "AsnId": asn_id,
            }
        )

    result: Dict[str, Any] = {
        "success": False,
        "asnId": asn_id,
        "facility": dest,
        "expectedLpnCount": expected_total,
        "steps": [],
        "lpns": [],
        "payload": payload,
    }

    baseline_ids = _snapshot_ilpn_ids(asn_id, token, org, dest)
    target_total = len(baseline_ids) + expected_total

    create_resp = create_lpns(payload, token, org, location=dest)
    create_ok = create_resp.status_code in (200, 201)
    result["steps"].append(
        {
            "step": "lpnCreate",
            "statusCode": create_resp.status_code,
            "ok": create_ok,
            "response": create_resp.text[:1200],
        }
    )
    if not create_ok:
        result["error"] = f"LPN create failed ({create_resp.status_code})"
        return result

    deadline = time.time() + max(1.0, poll_timeout_sec)
    attempt = 0
    unique: List[dict] = []
    while True:
        attempt += 1
        if attempt > 1:
            time.sleep(max(0.25, poll_interval_sec))
        unique = _collect_mapped_ilpns(asn_id, token, org, dest)
        new_count = sum(1 for row in unique if row["ilpnId"] not in baseline_ids)
        result["steps"].append(
            {
                "step": "ilpnSearch",
                "statusCode": 200,
                "ok": True,
                "attempt": attempt,
                "count": len(unique),
                "newCount": new_count,
                "targetTotal": target_total,
            }
        )
        if len(unique) >= target_total or new_count >= expected_total:
            break
        if time.time() >= deadline:
            result["steps"].append(
                {
                    "step": "ilpnSearchTimeout",
                    "statusCode": 0,
                    "ok": False,
                    "attempt": attempt,
                    "count": len(unique),
                    "newCount": new_count,
                    "timeoutSec": poll_timeout_sec,
                }
            )
            break

    # Prefer newly created LPNs for labels when we can identify them;
    # if indexing is incomplete, fall back to full ASN list.
    new_lpns = [row for row in unique if row["ilpnId"] not in baseline_ids]
    display = new_lpns if new_lpns else unique
    display = enrich_lpns_for_labels(display, token, org, location=dest, asn_id=asn_id)

    result["lpns"] = display
    result["lpnCount"] = len(display)
    result["success"] = True
    if display and (len(unique) >= target_total or len(new_lpns) >= expected_total):
        result["message"] = f"Created {fmt_count_msg(len(display))} for ASN {asn_id}"
    elif display:
        result["message"] = (
            f"LPN create accepted for ASN {asn_id}. Found {fmt_count_msg(len(display))} "
            f"(expected {fmt_count_msg(expected_total)}); more may still be indexing."
        )
        result["warning"] = "lpns_partial"
    else:
        result["message"] = (
            f"LPN create accepted for ASN {asn_id}, but no iLPNs found within "
            f"{int(poll_timeout_sec)}s. Try Download Labels shortly."
        )
        result["warning"] = "lpns_not_found_yet"
    return result


def fmt_count_msg(n: int) -> str:
    return "1 LPN" if n == 1 else f"{n} LPNs"


def _first_val(row: dict, keys) -> Any:
    for key in keys:
        if row.get(key) is not None and str(row.get(key)).strip() != "":
            return row.get(key)
    return None


def _format_date_yyyy_mm_dd(value) -> str:
    if value is None or value == "":
        return ""
    s = str(value).strip()
    # ISO / Manhattan timestamps: 2026-07-14T12:34:56... or 2026-07-14
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return s[:10] if s else ""


def _ilpn_quantity(row: dict) -> Any:
    val = _first_val(
        row,
        (
            "OnHandQuantity",
            "Quantity",
            "CurrentQuantity",
            "ActualQuantity",
            "EstimatedQuantity",
            "ShippedQuantity",
            "LpnQuantity",
        ),
    )
    if val is None:
        # nested detail totals
        details = row.get("LpnDetail") or row.get("Inventory") or []
        if isinstance(details, list) and details:
            total = Decimal("0")
            for d in details:
                q = _first_val(
                    d,
                    (
                        "Quantity",
                        "OnHandQuantity",
                        "ShippedQuantity",
                        "CurrentQuantity",
                        "InventoryQuantity",
                    ),
                )
                if q is not None:
                    total += _dec(q)
            if total > 0:
                return _num(total)
        return ""
    return _num(val)


def _detail_item_id(row: dict) -> str:
    item_id = str(row.get("ItemId") or "").strip()
    if item_id:
        return item_id
    details = row.get("LpnDetail") or row.get("Inventory") or []
    if isinstance(details, list):
        for d in details:
            iid = str(d.get("ItemId") or "").strip()
            if iid:
                return iid
    return ""


def _map_ilpn_row(row: dict, asn_id: str = "", nested: bool = False) -> Optional[dict]:
    ilpn_id = row.get("IlpnId") or row.get("LpnId")
    if not ilpn_id:
        return None
    created = _first_val(
        row,
        (
            "CreatedTimestamp",
            "CreateTimestamp",
            "CreatedDateTime",
            "CreationDate",
            "CreatedDate",
        ),
    )
    return {
        "ilpnId": str(ilpn_id),
        "asnId": str(row.get("AsnId") or asn_id or ""),
        "itemId": _detail_item_id(row),
        "description": str(
            _first_val(row, ("ItemDescription", "Description", "ItemDesc")) or ""
        ),
        "quantity": _ilpn_quantity(row),
        "vendorId": str(row.get("VendorId") or ""),
        "purchaseOrderId": str(row.get("PurchaseOrderId") or ""),
        "createdDate": _format_date_yyyy_mm_dd(created),
        "originFacilityId": str(
            row.get("OriginFacilityId") or row.get("originFacilityId") or ""
        ),
        "status": str(row.get("Status") or row.get("LpnStatus") or ""),
        "currentLocationId": str(row.get("CurrentLocationId") or ""),
        "_nested": nested,
    }


def _merge_mapped_lpn(existing: dict, incoming: dict) -> dict:
    """Fill blanks from another source (inventory vs ASN nested Lpn)."""
    out = dict(existing)
    for key in (
        "asnId",
        "itemId",
        "description",
        "quantity",
        "vendorId",
        "purchaseOrderId",
        "createdDate",
        "originFacilityId",
        "status",
        "currentLocationId",
    ):
        cur = out.get(key)
        empty = cur is None or cur == ""
        incoming_val = incoming.get(key)
        if empty and incoming_val is not None and incoming_val != "":
            out[key] = incoming_val
    return out


def _asn_lpn_index(asn: Optional[dict]) -> Dict[str, dict]:
    """Map LpnId -> mapped fields from ASN nested Lpn / LpnDetail."""
    out: Dict[str, dict] = {}
    if not asn:
        return out
    asn_id = str(asn.get("AsnId") or "")
    for lpn in asn.get("Lpn") or []:
        mapped = _map_ilpn_row(lpn, asn_id=asn_id, nested=True)
        if mapped:
            out[mapped["ilpnId"]] = mapped
    return out


def enrich_lpns_for_labels(
    lpns: List[dict],
    token: str,
    org: str,
    location: str = None,
    asn_id: str = "",
) -> List[dict]:
    """Fill description, qty, vendor, PO origin facility from item/PO/ASN masters."""
    if not lpns:
        return []
    dest = resolve_location(org, location)
    asn = None
    try:
        asn = search_asn(asn_id or lpns[0].get("asnId") or "", token, org, location=dest)
    except Exception:
        asn = None
    asn_vendor = str((asn or {}).get("VendorId") or "")
    asn_origin = str((asn or {}).get("OriginFacilityId") or "")
    asn_lpns = _asn_lpn_index(asn)

    # Map AsnLine ItemId -> PurchaseOrderId / description hints
    line_po_by_item: Dict[str, str] = {}
    line_desc_by_item: Dict[str, str] = {}
    for line in (asn or {}).get("AsnLine") or []:
        item_id = str(line.get("ItemId") or "")
        po_id = str(line.get("PurchaseOrderId") or "")
        if item_id and po_id and item_id not in line_po_by_item:
            line_po_by_item[item_id] = po_id
        desc = str(
            _first_val(line, ("ItemDescription", "Description", "ItemDesc")) or ""
        )
        if item_id and desc and item_id not in line_desc_by_item:
            line_desc_by_item[item_id] = desc

    # Merge ASN nested detail (qty/item) into each row
    for row in lpns:
        asn_row = asn_lpns.get(row.get("ilpnId") or "")
        if asn_row:
            merged = _merge_mapped_lpn(row, asn_row)
            row.clear()
            row.update(merged)
        if not row.get("asnId") and asn_id:
            row["asnId"] = asn_id
        if not row.get("vendorId") and asn_vendor:
            row["vendorId"] = asn_vendor
        if not row.get("purchaseOrderId") and row.get("itemId") in line_po_by_item:
            row["purchaseOrderId"] = line_po_by_item[row["itemId"]]
        if not row.get("description") and row.get("itemId") in line_desc_by_item:
            row["description"] = line_desc_by_item[row["itemId"]]

    item_ids = [r["itemId"] for r in lpns if r.get("itemId")]
    items = search_items(item_ids, token, org, location=dest) if item_ids else {}
    po_ids = [r["purchaseOrderId"] for r in lpns if r.get("purchaseOrderId")]
    pos = search_purchase_orders(po_ids, token, org, location=dest) if po_ids else {}

    for row in lpns:
        item = items.get(str(row.get("itemId") or "")) or {}
        if not row.get("description"):
            row["description"] = str(item.get("Description") or "")
        po = pos.get(str(row.get("purchaseOrderId") or "")) or {}
        origin = (
            po.get("OriginFacilityId")
            or po.get("OriginFacilityAliasId")
            or row.get("originFacilityId")
            or asn_origin
            or ""
        )
        row["originFacilityId"] = str(origin or "")
        if not row.get("vendorId"):
            row["vendorId"] = str(po.get("VendorId") or asn_vendor or "")
        row.pop("_nested", None)
    return lpns


def zpl_escape(value) -> str:
    return (
        str(value if value is not None else "")
        .replace("^", " ")
        .replace("~", " ")
        .replace("\\", " ")
    )


def build_lpn_label_zpl(lpn: dict) -> str:
    """Build one 4x6 ZPL label from enriched iLPN fields."""
    ilpn = zpl_escape(lpn.get("ilpnId") or "")
    asn = zpl_escape(lpn.get("asnId") or "")
    vendor = zpl_escape(lpn.get("vendorId") or "")
    po = zpl_escape(lpn.get("purchaseOrderId") or "")
    item = zpl_escape(lpn.get("itemId") or "")
    desc = zpl_escape(lpn.get("description") or "")
    qty = zpl_escape(lpn.get("quantity") if lpn.get("quantity") != "" else "")
    mfg_date = zpl_escape(lpn.get("createdDate") or "")
    mfg_plant = zpl_escape(lpn.get("originFacilityId") or "")
    # EXP DATE intentionally blank
    return f"""^XA
^CI28
^PW812
^LL1218
^LH0,0

^FO25,35^A0N,48,48^FDLPN NUMBER^FS

^BY3,2,140
^FO35,80^BCN,140,Y,N,N
^FD{ilpn}^FS

^FO75,290^A0N,72,72^FD{ilpn}^FS

^FO10,345^GB795,0,4^FS

^FO35,385^A0N,34,34^FDSHIPMENT: {asn}^FS
^FO455,385^A0N,34,34^FDMFG DATE: {mfg_date}^FS

^FO35,435^A0N,34,34^FDVENDOR#: {vendor}^FS
^FO455,435^A0N,34,34^FDMFG PLANT: {mfg_plant}^FS

^FO35,485^A0N,34,34^FDPO#: {po}^FS
^FO455,485^A0N,34,34^FDEXP DATE: ^FS

^FO10,520^GB795,0,4^FS

^FO50,565^A0N,46,46^FDITEM: {item}^FS
^FO50,615^A0N,46,46^FDITEM DESC: {desc}^FS

^FO50,720^A0N,54,54^FDQUANTITY: {qty}^FS

^XZ
"""


def build_labels_pdf_for_asn(
    token: str,
    org: str,
    asn_id: str,
    location: str = None,
    lpns: List[dict] = None,
    expected_lpn_count: int = 0,
    poll_timeout_sec: float = 10.0,
    poll_interval_sec: float = 0.75,
) -> Dict[str, Any]:
    """Enrich iLPNs for ASN and render a multi-page PDF via Labelary."""
    if not asn_id:
        return {"success": False, "error": "AsnId required"}
    dest = resolve_location(org, location)
    target = int(expected_lpn_count or 0)

    # Always refresh from MAWM so labels get ASN LpnDetail qty + inventory ItemId.
    # Seed with client rows only as a fallback if searches return nothing.
    client_rows = lpns or []
    rows: List[dict] = []
    deadline = time.time() + max(1.0, poll_timeout_sec)
    while True:
        found = _collect_mapped_ilpns(asn_id, token, org, dest)
        if found:
            rows = found
            if not target or len(found) >= target:
                break
        if time.time() >= deadline:
            break
        time.sleep(max(0.25, poll_interval_sec))

    if not rows and client_rows:
        rows = client_rows
    if not rows:
        return {"success": False, "error": f"No iLPNs found for ASN {asn_id}"}

    # Ensure keys normalized if client sent camelCase subset
    normalized = []
    for row in rows:
        if "ilpnId" in row:
            normalized.append(dict(row))
        else:
            mapped = _map_ilpn_row(row, asn_id=asn_id)
            if mapped:
                normalized.append(mapped)
    enriched = enrich_lpns_for_labels(
        normalized, token, org, location=dest, asn_id=asn_id
    )
    zpl = "".join(build_lpn_label_zpl(r) for r in enriched)
    try:
        pdf_bytes = render_zpl_labels_pdf(zpl)
    except Exception as exc:
        return {"success": False, "error": str(exc), "zplPreview": zpl[:2000]}

    return {
        "success": True,
        "asnId": asn_id,
        "lpnCount": len(enriched),
        "filename": f"{asn_id}-labels.pdf",
        "contentType": "application/pdf",
        "pdfBase64": base64.b64encode(pdf_bytes).decode("ascii"),
        "lpns": enriched,
    }
