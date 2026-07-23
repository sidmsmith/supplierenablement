/* Supplier Enablement — full-screen UI */
(function () {
  const state = {
    org: "",
    token: "",
    facility: "",
    preloadEntries: [],
    purchaseOrders: [],
    expanded: {},
    asnsExpanded: {}, // purchaseOrderId -> show ASN list under PO lines
    staged: {}, // key: poId|lineId -> { line payload + assignQty }
    preview: null,
    lastAsn: null, // { asnId, facility, edd } after successful create
    lastLpns: [], // enriched iLPNs after create_lpns (for label PDF)
    lastExpectedLpnCount: 0,
    lpnLines: [],
    lpnFocusPoId: "", // when opening LPN modal from a PO context
    asnsByPo: {}, // purchaseOrderId -> asn summary[] (undefined = not loaded)
    asnLoading: {}, // purchaseOrderId -> true while fetching
    asnLoadError: {}, // purchaseOrderId -> error string
    apptContext: null, // { asnId, facility, focusPoId }
    apptMonth: null, // Date at first of visible month
    apptSelectedDate: "", // YYYY-MM-DD
    apptSlots: [],
    apptSelectedSlot: null,
    apptSlotsReqId: 0,
    apptTypeId: "DROP_UNLOAD",
    apptEquipmentId: "48FT",
    apptEquipmentTypes: null, // null = not loaded; [] or [{id,description}]
    // === EXPERIMENTAL: calendar day heatmap — delete these + related helpers if unwanted ===
    apptDayColors: {}, // YYYY-MM-DD -> open|green|yellow|red
    apptDayColorsLoaded: {}, // "YYYY-M" -> true once fetched
    apptDayColorsInFlight: {}, // "YYYY-M" -> Promise
    // === END EXPERIMENTAL: calendar day heatmap ===
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
    resultsScheduleAppt: document.getElementById("resultsScheduleAppt"),
    resultsCreateLpns: document.getElementById("resultsCreateLpns"),
    resultsDownloadLabels: document.getElementById("resultsDownloadLabels"),
    lpnModal: document.getElementById("lpnModal"),
    lpnHead: document.getElementById("lpnHead"),
    lpnBody: document.getElementById("lpnBody"),
    lpnCancel: document.getElementById("lpnCancel"),
    lpnCreateBtn: document.getElementById("lpnCreateBtn"),
    apptModal: document.getElementById("apptModal"),
    apptHead: document.getElementById("apptHead"),
    apptBody: document.getElementById("apptBody"),
    apptCancel: document.getElementById("apptCancel"),
    apptBookBtn: document.getElementById("apptBookBtn"),
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
      state.asnsExpanded = {};
      state.asnsByPo = {};
      state.asnLoading = {};
      state.asnLoadError = {};
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

    bindAsnSectionControls(el.poBody);

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
    el.sheetBody.innerHTML =
      renderSheetLines(po, hideShipped()) + renderAsnSection(po.purchaseOrderId, true);
    bindSheetLineControls(po.purchaseOrderId);
    bindAsnSectionControls(el.sheetBody);
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

  function clearAsnCacheForPos(poIds) {
    (poIds || []).forEach((id) => {
      if (!id) return;
      delete state.asnsByPo[id];
      delete state.asnLoading[id];
      delete state.asnLoadError[id];
    });
  }

  function refreshOpenPoViews(poId) {
    if (state.expanded[poId]) renderPoTable();
    if (sheetIsOpen() && state.sheetPoIdx >= 0) {
      const rows = sortedPos();
      const po = rows[state.sheetPoIdx];
      if (po && po.purchaseOrderId === poId && el.sheetBody) {
        const prevScroll = el.sheetBody.scrollTop;
        el.sheetBody.innerHTML =
          renderSheetLines(po, hideShipped()) + renderAsnSection(po.purchaseOrderId, true);
        bindSheetLineControls(po.purchaseOrderId);
        bindAsnSectionControls(el.sheetBody);
        el.sheetBody.scrollTop = prevScroll;
        return;
      }
    }
    renderPoCards();
  }

  async function ensureAsnsForPo(poId, force) {
    if (!poId || !state.token) return;
    if (!force && Object.prototype.hasOwnProperty.call(state.asnsByPo, poId)) return;
    if (state.asnLoading[poId]) return;
    state.asnLoading[poId] = true;
    delete state.asnLoadError[poId];
    refreshOpenPoViews(poId);
    try {
      const data = await api("list_asns_for_po", {
        org: state.org,
        token: state.token,
        location: state.facility,
        purchaseOrderId: poId,
      });
      if (!data.success) {
        state.asnLoadError[poId] = data.error || "Could not load ASNs";
        state.asnsByPo[poId] = [];
      } else {
        state.asnsByPo[poId] = data.asns || [];
        delete state.asnLoadError[poId];
      }
      const po = (state.purchaseOrders || []).find((p) => p.purchaseOrderId === poId);
      if (po) po.hasAsns = (state.asnsByPo[poId] || []).length > 0;
    } catch (e) {
      state.asnLoadError[poId] = e.message || String(e);
      state.asnsByPo[poId] = [];
    } finally {
      delete state.asnLoading[poId];
      refreshOpenPoViews(poId);
    }
  }

  function fmtAsnEdd(raw) {
    if (raw == null || raw === "") return "—";
    const s = String(raw).trim();
    if (!s) return "—";
    // Prefer yyyy-MM-dd from ISO / date strings
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${mo}-${day}`;
    }
    return s;
  }

  function renderAsnSection(poId, mobile) {
    const loaded = Object.prototype.hasOwnProperty.call(state.asnsByPo, poId);
    const asns = state.asnsByPo[poId] || [];
    const po = (state.purchaseOrders || []).find((p) => p.purchaseOrderId === poId);
    const knownEmpty = loaded && !asns.length && !state.asnLoading[poId] && !state.asnLoadError[poId];
    const knownHas =
      (loaded && asns.length > 0) ||
      (!loaded && !!(po && po.hasAsns));
    // Hide toggle entirely when this PO has no ASNs.
    if (!knownHas && !state.asnsExpanded[poId] && !state.asnLoading[poId]) {
      return "";
    }
    if (knownEmpty) {
      if (po) po.hasAsns = false;
      state.asnsExpanded[poId] = false;
      return "";
    }

    const open = !!state.asnsExpanded[poId];
    const chevron = `<span class="chevron asn-toggle-chevron ${open ? "open" : ""}">▶</span>`;
    const toggle = `<button type="button" class="asn-section-toggle" data-asn-toggle="${escapeHtml(poId)}">
      ${chevron}
      <span class="asn-section-title">ASNs for this PO</span>
    </button>`;
    if (!open) {
      return `<div class="asn-section" data-asn-section="${escapeHtml(poId)}">${toggle}</div>`;
    }

    const loading = !!state.asnLoading[poId];
    const err = state.asnLoadError[poId];
    let body = "";
    if (loading && !loaded) {
      body = `<div class="asn-loading">Loading ASNs…</div>`;
    } else if (err) {
      body = `<div class="asn-error">${escapeHtml(err)}
        <button type="button" class="btn btn-sm btn-outline-secondary ms-2" data-asn-refresh="${escapeHtml(poId)}">Retry</button>
      </div>`;
    } else if (loaded) {
      body = asns
        .map((asn) => (mobile ? renderAsnSheetBlock(asn, poId) : renderAsnDesktopBlock(asn, poId)))
        .join("");
      if (loading) body += `<div class="asn-loading mt-1">Refreshing…</div>`;
    } else {
      body = `<div class="asn-loading">Loading ASNs…</div>`;
    }
    return `<div class="asn-section" data-asn-section="${escapeHtml(poId)}">
      ${toggle}
      <div class="asn-section-body">${body}</div>
    </div>`;
  }

  function renderAsnLineRows(asn, poId) {
    return (asn.lines || [])
      .map((line) => {
        const linked = !!line.linkedToPo || line.purchaseOrderId === poId;
        const chip = line.purchaseOrderId
          ? `<span class="po-chip">${escapeHtml(line.purchaseOrderId)}</span>`
          : "";
        return `<tr class="${linked ? "asn-line-linked" : "asn-line-other"}">
          <td>${chip}</td>
          <td>${escapeHtml(line.purchaseOrderLineId || "")}</td>
          <td class="col-item"><span class="item-cell"><span>${escapeHtml(line.itemId || "")}</span>${renderItemImage(line.itemImageUrl)}</span></td>
          <td title="${escapeHtml(line.description || "")}">${escapeHtml(line.description || "")}</td>
          <td>${fmtQty(line.shippedQuantity)} ${escapeHtml(line.quantityUomId || "")}</td>
        </tr>`;
      })
      .join("");
  }

  function renderAsnActions(asn, poId) {
    const hasLpns = (asn.existingLpnCount || 0) > 0;
    const hasAppt = !!(asn.appointmentId || "").trim();
    const labelsBtn = hasLpns
      ? `<button type="button" class="btn btn-sm btn-outline-primary" data-asn-labels
          data-asn-id="${escapeHtml(asn.asnId)}" data-facility="${escapeHtml(asn.facilityId || "")}"
          data-focus-po="${escapeHtml(poId)}">Download Labels</button>`
      : "";
    const scheduleBtn = hasAppt
      ? ""
      : `<button type="button" class="btn btn-sm btn-outline-secondary" data-asn-schedule
        data-asn-id="${escapeHtml(asn.asnId)}" data-facility="${escapeHtml(asn.facilityId || "")}"
        data-edd="${escapeHtml(fmtAsnEdd(asn.estimatedDeliveryDate))}"
        data-focus-po="${escapeHtml(poId)}">Schedule Appointment</button>`;
    return `<div class="asn-block-actions">
      ${scheduleBtn}
      <button type="button" class="btn btn-sm btn-outline-secondary" data-asn-create-lpns
        data-asn-id="${escapeHtml(asn.asnId)}" data-facility="${escapeHtml(asn.facilityId || "")}"
        data-focus-po="${escapeHtml(poId)}">Create LPNs</button>
      ${labelsBtn}
    </div>`;
  }

  function renderAsnApptMeta(asn) {
    const apptId = (asn.appointmentId || "").trim();
    return apptId ? `<span>Appt: ${escapeHtml(apptId)}</span>` : "";
  }

  function renderAsnDesktopBlock(asn, poId) {
    const lines = renderAsnLineRows(asn, poId);
    return `<div class="asn-block" data-asn-id="${escapeHtml(asn.asnId)}">
      <div class="asn-block-head">
        <div>
          <div class="asn-block-id-row">
            <span class="asn-block-id">${escapeHtml(asn.asnId)}</span>
            <span class="asn-status-chip">${escapeHtml(asn.statusLabel || asn.asnStatus || "—")}</span>
          </div>
          <div class="asn-block-meta">
            <span>${escapeHtml(asn.facilityId || "")}</span>
            ${asn.vendorId ? `<span>Vendor ${escapeHtml(asn.vendorId)}</span>` : ""}
            <span>Estimated Delivery Date: ${escapeHtml(fmtAsnEdd(asn.estimatedDeliveryDate))}</span>
            ${renderAsnApptMeta(asn)}
            <span>${fmtLpnCount(asn.existingLpnCount || 0)}</span>
          </div>
        </div>
        ${renderAsnActions(asn, poId)}
      </div>
      ${
        lines
          ? `<table class="asn-lines-table">
              <thead><tr><th>PO</th><th>Line</th><th>Item</th><th>Description</th><th>Qty</th></tr></thead>
              <tbody>${lines}</tbody>
            </table>`
          : `<div class="asn-empty" style="padding:0.5rem 0.75rem;">No AsnLine detail</div>`
      }
    </div>`;
  }

  function renderAsnSheetBlock(asn, poId) {
    const lineCards = (asn.lines || [])
      .map((line) => {
        const linked = !!line.linkedToPo || line.purchaseOrderId === poId;
        return `<div class="asn-sheet-line ${linked ? "asn-line-linked" : "asn-line-other"}">
          <span class="po-chip">${escapeHtml(line.purchaseOrderId || "—")}</span>
          <strong>${escapeHtml(line.itemId || "")}</strong>
          <span>${fmtQty(line.shippedQuantity)} ${escapeHtml(line.quantityUomId || "")}</span>
          <span style="color:var(--text-muted)">${escapeHtml(line.description || "")}</span>
        </div>`;
      })
      .join("");
    return `<div class="asn-sheet-card" data-asn-id="${escapeHtml(asn.asnId)}">
      <div class="asn-block-head" style="background:transparent;border:0;padding:0 0 0.45rem;">
        <div>
          <div class="asn-block-id-row">
            <span class="asn-block-id">${escapeHtml(asn.asnId)}</span>
            <span class="asn-status-chip">${escapeHtml(asn.statusLabel || asn.asnStatus || "—")}</span>
          </div>
          <div class="asn-block-meta">
            <span>Estimated Delivery Date: ${escapeHtml(fmtAsnEdd(asn.estimatedDeliveryDate))}</span>
            ${renderAsnApptMeta(asn)}
            <span>${fmtLpnCount(asn.existingLpnCount || 0)}</span>
          </div>
        </div>
        ${renderAsnActions(asn, poId)}
      </div>
      ${lineCards || `<div class="asn-empty">No AsnLine detail</div>`}
    </div>`;
  }

  function bindAsnSectionControls(root) {
    if (!root) return;
    root.querySelectorAll("[data-asn-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const poId = btn.getAttribute("data-asn-toggle");
        state.asnsExpanded[poId] = !state.asnsExpanded[poId];
        if (state.asnsExpanded[poId]) ensureAsnsForPo(poId);
        refreshOpenPoViews(poId);
      });
    });
    root.querySelectorAll("[data-asn-refresh]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        ensureAsnsForPo(btn.getAttribute("data-asn-refresh"), true);
      });
    });
    root.querySelectorAll("[data-asn-schedule]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openScheduleAppointment(
          btn.getAttribute("data-asn-id"),
          btn.getAttribute("data-facility"),
          btn.getAttribute("data-focus-po"),
          btn.getAttribute("data-edd")
        );
      });
    });
    root.querySelectorAll("[data-asn-create-lpns]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCreateLpnsForAsn(
          btn.getAttribute("data-asn-id"),
          btn.getAttribute("data-facility"),
          btn.getAttribute("data-focus-po")
        );
      });
    });
    root.querySelectorAll("[data-asn-labels]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadLpnLabelsForAsn(
          btn.getAttribute("data-asn-id"),
          btn.getAttribute("data-facility")
        );
      });
    });
  }

  function renderLinesPanel(po, hideShippedLines) {
    let lines = po.lines || [];
    if (hideShippedLines) {
      lines = lines.filter((l) => !l.fullyShipped);
    }
    const asnHtml = renderAsnSection(po.purchaseOrderId, false);
    if (!lines.length) {
      return `<div style="color:var(--text-muted)">No lines to show</div>${asnHtml}`;
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
    </table>${asnHtml}`;
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

  function setResultsActionButtons({ schedule, createLpns, downloadLabels }) {
    if (el.resultsScheduleAppt) {
      el.resultsScheduleAppt.style.display = schedule ? "" : "none";
    }
    if (el.resultsCreateLpns) {
      el.resultsCreateLpns.style.display = createLpns ? "" : "none";
    }
    if (el.resultsDownloadLabels) {
      el.resultsDownloadLabels.style.display = downloadLabels ? "" : "none";
    }
  }

  function formatApiStepsTable(steps) {
    const rows = (steps || [])
      .map((s) => {
        const detail = !s.ok && s.response
          ? `<div class="text-muted" style="font-size:0.75rem;max-width:28rem;white-space:pre-wrap;word-break:break-word;">${escapeHtml(String(s.response).slice(0, 400))}</div>`
          : "";
        return `<tr>
          <td>${escapeHtml(s.step || "")}</td>
          <td>${escapeHtml(String(s.statusCode != null ? s.statusCode : ""))}</td>
          <td>${s.ok ? "OK" : "FAIL"}${detail}</td>
        </tr>`;
      })
      .join("");
    if (!rows) return "";
    return `<table class="summary-table mt-3"><thead><tr><th>Step</th><th>HTTP</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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
      const previewAsnId = state.preview.asnId;
      const data = await api("create_asn", {
        org: state.org,
        token: state.token,
        location: facility,
        facility,
        edd,
        asnId: previewAsnId,
        lines: stagedList(),
      });
      const ok = !!data.success;
      el.resultsHead.className = "modal-head " + (ok ? "success" : "error");
      el.resultsHead.textContent = ok ? "ASN Created" : "Create Failed";
      el.resultsBody.innerHTML = `
        <p>${escapeHtml(ok ? data.message || "Success" : data.error || "Failed")}</p>
        <p><strong>ASN:</strong> ${escapeHtml(data.asnId || previewAsnId)}</p>
        <p><strong>Facility:</strong> ${escapeHtml(data.facility || facility)}</p>
        <p><strong>Estimated Delivery Date:</strong> ${escapeHtml(data.edd || edd || "")}</p>
        ${ok ? "" : formatApiStepsTable(data.steps)}
      `;
      if (ok) {
        const touchedPos = [
          ...new Set(stagedList().map((s) => s.purchaseOrderId).filter(Boolean)),
        ];
        state.staged = {};
        state.preview = null;
        state.lastAsn = {
          asnId: data.asnId || previewAsnId,
          facility: data.facility || facility,
          edd: data.edd || edd,
          appointmentId: "",
        };
        state.lastLpns = [];
        state.lastExpectedLpnCount = 0;
        state.lpnFocusPoId = "";
        clearAsnCacheForPos(touchedPos);
        touchedPos.forEach((id) => {
          const po = (state.purchaseOrders || []).find((p) => p.purchaseOrderId === id);
          if (po) po.hasAsns = true;
        });
        updateStageUi();
        renderPoCards();
        setResultsActionButtons({
          schedule: true,
          createLpns: true,
          downloadLabels: false,
        });
        touchedPos.forEach((id) => {
          if (state.asnsExpanded[id]) ensureAsnsForPo(id, true);
        });
      } else {
        setResultsActionButtons({
          schedule: false,
          createLpns: false,
          downloadLabels: false,
        });
      }
      openModal(el.resultsModal);
    } catch (e) {
      el.resultsHead.className = "modal-head error";
      el.resultsHead.textContent = "Create Failed";
      el.resultsBody.innerHTML = `<p>${escapeHtml(e.message || String(e))}</p>`;
      setResultsActionButtons({
        schedule: false,
        createLpns: false,
        downloadLabels: false,
      });
      openModal(el.resultsModal);
    } finally {
      setBusy(false);
    }
  }

  function predictedLpnCount(cartonize, standard) {
    const c = Number(cartonize);
    const s = Number(standard);
    if (!(c > 0) || !(s > 0)) return 0;
    // Residual LPN allowed: 10 @ 6 → 2 LPNs (6 + 4)
    return Math.ceil(c / s);
  }

  function fmtLpnCount(n) {
    return n === 1 ? "1 LPN" : n + " LPNs";
  }

  function collectLpnFormLines() {
    return (state.lpnLines || []).map((line, idx) => {
      const cartonizeEl = el.lpnBody.querySelector(
        `[data-lpn-cartonize="${idx}"]`
      );
      const standardEl = el.lpnBody.querySelector(
        `[data-lpn-standard="${idx}"]`
      );
      const cartonize = cartonizeEl ? Number(cartonizeEl.value) : line.quantityToCartonize;
      const standard = standardEl ? Number(standardEl.value) : line.standardIlpnQuantity;
      return {
        asnLineId: line.asnLineId,
        itemId: line.itemId,
        availableQtyForLpnCreation: line.availableQtyForLpnCreation,
        shippedQuantity: line.shippedQuantity,
        quantityToCartonize: cartonize,
        standardIlpnQuantity: standard,
      };
    });
  }

  function updateLpnPredictions() {
    let total = 0;
    let valid = true;
    (state.lpnLines || []).forEach((line, idx) => {
      const cartonizeEl = el.lpnBody.querySelector(
        `[data-lpn-cartonize="${idx}"]`
      );
      const standardEl = el.lpnBody.querySelector(
        `[data-lpn-standard="${idx}"]`
      );
      const predEls = el.lpnBody.querySelectorAll(`[data-lpn-pred="${idx}"]`);
      const cartonize = cartonizeEl ? Number(cartonizeEl.value) : 0;
      const standard = standardEl ? Number(standardEl.value) : 0;
      const available = Number(line.availableQtyForLpnCreation);
      let msg = "";
      let ok = true;
      if (!(cartonize > 0) || !(standard > 0)) {
        ok = false;
        msg = "Enter qtys";
      } else if (cartonize > available) {
        ok = false;
        msg = "Over available";
      } else if (standard > cartonize) {
        ok = false;
        msg = "Std > cartonize";
      } else {
        const n = predictedLpnCount(cartonize, standard);
        total += n;
        const rem = cartonize % standard;
        msg =
          rem === 0
            ? fmtLpnCount(n)
            : fmtLpnCount(n) + " (incl. residual " + rem + ")";
      }
      if (!ok) valid = false;
      predEls.forEach((node) => {
        node.innerHTML = msg;
        node.classList.toggle("invalid", !ok);
      });
    });
    const footer = el.lpnBody.querySelector("[data-lpn-total]");
    if (footer) {
      footer.textContent = valid
        ? "Total " + fmtLpnCount(total)
        : "Fix quantities to continue";
    }
    if (el.lpnCreateBtn) el.lpnCreateBtn.disabled = !valid || !(state.lpnLines || []).length;
  }

  function renderLpnModalBody(asnId, lines) {
    if (!lines.length) {
      return `<p style="color:var(--text-muted)">No ASN lines with available quantity for LPN creation.</p>`;
    }
    const focusPo = state.lpnFocusPoId || "";
    const mobile = window.matchMedia("(max-width: 992px)").matches;
    if (mobile) {
      const cards = lines
        .map((line, idx) => {
          const focus =
            focusPo && line.purchaseOrderId === focusPo ? " lpn-line-focus" : "";
          return `<div class="lpn-mobile-card${focus}">
            <div class="sheet-line-item">${escapeHtml(line.itemId)} ${renderItemImage(line.itemImageUrl)}</div>
            <div class="sheet-line-desc">${escapeHtml(line.description || "")}</div>
            ${
              line.purchaseOrderId
                ? `<div style="font-size:0.75rem;margin:0.25rem 0;"><span class="po-chip">${escapeHtml(line.purchaseOrderId)}</span></div>`
                : ""
            }
            <div class="sheet-line-qtys" style="grid-template-columns:1fr 1fr;">
              <div>Available<strong>${fmtQty(line.availableQtyForLpnCreation)}</strong></div>
              <div>Shipped<strong>${fmtQty(line.shippedQuantity)}</strong></div>
            </div>
            <div class="lpn-assign-grid">
              <div>
                <label>Qty to cartonize</label>
                <input class="form-control form-control-sm qty-input" type="number" min="0" step="any"
                  data-lpn-cartonize="${idx}" value="${fmtQty(line.quantityToCartonize)}" />
              </div>
              <div>
                <label>Std iLPN qty</label>
                <input class="form-control form-control-sm qty-input" type="number" min="0" step="any"
                  data-lpn-standard="${idx}" value="${fmtQty(line.standardIlpnQuantity)}" />
              </div>
            </div>
            <div class="lpn-pred mt-2" data-lpn-pred="${idx}"></div>
          </div>`;
        })
        .join("");
      return `
        <p class="mb-2" style="color:var(--text-secondary)">
          ASN <strong>${escapeHtml(asnId)}</strong> · all ASN lines · set cartonize and standard iLPN quantity.
        </p>
        <div class="lpn-mobile-cards" style="display:block">${cards}</div>
        <p class="mb-0 mt-2 lpn-total" data-lpn-total></p>
      `;
    }
    const rows = lines
      .map((line, idx) => {
        const focus =
          focusPo && line.purchaseOrderId === focusPo ? " lpn-line-focus" : "";
        return `<tr class="${focus.trim()}">
          <td class="lpn-col-item col-item"><span class="item-cell"><span>${escapeHtml(line.itemId)}</span>${renderItemImage(line.itemImageUrl)}</span>
            ${line.purchaseOrderId ? `<div class="mt-1"><span class="po-chip">${escapeHtml(line.purchaseOrderId)}</span></div>` : ""}
          </td>
          <td class="lpn-col-desc" title="${escapeHtml(line.description || "")}">${escapeHtml(line.description || "")}</td>
          <td class="lpn-col-qty">${fmtQty(line.availableQtyForLpnCreation)}</td>
          <td class="lpn-col-qty">${fmtQty(line.shippedQuantity)}</td>
          <td class="lpn-col-input"><input class="form-control form-control-sm qty-input" type="number" min="0" step="any"
            data-lpn-cartonize="${idx}" value="${fmtQty(line.quantityToCartonize)}" /></td>
          <td class="lpn-col-input"><input class="form-control form-control-sm qty-input" type="number" min="0" step="any"
            data-lpn-standard="${idx}" value="${fmtQty(line.standardIlpnQuantity)}" /></td>
          <td class="lpn-col-creates"><span class="lpn-pred" data-lpn-pred="${idx}"></span></td>
        </tr>`;
      })
      .join("");
    return `
      <p class="mb-2" style="color:var(--text-secondary)">
        ASN <strong>${escapeHtml(asnId)}</strong> · all ASN lines · set cartonize and standard iLPN quantity.
      </p>
      <div style="overflow-x:auto;">
        <table class="lpn-table">
          <thead><tr>
            <th class="lpn-col-item">Item</th>
            <th class="lpn-col-desc">Description</th>
            <th class="lpn-col-qty">Available</th>
            <th class="lpn-col-qty">Shipped</th>
            <th class="lpn-col-input">Cartonize</th>
            <th class="lpn-col-input">Std iLPN</th>
            <th class="lpn-col-creates">Creates</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="mb-0 mt-2 lpn-total" data-lpn-total></p>
    `;
  }

  function isoDateLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const APPT_TYPE_OPTIONS = [
    { id: "DROP_UNLOAD", label: "Drop Unload" },
    { id: "LIVE_UNLOAD", label: "Live Unload" },
  ];

  function monthLabel(d) {
    return d.toLocaleString(undefined, { month: "long", year: "numeric" });
  }

  function updateApptBookBtn() {
    if (!el.apptBookBtn) return;
    el.apptBookBtn.disabled = !(state.apptSelectedSlot && state.apptSelectedSlot.available);
  }

  function renderApptTypeOptions() {
    const cur = state.apptTypeId || "DROP_UNLOAD";
    return APPT_TYPE_OPTIONS.map((o) => {
      const sel = o.id === cur ? " selected" : "";
      return `<option value="${escapeHtml(o.id)}"${sel}>${escapeHtml(o.label)}</option>`;
    }).join("");
  }

  function renderApptEquipmentOptions() {
    const cur = state.apptEquipmentId || "48FT";
    const types = state.apptEquipmentTypes;
    if (!types) {
      return `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>`;
    }
    const ids = new Set(types.map((t) => t.equipmentTypeId));
    let opts = types
      .map((t) => {
        const id = t.equipmentTypeId;
        const label = t.description || id;
        const sel = id === cur ? " selected" : "";
        return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
      })
      .join("");
    if (cur && !ids.has(cur)) {
      opts =
        `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>` + opts;
    }
    if (!opts) {
      opts = `<option value="48FT" selected>48FT</option>`;
    }
    return opts;
  }

  function renderApptCalendarGrid() {
    const month = state.apptMonth || new Date();
    const year = month.getFullYear();
    const mon = month.getMonth();
    const first = new Date(year, mon, 1);
    const startPad = first.getDay(); // Sun=0
    const daysInMonth = new Date(year, mon + 1, 0).getDate();
    const todayIso = isoDateLocal(new Date());
    const dows = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
      .map((d) => `<div class="appt-cal-dow">${d}</div>`)
      .join("");
    const cells = [];
    for (let i = 0; i < startPad; i++) {
      cells.push(`<button type="button" class="appt-cal-day other-month" disabled>&nbsp;</button>`);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dt = new Date(year, mon, day);
      const iso = isoDateLocal(dt);
      const selected = iso === state.apptSelectedDate ? " selected" : "";
      const today = iso === todayIso ? " today" : "";
      // === EXPERIMENTAL: calendar day heatmap class ===
      const dayColor = state.apptDayColors[iso];
      const heat = dayColor ? " day-" + dayColor : "";
      // === END EXPERIMENTAL ===
      cells.push(
        `<button type="button" class="appt-cal-day${selected}${today}${heat}" data-appt-date="${iso}">${day}</button>`
      );
    }
    return `<div class="appt-cal-nav">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-appt-month="-1" aria-label="Previous month">‹</button>
        <strong>${escapeHtml(monthLabel(month))}</strong>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-appt-month="1" aria-label="Next month">›</button>
      </div>
      <div class="appt-cal-grid">${dows}${cells.join("")}</div>
      <div class="appt-cal-today-wrap">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-appt-today>Today</button>
      </div>`;
  }

  function renderApptSlotsPanel() {
    const date = state.apptSelectedDate;
    if (!date) {
      return `<div class="appt-slots-head">Select a date</div><div class="asn-empty">Pick a day to load available times.</div>`;
    }
    const visible = (state.apptSlots || []).filter((s) => !s.full && !s.past);
    if (!visible.length) {
      return `<div class="appt-slots-head">${escapeHtml(date)}</div><div class="asn-empty">No open slots for this day.</div>`;
    }
    const rows = visible
      .map((s) => {
        const selected =
          state.apptSelectedSlot &&
          state.apptSelectedSlot.preferredDateTime === s.preferredDateTime
            ? " selected"
            : "";
        const colorClass = "slot-" + (s.color || "open");
        const meta = s.capacity
          ? `${s.totalAppointments}/${s.capacity}`
          : "—";
        return `<button type="button" class="appt-slot ${colorClass}${selected}"
            data-appt-slot="${escapeHtml(s.preferredDateTime)}"
            ${s.available ? "" : "disabled"}>
            <span>${escapeHtml(s.displayLabel)}</span>
            <span class="appt-slot-meta">${escapeHtml(meta)}</span>
          </button>`;
      })
      .join("");
    return `<div class="appt-slots-head">Times for ${escapeHtml(date)}</div>
      <div class="appt-slots">${rows}</div>
      <div class="appt-legend">
        <span class="leg-open">Open</span>
        <span class="leg-green">&lt;50%</span>
        <span class="leg-yellow">50–75%</span>
        <span class="leg-red">&gt;75%</span>
      </div>`;
  }

  function renderApptSlotsLoading(iso) {
    return `<div class="appt-slots-head">Times for ${escapeHtml(iso || "")}</div>
      <div class="appt-slots-loading">Loading times…</div>`;
  }

  function syncApptCalendarSelection(iso) {
    if (!el.apptBody) return;
    el.apptBody.querySelectorAll("[data-appt-date]").forEach((btn) => {
      btn.classList.toggle("selected", btn.getAttribute("data-appt-date") === iso);
    });
  }

  function bindApptSlotsPane() {
    if (!el.apptBody) return;
    el.apptBody.querySelectorAll("[data-appt-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-appt-slot");
        state.apptSelectedSlot =
          (state.apptSlots || []).find((s) => s.preferredDateTime === key) || null;
        const pane = el.apptBody.querySelector("[data-appt-slots-pane]");
        if (pane) {
          pane.innerHTML = renderApptSlotsPanel();
          bindApptSlotsPane();
        }
        updateApptBookBtn();
      });
    });
  }

  function renderApptModalBody() {
    const ctx = state.apptContext || {};
    return `<div class="appt-meta">
        ASN <strong>${escapeHtml(ctx.asnId || "")}</strong>
        ${ctx.facility ? " · " + escapeHtml(ctx.facility) : ""}
        <span style="color:var(--text-muted)"> · Dock 1 · 60 min</span>
      </div>
      <div class="appt-controls">
        <label class="appt-field">Type
          <select id="apptTypeSelect" aria-label="Appointment type">${renderApptTypeOptions()}</select>
        </label>
        <label class="appt-field">Equipment
          <select id="apptEquipSelect" aria-label="Equipment type">${renderApptEquipmentOptions()}</select>
        </label>
      </div>
      <div class="appt-layout">
        <div class="appt-cal-pane">${renderApptCalendarGrid()}</div>
        <div class="appt-slots-pane" data-appt-slots-pane>${renderApptSlotsPanel()}</div>
      </div>`;
  }

  function goApptCalendarToToday() {
    const now = new Date();
    const iso = isoDateLocal(now);
    state.apptMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    if (el.apptBody) {
      el.apptBody.innerHTML = renderApptModalBody();
      bindApptModalControls();
      updateApptBookBtn();
    }
    // === EXPERIMENTAL: calendar day heatmap ===
    loadApptDayColorsForVisibleMonth();
    // === END EXPERIMENTAL ===
    loadApptSlotsForDate(iso);
  }

  function bindApptTodayButton(root) {
    const scope = root || el.apptBody;
    if (!scope) return;
    scope.querySelectorAll("[data-appt-today]").forEach((btn) => {
      btn.addEventListener("click", goApptCalendarToToday);
    });
  }

  function bindApptModalControls() {
    if (!el.apptBody) return;
    const typeSel = el.apptBody.querySelector("#apptTypeSelect");
    if (typeSel) {
      typeSel.addEventListener("change", () => {
        state.apptTypeId = typeSel.value || "DROP_UNLOAD";
      });
    }
    const equipSel = el.apptBody.querySelector("#apptEquipSelect");
    if (equipSel) {
      equipSel.addEventListener("change", () => {
        state.apptEquipmentId = equipSel.value || "48FT";
      });
    }
    el.apptBody.querySelectorAll("[data-appt-month]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = parseInt(btn.getAttribute("data-appt-month"), 10) || 0;
        const cur = state.apptMonth || new Date();
        state.apptMonth = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
        el.apptBody.innerHTML = renderApptModalBody();
        bindApptModalControls();
        updateApptBookBtn();
        // === EXPERIMENTAL: calendar day heatmap ===
        loadApptDayColorsForVisibleMonth();
        // === END EXPERIMENTAL ===
      });
    });
    el.apptBody.querySelectorAll("[data-appt-date]").forEach((btn) => {
      btn.addEventListener("click", () => {
        loadApptSlotsForDate(btn.getAttribute("data-appt-date"));
      });
    });
    bindApptTodayButton(el.apptBody);
    el.apptBody.querySelectorAll("[data-appt-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-appt-slot");
        state.apptSelectedSlot =
          (state.apptSlots || []).find((s) => s.preferredDateTime === key) || null;
        const pane = el.apptBody.querySelector("[data-appt-slots-pane]");
        if (pane) {
          pane.innerHTML = renderApptSlotsPanel();
          bindApptSlotsPane();
        }
        updateApptBookBtn();
      });
    });
  }

  async function ensureEquipmentTypesLoaded() {
    if (state.apptEquipmentTypes) return;
    try {
      const data = await api("equipment_types", {
        org: state.org,
        token: state.token,
        location: (state.apptContext && state.apptContext.facility) || state.facility,
      });
      if (data.success && Array.isArray(data.types) && data.types.length) {
        state.apptEquipmentTypes = data.types;
      } else {
        state.apptEquipmentTypes = [{ equipmentTypeId: "48FT", description: "48FT" }];
      }
    } catch (e) {
      state.apptEquipmentTypes = [{ equipmentTypeId: "48FT", description: "48FT" }];
    }
    if (!state.apptEquipmentId) state.apptEquipmentId = "48FT";
    const ids = new Set(state.apptEquipmentTypes.map((t) => t.equipmentTypeId));
    if (!ids.has(state.apptEquipmentId)) {
      state.apptEquipmentId = ids.has("48FT")
        ? "48FT"
        : state.apptEquipmentTypes[0].equipmentTypeId;
    }
  }

  function parseApptEddDate(raw) {
    const iso = fmtAsnEdd(raw);
    if (!iso || iso === "—") return null;
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function apptMonthKey(year, month) {
    return year + "-" + month;
  }

  function nextApptMonth(year, month) {
    if (month >= 12) return { year: year + 1, month: 1 };
    return { year, month: month + 1 };
  }

  function prevApptMonth(year, month) {
    if (month <= 1) return { year: year - 1, month: 12 };
    return { year, month: month - 1 };
  }

  // === EXPERIMENTAL: calendar day heatmap — remove this block + CSS if unwanted ===
  function refreshApptCalendarPane() {
    if (!el.apptBody) return;
    const pane = el.apptBody.querySelector(".appt-cal-pane");
    if (!pane) return;
    pane.innerHTML = renderApptCalendarGrid();
    pane.querySelectorAll("[data-appt-month]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = parseInt(btn.getAttribute("data-appt-month"), 10) || 0;
        const cur = state.apptMonth || new Date();
        state.apptMonth = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
        el.apptBody.innerHTML = renderApptModalBody();
        bindApptModalControls();
        updateApptBookBtn();
        loadApptDayColorsForVisibleMonth();
      });
    });
    pane.querySelectorAll("[data-appt-date]").forEach((btn) => {
      btn.addEventListener("click", () => {
        loadApptSlotsForDate(btn.getAttribute("data-appt-date"));
      });
    });
    bindApptTodayButton(pane);
  }

  async function fetchApptDayColorsMonth(year, month, { applyUi } = {}) {
    if (!state.apptContext) return;
    const key = apptMonthKey(year, month);
    const runApply = () => {
      if (
        applyUi &&
        el.apptBody &&
        state.apptMonth &&
        state.apptMonth.getFullYear() === year &&
        state.apptMonth.getMonth() + 1 === month
      ) {
        refreshApptCalendarPane();
      }
    };
    if (state.apptDayColorsLoaded[key]) {
      runApply();
      return;
    }
    if (state.apptDayColorsInFlight[key]) {
      try {
        await state.apptDayColorsInFlight[key];
      } catch (e) {
        /* ignore */
      }
      runApply();
      return;
    }
    const promise = (async () => {
      const data = await api("appointment_day_colors", {
        org: state.org,
        token: state.token,
        location: state.apptContext.facility || state.facility,
        year,
        month,
      });
      if (data.success && data.colors) {
        state.apptDayColors = Object.assign({}, state.apptDayColors, data.colors);
        state.apptDayColorsLoaded[key] = true;
      }
    })();
    state.apptDayColorsInFlight[key] = promise;
    try {
      await promise;
    } catch (e) {
      /* ignore — heatmap is optional */
    } finally {
      delete state.apptDayColorsInFlight[key];
    }
    runApply();
  }

  async function loadApptDayColorsForVisibleMonth() {
    if (!state.apptContext || !state.apptMonth) return;
    const year = state.apptMonth.getFullYear();
    const month = state.apptMonth.getMonth() + 1;
    await fetchApptDayColorsMonth(year, month, { applyUi: true });
    // Prefetch adjacent months so either arrow feels instant.
    const next = nextApptMonth(year, month);
    const prev = prevApptMonth(year, month);
    fetchApptDayColorsMonth(next.year, next.month, { applyUi: false });
    fetchApptDayColorsMonth(prev.year, prev.month, { applyUi: false });
  }
  // === END EXPERIMENTAL: calendar day heatmap ===

  async function loadApptSlotsForDate(iso) {
    if (!iso || !state.apptContext) return;
    const reqId = (state.apptSlotsReqId = (state.apptSlotsReqId || 0) + 1);
    state.apptSelectedDate = iso;
    state.apptSelectedSlot = null;
    updateApptBookBtn();

    // Update selection + slots pane in place — avoid full modal re-render (height jump).
    syncApptCalendarSelection(iso);
    const pane = el.apptBody && el.apptBody.querySelector("[data-appt-slots-pane]");
    if (pane) pane.innerHTML = renderApptSlotsLoading(iso);

    try {
      const data = await api("appointment_slots", {
        org: state.org,
        token: state.token,
        location: state.apptContext.facility || state.facility,
        date: iso,
      });
      if (reqId !== state.apptSlotsReqId) return; // stale response
      if (!data.success) {
        state.apptSlots = [];
        if (pane) {
          pane.innerHTML = `<div class="appt-slots-head">${escapeHtml(iso)}</div>
            <div class="asn-error">${escapeHtml(data.error || "Could not load slots")}</div>`;
        }
        return;
      }
      state.apptSlots = data.slots || [];
      // === EXPERIMENTAL: keep heatmap in sync with latest day fetch ===
      if (data.slots && data.slots.length) {
        const ranks = { open: 0, green: 1, yellow: 2, red: 3 };
        let worst = "open";
        data.slots.forEach((s) => {
          const c = s.color || "open";
          if ((ranks[c] || 0) > (ranks[worst] || 0)) worst = c;
        });
        state.apptDayColors[iso] = worst;
        const dayBtn =
          el.apptBody &&
          el.apptBody.querySelector('[data-appt-date="' + iso + '"]');
        if (dayBtn) {
          dayBtn.classList.remove("day-open", "day-green", "day-yellow", "day-red");
          dayBtn.classList.add("day-" + worst);
        }
      }
      // === END EXPERIMENTAL ===
      if (pane) {
        pane.innerHTML = renderApptSlotsPanel();
        bindApptSlotsPane();
      }
      updateApptBookBtn();
    } catch (e) {
      if (reqId !== state.apptSlotsReqId) return;
      state.apptSlots = [];
      if (pane) {
        pane.innerHTML = `<div class="appt-slots-head">${escapeHtml(iso)}</div>
          <div class="asn-error">${escapeHtml(e.message || String(e))}</div>`;
      }
    }
  }

  async function openScheduleAppointment(asnId, facility, focusPoId, edd) {
    if (!asnId) return;
    const now = new Date();
    const eddDate =
      parseApptEddDate(edd) ||
      parseApptEddDate(state.lastAsn && state.lastAsn.asnId === asnId && state.lastAsn.edd);
    const focus = eddDate || now;
    state.apptContext = {
      asnId,
      facility: facility || state.facility,
      focusPoId: focusPoId || "",
      edd: eddDate ? isoDateLocal(eddDate) : "",
    };
    state.apptMonth = new Date(focus.getFullYear(), focus.getMonth(), 1);
    state.apptSelectedDate = isoDateLocal(focus);
    state.apptSlots = [];
    state.apptSelectedSlot = null;
    state.apptTypeId = "DROP_UNLOAD";
    state.apptEquipmentId = "48FT";
    if (el.apptHead) el.apptHead.textContent = "Schedule Appointment — " + asnId;
    if (el.apptBody) {
      el.apptBody.innerHTML = renderApptModalBody();
      bindApptModalControls();
    }
    updateApptBookBtn();
    openModal(el.apptModal);
    await ensureEquipmentTypesLoaded();
    if (el.apptBody) {
      el.apptBody.innerHTML = renderApptModalBody();
      bindApptModalControls();
    }
    // === EXPERIMENTAL: calendar day heatmap ===
    loadApptDayColorsForVisibleMonth();
    // === END EXPERIMENTAL ===
    loadApptSlotsForDate(state.apptSelectedDate);
  }

  async function confirmBookAppointment() {
    if (!state.apptSelectedSlot || !state.apptContext) return;
    const slot = state.apptSelectedSlot;
    const ctx = state.apptContext;
    const typeId = state.apptTypeId || "DROP_UNLOAD";
    const equipId = state.apptEquipmentId || "48FT";
    setBusy(true, "Scheduling appointment…");
    closeModal(el.apptModal);
    try {
      const data = await api("schedule_appointment", {
        org: state.org,
        token: state.token,
        location: ctx.facility || state.facility,
        preferredDateTime: slot.preferredDateTime,
        asnId: ctx.asnId,
        appointmentTypeId: typeId,
        equipmentTypeId: equipId,
      });
      const ok = !!data.success;
      el.resultsHead.className = "modal-head " + (ok ? "success" : "error");
      el.resultsHead.textContent = ok ? "Appointment Scheduled" : "Schedule Failed";
      el.resultsBody.innerHTML = `
        <p>${escapeHtml(ok ? data.message || "Success" : data.error || "Failed")}</p>
        <p><strong>Appointment:</strong> ${escapeHtml(data.appointmentId || "—")}</p>
        <p><strong>Time:</strong> ${escapeHtml(data.preferredDateTime || slot.preferredDateTime)}</p>
        <p><strong>Type:</strong> ${escapeHtml(data.appointmentTypeId || typeId)}
          · <strong>Equipment:</strong> ${escapeHtml(data.equipmentTypeId || equipId)}</p>
        <p><strong>ASN:</strong> ${escapeHtml(ctx.asnId || "")}
          ${data.asnAttached ? "" : '<span style="color:var(--text-muted)">(not attached)</span>'}</p>
        <p><strong>Facility:</strong> ${escapeHtml(data.facility || ctx.facility || "")}</p>
      `;
      setResultsActionButtons({
        schedule: false,
        createLpns: false,
        downloadLabels: false,
      });
      if (ok) {
        const refreshPos = [];
        if (ctx.focusPoId) refreshPos.push(ctx.focusPoId);
        Object.keys(state.asnsByPo || {}).forEach((poId) => {
          const rows = state.asnsByPo[poId] || [];
          if (rows.some((a) => a.asnId === ctx.asnId)) refreshPos.push(poId);
        });
        const uniquePos = [...new Set(refreshPos)];
        if (uniquePos.length) {
          clearAsnCacheForPos(uniquePos);
          uniquePos.forEach((id) => {
            if (state.asnsExpanded[id]) ensureAsnsForPo(id, true);
          });
        }
      }
      openModal(el.resultsModal);
    } catch (e) {
      el.resultsHead.className = "modal-head error";
      el.resultsHead.textContent = "Schedule Failed";
      el.resultsBody.innerHTML = `<p>${escapeHtml(e.message || String(e))}</p>`;
      setResultsActionButtons({
        schedule: false,
        createLpns: false,
        downloadLabels: false,
      });
      openModal(el.resultsModal);
    } finally {
      setBusy(false);
    }
  }

  async function openCreateLpnsForAsn(asnId, facility, focusPoId) {
    if (!asnId) return;
    state.lastAsn = {
      asnId,
      facility: facility || (state.lastAsn && state.lastAsn.facility) || state.facility,
      edd: (state.lastAsn && state.lastAsn.edd) || "",
    };
    state.lpnFocusPoId = focusPoId || "";
    closeModal(el.resultsModal);
    setBusy(true, "Loading ASN lines…");
    try {
      const data = await api("load_asn_for_lpn", {
        org: state.org,
        token: state.token,
        location: state.lastAsn.facility || state.facility,
        asnId: state.lastAsn.asnId,
      });
      if (!data.success) {
        alert(data.error || "Could not load ASN for LPN creation");
        return;
      }
      state.lastAsn.appointmentId = data.appointmentId || "";
      state.lpnLines = data.lines || [];
      el.lpnHead.textContent = "Create LPNs for " + state.lastAsn.asnId;
      el.lpnBody.innerHTML = renderLpnModalBody(state.lastAsn.asnId, state.lpnLines);
      el.lpnBody.querySelectorAll("[data-lpn-cartonize], [data-lpn-standard]").forEach((input) => {
        input.addEventListener("input", updateLpnPredictions);
        input.addEventListener("change", updateLpnPredictions);
      });
      if (typeof window.bindItemImagePreview === "function") {
        delete el.lpnBody.dataset.itemImagePreviewBound;
        window.bindItemImagePreview(el.lpnBody);
      }
      updateLpnPredictions();
      openModal(el.lpnModal);
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openCreateLpnsFromResults() {
    if (!state.lastAsn || !state.lastAsn.asnId) return;
    return openCreateLpnsForAsn(state.lastAsn.asnId, state.lastAsn.facility, "");
  }

  async function downloadLpnLabelsForAsn(asnId, facility) {
    if (!asnId) return;
    state.lastAsn = {
      asnId,
      facility: facility || (state.lastAsn && state.lastAsn.facility) || state.facility,
      edd: (state.lastAsn && state.lastAsn.edd) || "",
    };
    state.lastLpns = [];
    state.lastExpectedLpnCount = 0;
    return downloadLpnLabels();
  }

  async function confirmCreateLpns() {
    if (!state.lastAsn || !state.lastAsn.asnId) return;
    const lines = collectLpnFormLines();
    setBusy(true, "Creating LPNs…");
    closeModal(el.lpnModal);
    try {
      const data = await api("create_lpns", {
        org: state.org,
        token: state.token,
        location: state.lastAsn.facility || state.facility,
        asnId: state.lastAsn.asnId,
        lines,
      });
      const ok = !!data.success;
      el.resultsHead.className = "modal-head " + (ok ? "success" : "error");
      el.resultsHead.textContent = ok ? "LPNs Created" : "LPN Create Failed";
      const chips = (data.lpns || [])
        .map((l) => `<span class="lpn-id-chip">${escapeHtml(l.ilpnId)}</span>`)
        .join("");
      el.resultsBody.innerHTML = `
        <p>${escapeHtml(ok ? data.message || "Success" : data.error || "Failed")}</p>
        <p><strong>ASN:</strong> ${escapeHtml(data.asnId || state.lastAsn.asnId)}</p>
        <p><strong>Expected:</strong> ${fmtLpnCount(data.expectedLpnCount || 0)}
          · <strong>Found:</strong> ${fmtLpnCount(data.lpnCount || 0)}</p>
        ${chips ? `<div class="lpn-id-list">${chips}</div>` : ""}
        ${ok ? "" : formatApiStepsTable(data.steps)}
      `;
      if (ok && (data.lpns || []).length) {
        state.lastLpns = data.lpns || [];
        state.lastExpectedLpnCount = data.expectedLpnCount || (data.lpns || []).length;
        setResultsActionButtons({
          schedule: !state.lastAsn.appointmentId,
          createLpns: false,
          downloadLabels: true,
        });
        if (state.lpnFocusPoId) {
          clearAsnCacheForPos([state.lpnFocusPoId]);
          ensureAsnsForPo(state.lpnFocusPoId, true);
        }
      } else {
        state.lastLpns = [];
        state.lastExpectedLpnCount = data.expectedLpnCount || 0;
        const showCreate =
          ok && (data.lpnCount || 0) === 0 ? true : !ok;
        setResultsActionButtons({
          schedule: !!state.lastAsn && !state.lastAsn.appointmentId,
          createLpns: showCreate,
          downloadLabels: false,
        });
      }
      openModal(el.resultsModal);
    } catch (e) {
      el.resultsHead.className = "modal-head error";
      el.resultsHead.textContent = "LPN Create Failed";
      el.resultsBody.innerHTML = `<p>${escapeHtml(e.message || String(e))}</p>`;
      state.lastLpns = [];
      setResultsActionButtons({
        schedule: !!state.lastAsn && !state.lastAsn.appointmentId,
        createLpns: true,
        downloadLabels: false,
      });
      openModal(el.resultsModal);
    } finally {
      setBusy(false);
    }
  }

  async function downloadLpnLabels() {
    if (!state.lastAsn || !state.lastAsn.asnId) return;
    setBusy(true, "Building label PDF…");
    try {
      const data = await api("download_lpn_labels", {
        org: state.org,
        token: state.token,
        location: state.lastAsn.facility || state.facility,
        asnId: state.lastAsn.asnId,
        lpns: state.lastLpns || [],
        expectedLpnCount: state.lastExpectedLpnCount || 0,
      });
      if (!data.success || !data.pdfBase64) {
        alert(data.error || "Could not generate label PDF");
        return;
      }
      if (data.lpns && data.lpns.length) state.lastLpns = data.lpns;
      const bin = atob(data.pdfBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: data.contentType || "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename || state.lastAsn.asnId + "-labels.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e.message || String(e));
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
  if (el.resultsScheduleAppt) {
    el.resultsScheduleAppt.addEventListener("click", () => {
      if (!state.lastAsn || !state.lastAsn.asnId) return;
      closeModal(el.resultsModal);
      openScheduleAppointment(
        state.lastAsn.asnId,
        state.lastAsn.facility || state.facility,
        "",
        state.lastAsn.edd || ""
      );
    });
  }
  if (el.resultsCreateLpns) {
    el.resultsCreateLpns.addEventListener("click", openCreateLpnsFromResults);
  }
  if (el.resultsDownloadLabels) {
    el.resultsDownloadLabels.addEventListener("click", downloadLpnLabels);
  }
  if (el.lpnCancel) {
    el.lpnCancel.addEventListener("click", () => {
      closeModal(el.lpnModal);
      if (state.lastAsn) {
        setResultsActionButtons({
          schedule: !state.lastAsn.appointmentId,
          createLpns: true,
          downloadLabels: false,
        });
        openModal(el.resultsModal);
      }
    });
  }
  if (el.lpnCreateBtn) {
    el.lpnCreateBtn.addEventListener("click", confirmCreateLpns);
  }
  if (el.apptCancel) {
    el.apptCancel.addEventListener("click", () => closeModal(el.apptModal));
  }
  if (el.apptBookBtn) {
    el.apptBookBtn.addEventListener("click", confirmBookAppointment);
  }

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
