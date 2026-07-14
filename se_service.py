#!/usr/bin/env python3
"""Supplier Enablement — shared service for CLI + web API."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from mawm_client import (
    PO_SEARCH_URL,
    _post,
    _response_data_list,
    build_receiving_headers,
    bulk_import_asn,
    create_shell_asn,
    get_next_asn_number,
    line_excluded_by_flags,
    po_status_description,
    qty_for_payload,
    remaining_qty,
    resolve_location,
    search_items,
    search_purchase_order_lines,
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
