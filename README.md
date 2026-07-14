# Supplier Enablement — Create ASN from PO

CLI tools and a web app for creating ASNs from purchase orders against the MAWM demo environment (`salep.sce.manh.com`).

- **Repo:** [github.com/sidmsmith/supplierenablement](https://github.com/sidmsmith/supplierenablement)
- **Auth:** same org/OAuth + `--token-file` CLI patterns as flowthrough
- **UI themes:** inspection theme picker (all inspection themes)

## Setup

```bash
cd supplierenablement
pip install -r requirements.txt
npm install
```

### Local web (Vercel-style)

**Preferred (local):** put a Bearer access token in `.token` (gitignored) at the project root — same file as the CLI. On load the UI briefly shows the ORG gate, then authenticates from `.token` (default ORG `SS-DEMO`).

```powershell
# .token already filled from CLI use
npm start
# App: http://localhost:3010  (not 3000 — that is often Inspection)
# Flask API in another window: python api/index.py
```

**Optional (Vercel / no .token):** set `MANHATTAN_PASSWORD` and `MANHATTAN_SECRET` for OAuth instead.

## URL parameters

| Param | Aliases | Example |
|-------|---------|---------|
| `Organization` | `org`, `organization` | `?Organization=SS-DEMO` |
| `PO` | `po`, `PurchaseOrder`, `criteria` | `?PO=PO000002;PO000010` or `?PO=PO000002,PO000010` |
| `Location` | `Facility`, `facility`, `location` | `?Location=SS-DEMO-DM1` |
| `Theme` | — | `Theme=N` hides the theme picker |

Multiple PO / criteria values may be separated by **semicolons**, **commas**, or spaces. After auth + preload, a `PO` param auto-loads matching purchase orders.

Example: `http://localhost:3010/?Organization=SS-DEMO&PO=PO000002;PO000010`

## Web UI flow

1. Enter ORG → authenticate  
2. App preloads light PO index (PO / Vendor / Item)  
3. Type criteria matching **PO, Vendor ID, or Item** → **Load POs**  
4. Expand PO rows → assign qty (or **All**) on eligible lines; ineligible lines disabled  
5. **Hide shipped lines** toggle (saved in `localStorage`)  
6. **Create ASN** → confirm modal (next ASN #, facility, EDD, summary) → results modal → list refresh  

## CLI

```powershell
python run_supplierenablement.py --token-file .token
python run_supplierenablement.py --token-file .token --po "PO000002;PO000010" --select "1:10;3:20"
```

See CLI flags in prior README section / `--help`.

## API actions

| Action | Purpose |
|--------|---------|
| `auth` | OAuth token for ORG |
| `preload` | Light PO/Vendor/Item index |
| `load_pos` | Full PO + line details for selected POs |
| `preview_asn` | Nextup AsnNumber + summary |
| `create_asn` | Shell save + bulkImport |

## Project layout

```
supplierenablement/
├── public/                 # Web UI
│   ├── index.html
│   ├── app.js
│   ├── themes.js           # inspection themes
│   └── *logo*.png
├── api/index.py            # Flask / Vercel API
├── mawm_client.py
├── se_service.py
├── cli_utils.py
├── run_supplierenablement.py
├── server.js
├── vercel.json
└── requirements*.txt
```
