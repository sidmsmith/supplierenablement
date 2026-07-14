/* Supplier Enablement — full-screen UI */
(function () {
  const state = {
    org: "",
    token: "",
    facility: "",
    preloadEntries: [],
    purchaseOrders: [],
    expanded: {},
    staged: {}, // key: poId|lineId -> { line payload + assignQty }
    preview: null,
    sortKey: "purchaseOrderId",
    sortAsc: true,
    sheetPoIdx: -1,
  };

  const HIDE_SHIPPED_KEY = "se_hide_shipped_lines";
  const COL_STORAGE_KEY = "se_column_config_v2";

  const el = {
    filtersScreen: document.getElementById("filtersScreen"),
    resultsScreen: document.getElementById("resultsScreen"),
    orgSection: document.getElementById("orgSection"),
    mainUI: document.getElementById("mainUI"),
    org: document.getElementById("org"),
    criteria: document.getElementById("criteria"),
    matchHint: document.getElementById("matchHint"),
    status: document.getElementById("status"),
    loadPosBtn: document.getElementById("loadPosBtn"),
    backToFilters: document.getElementById("backToFilters"),
    resultsStatus: document.getElementById("resultsStatus"),
    hideShippedToggle: document.getElementById("hideShippedToggle"),
    colConfigBtn: document.getElementById("colConfigBtn"),
    colConfigPopover: document.getElementById("colConfigPopover"),
    colConfigList: document.getElementById("colConfigList"),
    resetColumns: document.getElementById("resetColumns"),
    poHead: document.querySelector("#poHead tr"),
    poBody: document.getElementById("poBody"),
    poCardsMobile: document.getElementById("poCardsMobile"),
    sheetOverlay: document.getElementById("sheetOverlay"),
    bottomSheet: document.getElementById("bottomSheet"),
    sheetClose: document.getElementById("sheetClose"),
    sheetPrev: document.getElementById("sheetPrev"),
    sheetNext: document.getElementById("sheetNext"),
    sheetPoId: document.getElementById("sheetPoId"),
    sheetOverview: document.getElementById("sheetOverview"),
    sheetBody: document.getElementById("sheetBody"),
    sheetStageStatus: document.getElementById("sheetStageStatus"),
    sheetCreateAsnBtn: document.getElementById("sheetCreateAsnBtn"),
    stageStatus: document.getElementById("stageStatus"),
    createAsnBtn: document.getElementById("createAsnBtn"),
    confirmModal: document.getElementById("confirmModal"),
    confirmHead: document.getElementById("confirmHead"),
    confirmBody: document.getElementById("confirmBody"),
    confirmCancel: document.getElementById("confirmCancel"),
    confirmCreate: document.getElementById("confirmCreate"),
    resultsModal: document.getElementById("resultsModal"),
    resultsHead: document.getElementById("resultsHead"),
    resultsBody: document.getElementById("resultsBody"),
    resultsOk: document.getElementById("resultsOk"),
    busyOverlay: document.getElementById("busyOverlay"),
    themeLogo: document.getElementById("themeLogo"),
    themeSelectorBtn: document.getElementById("themeSelectorBtn"),
    themeList: document.getElementById("themeList"),
    authBtn: document.getElementById("authBtn"),
  };

  const DEFAULT_COLUMNS = [
    { key: "purchaseOrderId", label: "PO Number", visible: true },
    { key: "statusLabel", label: "Status", visible: true },
    { key: "destinationFacilityId", label: "Destination Facility", visible: true },
    { key: "vendorId", label: "Vendor", visible: true },
    { key: "lineCount", label: "Total Lines", visible: true },
    { key: "eligibleLineCount", label: "Eligible Lines", visible: true },
    { key: "totalOrderQuantity", label: "Order Qty", visible: true },
    { key: "totalShippedQuantity", label: "Shipped Qty", visible: true },
    { key: "totalUnshippedQuantity", label: "Unshipped Qty", visible: true },
  ];

  let columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));

  function setBusy(on, label) {
    el.busyOverlay.classList.toggle("visible", !!on);
    el.busyOverlay.textContent = label || "Working…";
  }

  function setStatus(msg, kind) {
    el.status.textContent = msg || "";
    el.status.className = "status-line flex-grow-1" + (kind ? " " + kind : "");
  }

  async function api(action, data) {
    const res = await fetch("/api/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    });
    let body = {};
    try {
      body = await res.json();
    } catch (_) {
      body = { success: false, error: "Invalid JSON response (" + res.status + ")" };
    }
    if (!res.ok && body && !body.error) {
      body.error = "Request failed (" + res.status + ")";
      body.success = false;
    }
    return body;
  }

  function todayIso() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function fmtQty(v) {
    if (v === null || v === undefined || v === "") return "0";
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    return Number.isInteger(n) ? String(n) : String(n);
  }

  function fmtCount(n, singular, plural) {
    const count = Number(n) || 0;
    const word = count === 1 ? singular : plural || singular + "s";
    return count + " " + word;
  }

  function fmtLineCount(n) {
    return fmtCount(n, "line", "lines");
  }

  function fmtPoCount(n) {
    return fmtCount(n, "PO", "POs");
  }

  function stageKey(poId, lineId) {
    return poId + "|" + lineId;
  }

  function splitCriteriaTokens(criteria) {
    return String(criteria || "")
      .trim()
      .split(/[,;\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function matchedEntries(criteria) {
    const tokens = splitCriteriaTokens(criteria).map((t) => t.toLowerCase());
    if (!tokens.length) return [];
    const matched = [];
    const seen = new Set();
    state.preloadEntries.forEach((entry) => {
      const parts = [entry.purchaseOrderId || "", entry.vendorId || ""];
      (entry.items || []).forEach((it) => {
        parts.push(it.itemId || "");
        parts.push(it.description || "");
      });
      const hay = parts.map((p) => String(p).toLowerCase()).filter(Boolean);
      const hit = tokens.some((tok) => hay.some((h) => h.includes(tok)));
      if (!hit) return;
      const poId = entry.purchaseOrderId;
      if (seen.has(poId)) return;
      seen.add(poId);
      matched.push(entry);
    });
    return matched;
  }

  function updateLoadButton() {
    const criteria = el.criteria.value;
    const matches = matchedEntries(criteria);
    const valid = matches.length > 0;
    const poCount = valid
      ? new Set(matches.map((m) => m.purchaseOrderId)).size
      : 0;
    el.loadPosBtn.disabled = !valid || !state.token;
    el.loadPosBtn.textContent = valid
      ? poCount === 1
        ? "Load PO"
        : "Load POs"
      : "Enter Valid Criteria";
    if (!state.token) {
      el.matchHint.textContent = "Authenticate to preload purchase orders.";
    } else if (!criteria.trim()) {
      el.matchHint.textContent =
        "Preloaded " +
        fmtPoCount(state.preloadEntries.length) +
        ". Type PO, Vendor, Item, or Description.";
    } else if (valid) {
      const verb = poCount === 1 ? "matches" : "match";
      el.matchHint.textContent =
        fmtPoCount(poCount) + " " + verb + ' "' + criteria.trim() + '".';
    } else {
      el.matchHint.textContent = "No POs match that criteria.";
    }
  }

  async function authenticate(org, options) {
    options = options || {};
    org = (org || "").trim().toUpperCase();
    if (!org) {
      setStatus("ORG is required", "error");
      return false;
    }
    if (!options.quiet) {
      setBusy(true, "Authenticating…");
      setStatus("Authenticating…");
    }
    try {
      const data = await api("auth", { org });
      if (!data.success) {
        setStatus(data.error || "Auth failed", "error");
        return false;
      }
      state.org = data.org || org;
      state.token = data.token;
      state.facility = state.org + "-DM1";
      el.org.value = state.org;
      el.orgSection.style.display = "none";
      el.mainUI.style.display = "block";
      el.criteria.disabled = false;
      el.criteria.focus();
      const via =
        data.source === "token-file"
          ? "via .token"
          : data.source === "oauth"
            ? "via OAuth"
            : "";
      setStatus("Authenticated " + via + ". Preloading POs…", "success");
      await preload();
      await applyUrlBootOptions();
      return true;
    } catch (e) {
      setStatus(e.message || String(e), "error");
      return false;
    } finally {
      if (!options.quiet) setBusy(false);
    }
  }

  async function preload() {
    setBusy(true, "Preloading POs…");
    try {
      const data = await api("preload", {
        org: state.org,
        token: state.token,
        location: state.facility,
      });
      if (!data.success) {
        setStatus(data.error || "Preload failed", "error");
        return;
      }
      state.preloadEntries = data.entries || [];
      setStatus("Ready — " + fmtPoCount(state.preloadEntries.length) + " indexed", "success");
      updateLoadButton();
    } catch (e) {
      setStatus(e.message || String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function loadPos() {
    const criteria = el.criteria.value.trim();
    const matches = matchedEntries(criteria);
    if (!matches.length) return;
    const poIds = [...new Set(matches.map((m) => m.purchaseOrderId))];
    setBusy(true, "Loading POs…");
    setStatus("Loading " + fmtPoCount(poIds.length) + "…");
    try {
      const data = await api("load_pos", {
        org: state.org,
        token: state.token,
        location: state.facility,
        purchaseOrderIds: poIds,
      });
      if (!data.success) {
        setStatus(data.error || "Load failed", "error");
        return;
      }
      state.purchaseOrders = data.purchaseOrders || [];
      state.expanded = {};
      // keep staged qty if still present/eligible, else clear
      pruneStaged();
      showResults();
      renderResults();
      updateStageUi();
      el.resultsStatus.textContent =
        fmtPoCount(state.purchaseOrders.length) +
        " · " +
        fmtLineCount(data.lineCount || 0) +
        ' · criteria "' +
        criteria +
        '"';
      setStatus("Loaded POs", "success");
    } catch (e) {
      setStatus(e.message || String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  function pruneStaged() {
    const next = {};
    const map = {};
    state.purchaseOrders.forEach((po) => {
      (po.lines || []).forEach((line) => {
        map[stageKey(line.purchaseOrderId, line.purchaseOrderLineId)] = line;
      });
    });
    Object.keys(state.staged).forEach((k) => {
      const line = map[k];
      if (line && line.eligible) {
        const qty = Number(state.staged[k].shippedQuantity);
        if (qty > 0 && qty <= Number(line.unshippedQuantity)) {
          next[k] = {
            purchaseOrderId: line.purchaseOrderId,
            purchaseOrderLineId: line.purchaseOrderLineId,
            itemId: line.itemId,
            description: line.description,
            itemImageUrl: line.itemImageUrl || "",
            quantityUomId: line.quantityUomId,
            vendorId: line.vendorId || poVendor(line.purchaseOrderId),
            shippedQuantity: qty,
            unshippedQuantity: line.unshippedQuantity,
          };
        }
      }
    });
    state.staged = next;
  }

  function poVendor(poId) {
    const po = state.purchaseOrders.find((p) => p.purchaseOrderId === poId);
    return (po && po.vendorId) || "";
  }

  function showFilters() {
    closeBottomSheet();
    el.resultsScreen.classList.remove("active");
    el.filtersScreen.classList.add("active");
  }

  function showResults() {
    el.filtersScreen.classList.remove("active");
    el.resultsScreen.classList.add("active");
  }

  function hideShipped() {
    return !!el.hideShippedToggle.checked;
  }

  function visibleColumns() {
    return columns.filter((c) => c.visible);
  }

  function saveColumns() {
    localStorage.setItem(
      COL_STORAGE_KEY,
      JSON.stringify({
        cols: columns.map((c) => ({ key: c.key, visible: c.visible })),
        sortKey: state.sortKey,
        sortAsc: state.sortAsc,
      })
    );
  }

  function restoreColumns() {
    try {
      const raw = localStorage.getItem(COL_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const ordered = [];
      (saved.cols || []).forEach((s) => {
        const def = DEFAULT_COLUMNS.find((d) => d.key === s.key);
        if (def) ordered.push({ ...def, visible: s.visible });
      });
      DEFAULT_COLUMNS.forEach((def) => {
        if (!ordered.find((o) => o.key === def.key)) ordered.push({ ...def });
      });
      columns = ordered;
      if (saved.sortKey) {
        state.sortKey = saved.sortKey;
        state.sortAsc = saved.sortAsc !== false;
      }
    } catch (_) {
      /* ignore */
    }
  }

  function renderColConfig() {
    let dragIdx = null;
    el.colConfigList.innerHTML = columns
      .map(
        (c, i) =>
          `<li draggable="true" data-idx="${i}">
            <span class="drag-handle"><i class="fas fa-grip-vertical"></i></span>
            <label><input type="checkbox" data-key="${c.key}" ${c.visible ? "checked" : ""}/> ${c.label}</label>
          </li>`
      )
      .join("");

    el.colConfigList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const col = columns.find((c) => c.key === cb.getAttribute("data-key"));
        if (col) {
          col.visible = cb.checked;
          saveColumns();
          renderResults();
        }
      });
      cb.addEventListener("click", (e) => e.stopPropagation());
    });

    el.colConfigList.querySelectorAll("li").forEach((li) => {
      li.addEventListener("dragstart", (e) => {
        dragIdx = parseInt(li.dataset.idx, 10);
        li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (e) => e.preventDefault());
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const dropIdx = parseInt(li.dataset.idx, 10);
        if (dragIdx == null || dragIdx === dropIdx) return;
        const [moved] = columns.splice(dragIdx, 1);
        columns.splice(dropIdx, 0, moved);
        saveColumns();
        renderResults();
        renderColConfig();
        dragIdx = null;
      });
    });
  }

  function attachPoHeaderListeners() {
    let dragSrcKey = null;
    el.poHead.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-key");
        if (state.sortKey === key) state.sortAsc = !state.sortAsc;
        else {
          state.sortKey = key;
          state.sortAsc = true;
        }
        saveColumns();
        renderResults();
      });

      th.addEventListener("dragstart", (e) => {
        dragSrcKey = th.getAttribute("data-key");
        e.dataTransfer.effectAllowed = "move";
        th.style.opacity = "0.4";
      });
      th.addEventListener("dragend", () => {
        th.style.opacity = "";
      });
      th.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        th.classList.add("drag-over");
      });
      th.addEventListener("dragleave", () => th.classList.remove("drag-over"));
      th.addEventListener("drop", (e) => {
        e.preventDefault();
        th.classList.remove("drag-over");
        const dropKey = th.getAttribute("data-key");
        if (!dragSrcKey || dragSrcKey === dropKey) return;
        const srcIdx = columns.findIndex((c) => c.key === dragSrcKey);
        const dstIdx = columns.findIndex((c) => c.key === dropKey);
        if (srcIdx < 0 || dstIdx < 0) return;
        const [moved] = columns.splice(srcIdx, 1);
        columns.splice(dstIdx, 0, moved);
        saveColumns();
        renderResults();
        if (el.colConfigPopover.classList.contains("visible")) renderColConfig();
      });
    });
  }

  function sortedPos() {
    const rows = state.purchaseOrders.slice();
    const key = state.sortKey;
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") {
        return state.sortAsc ? av - bv : bv - av;
      }
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return state.sortAsc ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return rows;
  }

  function renderResults() {
    renderPoTable();
    renderPoCards();
    if (sheetIsOpen() && state.sheetPoIdx >= 0) {
      const rows = sortedPos();
      if (state.sheetPoIdx < rows.length) {
        showBottomSheet(rows[state.sheetPoIdx], state.sheetPoIdx, { keepScroll: true });
      } else {
        closeBottomSheet();
      }
    }
  }

  function renderPoTable() {
    const cols = visibleColumns();
    el.poHead.innerHTML =
      `<th style="width:2rem"></th>` +
      cols
        .map((c) => {
          const sorted = state.sortKey === c.key;
          const arrow = sorted ? (state.sortAsc ? "▲" : "▼") : "▲";
          const arrowClass = "sort-arrow" + (sorted ? "" : " is-hidden");
          return `<th data-key="${c.key}" draggable="true"><span class="th-label">${c.label}</span><span class="${arrowClass}" aria-hidden="${sorted ? "false" : "true"}">${arrow}</span></th>`;
        })
        .join("");
    attachPoHeaderListeners();

    const hide = hideShipped();
    const fragments = [];
    sortedPos().forEach((po) => {
      const open = !!state.expanded[po.purchaseOrderId];
      const cells = cols
        .map((c) => {
          let v = po[c.key];
          if (
            c.key === "totalOrderQuantity" ||
            c.key === "totalShippedQuantity" ||
            c.key === "totalUnshippedQuantity"
          ) {
            v = fmtQty(v);
          }
          return `<td>${v ?? ""}</td>`;
        })
        .join("");
      fragments.push(
        `<tr class="po-header-row ${open ? "expanded" : ""}" data-po="${po.purchaseOrderId}">
          <td><span class="chevron ${open ? "open" : ""}">▶</span></td>${cells}
        </tr>`
      );
      if (open) {
        fragments.push(
          `<tr class="po-lines-row" data-po-lines="${po.purchaseOrderId}">
            <td colspan="${cols.length + 1}"><div class="lines-panel">${renderLinesPanel(po, hide)}</div></td>
          </tr>`
        );
      }
    });
    el.poBody.innerHTML = fragments.join("") || `<tr><td colspan="${cols.length + 1}" style="padding:1rem;color:var(--text-muted)">No purchase orders</td></tr>`;

    el.poBody.querySelectorAll("tr.po-header-row").forEach((row) => {
      row.addEventListener("click", () => {
        const poId = row.getAttribute("data-po");
        state.expanded[poId] = !state.expanded[poId];
        renderPoTable();
        renderPoCards();
      });
    });

    el.poBody.querySelectorAll("[data-qty-input]").forEach((input) => {
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("change", () => onQtyChange(input));
      input.addEventListener("input", () => onQtyChange(input));
    });
    el.poBody.querySelectorAll("[data-full-qty]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const poId = btn.getAttribute("data-po");
        const lineId = btn.getAttribute("data-line");
        const action = btn.getAttribute("data-assign-action") || "all";
        const input = el.poBody.querySelector(
          `input[data-qty-input][data-po="${poId}"][data-line="${lineId}"]`
        );
        if (action === "clear") {
          if (input) input.value = "";
          const key = stageKey(poId, lineId);
          delete state.staged[key];
          setQtyInputsForPo(poId, lineId, "");
          updateStageUi();
          syncAssignButtons(poId);
          renderPoCards();
          return;
        }
        if (input) {
          input.value = btn.getAttribute("data-full-qty");
          onQtyChange(input);
        }
      });
    });
    el.poBody.querySelectorAll("[data-all-po]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const poId = btn.getAttribute("data-all-po");
        const action = btn.getAttribute("data-assign-action") || "all";
        if (action === "clear") clearAllForPo(poId);
        else assignAllForPo(poId);
      });
    });

    if (typeof window.bindItemImagePreview === "function") {
      delete el.poBody.dataset.itemImagePreviewBound;
      window.bindItemImagePreview(el.poBody);
    }
  }

  function sheetIsOpen() {
    return el.bottomSheet && el.bottomSheet.classList.contains("visible");
  }

  function renderPoCards() {
    if (!el.poCardsMobile) return;
    const rows = sortedPos();
    if (!rows.length) {
      el.poCardsMobile.innerHTML =
        `<div style="padding:1rem;color:var(--text-muted)">No purchase orders</div>`;
      return;
    }
    el.poCardsMobile.innerHTML = rows
      .map((po, i) => {
        return `<div class="po-card-item${state.sheetPoIdx === i ? " selected" : ""}" data-idx="${i}">
          <div class="po-card-top">
            <span class="po-card-id">${escapeHtml(po.purchaseOrderId)}</span>
            <span class="po-card-status">${escapeHtml(po.statusLabel || "")}</span>
          </div>
          <div class="po-card-meta">
            <div class="po-card-meta-row">
              <span><strong>Dest</strong> ${escapeHtml(po.destinationFacilityId || "—")}</span>
              <span><strong>Vendor</strong> ${escapeHtml(po.vendorId || "—")}</span>
            </div>
            <div class="po-card-meta-row">
              <span><strong>Lines</strong> ${po.lineCount ?? (po.lines || []).length}</span>
              <span><strong>Eligible</strong> ${po.eligibleLineCount ?? 0}</span>
              <span><strong>Unshipped</strong> ${fmtQty(po.totalUnshippedQuantity)}</span>
            </div>
          </div>
        </div>`;
      })
      .join("");

    el.poCardsMobile.querySelectorAll(".po-card-item").forEach((card) => {
      card.addEventListener("click", () => {
        const idx = parseInt(card.getAttribute("data-idx"), 10);
        showBottomSheet(rows[idx], idx);
      });
    });
  }

  function updateSheetNavArrows(count) {
    if (!el.sheetPrev || !el.sheetNext) return;
    el.sheetPrev.classList.toggle("hidden", state.sheetPoIdx <= 0);
    el.sheetNext.classList.toggle("hidden", state.sheetPoIdx >= count - 1);
  }

  function showBottomSheet(po, idx, opts) {
    if (!po || !el.bottomSheet) return;
    const keepScroll = opts && opts.keepScroll;
    const prevScroll = keepScroll && el.sheetBody ? el.sheetBody.scrollTop : 0;
    const rows = sortedPos();
    state.sheetPoIdx = idx != null ? idx : rows.indexOf(po);
    el.sheetPoId.textContent = po.purchaseOrderId || "";
    el.sheetOverview.innerHTML = `
      <div class="sheet-kv"><span class="kv-label">Status</span><span class="kv-value">${escapeHtml(po.statusLabel || "—")}</span></div>
      <div class="sheet-kv"><span class="kv-label">Vendor</span><span class="kv-value">${escapeHtml(po.vendorId || "—")}</span></div>
      <div class="sheet-kv"><span class="kv-label">Destination</span><span class="kv-value">${escapeHtml(po.destinationFacilityId || "—")}</span></div>
      <div class="sheet-kv"><span class="kv-label">Lines</span><span class="kv-value">${po.lineCount ?? (po.lines || []).length} total · ${po.eligibleLineCount ?? 0} eligible</span></div>
      <div class="sheet-kv"><span class="kv-label">Unshipped qty</span><span class="kv-value">${fmtQty(po.totalUnshippedQuantity)}</span></div>
    `;
    el.sheetBody.innerHTML = renderSheetLines(po, hideShipped());
    bindSheetLineControls(po.purchaseOrderId);
    el.sheetOverlay.classList.add("visible");
    el.bottomSheet.classList.add("visible");
    updateSheetNavArrows(rows.length);
    if (el.poCardsMobile) {
      el.poCardsMobile.querySelectorAll(".po-card-item").forEach((c) => c.classList.remove("selected"));
      const active = el.poCardsMobile.querySelector(`.po-card-item[data-idx="${state.sheetPoIdx}"]`);
      if (active) active.classList.add("selected");
    }
    updateStageUi();
    if (keepScroll && el.sheetBody) el.sheetBody.scrollTop = prevScroll;
  }

  function setHideShipped(on) {
    el.hideShippedToggle.checked = !!on;
    localStorage.setItem(HIDE_SHIPPED_KEY, on ? "1" : "0");
    renderResults();
  }

  function renderSheetLines(po, hideShippedLines) {
    let lines = po.lines || [];
    if (hideShippedLines) lines = lines.filter((l) => !l.fullyShipped);
    const headerAction = headerAssignAction(po, hideShippedLines);
    const headerLabel = headerAction === "clear" ? "Clear" : "All";
    const hideToggleLabel = hideShippedLines ? "Show" : "Hide";
    const hideBtn = `<button type="button" class="btn btn-sm btn-outline-secondary" data-toggle-hide-shipped>${hideToggleLabel}</button>`;
    const headerAll = headerAction
      ? `<button type="button" class="btn btn-sm btn-outline-secondary"
          data-all-po="${escapeHtml(po.purchaseOrderId)}" data-assign-action="${headerAction}">
          ${headerLabel}</button>`
      : "";
    const headerRow = `<div class="sheet-lines-header">${hideBtn}${headerAll}</div>`;
    if (!lines.length) {
      return `${headerRow}<div style="color:var(--text-muted);padding:0.5rem 0;">No lines to show</div>`;
    }
    const cards = lines
      .map((line) => {
        const key = stageKey(line.purchaseOrderId, line.purchaseOrderLineId);
        const staged = state.staged[key];
        const disabled = !line.eligible;
        const action = lineAssignAction(line);
        const val = staged ? staged.shippedQuantity : "";
        const label = action === "clear" ? "Clear" : "All";
        const allCtrl = action
          ? `<button type="button" class="btn btn-sm btn-outline-secondary btn-full-qty"
              data-full-qty="${line.unshippedQuantity}" data-po="${line.purchaseOrderId}" data-line="${line.purchaseOrderLineId}"
              data-assign-action="${action}">${label}</button>`
          : "";
        return `<div class="sheet-line-card${disabled ? " disabled" : ""}">
          <div class="sheet-line-top">
            <span class="sheet-line-item">
              ${escapeHtml(line.itemId || "")}
              ${renderItemImage(line.itemImageUrl)}
            </span>
            <span style="font-size:0.75rem;color:var(--text-muted)">Line ${escapeHtml(line.purchaseOrderLineId)}</span>
          </div>
          <div class="sheet-line-desc">${escapeHtml(line.description || "")}</div>
          <div class="sheet-line-qtys">
            <div>Order<strong>${fmtQty(line.orderQuantity)}</strong></div>
            <div>Shipped<strong>${fmtQty(line.shippedQuantity)}</strong></div>
            <div>Unshipped<strong>${fmtQty(line.unshippedQuantity)}</strong></div>
            <div>UOM<strong>${escapeHtml(line.quantityUomId || "UNIT")}</strong></div>
          </div>
          <div class="sheet-assign-row">
            <input class="form-control form-control-sm qty-input" type="number" min="0" step="any"
              data-qty-input data-po="${line.purchaseOrderId}" data-line="${line.purchaseOrderLineId}"
              ${disabled ? "disabled" : ""} value="${val}" placeholder="Assign qty" />
            ${allCtrl}
          </div>
          ${disabled ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.35rem">${escapeHtml(line.disabledReason || "Not eligible")}</div>` : ""}
        </div>`;
      })
      .join("");
    return `${headerRow}${cards}`;
  }

  function bindSheetLineControls(poId) {
    if (!el.sheetBody) return;
    el.sheetBody.querySelectorAll("[data-toggle-hide-shipped]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setHideShipped(!hideShipped());
      });
    });
    el.sheetBody.querySelectorAll("[data-qty-input]").forEach((input) => {
      input.addEventListener("change", () => onQtyChange(input));
      input.addEventListener("input", () => onQtyChange(input));
    });
    el.sheetBody.querySelectorAll("[data-full-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const linePo = btn.getAttribute("data-po");
        const lineId = btn.getAttribute("data-line");
        const action = btn.getAttribute("data-assign-action") || "all";
        const input = el.sheetBody.querySelector(
          `input[data-qty-input][data-po="${linePo}"][data-line="${lineId}"]`
        );
        if (action === "clear") {
          if (input) input.value = "";
          delete state.staged[stageKey(linePo, lineId)];
          updateStageUi();
          syncAssignButtons(linePo);
          renderPoCards();
          return;
        }
        if (input) {
          input.value = btn.getAttribute("data-full-qty");
          onQtyChange(input);
        }
      });
    });
    el.sheetBody.querySelectorAll("[data-all-po]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-assign-action") || "all";
        if (action === "clear") clearAllForPo(poId);
        else assignAllForPo(poId);
      });
    });
    if (typeof window.bindItemImagePreview === "function") {
      delete el.sheetBody.dataset.itemImagePreviewBound;
      window.bindItemImagePreview(el.sheetBody);
    }
  }

  function closeBottomSheet() {
    if (el.sheetOverlay) el.sheetOverlay.classList.remove("visible");
    if (el.bottomSheet) el.bottomSheet.classList.remove("visible");
    if (el.poCardsMobile) {
      el.poCardsMobile.querySelectorAll(".po-card-item").forEach((c) => c.classList.remove("selected"));
    }
    state.sheetPoIdx = -1;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderItemImage(url) {
    const src = (url || "").trim();
    if (!src) return "";
    const safe = escapeHtml(src);
    return `<span class="item-image-wrap item-image-wrap--inline" data-image-url="${safe}">
      <img class="item-image-thumb" src="${safe}" alt="" loading="lazy" decoding="async"
        onerror="this.closest('.item-image-wrap')?.remove()" />
    </span>`;
  }

  function lineAssignAction(line) {
    const unshipped = Number(line.unshippedQuantity);
    if (!line.eligible || !(unshipped > 0)) return null;
    const key = stageKey(line.purchaseOrderId, line.purchaseOrderLineId);
    const staged = state.staged[key];
    const assigned = staged ? Number(staged.shippedQuantity) : 0;
    if (assigned > 0 && assigned === unshipped) return "clear";
    return "all";
  }

  function assignableLines(po, hideShippedLines) {
    let lines = po.lines || [];
    if (hideShippedLines) lines = lines.filter((l) => !l.fullyShipped);
    return lines.filter((l) => l.eligible && Number(l.unshippedQuantity) > 0);
  }

  function headerAssignAction(po, hideShippedLines) {
    const lines = assignableLines(po, hideShippedLines);
    if (!lines.length) return null;
    return lines.every((l) => lineAssignAction(l) === "clear") ? "clear" : "all";
  }

  function applyAssignButtonState(btn, action) {
    if (!btn || !action) return;
    btn.setAttribute("data-assign-action", action);
    btn.textContent = action === "clear" ? "Clear" : "All";
    btn.title =
      action === "clear"
        ? "Clear assigned quantity"
        : "Assign full unshipped";
  }

  function syncAssignButtons(poId) {
    const po = state.purchaseOrders.find((p) => p.purchaseOrderId === poId);
    if (!po) return;
    const hide = hideShipped();
    const scopes = [el.poBody, el.sheetBody].filter(Boolean);
    (po.lines || []).forEach((line) => {
      if (hide && line.fullyShipped) return;
      const action = lineAssignAction(line);
      scopes.forEach((scope) => {
        const btn = scope.querySelector(
          `button[data-full-qty][data-po="${CSS.escape(poId)}"][data-line="${CSS.escape(String(line.purchaseOrderLineId))}"]`
        );
        if (btn && action) applyAssignButtonState(btn, action);
      });
    });
    const headerAction = headerAssignAction(po, hide);
    scopes.forEach((scope) => {
      const headerBtn = scope.querySelector(
        `button[data-all-po="${CSS.escape(poId)}"]`
      );
      if (headerBtn && headerAction) applyAssignButtonState(headerBtn, headerAction);
    });
  }

  function setQtyInputsForPo(poId, lineId, value) {
    const selector = `input[data-qty-input][data-po="${poId}"][data-line="${lineId}"]`;
    [el.poBody, el.sheetBody].filter(Boolean).forEach((scope) => {
      const input = scope.querySelector(selector);
      if (input) input.value = value;
    });
  }

  function assignAllForPo(poId) {
    const po = state.purchaseOrders.find((p) => p.purchaseOrderId === poId);
    if (!po) return;
    (po.lines || []).forEach((line) => {
      if (!line.eligible) return;
      const key = stageKey(line.purchaseOrderId, line.purchaseOrderLineId);
      const qty = Number(line.unshippedQuantity);
      if (!(qty > 0)) return;
      state.staged[key] = {
        purchaseOrderId: line.purchaseOrderId,
        purchaseOrderLineId: line.purchaseOrderLineId,
        itemId: line.itemId,
        description: line.description,
        itemImageUrl: line.itemImageUrl || "",
        quantityUomId: line.quantityUomId || "UNIT",
        vendorId: line.vendorId || poVendor(poId),
        shippedQuantity: qty,
        unshippedQuantity: line.unshippedQuantity,
      };
      setQtyInputsForPo(poId, line.purchaseOrderLineId, String(qty));
    });
    updateStageUi();
    syncAssignButtons(poId);
    renderPoCards();
  }

  function clearAllForPo(poId) {
    const po = state.purchaseOrders.find((p) => p.purchaseOrderId === poId);
    if (!po) return;
    (po.lines || []).forEach((line) => {
      const key = stageKey(line.purchaseOrderId, line.purchaseOrderLineId);
      delete state.staged[key];
      setQtyInputsForPo(poId, line.purchaseOrderLineId, "");
    });
    updateStageUi();
    syncAssignButtons(poId);
    renderPoCards();
  }

  function renderLinesPanel(po, hideShippedLines) {
    let lines = po.lines || [];
    if (hideShippedLines) {
      lines = lines.filter((l) => !l.fullyShipped);
    }
    if (!lines.length) {
      return `<div style="color:var(--text-muted)">No lines to show</div>`;
    }
    const headerAction = headerAssignAction(po, hideShippedLines);
    const rows = lines
      .map((line) => {
        const key = stageKey(line.purchaseOrderId, line.purchaseOrderLineId);
        const staged = state.staged[key];
        const disabled = !line.eligible;
        const action = lineAssignAction(line);
        const val = staged ? staged.shippedQuantity : "";
        const label = action === "clear" ? "Clear" : "All";
        const title =
          action === "clear" ? "Clear assigned quantity" : "Assign full unshipped";
        const allCtrl = action
          ? `<button type="button" class="btn btn-outline-secondary btn-full-qty"
              data-full-qty="${line.unshippedQuantity}" data-po="${line.purchaseOrderId}" data-line="${line.purchaseOrderLineId}"
              data-assign-action="${action}" title="${title}">${label}</button>`
          : `<span class="btn-full-qty-spacer" aria-hidden="true"></span>`;
        return `<tr class="${disabled ? "line-disabled" : ""}">
          <td class="col-line">${escapeHtml(line.purchaseOrderLineId)}</td>
          <td class="col-item"><span class="item-cell"><span>${escapeHtml(line.itemId || "")}</span>${renderItemImage(line.itemImageUrl)}</span></td>
          <td class="col-desc" title="${escapeHtml(line.description || "")}">${escapeHtml(line.description || "")}</td>
          <td class="col-qty">${fmtQty(line.orderQuantity)}</td>
          <td class="col-qty">${fmtQty(line.shippedQuantity)}</td>
          <td class="col-qty">${fmtQty(line.unshippedQuantity)}</td>
          <td class="assign-cell">
            <div class="assign-row">
              <input class="form-control qty-input" type="number" min="0" step="any"
                data-qty-input data-po="${line.purchaseOrderId}" data-line="${line.purchaseOrderLineId}"
                ${disabled ? "disabled" : ""} value="${val}" placeholder="0" />
              ${allCtrl}
            </div>
          </td>
          <td class="col-uom">${line.quantityUomId || "UNIT"}</td>
          <td class="col-elig">${disabled ? line.disabledReason || "N/A" : "Eligible"}</td>
        </tr>`;
      })
      .join("");
    const headerLabel = headerAction === "clear" ? "Clear" : "All";
    const headerTitle =
      headerAction === "clear"
        ? "Clear assigned quantity for all lines"
        : "Assign full unshipped for all eligible lines";
    const headerAll = headerAction
      ? `<button type="button" class="btn btn-outline-secondary btn-full-qty"
          data-all-po="${po.purchaseOrderId}" data-assign-action="${headerAction}"
          title="${headerTitle}">${headerLabel}</button>`
      : `<span class="btn-full-qty-spacer" aria-hidden="true"></span>`;
    return `<table class="lines-table">
      <thead><tr>
        <th class="col-line">Line</th>
        <th class="col-item">Item</th>
        <th class="col-desc">Description</th>
        <th class="col-qty">Order</th>
        <th class="col-qty">Shipped</th>
        <th class="col-qty">Unshipped</th>
        <th class="assign-col">
          <div class="assign-row">
            <span class="assign-label">Assign</span>
            ${headerAll}
          </div>
        </th>
        <th class="col-uom">UOM</th>
        <th class="col-elig"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function findLine(poId, lineId) {
    const po = state.purchaseOrders.find((p) => p.purchaseOrderId === poId);
    if (!po) return null;
    return (po.lines || []).find((l) => l.purchaseOrderLineId === lineId) || null;
  }

  function onQtyChange(input) {
    const poId = input.getAttribute("data-po");
    const lineId = input.getAttribute("data-line");
    const line = findLine(poId, lineId);
    if (!line || !line.eligible) return;
    const raw = String(input.value || "").trim();
    const key = stageKey(poId, lineId);
    if (!raw) {
      delete state.staged[key];
      updateStageUi();
      syncAssignButtons(poId);
      setQtyInputsForPo(poId, lineId, "");
      renderPoCards();
      return;
    }
    const qty = Number(raw);
    if (!(qty > 0)) {
      delete state.staged[key];
      updateStageUi();
      syncAssignButtons(poId);
      setQtyInputsForPo(poId, lineId, "");
      renderPoCards();
      return;
    }
    if (qty > Number(line.unshippedQuantity)) {
      input.value = String(line.unshippedQuantity);
      return onQtyChange(input);
    }
    state.staged[key] = {
      purchaseOrderId: line.purchaseOrderId,
      purchaseOrderLineId: line.purchaseOrderLineId,
      itemId: line.itemId,
      description: line.description,
      itemImageUrl: line.itemImageUrl || "",
      quantityUomId: line.quantityUomId || "UNIT",
      vendorId: line.vendorId || poVendor(poId),
      shippedQuantity: qty,
      unshippedQuantity: line.unshippedQuantity,
    };
    setQtyInputsForPo(poId, lineId, String(qty));
    updateStageUi();
    syncAssignButtons(poId);
    renderPoCards();
  }

  function stagedList() {
    return Object.values(state.staged);
  }

  function updateStageUi() {
    const list = stagedList();
    const total = list.reduce((s, r) => s + Number(r.shippedQuantity || 0), 0);
    const label = list.length
      ? fmtLineCount(list.length) + " assigned · total qty " + fmtQty(total)
      : "No lines assigned";
    const disabled = !list.length;
    el.stageStatus.textContent = label;
    el.createAsnBtn.disabled = disabled;
    if (el.sheetStageStatus) el.sheetStageStatus.textContent = label;
    if (el.sheetCreateAsnBtn) el.sheetCreateAsnBtn.disabled = disabled;
  }

  function openModal(node) {
    node.classList.add("visible");
  }
  function closeModal(node) {
    node.classList.remove("visible");
  }

  async function openCreateConfirm() {
    const lines = stagedList();
    if (!lines.length) return;
    setBusy(true, "Reserving ASN number…");
    try {
      const data = await api("preview_asn", {
        org: state.org,
        token: state.token,
        location: state.facility,
        facility: state.facility,
        edd: todayIso(),
        lines,
      });
      if (!data.success) {
        alert(data.error || "Could not preview ASN");
        return;
      }
      state.preview = data;
      el.confirmHead.textContent = "Create ASN " + data.asnId;
      el.confirmBody.innerHTML = `
        <div class="mb-3">
          <label class="form-label">Destination Facility</label>
          <input class="form-control" id="confirmFacility" value="${data.facility || state.facility}" />
        </div>
        <div class="mb-3">
          <label class="form-label">Estimated Delivery Date</label>
          <input class="form-control" id="confirmEdd" type="date" value="${(data.edd || todayIso()).slice(0, 10)}" />
        </div>
        <p class="mb-2" style="color:var(--text-secondary)">
          ${fmtLineCount(data.lineCount)} · total qty ${fmtQty(data.totalQuantity)}
          ${data.vendorId ? " · vendor " + data.vendorId : ""}
        </p>
        <table class="summary-table">
          <thead><tr><th>PO</th><th>Line</th><th>Item</th><th>Qty</th></tr></thead>
          <tbody>
            ${lines
              .map((l) => {
                return `<tr>
                  <td>${escapeHtml(l.purchaseOrderId)}</td>
                  <td>${escapeHtml(l.purchaseOrderLineId)}</td>
                  <td><span class="item-cell"><span>${escapeHtml(l.itemId || "")}</span>${renderItemImage(l.itemImageUrl)}</span></td>
                  <td>${fmtQty(l.shippedQuantity)}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>`;
      openModal(el.confirmModal);
      if (typeof window.bindItemImagePreview === "function") {
        delete el.confirmBody.dataset.itemImagePreviewBound;
        window.bindItemImagePreview(el.confirmBody);
      }
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreate() {
    if (!state.preview) return;
    const facility =
      (document.getElementById("confirmFacility") || {}).value || state.preview.facility;
    const edd =
      (document.getElementById("confirmEdd") || {}).value || state.preview.edd;
    setBusy(true, "Creating ASN…");
    closeModal(el.confirmModal);
    try {
      const data = await api("create_asn", {
        org: state.org,
        token: state.token,
        location: facility,
        facility,
        edd,
        asnId: state.preview.asnId,
        lines: stagedList(),
      });
      const ok = !!data.success;
      el.resultsHead.className = "modal-head " + (ok ? "success" : "error");
      el.resultsHead.textContent = ok ? "ASN Created" : "Create Failed";
      const steps = (data.steps || [])
        .map(
          (s) =>
            `<tr><td>${s.step}</td><td>${s.statusCode}</td><td>${s.ok ? "OK" : "FAIL"}</td></tr>`
        )
        .join("");
      el.resultsBody.innerHTML = `
        <p>${ok ? data.message || "Success" : data.error || "Failed"}</p>
        <p><strong>ASN:</strong> ${data.asnId || state.preview.asnId}</p>
        <p><strong>Facility:</strong> ${data.facility || facility}</p>
        <p><strong>EDD:</strong> ${data.edd || edd}</p>
        ${steps ? `<table class="summary-table"><thead><tr><th>Step</th><th>HTTP</th><th></th></tr></thead><tbody>${steps}</tbody></table>` : ""}
      `;
      if (ok) {
        state.staged = {};
        state.preview = null;
        updateStageUi();
        renderPoCards();
      }
      openModal(el.resultsModal);
    } catch (e) {
      el.resultsHead.className = "modal-head error";
      el.resultsHead.textContent = "Create Failed";
      el.resultsBody.innerHTML = `<p>${e.message || String(e)}</p>`;
      openModal(el.resultsModal);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAfterResults() {
    closeModal(el.resultsModal);
    const poIds = state.purchaseOrders.map((p) => p.purchaseOrderId);
    if (!poIds.length) {
      showFilters();
      return;
    }
    setBusy(true, "Refreshing POs…");
    try {
      const data = await api("load_pos", {
        org: state.org,
        token: state.token,
        location: state.facility,
        purchaseOrderIds: poIds,
      });
      if (data.success) {
        state.purchaseOrders = data.purchaseOrders || [];
        pruneStaged();
        renderResults();
        updateStageUi();
        el.resultsStatus.textContent =
          fmtPoCount(state.purchaseOrders.length) + " refreshed";
      }
    } catch (_) {
      /* keep current */
    } finally {
      setBusy(false);
    }
  }

  // Themes
  const themeModal = new bootstrap.Modal(document.getElementById("themeModal"));
  if (window.InspectionThemes) {
    window.InspectionThemes.wireThemePicker({
      themeSelectorBtn: el.themeSelectorBtn,
      themeModal,
      themeList: el.themeList,
      themeLogo: el.themeLogo,
    });
  }

  // Events
  el.org.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      authenticate(el.org.value);
    }
  });
  if (el.authBtn) {
    el.authBtn.addEventListener("click", () => authenticate(el.org.value));
  }
  el.criteria.addEventListener("input", updateLoadButton);
  el.criteria.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !el.loadPosBtn.disabled) loadPos();
  });
  el.loadPosBtn.addEventListener("click", loadPos);
  el.backToFilters.addEventListener("click", showFilters);
  el.hideShippedToggle.checked = localStorage.getItem(HIDE_SHIPPED_KEY) === "1";
  el.hideShippedToggle.addEventListener("change", () => {
    setHideShipped(el.hideShippedToggle.checked);
  });
  el.colConfigBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    el.colConfigPopover.classList.toggle("visible");
    if (el.colConfigPopover.classList.contains("visible")) renderColConfig();
  });
  document.addEventListener("click", (e) => {
    if (!el.colConfigPopover.contains(e.target) && e.target !== el.colConfigBtn) {
      el.colConfigPopover.classList.remove("visible");
    }
  });
  el.resetColumns.addEventListener("click", () => {
    columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
    state.sortKey = "purchaseOrderId";
    state.sortAsc = true;
    localStorage.removeItem(COL_STORAGE_KEY);
    renderColConfig();
    renderResults();
  });
  el.createAsnBtn.addEventListener("click", openCreateConfirm);
  if (el.sheetCreateAsnBtn) {
    el.sheetCreateAsnBtn.addEventListener("click", openCreateConfirm);
  }
  if (el.sheetPrev) {
    el.sheetPrev.addEventListener("click", () => {
      const rows = sortedPos();
      if (state.sheetPoIdx > 0) showBottomSheet(rows[state.sheetPoIdx - 1], state.sheetPoIdx - 1);
    });
  }
  if (el.sheetNext) {
    el.sheetNext.addEventListener("click", () => {
      const rows = sortedPos();
      if (state.sheetPoIdx < rows.length - 1) {
        showBottomSheet(rows[state.sheetPoIdx + 1], state.sheetPoIdx + 1);
      }
    });
  }
  if (el.sheetClose) el.sheetClose.addEventListener("click", closeBottomSheet);
  if (el.sheetOverlay) el.sheetOverlay.addEventListener("click", closeBottomSheet);
  el.confirmCancel.addEventListener("click", () => {
    state.preview = null;
    closeModal(el.confirmModal);
  });
  el.confirmCreate.addEventListener("click", confirmCreate);
  el.resultsOk.addEventListener("click", refreshAfterResults);

  restoreColumns();
  updateLoadButton();
  api("app_opened", {}).catch(() => {});

  // URL boot: Organization/org, PO/criteria (; or , for multiple), Location/Facility, Theme=N
  const params = new URLSearchParams(window.location.search);

  function firstParam(keys) {
    for (const key of keys) {
      const v = params.get(key);
      if (v && String(v).trim()) return String(v).trim();
    }
    return "";
  }

  function normalizeCriteriaParam(raw) {
    // Keep tokens; allow ; , and whitespace as separators (same as search box).
    return String(raw || "")
      .trim()
      .replace(/[,;]+/g, ";")
      .replace(/\s*;\s*/g, ";")
      .replace(/;+/g, ";")
      .replace(/^;|;$/g, "");
  }

  const autoOrg = firstParam(["Organization", "org", "organization"]);
  const urlCriteria = normalizeCriteriaParam(
    firstParam([
      "PO",
      "po",
      "PurchaseOrder",
      "purchaseOrder",
      "Pos",
      "POs",
      "criteria",
      "Criteria",
    ])
  );
  const urlFacility = firstParam([
    "Location",
    "location",
    "Facility",
    "facility",
  ]).toUpperCase();

  let urlBootApplied = false;
  async function applyUrlBootOptions() {
    if (urlBootApplied) return;
    urlBootApplied = true;
    if (urlFacility) state.facility = urlFacility;
    if (!urlCriteria) return;
    el.criteria.value = urlCriteria.replace(/;/g, "; ");
    updateLoadButton();
    if (!el.loadPosBtn.disabled) await loadPos();
  }

  // Query Theme=N hides picker like other apps
  if ((params.get("Theme") || "").toLowerCase() === "n") {
    el.themeSelectorBtn.style.display = "none";
  }

  // Prompt for ORG unless Organization (or alias) is in the URL.
  // Local .token is gitignored and never shipped to Vercel; OAuth env is used there.
  (async function bootAuth() {
    if (!autoOrg) {
      el.org.value = "";
      el.orgSection.style.display = "block";
      el.mainUI.style.display = "none";
      el.org.focus();
      setStatus("Enter ORG and press Enter to authenticate", "");
      return;
    }
    el.org.value = autoOrg.toUpperCase();
    setBusy(true, "Authenticating…");
    setStatus("Authenticating…");
    const ok = await authenticate(autoOrg, { quiet: true });
    setBusy(false);
    if (!ok) {
      el.orgSection.style.display = "block";
      el.mainUI.style.display = "none";
      el.org.focus();
      setStatus("Enter ORG and press Enter to authenticate", "");
    }
  })();
})();
