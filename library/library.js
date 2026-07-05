// Fab Library Browser — search, filter, version selection, download trigger
import { downloadAsset } from '../vendor/fab-download-browser.js';
import { debug } from '../lib/debug.js';

const $ = (sel, parent = document) => parent.querySelector(sel);
const $$ = (sel, parent = document) => [...parent.querySelectorAll(sel)];

// ==================== State ====================
let allItems = [];
let engineVersions = new Set();

/** Active downloads: key = `${assetId}::${artifactId}` */
const activeDownloads = new Map();

function downloadKey(assetId, artifactId) {
  return `${assetId}::${artifactId}`;
}

// ==================== Type badge mapping ====================
const TYPE_BADGES = {
  "3D":                { cls: "badge-blue",   label: "3D" },
  "工具与插件":         { cls: "badge-purple", label: "Plugin" },
  "COMPLETE_PROJECT":  { cls: "badge-green",  label: "Project" },
  "ASSET_PACK":        { cls: "badge-blue",   label: "Assets" },
  "CODE_PLUGIN":       { cls: "badge-purple", label: "Code Plugin" },
  "游戏系统":           { cls: "badge-indigo", label: "Game System" },
  "材质与纹理":         { cls: "badge-orange", label: "Material" },
  "视觉效果":           { cls: "badge-pink",   label: "VFX" },
  "动画":              { cls: "badge-teal",   label: "Anim" },
  "游戏模板":           { cls: "badge-green",  label: "Template" },
  "教程和示例":         { cls: "badge-gray",   label: "Tutorial" },
  "Legacy":            { cls: "badge-gray",   label: "Legacy" },
  "ENGINE":            { cls: "badge-gray",   label: "Engine" },
};

function getBadge(item) {
  const listingBadge = TYPE_BADGES[item.listingType] || { cls: "badge-gray", label: item.listingType };
  const methodBadge = TYPE_BADGES[item.distributionMethod];
  if (methodBadge && item.distributionMethod !== item.listingType) {
    return [listingBadge, methodBadge];
  }
  return [listingBadge];
}

// ==================== Toast ====================
function showToast(msg, type = "success") {
  const t = $("#toast");
  t.textContent = msg; t.className = `toast toast-${type}`; t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 4000);
}

// ==================== Load Library ====================
async function loadLibrary(forceRefresh = false) {
  $("#loading-state").style.display = "flex";
  $("#empty-state").style.display = "none";
  $("#card-grid").style.display = "none";

  const action = forceRefresh ? "library:refresh" : "library:list";
  const resp = await chrome.runtime.sendMessage({ action });

  if (resp?.status === "auth_expired") {
    $("#loading-state").style.display = "none";
    $("#empty-state").style.display = "flex";
    $("p", $("#empty-state")).textContent = "Please log in first. Open the Fab Downloader popup to authenticate.";
    $("#btn-login-prompt").style.display = "none";
    return;
  }

  if (resp?.status !== "ok") {
    $("#loading-state").style.display = "none";
    showToast(resp?.message || "Failed to load library", "error");
    return;
  }

  allItems = resp.items || [];
  engineVersions = new Set();
  for (const item of allItems) {
    for (const pv of item.projectVersions || []) {
      for (const ev of pv.engineVersions || []) {
        engineVersions.add(ev);
      }
    }
  }

  // Populate engine filter dropdown
  const engineSelect = $("#filter-engine");
  engineSelect.innerHTML = '<option value="">All Engine Versions</option>';
  [...engineVersions].sort((a, b) => {
    const pa = parseEngineNum(a), pb = parseEngineNum(b);
    return pb - pa || a.localeCompare(b);
  }).forEach(ev => {
    const opt = document.createElement("option");
    opt.value = ev; opt.textContent = ev;
    engineSelect.appendChild(opt);
  });

  // Update user info (displayName comes from the library:list response)
  $("#display-name").textContent = resp.displayName || "";

  $("#loading-state").style.display = "none";
  renderCards();
}

function parseEngineNum(s) {
  const m = s?.match(/UE_(\d+)\.(\d+)/);
  return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0;
}

