# Supplier Enablement v0.1.1

CLI tools and a full-screen web app for **Create ASN from PO** against the MAWM demo environment (`salep.sce.manh.com`).

| | |
|---|---|
| **Repo** | [github.com/sidmsmith/supplierenablement](https://github.com/sidmsmith/supplierenablement) |
| **Live** | [supplierenablement.vercel.app](https://supplierenablement.vercel.app/) |
| **Version** | `0.1.1` (shown in the browser tab title only) |

## Features

- Authenticate by ORG (local `.token` or Vercel OAuth env)
- Light preload index → find POs by **PO number, Vendor, Item, or Description** (multi-token with space / `,` / `;`)
- Desktop: expandable PO table with column config, sort, assign qty / **All** / **Clear**
- Mobile (≤992px): dispatch-style PO cards + bottom sheet with editable lines, **Show/Hide** shipped lines, prev/next PO
- One ASN for all assigned lines; confirm facility + EDD; item image thumbs with hover preview
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

Set:

- `MANHATTAN_PASSWORD`
- `MANHATTAN_SECRET`

Optional: `MANHATTAN_DEFAULT_ORG`, `MANHATTAN_USAGE_INGEST_URL`.

Deployed app: https://supplierenablement.vercel.app/

## URL parameters

| Param | Aliases | Example |
|-------|---------|---------|
| `Organization` | `org`, `organization` | `?Organization=SS-DEMO` |
| `PO` | `po`, `PurchaseOrder`, `criteria` | `?PO=PO000002;PO000010` or `?PO=PO000002,PO000010` |
| `Location` | `Facility`, `facility`, `location` | `?Location=SS-DEMO-DM1` |
| `Theme` | — | `Theme=N` hides the theme picker |

- Multiple PO / criteria values: **semicolons**, **commas**, or **spaces**.
- With `Organization` (+ optional `PO`), the app auto-authenticates and can auto-load matching POs after preload.

Examples:

```
https://supplierenablement.vercel.app/?Organization=SS-DEMO
https://supplierenablement.vercel.app/?Organization=SS-DEMO&PO=PO000002;PO000010
http://localhost:3010/?org=SS-DEMO&PO=PO000002,PO000010&Location=SS-DEMO-DM1
```

## Web UI flow

1. Enter **ORG** → Authenticate (skipped only when `Organization` is in the URL).
2. App preloads a light PO / Vendor / Item / Description index.
3. Enter criteria → **Load PO** / **Load POs** (plural-aware labels).
4. **Desktop:** expand a PO row → assign quantities (or **All** / **Clear**). Use **Hide shipped lines** and **Columns** as needed.
5. **Mobile:** tap a PO card → bottom sheet shows lines; **Show** / **Hide** (same `localStorage` key as desktop), assign per line, **All** / **Clear**, Create ASN.
6. **Create ASN** → confirm ASN #, facility, EDD, line summary → result modal → list refresh.

Assigned lines are shared between desktop and mobile. Status text is plural-aware (e.g. `2 lines assigned`).

### Preferences (browser `localStorage`)

| Key | Purpose |
|-----|---------|
| `se_hide_shipped_lines` | Hide shipped lines (`1` / unset) |
| `se_column_config_v2` | Desktop column visibility, order, sort |

## CLI

```powershell
python run_supplierenablement.py --help
python run_supplierenablement.py --token-file .token
python run_supplierenablement.py --token-file .token --org SS-DEMO --facility SS-DEMO-DM1 --edd 2026-07-15
python run_supplierenablement.py --token-file .token --po "PO000002;PO000010" --select "1:10;3:20"
python run_supplierenablement.py --token-file .token --po "PO000002" --dry-run
```

| Flag | Description |
|------|-------------|
| `--org` | ORG (e.g. `SS-DEMO`); prompted if omitted |
| `--token` | Bearer access token |
| `--token-file` | Path to file with Bearer token (e.g. `.token`) |
| `--verify` | Verify token via PO search |
| `--facility` | Destination facility (default `{ORG}-DM1`) |
| `--edd` | Estimated delivery date `yyyy-MM-dd` (default today) |
| `--po` / `--pos` | PO id(s); `;` or `,` delimited |
| `--select` | Line selection, e.g. `1:10;3:20` (skip interactive select) |
| `--dry-run` | Print payloads without writing to MAWM |
| `--skip-shell` | Skip `asn/save` shell header; only nextup + bulkImport |

Audit JSON from CLI runs is written under `runs/` (gitignored).

## API actions

Proxied as `POST /api/<action>` (Express → Flask locally; Vercel serverless in cloud).

| Action | Purpose |
|--------|---------|
| `auth` | Resolve token for ORG (`.token` file or OAuth) |
| `preload` | Light PO / Vendor / Item index |
| `load_pos` | Full PO + line details for selected POs |
| `preview_asn` | Reserve next ASN number + summary |
| `create_asn` | Shell `asn/save` + `asn/bulkImport` |
| `app_opened` | Optional usage ping |

## Project layout

```
supplierenablement/
├── public/                      # Web UI
│   ├── index.html               # App shell, themes, mobile sheet
│   ├── app.js                   # Desktop + mobile UI
│   ├── themes.js                # Inspection themes
│   ├── item-image-preview.js
│   └── *logo*.png
├── api/index.py                 # Flask / Vercel API (APP_VERSION)
├── mawm_client.py               # MAWM HTTP helpers
├── se_service.py                # Preload / load / preview / create
├── cli_utils.py                 # Shared CLI auth helpers
├── run_supplierenablement.py    # CLI entrypoint
├── server.js                    # Express static + /api proxy (:3010)
├── vercel.json
├── package.json                 # version 0.1.1
├── requirements.txt
├── requirements-vercel.txt
└── .gitignore                   # .token, runs/, node_modules/, …
```

## Notes

- Status codes in MAWM are **domain-scoped**; do not assume a code means the same thing across objects. Prefer the `mawm_api_library` under `Web/` when extending API usage.
- Default destination facility when not overridden: `{ORG}-DM1`.
