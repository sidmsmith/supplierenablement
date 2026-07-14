#!/usr/bin/env python3
"""CLI helpers for supplier enablement scripts."""

import getpass
import os
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

from mawm_client import HOST, get_manhattan_token, normalize_token, resolve_location, validate_org

DEFAULT_ORG = "SS-DEMO"
DEFAULT_TOKEN = ""


def prompt_org() -> str:
    if DEFAULT_ORG and validate_org(DEFAULT_ORG.strip()):
        print(f"Using default ORG: {DEFAULT_ORG}")
        return DEFAULT_ORG.strip().upper()
    while True:
        org = input("Enter ORG (e.g. SS-DEMO): ").strip().upper()
        if validate_org(org):
            return org
        print("Invalid ORG. Must be ALL CAPS and end with '-DEMO'.")


def read_token_from_file(path: str) -> str:
    text = Path(path).read_text(encoding="utf-8")
    token = normalize_token(text)
    if not token:
        print(f"Token file is empty: {path}")
        sys.exit(1)
    print(f"Using Bearer token from file ({len(token)} chars).")
    return token


def prompt_bearer_token() -> str:
    if DEFAULT_TOKEN and DEFAULT_TOKEN.strip():
        print("Using default Bearer token.")
        return normalize_token(DEFAULT_TOKEN)
    print("Enter Bearer token (paste access token only, not 'Bearer ').")
    print("Or use --token-file to read from a file.")
    token = normalize_token(getpass.getpass("Bearer token: "))
    if not token:
        print("Token is required.")
        sys.exit(1)
    return token


def authenticate(
    org: str,
    token_arg: str = None,
    token_file: str = None,
    verify: bool = False,
    location: str = None,
) -> str:
    """
    Resolve a Bearer token before PO / ASN work.

    Priority: --token-file > --token > OAuth env vars > manual prompt.
    """
    loc = resolve_location(org, location)
    print(f"Using HOST: {HOST}")
    print(f"selectedOrganization: {org}")
    print(f"selectedLocation: {loc}")

    if token_file:
        token = read_token_from_file(token_file)
    elif token_arg:
        token = normalize_token(token_arg)
        print("Using Bearer token from command line.")
    else:
        token = get_manhattan_token(org)
        if token:
            token = normalize_token(token)
            print("Authenticated via OAuth.")
        else:
            if not os.getenv("MANHATTAN_PASSWORD") or not os.getenv("MANHATTAN_SECRET"):
                print("OAuth env vars not set; falling back to manual Bearer token.")
            token = prompt_bearer_token()

    if verify:
        from mawm_client import verify_auth

        ok, message = verify_auth(token, org, location=location)
        if not ok:
            print(f"\n{message}")
            sys.exit(1)
        print(message)

    return token


def prompt_yes(label: str = "Continue") -> bool:
    return input(f"{label} (YES): ").strip().upper() == "YES"


def format_qty(value) -> str:
    if value in (None, "", []):
        return "0"
    try:
        dec = Decimal(str(value))
    except InvalidOperation:
        return str(value)
    if dec == dec.to_integral_value():
        return str(int(dec))
    return format(dec.normalize(), "f")


def print_table(headers, rows, title: str):
    if not rows:
        print(f"\n=== {title} ===")
        print("No data.")
        return
    string_rows = [["" if v is None else str(v) for v in row] for row in rows]
    widths = [
        max(len(headers[i]), max(len(r[i]) for r in string_rows))
        for i in range(len(headers))
    ]
    print(f"\n=== {title} ===")
    print(" | ".join(headers[i].ljust(widths[i]) for i in range(len(headers))))
    print("-+-".join("-" * w for w in widths))
    for row in string_rows:
        print(" | ".join(row[i].ljust(widths[i]) for i in range(len(headers))))