// ==================== Render ====================
function renderCards() {
  const grid = $("#card-grid");
  grid.innerHTML = "";

  const searchTerm = $("#search-input").value.toLowerCase();
  const filterType = $("#filter-type").value;
  const filterEngine = $("#filter-engine").value;

  let filtered = allItems;

  if (searchTerm) {
    filtered = filtered.filter(i =>
      (i.title || "").toLowerCase().includes(searchTerm) ||
      (i.seller || "").toLowerCase().includes(searchTerm)
    );
  }

  if (filterType) {
    if (filterType === "COMPLETE_PROJECT") {
      filtered = filtered.filter(i => i.distributionMethod === "COMPLETE_PROJECT");
    } else {
      filtered = filtered.filter(i =>
        i.listingType === filterType || i.distributionMethod === filterType
      );
    }
  }

  if (filterEngine) {
    filtered = filtered.filter(i =>
      (i.projectVersions || []).some(pv =>
        (pv.engineVersions || []).includes(filterEngine)
      )
    );
  }

  $("#result-count").textContent = `${filtered.length} of ${allItems.length} items`;

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-container" style="grid-column:1/-1"><p>No matching items.</p></div>';
    grid.style.display = "grid";
    return;
  }

  for (const item of filtered) {
    grid.appendChild(createCard(item));
  }
  grid.style.display = "grid";
}

function createCard(item) {
  const card = document.createElement("div");
  card.className = "card";

  // Thumbnail
  const thumbUrl = (item.images && item.images[0]?.url) || "";
  let thumbHtml;
  if (thumbUrl) {
    thumbHtml = `<img class="card-thumb" src="${escapeAttr(thumbUrl)}" alt="" loading="lazy">`;
  } else {
    const initial = (item.title || "?")[0].toUpperCase();
    thumbHtml = `<div class="card-thumb-placeholder">${initial}</div>`;
  }

  // Badges
  const badges = getBadge(item);
  const badgesHtml = badges.map(b => `<span class="badge ${b.cls}">${escapeHtml(b.label)}</span>`).join("");

  // Engine versions
  const allEngines = new Set();
  for (const pv of item.projectVersions || []) {
    for (const ev of pv.engineVersions || []) allEngines.add(ev);
  }
  const sortedEngines = [...allEngines].sort((a, b) => parseEngineNum(b) - parseEngineNum(a));
  const enginesText = sortedEngines.slice(0, 8).join(", ");
  const enginesMore = sortedEngines.length > 8 ? ` +${sortedEngines.length - 8} more` : "";

  // Version options for expanded detail
  const versionOptions = (item.projectVersions || []).map(pv => {
    const evList = (pv.engineVersions || []).join(", ") || "Engine (no specific versions)";
    const platforms = (pv.targetPlatforms || []).join(", ") || "All";
    return `<option value="${escapeAttr(pv.artifactId)}" data-asset-id="${escapeAttr(item.assetId)}" data-namespace="${escapeAttr(item.assetNamespace)}">
      ${escapeHtml(pv.artifactId)} — ${escapeHtml(evList)} [${escapeHtml(platforms)}]
    </option>`;
  }).join("");

  const sellerHtml = item.seller ? `<div class="card-seller">by ${escapeHtml(item.seller)}</div>` : "";

  card.innerHTML = `
    <div class="card-header">
      ${thumbHtml}
      <div class="card-info">
        <div class="card-title" title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</div>
        <div class="card-badges">${badgesHtml}</div>
        <div class="card-engines">${escapeHtml(enginesText)}${enginesMore}</div>
        ${sellerHtml}
      </div>
    </div>
    <div class="card-detail">
      <label class="version-select-label">Select version to download:</label>
      <select class="version-select">
        <option value="">Choose a version...</option>
        ${versionOptions}
      </select>
      <div class="card-actions">
        <button class="btn btn-primary btn-download" disabled>Download</button>
        <button class="btn btn-danger btn-cancel" style="display:none">Cancel</button>
        <span class="download-status"></span>
      </div>
    </div>
  `;

  // Click card (anywhere) to expand/collapse — but not on interactive elements
  card.addEventListener("click", (e) => {
    // Don't toggle when clicking interactive controls
    if (e.target.closest('select, button, input, a')) return;
    // Don't collapse cards with active downloads
    if (card.classList.contains("expanded") && card.dataset.downloadActive === "1") return;
    const wasExpanded = card.classList.contains("expanded");
    // Collapse other cards (but not those with active downloads)
    $$(".card.expanded").forEach(c => {
      if (c.dataset.downloadActive !== "1") c.classList.remove("expanded");
    });
    if (!wasExpanded) card.classList.add("expanded");
  });

  // Version select → enable download
  const select = $(".version-select", card);
  const btnDownload = $(".btn-download", card);
  const btnCancel = $(".btn-cancel", card);
  const status = $(".download-status", card);

  select.addEventListener("change", () => {
    const key = downloadKey(item.assetId, select.value);
    const active = activeDownloads.get(key);
    if (active) {
      // Re-select the currently downloading version → show cancel UI
      restoreDownloadUI(card, active);
    } else {
      btnDownload.disabled = !select.value;
      btnDownload.textContent = "Download";
      btnCancel.style.display = "none";
      status.innerHTML = "";
    }
  });

  select.addEventListener("dblclick", (e) => {
    e.stopPropagation();
  });

  // Check if any version of this item has an active download — restore UI
  for (const pv of (item.projectVersions || [])) {
    const key = downloadKey(item.assetId, pv.artifactId);
    const active = activeDownloads.get(key);
    if (active) {
      // Pre-select the downloading version
      select.value = pv.artifactId;
      card.classList.add("expanded");
      card.dataset.downloadActive = "1";
      restoreDownloadUI(card, active);
      break;
    }
  }

  // Download button
  btnDownload.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!select.value) return;

    const option = select.selectedOptions[0];
    const assetId = option.dataset.assetId;
    const assetNamespace = option.dataset.namespace;
    const artifactId = option.value;

    await startDownload(card, item, assetId, assetNamespace, artifactId, status, btnDownload, btnCancel);
  });

  // Cancel button
  btnCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = downloadKey(item.assetId, select.value);
    const active = activeDownloads.get(key);
    if (active) {
      active.controller.abort();
      btnCancel.textContent = "Cancelling...";
      btnCancel.disabled = true;
    }
  });

  return card;
}

