# Supplier Enablement v0.2.1

CLI tools and a full-screen web app for **Create ASN from PO** and **Create LPNs** against the MAWM demo environment (`salep.sce.manh.com`).

| | |
|---|---|
| **Repo** | [github.com/sidmsmith/supplierenablement](https://github.com/sidmsmith/supplierenablement) |
| **Live** | [supplierenablement.vercel.app](https://supplierenablement.vercel.app/) |
| **Version** | `0.2.1` (browser tab title only) |

## Features

- Authenticate by ORG (local `.token` or Vercel OAuth env)
- Light preload index â†’ find POs by **PO number, Vendor, Item, or Description** (multi-token with space / `,` / `;`)
- Desktop: expandable PO table with column config, sort, assign qty / **All** / **Clear**
- Mobile (â‰¤992px): PO cards + bottom sheet with editable lines, **Show/Hide** shipped lines
- One ASN for all assigned lines; confirm facility + EDD
- After ASN create: **Create LPNs** modal (cartonize + standard iLPN qty) â†’ `lpn/create` â†’ list iLPN numbers by AsnId
- Expand a PO to see **linked ASNs** (multi-PO ASNs show all lines; other-PO lines muted) with Create LPNs / Download Labels
- URL deep-link params for Organization, PO, Location, Theme

## Setup

```bash
cd supplierenablement
pip install -r requirements.txt
npm install
```

### Local web

1. Put a Bearer access token in `.token` at the project root (**gitignored — never commit**).
2. Start API and UI in two terminals:

```powershell
python api\index.py
npm start
# UI: http://localhost:3010  (port 3010 avoids Inspection on 3000)
```

The UI **always prompts for ORG** unless you pass `?Organization=…`. After ORG is entered, local auth uses `.token`; on Vercel it uses OAuth env vars.

### Vercel / cloud auth

Set `MANHATTAN_PASSWORD` and `MANHATTAN_SECRET`.

Optional: `MANHATTAN_DEFAULT_ORG`, `MANHATTAN_USAGE_INGEST_URL`.

## URL parameters

| Param | Aliases | Example |
|-------|---------|---------|
| `Organization` | `org`, `organization` | `?Organization=SS-DEMO` |
| `PO` | `po`, `PurchaseOrder`, `criteria` | `?PO=PO000002;PO000010` |
| `Location` | `Facility`, `facility`, `location` | `?Location=SS-DEMO-DM1` |
| `Theme` | — | `Theme=N` hides the theme picker |

Multiple PO / criteria values: semicolons, commas, or spaces.

## Web UI flow

1. Enter **ORG** â†’ Authenticate (skipped only when `Organization` is in the URL).
2. Preload â†’ enter criteria â†’ **Load PO(s)**.
3. Assign quantities on eligible lines â†’ **Create ASN** â†’ confirm facility / EDD.
4. On **ASN Created**: **Create LPNs** or **Done** (refreshes PO list).
5. LPN modal: per ASN line set **Qty to cartonize** and **Std iLPN qty** (uneven splits OK — residual LPN). Predicted LPN count shown live. After create, the API polls for iLPNs up to ~10s.
6. Create calls receiving `lpn/create`, then finds iLPNs by `AsnId` and displays LPN numbers.

## API actions

| Action | Purpose |
|--------|---------|
| `auth` | Resolve token for ORG (`.token` file or OAuth) |
| `preload` | Light PO / Vendor / Item index |
| `load_pos` | Full PO + line details |
| `preview_asn` | Reserve next ASN number + summary |
| `create_asn` | Shell `asn/save` + `asn/bulkImport` |
| `list_asns_for_po` | ASNs linked to a PO (`AsnLine.PurchaseOrderId`) |
| `load_asn_for_lpn` | ASN search â†’ lines with AsnLineId for LPN modal |
| `create_lpns` | `receiving/ui/lpn/create` + iLPN search by AsnId |
| `download_lpn_labels` | Build ZPL labels + Labelary PDF (`{AsnId}-labels.pdf`) |
| `app_opened` | Optional usage ping |

## CLI

```powershell
python run_supplierenablement.py --help
python run_supplierenablement.py --token-file .token --po "PO000002;PO000010" --select "1:10;3:20"
```

| Flag | Description |
|------|-------------|
| `--org` | ORG (e.g. `SS-DEMO`) |
| `--token` / `--token-file` | Bearer auth |
| `--facility` | Destination (default `{ORG}-DM1`) |
| `--edd` | `yyyy-MM-dd` (default today) |
| `--po` / `--pos` | PO id(s); `;` or `,` delimited |
| `--select` | Line selection, e.g. `1:10;3:20` |
| `--dry-run` | Print payloads without writing |
| `--skip-shell` | Skip `asn/save`; only nextup + bulkImport |

Audit JSON under `runs/` (gitignored). CLI does not yet create LPNs (web UI only).

## Project layout

```
supplierenablement/
├── public/                 # Web UI (ASN + LPN modals)
├── api/index.py            # Flask / Vercel API
├── mawm_client.py          # MAWM HTTP helpers (incl. lpn/create, ilpn search)
├── se_service.py
├── run_supplierenablement.py
├── server.js               # :3010
└── …
```

MAWM reference for LPN create: `../mawm_api_library/lpn_create/`.
