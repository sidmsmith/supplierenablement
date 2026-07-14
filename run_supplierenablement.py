#!/usr/bin/env python3
"""
Supplier Enablement — Create ASN from PO (CLI).

Usage:
  python run_supplierenablement.py --token-file .token
  python run_supplierenablement.py --org SS-DEMO --facility SS-DEMO-DM1 --edd 2026-07-15 --token-file .token
  python run_supplierenablement.py --dry-run --token-file .token
  python run_supplierenablement.py --po "PO000002;PO000010" --select "1:10;2" --token-file .token
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from cli_utils import (
    authenticate,
    format_qty,
    print_table,
    prompt_org,
    prompt_yes,
)
from mawm_client import (
    bulk_import_asn,
    create_shell_asn,
    filter_eligible_po_lines,
    get_next_asn_number,
    po_status_label,
    qty_for_payload,
    remaining_qty,
    resolve_location,
    search_items,
    search_purchase_order_lines,
)

ROOT = Path(__file__).resolve().parent
RUNS_DIR = ROOT / "runs"


def parse_po_ids(raw: str) -> List[str]:
    parts = [p.strip() for p in (raw or "").replace(",", ";").split(";")]
    return [p for p in parts if p]


def prompt_po_ids(initial: str = None) -> List[str]:
    if initial and parse_po_ids(initial):
        ids = parse_po_ids(initial)
        print(f"Using POs: {'; '.join(ids)}")
        return ids
    while True:
        raw = input("Enter PO(s) (semicolon-delimited): ").strip()
        ids = parse_po_ids(raw)
        if ids:
            return ids
        print("At least one Purchase Order Id is required.")


def line_description(line: dict, items: Dict[str, dict]) -> str:
    for key in ("ItemDescription", "Description", "ItemDesc"):
        val = line.get(key)
        if val:
            return str(val).strip()
    item_id = str(line.get("ItemId") or "").strip()
    if item_id and item_id in items:
        desc = items[item_id].get("Description")
        if desc:
            return str(desc).strip()
    return ""


def display_rows(lines: List[dict], items: Dict[str, dict]) -> List[list]:
    rows = []
    for idx, line in enumerate(lines, start=1):
        rows.append(
            [
                str(idx),
                line.get("PurchaseOrderId") or "",
                line.get("PurchaseOrderLineId") or "",
                line.get("ItemId") or "",
                line_description(line, items),
                po_status_label(line.get("PurchaseOrderStatus")),
                format_qty(line.get("OrderQuantity")),
                format_qty(line.get("ShippedQuantity")),
                format_qty(remaining_qty(line)),
                line.get("QuantityUomId") or "UNIT",
            ]
        )
    return rows


def parse_selection(raw: str, line_count: int) -> List[Tuple[int, Optional[Decimal]]]:
    """
    Parse selection like: 1:10; 3:5; 2
    Returns list of (1-based index, qty_or_None for default remaining).
    """
    selections: List[Tuple[int, Optional[Decimal]]] = []
    seen = set()
    chunks = [c.strip() for c in (raw or "").split(";") if c.strip()]
    if not chunks:
        raise ValueError("No lines selected.")
    for chunk in chunks:
        if ":" in chunk:
            left, right = chunk.split(":", 1)
            idx_s, qty_s = left.strip(), right.strip()
        else:
            idx_s, qty_s = chunk.strip(), ""
        if not idx_s.isdigit():
            raise ValueError(f"Invalid row number: {chunk}")
        idx = int(idx_s)
        if idx < 1 or idx > line_count:
            raise ValueError(f"Row {idx} out of range (1-{line_count}).")
        if idx in seen:
            raise ValueError(f"Row {idx} selected more than once.")
        seen.add(idx)
        if qty_s == "":
            qty = None
        else:
            try:
                qty = Decimal(qty_s)
            except InvalidOperation as exc:
                raise ValueError(f"Invalid qty for row {idx}: {qty_s}") from exc
            if qty <= 0:
                raise ValueError(f"Qty for row {idx} must be > 0.")
        selections.append((idx, qty))
    return selections


def build_staged_lines(
    eligible: List[dict], selections: List[Tuple[int, Optional[Decimal]]]
) -> List[dict]:
    staged = []
    for idx, qty in selections:
        line = eligible[idx - 1]
        rem = remaining_qty(line)
        chosen = rem if qty is None else qty
        if chosen > rem:
            raise ValueError(
                f"Row {idx}: qty {format_qty(chosen)} exceeds unshipped {format_qty(rem)}"
            )
        staged.append(
            {
                "row": idx,
                "PurchaseOrderId": line.get("PurchaseOrderId"),
                "PurchaseOrderLineId": str(line.get("PurchaseOrderLineId") or ""),
                "ItemId": line.get("ItemId"),
                "QuantityUomId": line.get("QuantityUomId") or "UNIT",
                "ShippedQuantity": chosen,
                "RemainingQty": rem,
                "VendorId": line.get("VendorId"),
            }
        )
    return staged


def prompt_selection(eligible: List[dict], initial: str = None) -> List[dict]:
    if initial:
        staged = build_staged_lines(eligible, parse_selection(initial, len(eligible)))
        print("Using --select staging:")
        for row in staged:
            print(
                f"  #{row['row']}: {row['PurchaseOrderId']}/{row['PurchaseOrderLineId']} "
                f"{row['ItemId']} qty={format_qty(row['ShippedQuantity'])}"
            )
        return staged
    print("\nSelect lines to assign (row:qty). Omit qty to use full unshipped.")
    print("Example: 1:10; 3:5; 2")
    while True:
        raw = input("Selection: ").strip()
        try:
            return build_staged_lines(eligible, parse_selection(raw, len(eligible)))
        except ValueError as exc:
            print(f"  {exc}")


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
                "ItemId": row["ItemId"],
                "QuantityUomId": row["QuantityUomId"],
                "ShippedQuantity": qty_for_payload(row["ShippedQuantity"]),
                "PurchaseOrderId": row["PurchaseOrderId"],
                "PurchaseOrderLineId": row["PurchaseOrderLineId"],
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


def write_audit(payload: dict) -> Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = date.today().isoformat().replace("-", "")
    asn_id = (
        ((payload.get("result") or {}).get("asn_id"))
        or "unknown"
    )
    path = RUNS_DIR / f"{stamp}_{asn_id}.json"
    # avoid collisions
    if path.exists():
        n = 1
        while True:
            path = RUNS_DIR / f"{stamp}_{asn_id}_{n}.json"
            if not path.exists():
                break
            n += 1
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Supplier Enablement — create ASN from PO lines (CLI)"
    )
    parser.add_argument("--org", help="ORG (e.g. SS-DEMO)")
    parser.add_argument("--token", help="Bearer token (access token only)")
    parser.add_argument("--token-file", help="Path to file containing Bearer token")
    parser.add_argument(
        "--verify", action="store_true", help="Verify token via PO search"
    )
    parser.add_argument(
        "--facility",
        help="Destination facility (default: {ORG}-DM1)",
    )
    parser.add_argument(
        "--edd",
        help="Estimated delivery date yyyy-MM-dd (default: today)",
    )
    parser.add_argument(
        "--po",
        "--pos",
        dest="po",
        help='Purchase order id(s), semicolon-delimited (e.g. "PO000002" or "PO000002;PO000010")',
    )
    parser.add_argument(
        "--select",
        help='Line selection, e.g. "1:10;2" (skip interactive select)',
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print payloads without writing to MAWM",
    )
    parser.add_argument(
        "--skip-shell",
        action="store_true",
        help="Skip asn/save shell header; only nextup + bulkImport",
    )
    args = parser.parse_args()

    print("=== Supplier Enablement — Create ASN from PO ===")
    org = args.org.upper() if args.org else prompt_org()
    facility = resolve_location(org, args.facility)
    edd = (args.edd or date.today().isoformat()).strip()
    if len(edd) < 10:
        print("EDD must be yyyy-MM-dd")
        return 1
    edd = edd[:10]

    # Always authenticate — dry-run still needs nextup + PO search.
    token = authenticate(
        org,
        token_arg=args.token,
        token_file=args.token_file,
        verify=args.verify,
        location=facility,
    )

    po_ids = prompt_po_ids(args.po)
    print(f"\nSearching PO lines for: {', '.join(po_ids)}")
    try:
        raw_lines, source = search_purchase_order_lines(
            po_ids, token, org, location=facility
        )
    except Exception as exc:
        print(f"PO search failed: {exc}")
        return 1

    print(f"Source: {source} ({len(raw_lines)} row(s) before eligibility filter)")
    eligible = filter_eligible_po_lines(raw_lines)
    if not eligible:
        print("No eligible PO lines (open, not canceled/closed, remaining qty > 0).")
        return 1

    item_ids = [str(l.get("ItemId") or "") for l in eligible]
    items = search_items(item_ids, token, org, location=facility)
    print_table(
        [
            "#",
            "PO",
            "Line",
            "Item",
            "Description",
            "Status",
            "OrderQty",
            "Shipped",
            "Unshipped",
            "UOM",
        ],
        display_rows(eligible, items),
        "Eligible PO lines",
    )

    try:
        staged = prompt_selection(eligible, args.select)
    except ValueError as exc:
        print(f"Selection error: {exc}")
        return 1

    vendors = {str(s.get("VendorId") or "") for s in staged if s.get("VendorId")}
    vendor_id = next(iter(vendors), None) if len(vendors) == 1 else None

    print(f"\nDestination facility: {facility}")
    print(f"Estimated delivery date: {edd}")
    print_table(
        ["#", "PO", "Line", "Item", "AssignQty", "UOM"],
        [
            [
                str(s["row"]),
                s["PurchaseOrderId"],
                s["PurchaseOrderLineId"],
                s["ItemId"],
                format_qty(s["ShippedQuantity"]),
                s["QuantityUomId"],
            ]
            for s in staged
        ],
        "Staged ASN lines",
    )

    if not args.dry_run and not prompt_yes("Create ASN"):
        print("Cancelled.")
        return 0

    try:
        asn_id = get_next_asn_number(token, org, location=facility)
    except Exception as exc:
        print(f"Nextup failed: {exc}")
        return 1
    print(f"\nNext ASN number: {asn_id}")

    shell_payload = {
        "AsnId": asn_id,
        "AsnLevelId": "ITEM",
        "AsnOriginTypeId": "P",
        "AsnStatus": "0000",
        "DestinationFacilityId": facility,
        "EstimatedDeliveryDate": edd,
    }
    bulk_payload = build_bulk_payload(
        asn_id, facility, edd, staged, vendor_id=vendor_id
    )

    audit = {
        "org": org,
        "facility": facility,
        "edd": edd,
        "po_ids": po_ids,
        "source": source,
        "staged": staged,
        "shell_payload": shell_payload,
        "bulk_payload": bulk_payload,
        "dry_run": args.dry_run,
        "skip_shell": args.skip_shell,
        "result": {"asn_id": asn_id},
    }

    if args.dry_run:
        print("\n--- Shell payload (asn/save) ---")
        print(json.dumps(shell_payload, indent=2))
        print("\n--- Bulk import payload ---")
        print(json.dumps(bulk_payload, indent=2))
        path = write_audit(audit)
        print(f"\nDry-run audit written: {path}")
        return 0

    shell_status = None
    shell_body = None
    if not args.skip_shell:
        print("Creating shell ASN header...")
        shell_resp = create_shell_asn(
            asn_id, token, org, facility, edd, location=facility
        )
        shell_status = shell_resp.status_code
        shell_body = shell_resp.text[:1000]
        audit["result"]["shell_status"] = shell_status
        audit["result"]["shell_response"] = shell_body
        if shell_status not in (200, 201):
            print(f"Shell ASN create FAILED ({shell_status}): {shell_body}")
            print(
                "Tip: retry with --skip-shell if the environment expects "
                "nextup + bulkImport only."
            )
            write_audit(audit)
            return 1
        print(f"Shell ASN created ({shell_status})")

    print("Persisting ASN lines via bulkImport...")
    bulk_resp = bulk_import_asn(bulk_payload, token, org, location=facility)
    bulk_status = bulk_resp.status_code
    bulk_body = bulk_resp.text[:2000]
    audit["result"]["bulk_status"] = bulk_status
    audit["result"]["bulk_response"] = bulk_body
    path = write_audit(audit)

    if bulk_status not in (200, 201):
        print(f"bulkImport FAILED ({bulk_status}): {bulk_body}")
        print(f"Audit: {path}")
        return 1

    print(f"ASN {asn_id} created successfully ({bulk_status})")
    print(f"Audit: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