// ==================== Download management ====================

async function startDownload(card, item, assetId, assetNamespace, artifactId, statusEl, btnDownload, btnCancel) {
  const key = downloadKey(assetId, artifactId);
  const controller = new AbortController();

  btnDownload.disabled = true;
  btnDownload.style.display = "none";
  btnCancel.style.display = "";
  btnCancel.textContent = "Cancel";
  btnCancel.disabled = false;
  card.dataset.downloadActive = "1";
  card.classList.add("expanded");
  statusEl.innerHTML = '<span class="download-progress">Getting manifest...</span>';

  const state = { controller, item, progress: { phase: 'manifest', current: 0, total: 0, totalWritten: 0, label: 'Getting manifest...', detail: '' } };
  activeDownloads.set(key, state);

  try {
    const resp = await chrome.runtime.sendMessage({
      action: "manifest:fetch",
      assetId, assetNamespace, artifactId,
    });

    if (resp?.status !== "ok") {
      throw new Error(resp?.message || "Failed to get manifest");
    }

    await handleBrowserDownload(item, resp, controller.signal, (p) => {
      state.progress = p;
      if (statusEl.isConnected) updateProgressUI(statusEl, p);
    });
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) {
      if (statusEl.isConnected) {
        statusEl.innerHTML = '<span style="color:#94a3b8;font-size:12px">Cancelled.</span>';
      }
    } else {
      debug.warn('Download failed:', e.message);
      if (statusEl.isConnected) {
        statusEl.innerHTML = `<span style="color:#f87171;font-size:12px">${escapeHtml(e.message)}</span>`;
      }
      showToast(e.message, "error");
    }
  } finally {
    activeDownloads.delete(key);
    if (card.isConnected) {
      card.dataset.downloadActive = "0";
      btnDownload.style.display = "";
      btnDownload.disabled = false;
      btnCancel.style.display = "none";
    }
  }
}

function restoreDownloadUI(card, state) {
  const btnDownload = $(".btn-download", card);
  const btnCancel = $(".btn-cancel", card);
  const status = $(".download-status", card);

  btnDownload.style.display = "none";
  btnDownload.disabled = true;
  btnCancel.style.display = "";
  btnCancel.textContent = "Cancel";
  btnCancel.disabled = false;
  card.dataset.downloadActive = "1";
  card.classList.add("expanded");

  updateProgressUI(status, state.progress);
}

function updateProgressUI(statusEl, p) {
  if (p.phase === 'parsing' || p.phase === 'manifest') {
    statusEl.innerHTML = renderProgressBar(0, 0, 'Parsing manifest...');
  } else if (p.phase === 'downloading') {
    const pct = p.total ? Math.round(p.current / p.total * 100) : 0;
    const parts = [`File ${p.current}/${p.total}`];
    if (p.speed) parts.push(p.speed);
    statusEl.innerHTML = renderProgressBar(p.current, p.total,
      parts.join(' · '),
      p.totalWritten ? formatSize(p.totalWritten) : ''
    );
  } else if (p.phase === 'file_progress') {
    const filePct = p.fileSize ? Math.round(p.fileBytes / p.fileSize * 100) : 0;
    statusEl.innerHTML = renderProgressBar(p.current, p.total,
      `${p.filename?.replace(/.*\//, '')} ${filePct}%`,
      p.totalWritten ? formatSize(p.totalWritten) : ''
    );
  } else if (p.phase === 'done') {
    statusEl.innerHTML = `<span class="download-done">&#10003; ${escapeHtml(p.filename || '')} (${formatSize(p.totalWritten)})</span>`;
  }
}

// ==================== Browser-native download (File System Access API) ====================

async function handleBrowserDownload(item, resp, signal, onProgress) {
  try {
    onProgress({ phase: 'parsing', current: 0, total: 0, totalWritten: 0, label: 'Pick a folder...', detail: '' });
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    onProgress({ phase: 'downloading', current: 0, total: 0, totalWritten: 0, label: 'Downloading...', detail: '', speed: '' });

    const assetName = sanitizeFilename(item.title);
    let lastUpdate = 0;
    let lastBytes = 0;

    await downloadAsset({
      manifestUrls: resp.manifestUrls,
      manifestBase64: resp.manifestBase64,
      baseUrls: resp.baseUrls,
      baseUrlTokens: resp.baseUrlTokens,
      dirHandle,
      assetName,
      signal,
      onProgress: (p) => {
        const now = Date.now();
        const elapsed = now - lastUpdate;
        if (elapsed < 200 && p.phase !== 'file_progress') return;
        lastUpdate = now;

        if (p.phase === 'downloading') {
          const speed = p.totalWritten && lastBytes && elapsed > 0
            ? formatSpeed((p.totalWritten - lastBytes) / (elapsed / 1000))
            : '';
          lastBytes = p.totalWritten || 0;
          onProgress({ ...p, speed });
        } else if (p.phase === 'done') {
          onProgress({ phase: 'done', totalWritten: lastBytes, filename: `${assetName}.tar` });
        } else {
          onProgress(p);
        }
      },
    });
  } catch (fsErr) {
    if (fsErr.name === 'AbortError' || signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const detail = `${fsErr.name}: ${fsErr.message}`;
    debug.warn('Download failed:', detail, fsErr);
    throw fsErr;
  }
}

// ==================== Utils ====================
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeFilename(name) {
  return (name || "asset").replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_").slice(0, 64);
}

// ==================== Event Listeners ====================
let searchTimer;
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderCards, 250);
});

$("#filter-type").addEventListener("change", renderCards);
$("#filter-engine").addEventListener("change", renderCards);

$("#btn-refresh").addEventListener("click", async () => {
  const btn = $("#btn-refresh");
  btn.addEventListener('animationend', () => btn.classList.remove('spin-once'), { once: true });
  btn.classList.add('spin-once');
  await loadLibrary(true);
  showToast("Library refreshed");
});

$("#btn-login-prompt")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "auth:start" });
});

// ==================== Progress Bar ====================
function renderProgressBar(current, total, label, detail) {
  const pct = total ? Math.round(current / total * 100) : 0;
  return `
    <div class="progress-container">
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
      <div class="progress-text">
        <span>${escapeHtml(label)}</span>
        ${detail ? `<span>${escapeHtml(detail)}</span>` : ''}
      </div>
    </div>`;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatSpeed(bps) {
  if (!bps || bps <= 0 || !isFinite(bps)) return '';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let v = bps;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

// ==================== Init ====================
loadLibrary();
