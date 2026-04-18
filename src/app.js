import {
  COL_STORE,
  DATA_STORE,
  RECENT_ACCOUNTS_KEY,
  ROW_HEIGHT_KEY,
  MAP_PRESETS_KEY,
  MAP_POS_KEY,
  LEGACY_MAP_POSITIONS_KEY,
  CONTENT_SYNC_BUMP_KEY,
  getSupabaseAuthStorageKey,
} from './app/storage-keys.js';
import {
  columns,
  loadColumns,
  syncColumnsFromSupabase,
  applyRemoteColumns,
  setColumnsAppHooks,
  openColModal,
  closeColModal,
  renderColList,
  cancelEditColumn,
  onEditColTypeChange,
  addEditOption,
  addOption,
  removeEditOption,
  removeOption,
  saveEditColumn,
  onNewColTypeChange,
  createColumn,
} from './app/columns.js';
import { esc, toast, showConfirm, closeExport, setSyncStatus, withTimeout } from './app/lib.js';
import { appSession } from './app/session.js';
import {
  toggleSignup,
  doLogin,
  toggleUserMenu,
  switchAccount,
  openAdminPanelFromMenu,
  doLogout,
  closeAdminPanel,
  updateUserRole,
  loadProfile,
} from './app/auth.js';
import {
  rowToItem,
  itemToRow as itemToDbRow,
  loadData as loadContentFromSupabase,
  subscribeRealtimeChannels,
} from './app/data-pipeline.js';
import {
  normalizeMultiselectToOptions,
  normalizeSelectToOptions,
  sameMultiValue,
} from './app/field-normalize.js';
import {
  setTableAppHooks,
  renderTable,
  toggleSelectAll,
  clearBulkSelection,
  clearSelectionOnViewChange,
  onBulkFieldChange,
  bulkDelete,
  applyBulkMultiselect,
  applyBulkEdit,
  setRowHeight,
  getCurrentRowHeight,
  preserveTableScrollPosition,
} from './app/table.js';
import {
  populateKanbanGroupBy,
  renderKanban,
  setKanbanHooks,
} from './app/kanban.js';
import {
  exportCSV,
  exportJSON,
  handleImportFile,
  setImportExportHooks,
} from './app/import-export.js';

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// COLUMN DEFINITIONS → ./app/columns.js (+ columns-defaults.js)
// ═══════════════════════════════════════════

let data = [];     // content items
let activeFilter = null; // {colId, values: Set<string>}
let activeFilterColId = null; // which select-column the sidebar filter uses
let showIdeas = true; // toggle for idea visibility
let currentView = 'table';
let colorMode = 'type';
let hiddenCats = new Set();
let simulation = null; // legacy reference kept for compatibility
let onlineUsers = {}; // { userId: { display_name, color } } — realtime presence
let sortColId = 'title'; // which column to sort by
let sortDir = 'asc';     // 'asc' or 'desc'
let _sim = null;       // new simulation reference
let selectedNodeId = null;
let mapZoom = null;
let realtimeChannels = [];
/** True während Mehrfachänderungen — blockiert parallele Realtime-Refreshes (verhindert Sync-„Loops“). */
let bulkOperationRunning = false;

// Temp state for drawer
let drawerKws = [];
let drawerLinks = [];
let drawerItem = null; // null = new

// ═══════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════

/** Entfernt veraltete Auswahlwerte, wenn Optionen umbenannt/gelöscht wurden. Gibt Einträge zurück, die in die DB geschrieben werden müssen. */
function pruneStaleCategoryValuesSync() {
  const dirty = [];
  for (const item of data) {
    let changed = false;
    for (const col of columns) {
      if (col.type === 'multiselect') {
        const next = normalizeMultiselectToOptions(col, item[col.id]);
        const prev = Array.isArray(item[col.id]) ? item[col.id] : (item[col.id] ? [item[col.id]] : []);
        if (!sameMultiValue(prev, next)) {
          item[col.id] = next;
          changed = true;
        }
      } else if (col.type === 'select') {
        const next = normalizeSelectToOptions(col, item[col.id]);
        const prev = item[col.id] ?? '';
        if (next !== prev) {
          item[col.id] = next;
          changed = true;
        }
      }
    }
    if (changed) dirty.push(item);
  }
  return dirty;
}

async function persistPrunedItems(items) {
  if (!items.length) return;
  bulkOperationRunning = true;
  try {
    for (const item of items) {
      const row = itemToRow(item);
      const { error } = await appSession.sb.from('content_items').update(row).eq('id', item.id);
      if (error) console.error('Aufräumen alter Kategoriewerte fehlgeschlagen', item.id, error);
    }
  } finally {
    bulkOperationRunning = false;
  }
}

/** Nach geladenen Spalten-Definitionen: ungültige Auswahlwerte entfernen und speichern (nicht bei jedem loadData — sonst Race mit neuen Kategorie-Optionen). */
async function runPruneStaleCategoryValues() {
  const dirty = pruneStaleCategoryValuesSync();
  if (!dirty.length) return;
  await persistPrunedItems(dirty);
}

/** Verhindert, dass eine langsamere stille Anfrage neuere Daten überschreibt (Race bei Realtime + Storage + Debounce). */
let _quietLoadGen = 0;

async function loadData(options = {}) {
  const { quiet = false } = options;
  const gen = quiet ? ++_quietLoadGen : null;
  await loadContentFromSupabase({
    sb: appSession.sb,
    setSyncStatus,
    setData: (next) => { data = next; },
    render,
    quiet,
    isStale: quiet ? () => gen !== _quietLoadGen : () => false,
  });
}

/** Viele Trigger gleichzeitig (Broadcast + storage + Realtime-Debounce) → leicht bündeln, ohne sichtbares `loadData` zu blockieren. */
let _quietReloadDebounceTimer = null;
function enqueueQuietReloadData() {
  if (!appSession.currentUser) return;
  clearTimeout(_quietReloadDebounceTimer);
  _quietReloadDebounceTimer = setTimeout(() => {
    _quietReloadDebounceTimer = null;
    void loadData({ quiet: true }).catch((e) => console.error('quiet reload', e));
  }, 280);
}

/** Tab-eigene ID für BroadcastChannel (jeder Tab hat eigenes sessionStorage). */
function getContentSyncTabId() {
  let id = sessionStorage.getItem('contentify_sync_tab');
  if (!id) {
    id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('contentify_sync_tab', id);
  }
  return id;
}

let contentSyncChannel = null;

function initContentSyncChannel() {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    contentSyncChannel = new BroadcastChannel('contentify-content-items');
    contentSyncChannel.onmessage = (ev) => {
      if (ev.data?.type !== 'items-mutated') return;
      if (ev.data?.source === getContentSyncTabId()) return;
      if (!appSession.currentUser) return;
      enqueueQuietReloadData();
    };
  } catch (e) { /* ignore */ }
}

/** Andere Tabs benachrichtigen: BroadcastChannel + localStorage (storage-Event nur in anderen Tabs). */
function notifyOtherTabsContentChanged() {
  try {
    contentSyncChannel?.postMessage({ type: 'items-mutated', source: getContentSyncTabId() });
  } catch (e) { /* ignore */ }
  try {
    localStorage.setItem(CONTENT_SYNC_BUMP_KEY, String(Date.now()));
  } catch (e) { /* ignore */ }
}

window.addEventListener('storage', (e) => {
  if (e.key !== CONTENT_SYNC_BUMP_KEY || e.newValue == null) return;
  if (!appSession.currentUser) return;
  enqueueQuietReloadData();
});

/**
 * Nach Tab-Rückkehr: Session refreshen, hängende Zellen-Edits bereinigen, neu zeichnen.
 * (Realtime nicht bei jedem Sichtbar-werden neu abonnieren — das erzeugt nur Last und half nicht.)
 */
function runTabReturnRecovery() {
  void (async () => {
    /** Hängender Bulk/Prune kann den Flag stehen lassen → Speichern wirkt „blockiert“. */
    bulkOperationRunning = false;
    /** Im Hintergrund-Tab laufen Auto-Refresh-Timer oft nicht; JWT kann ablaufen. getSession() ist nur Cache — explizit neu holen. */
    try {
      const { error } = await appSession.sb?.auth?.refreshSession?.() ?? { error: null };
      if (error) console.warn('refreshSession nach Tab-Rückkehr', error);
    } catch (e) {
      console.warn('refreshSession nach Tab-Rückkehr', e);
    }
    const shell = document.getElementById('appShell');
    const ae = document.activeElement;
    if (ae && typeof ae.blur === 'function' && shell?.contains(ae)) {
      ae.blur();
    }
    document.querySelectorAll('#tBody td.editing').forEach((td) => {
      td.classList.remove('editing', 'cell-ms-wrap');
    });
    preserveTableScrollPosition();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          render();
        } catch (e) {
          console.error('render after tab return', e);
        }
      });
    });
  })();
}

function initTabReturnRecovery() {
  document.addEventListener('visibilitychange', () => {
    if (!appSession.currentUser || !appSession.sb) return;
    if (document.visibilityState === 'hidden') {
      try {
        appSession.sb.auth.stopAutoRefresh?.();
      } catch (_) { /* ignore */ }
      return;
    }
    try {
      appSession.sb.auth.startAutoRefresh?.();
    } catch (_) { /* ignore */ }
    runTabReturnRecovery();
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || !appSession.currentUser || !appSession.sb) return;
    try {
      appSession.sb.auth.startAutoRefresh?.();
    } catch (_) { /* ignore */ }
    runTabReturnRecovery();
  });
}

/** Realtime: debounced (viele Events), dann in die Reload-Kette — kein Dauer-„Lade…“. */
let _contentReloadDebounceTimer = null;
function scheduleDebouncedContentReload() {
  clearTimeout(_contentReloadDebounceTimer);
  _contentReloadDebounceTimer = setTimeout(() => {
    _contentReloadDebounceTimer = null;
    enqueueQuietReloadData();
  }, 450);
}

/**
 * Realtime: Kein In-Place-Patch mehr — nur gedrosselter Voll-Fetch wie nach F5.
 * Der Patch-Pfad war fehleranfällig (Merge, Timing, zweite Tabs); `select *` ist die eine Quelle der Wahrheit.
 */
function subscribeRealtime() {
  const presenceColors = ['#e03131', '#1971c2', '#2f9e44', '#e8590c', '#9b4dca', '#f0b429', '#0ca678', '#d6336c'];
  const myColor = presenceColors[Math.abs(appSession.currentUser.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % presenceColors.length];
  subscribeRealtimeChannels({
    sb: appSession.sb,
    channels: realtimeChannels,
    onContentItemsEvent: async (p) => {
      const icons = { INSERT: '✨', UPDATE: '✏️', DELETE: '🗑️' };
      const et = String(p.eventType || p.event || '').toUpperCase();
      showActivity(icons[et] || '●', p.new?.title || p.old?.title || 'Eintrag');
      scheduleDebouncedContentReload();
    },
    onAppSettingsEvent: async (p) => {
      if (p.new?.key === 'columns' && Array.isArray(p.new?.value)) {
        applyRemoteColumns(p.new.value);
        render();
        toast('🔄 Kategorien aktualisiert');
        void (async () => {
          try {
            await loadData({ quiet: true });
            await runPruneStaleCategoryValues();
          } catch (e) {
            console.error('Nach Kategorien-Update', e);
          }
        })();
      }
    },
    presence: {
      userId: appSession.currentUser.id,
      displayName: appSession.currentProfile?.display_name || appSession.currentUser.email,
      color: myColor,
      onPresenceSync: (map) => {
        onlineUsers = map;
        renderOnlineUsers();
      },
    },
  });
}

function renderOnlineUsers() {
  let el = document.getElementById('onlineUsersBar');
  if(!el) return;
  const users = Object.values(onlineUsers);
  el.innerHTML = users.map(u => {
    const initials = (u.display_name || '?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    return `<div title="${esc(u.display_name || '')}" style="width:28px;height:28px;border-radius:50%;background:${u.color};color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-left:-6px;border:2px solid var(--surface);flex-shrink:0">${initials}</div>`;
  }).join('');
  el.style.display = users.length > 0 ? 'flex' : 'none';
}

// ═══════════════════════════════════════════
// ACTIVITY FEED
// ═══════════════════════════════════════════
function showActivity(icon, text) {
  const panel = document.getElementById('activityPanel');
  if (!panel) return;
  while (panel.children.length >= 6) panel.removeChild(panel.firstChild);
  const pill = document.createElement('div');
  pill.className = 'activity-pill';
  pill.innerHTML = `<span>${icon}</span><span style="flex:1;color:var(--text-muted)">${esc(text)}</span>`;
  panel.appendChild(pill);
  setTimeout(()=>{ pill.classList.add('fade-out'); setTimeout(()=>pill.remove(),500); }, 4000);
}

// ═══════════════════════════════════════════
// FILTER & SORT
// ═══════════════════════════════════════════
function getFiltered() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  let items = data.filter(d => {
    if (ideaMode === 'hide' && isIdea(d)) return false;
    if (ideaMode === 'only' && !isIdea(d)) return false;
    if (activeFilter && activeFilter.values.size > 0) {
      const raw = d[activeFilter.colId];
      // Handle both single values (select) and arrays (multiselect)
      const vals = Array.isArray(raw) ? raw : [String(raw || '')];
      const hasMatch = vals.some(v => activeFilter.values.has(String(v)));
      if (!hasMatch) return false;
    }
    if (q) {
      const h = Object.values(d).join(' ').toLowerCase();
      if (!h.includes(q)) return false;
    }
    return true;
  });
  const col = columns.find(c => c.id === sortColId);
  items.sort((a,b) => {
    let va = a[sortColId], vb = b[sortColId];
    let cmp = 0;
    if(col?.type === 'links') {
      // Sort by number of links
      cmp = (Array.isArray(va) ? va.length : 0) - (Array.isArray(vb) ? vb.length : 0);
    } else if(col?.type === 'number') {
      cmp = (parseFloat(va)||0) - (parseFloat(vb)||0);
    } else if(col?.type === 'date') {
      cmp = (va||'').localeCompare(vb||'');
    } else if(col?.type === 'multiselect') {
      // Use first item alphabetically
      const a0 = (Array.isArray(va) ? va[0] : va) || '';
      const b0 = (Array.isArray(vb) ? vb[0] : vb) || '';
      cmp = a0.localeCompare(b0, 'de');
    } else {
      cmp = (String(va||'')).localeCompare(String(vb||''), 'de');
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return items;
}

// ═══════════════════════════════════════════
// RENDER SIDEBAR
// ═══════════════════════════════════════════
function renderSidebar() {
  const selectCols = columns.filter(c => c.type === 'select');
  const filterableCols = columns.filter(c => c.type === 'select' || c.type === 'multiselect');
  // Populate filter column picker
  const picker = document.getElementById('filterColPicker');
  if (picker) {
    picker.innerHTML = filterableCols.map(c =>
      `<option value="${c.id}" ${activeFilterColId===c.id?'selected':''}>${esc(c.name)}</option>`
    ).join('');
    if (!activeFilterColId && selectCols.length > 0) activeFilterColId = selectCols[0].id;
    if (picker.value !== activeFilterColId && activeFilterColId) picker.value = activeFilterColId;
  }
  const filterCol = filterableCols.find(c => c.id === activeFilterColId) || filterableCols[0];
  const el = document.getElementById('dynamicFilters');
  el.innerHTML = '';
  if (filterCol) {
    const visibleData = showIdeas ? data : data.filter(d => !isIdea(d));
    const hasFilter = activeFilter && activeFilter.values?.size > 0;
    // "Alle" clears all selections
    const all = document.createElement('button');
    all.className = 'filter-btn' + (!hasFilter ? ' active' : '');
    all.onclick = () => { activeFilter = null; render(); };
    all.innerHTML = `Alle <span class="cnt">${visibleData.length}</span>`;
    el.appendChild(all);
    const counts = {};
    visibleData.forEach(d => {
      const raw = d[filterCol.id];
      // Handle multiselect (array) and select (string)
      const vals = Array.isArray(raw) ? raw : (raw ? [raw] : ['—']);
      vals.forEach(v => { counts[v] = (counts[v]||0) + 1; });
    });
    (filterCol.options||[]).forEach(opt => {
      if (!counts[opt.label]) return;
      const isActive = activeFilter?.values?.has(opt.label);
      const b = document.createElement('button');
      b.className = 'filter-btn' + (isActive ? ' active' : '');
      b.onclick = () => {
        if (!activeFilter) activeFilter = {colId: filterCol.id, values: new Set()};
        const newValues = new Set(activeFilter.values);
        if (newValues.has(opt.label)) {
          newValues.delete(opt.label);
          activeFilter = newValues.size > 0 ? {colId: filterCol.id, values: newValues} : null;
        } else {
          newValues.add(opt.label);
          activeFilter = {colId: filterCol.id, values: newValues};
        }
        render();
      };
      b.innerHTML = `${esc(opt.label)} <span class="cnt">${counts[opt.label]||0}</span>`;
      el.appendChild(b);
    });
  }
  // Update ideas toggle UI
  const track = document.getElementById('ideasToggleTrack');
  const thumb = document.getElementById('ideasToggleThumb');
  const label = document.getElementById('ideasToggleLabel');
  if (track) track.style.background = ideaMode!=='hide' ? 'var(--accent)' : 'var(--border-mid)';
  if (thumb) thumb.style.left = ideaMode!=='hide' ? '14px' : '2px';
  if (label) label.textContent = ideaMode==='hide' ? 'Ideen versteckt' : 'Ideen sichtbar';
  const onlyBtn = document.getElementById('onlyIdeasBtn');
  if (onlyBtn) {
    onlyBtn.classList.toggle('active', ideaMode==='only');
  }
  // Stats
  const phaseCol = columns.find(c=>c.id==='phase');
  const done = phaseCol ? data.filter(d=>d.phase==='Fertig').length : 0;
  const ideas = data.filter(d=>isIdea(d)).length;
  const totalLinks = data.reduce((s,d)=>s+(d.internalLinks||[]).length,0);
  const withUrl = data.filter(d=>d.url).length;
  const avgLinks = data.length ? (totalLinks/data.length).toFixed(1) : 0;
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-num">${data.length}</div><div class="stat-lbl">Seiten gesamt</div></div>
    <div class="stat-card"><div class="stat-num">${ideas}</div><div class="stat-lbl">💡 Ideen</div></div>
    <div class="stat-card"><div class="stat-num">${totalLinks}</div><div class="stat-lbl">🔗 Links</div></div>
    <div class="stat-card"><div class="stat-num">${avgLinks}</div><div class="stat-lbl">Ø Links/Seite</div></div>`;
}

function isIdea(d) {
  // First check explicit isIdeaFlag (set via drawer toggle)
  if (d.isIdeaFlag) return true;
  // Then check phase column isIdea flag
  const phaseCol = columns.find(c=>c.id==='phase');
  if (!phaseCol) return false;
  const ideaOpts = (phaseCol.options||[]).filter(o=>o.isIdea).map(o=>o.label);
  if (ideaOpts.length) return ideaOpts.includes(d[phaseCol.id]);
  return d.phase === 'Idee';
}

// ideaMode: 'show' = all visible, 'hide' = ideas hidden, 'only' = only ideas
let ideaMode = 'show';
function setIdeaMode(mode) {
  if (ideaMode === mode) {
    ideaMode = 'show'; // toggle off
  } else {
    ideaMode = mode;
  }
  showIdeas = ideaMode !== 'hide';
  render();
}
function toggleIdeas() { setIdeaMode(showIdeas ? 'hide' : 'show'); }

// ═══════════════════════════════════════════
// RENDER MAIN
// ═══════════════════════════════════════════
function render() {
  try {
    renderSidebar();
    if (currentView==='map') {
      // If map is already rendered with good dimensions, just rebuild graph
      const existingWrap = document.getElementById('mapWrap');
      const existingW = existingWrap?.offsetWidth;
      const existingH = existingWrap?.offsetHeight;
      if(existingWrap && existingW > 100 && existingH > 100) {
        buildGraph(); // dimensions already good, skip HTML rebuild
      } else {
        renderMap(); // first load or bad dimensions — full rebuild
      }
      return;
    }
    const items = getFiltered();
    const area = document.getElementById('contentArea');
    if (!area) return;
    if (!items.length) { area.innerHTML=`<div class="empty"><div style="font-size:32px">📭</div><p>Keine Einträge.</p></div>`; return; }
    if (currentView==='table') renderTable(items, area);
    else renderKanban(items, area);
  } catch (e) {
    console.error('render', e);
    toast('Anzeige-Fehler — bitte Seite neu laden (F5).');
  }
}

// ─────────────────────────────────────────
// LINK MAP
// ─────────────────────────────────────────
let linkModeActive = false;
// Map state
let mapPhysicsEnabled = true;

// ─── Position store ───────────────────────────────────────────────────────────
// nodePos: { [id]: {x, y} } — the ONLY source of truth for node positions
const nodePos = {};

function loadSavedPos() {
  try {
    const raw = JSON.parse(localStorage.getItem(MAP_POS_KEY)||'{}');
    // Strip invalid positions from buggy 0-dimension builds
    const clean = {};
    Object.entries(raw).forEach(([k,v]) => {
      if(v && isFinite(v.x) && isFinite(v.y) && v.x > 20 && v.y > 20) clean[k] = v;
    });
    return clean;
  } catch { return {}; }
}
function persistPos() {
  // Only persist if we have valid canvas dimensions
  const wrap = document.getElementById('mapWrap');
  if(!wrap || wrap.offsetWidth < 100 || wrap.offsetHeight < 100) return;
  localStorage.setItem(MAP_POS_KEY, JSON.stringify(nodePos));
}
function clearSavedPos() {
  Object.keys(nodePos).forEach(k=>delete nodePos[k]);
  localStorage.removeItem(MAP_POS_KEY);
}

// ─── Presets ─────────────────────────────────────────────────────────────────
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(MAP_PRESETS_KEY)||'[]'); } catch { return []; }
}
function savePresetsStore(p) { localStorage.setItem(MAP_PRESETS_KEY, JSON.stringify(p)); }

function togglePresetPanel() {
  const panel = document.getElementById('presetPanel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) renderPresetList();
}

function renderPresetList() {
  const el = document.getElementById('presetList');
  if (!el) return;
  const presets = loadPresets();
  if (!presets.length) {
    el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-faint);text-align:center">Noch keine Speicherstände</div>';
    return;
  }
  el.innerHTML = presets.map((p, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 4px;border-radius:6px" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:500;color:var(--text)">${esc(p.name)}</div>
        <div style="font-size:10px;color:var(--text-faint)">${new Date(p.ts).toLocaleDateString('de-DE')} · ${p.count||0} Einträge · ${esc(p.filterLabel||'Alle')}</div>
      </div>
      <button onclick="loadPreset(${i})" style="font-size:11px;padding:3px 8px;background:var(--accent-light);color:var(--accent);border:none;border-radius:5px;cursor:pointer">Laden</button>
      <button onclick="deletePreset(${i})" style="font-size:11px;padding:3px 6px;background:none;color:var(--red);border:none;border-radius:5px;cursor:pointer">🗑</button>
    </div>`).join('');
}

function savePreset() {
  const nameEl = document.getElementById('presetNameInput');
  const name = nameEl?.value.trim();
  if (!name) { toast('Bitte einen Namen eingeben'); return; }
  // Snapshot current positions
  if (_sim) _sim.nodes().forEach(n=>{ if(n.id) nodePos[n.id]={x:n.x,y:n.y}; });
  const presets = loadPresets();
  const filterLabel = activeFilter?.values?.size > 0 ? `${activeFilter.colId}:[${[...activeFilter.values].join(',')}]` : 'Alle';
  presets.unshift({
    name, ts: Date.now(),
    count: Object.keys(nodePos).length,
    filterLabel,
    colorMode,
    activeFilter: activeFilter ? {...activeFilter, values: [...(activeFilter.values||[])]} : null,
    activeFilterColId,
    positions: {...nodePos},
  });
  savePresetsStore(presets);
  if(nameEl) nameEl.value = '';
  renderPresetList();
  toast(`💾 "${name}" gespeichert`);
}

function loadPreset(i) {
  const preset = loadPresets()[i];
  if (!preset) return;
  // Restore positions
  Object.keys(nodePos).forEach(k=>delete nodePos[k]);
  Object.assign(nodePos, preset.positions||{});
  persistPos();
  // Restore filters
  if (preset.colorMode) colorMode = preset.colorMode;
  if (preset.activeFilterColId) activeFilterColId = preset.activeFilterColId;
  // Restore activeFilter — convert values array back to Set
  if (preset.activeFilter) {
    activeFilter = {...preset.activeFilter, values: new Set(preset.activeFilter.values||[])};
  } else { activeFilter = null; }
  togglePresetPanel();
  renderSidebar();
  renderMap(); // full rebuild with correct colorMode/filter
  toast(`✅ "${preset.name}" geladen`);
}

function deletePreset(i) {
  const presets = loadPresets();
  const name = presets[i]?.name;
  presets.splice(i, 1);
  savePresetsStore(presets);
  renderPresetList();
  toast(`🗑 "${name}" gelöscht`);
}

// ─── Physics toggle ──────────────────────────────────────────────────────────
function toggleMapPhysics() {
  mapPhysicsEnabled = !mapPhysicsEnabled;
  const track = document.getElementById('physicsTrack');
  const thumb = document.getElementById('physicsThumb');
  if(track) track.style.background = mapPhysicsEnabled ? 'var(--accent)' : 'var(--border-mid)';
  if(thumb) thumb.style.left = mapPhysicsEnabled ? '12px' : '2px';
  toast(mapPhysicsEnabled ? '▶ Physics aktiv' : '⏸ Physics aus');
}

// ─── Undo ────────────────────────────────────────────────────────────────────
const undoStack = [];
function pushUndo(action) { undoStack.push(action); if(undoStack.length>30) undoStack.shift(); }
async function undoMapAction() {
  const action = undoStack.pop();
  if(!action) { toast('Nichts rückgängig zu machen'); return; }
  if(action.type==='move') {
    nodePos[action.id] = {x:action.prevX, y:action.prevY};
    persistPos();
    renderMap();
    toast('↩ Position wiederhergestellt');
  } else if(action.type==='link') {
    const src = data.find(d=>d.id===action.sourceId);
    if(!src) return;
    const newLinks = (src.internalLinks||[]).filter(id=>id!==action.targetId);
    const {error} = await appSession.sb.from('content_items').update({internal_links:newLinks}).eq('id',action.sourceId);
    if(!error) {
      toast('↩ Verlinkung entfernt');
      notifyOtherTabsContentChanged();
    }
  }
}

// ─── Link drag mode ───────────────────────────────────────────────────────────
let linkModeActiveInMap = false;
let _linkDragSource = null;

function toggleLinkMode() {
  linkModeActive = !linkModeActive;
  linkModeActiveInMap = linkModeActive;
  const btn = document.getElementById('linkModeBtn');
  if(btn) {
    btn.style.background = linkModeActive ? 'var(--teal)' : '';
    btn.style.color = linkModeActive ? '#fff' : '';
  }
  const wrap = document.getElementById('mapWrap');
  if(wrap) wrap.style.cursor = linkModeActive ? 'crosshair' : 'default';
  toast(linkModeActive ? '🔗 Zieh von Kreis zu Kreis zum Verknüpfen' : 'Verknüpfungs-Modus aus');
}

async function createLinkBetween(sourceId, targetId) {
  const source = data.find(d=>d.id===sourceId);
  const target = data.find(d=>d.id===targetId);
  if (!source||!target) return;
  if ((source.internalLinks||[]).includes(targetId)) { toast('Bereits verlinkt'); return; }
  const newLinks = [...(source.internalLinks||[]), targetId];
  preserveTableScrollPosition();
  const {error} = await appSession.sb.from('content_items').update({internal_links:newLinks}).eq('id',sourceId);
  if(error) { toast('Fehler: '+error.message); return; }
  pushUndo({type:'link', sourceId, targetId});
  toast(`✅ ${source.title.slice(0,20)} → ${target.title.slice(0,20)}`);
  notifyOtherTabsContentChanged();
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
// mapZoom declared at top level (line 539)
function zoomIn(){ if(mapZoom) d3.select('#mapSvg').transition().duration(250).call(mapZoom.scaleBy,1.4); }
function zoomOut(){ if(mapZoom) d3.select('#mapSvg').transition().duration(250).call(mapZoom.scaleBy,0.7); }
function zoomReset(){ if(!mapZoom)return; const w=document.getElementById('mapWrap'); const W=w?w.offsetWidth:900,H=w?w.offsetHeight:600; d3.select('#mapSvg').transition().duration(350).call(mapZoom.transform, d3.zoomIdentity.translate(W/2,H/2).scale(0.9).translate(-W/2,-H/2)); }

// ─── Color helpers ────────────────────────────────────────────────────────────
function getNodeColor(d) {
  const col = columns.find(c=>c.id===colorMode);
  const opt = (col?.options||[]).find(o=>o.label===d[colorMode]);
  return opt?.color || '#888';
}
function getNodeLabel(d) { return d[colorMode]||'–'; }

// ─── renderMap ────────────────────────────────────────────────────────────────
function renderMap() {
  const area = document.getElementById('contentArea');
  const selectCols = columns.filter(c=>c.type==='select');
  if(!colorMode||!selectCols.find(c=>c.id===colorMode)) colorMode=selectCols[0]?.id||'';
  const colorByOpts = selectCols.map(c=>`<option value="${c.id}" ${colorMode===c.id?'selected':''}>${esc(c.name)}</option>`).join('');

  area.innerHTML = `
    <div id="mapWrap">
      <svg id="mapSvg"></svg>
      <div id="mapTooltip"></div>
      <div id="mapColorBy">
        <label>Einfärben</label>
        <select id="colorBySelect" onchange="colorMode=this.value;hiddenCats=new Set();renderMap()">${colorByOpts}</select>
      </div>
      <div id="mapLegend"><h4>Legende</h4><div id="legendItems"></div></div>
      <div id="mapControls">
        <button onclick="zoomIn()" title="Zoom in">+</button>
        <button onclick="zoomOut()" title="Zoom out">−</button>
        <button id="linkModeBtn" onclick="toggleLinkMode()" title="Verknüpfen" style="font-size:11px">🔗</button>
        <button onclick="undoMapAction()" title="Rückgängig (Strg+Z)" style="font-size:11px">↩</button>
      </div>
      <div id="mapBottomBar">
        <label style="display:flex;align-items:center;gap:5px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 10px;font-size:11px;color:var(--text-muted);cursor:pointer;box-shadow:var(--shadow)">
          <div id="physicsTrack" onclick="toggleMapPhysics()" style="width:26px;height:14px;border-radius:7px;background:${mapPhysicsEnabled?'var(--accent)':'var(--border-mid)'};position:relative;cursor:pointer;transition:background .2s;flex-shrink:0">
            <div id="physicsThumb" style="position:absolute;top:2px;left:${mapPhysicsEnabled?'12':'2'}px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .2s"></div>
          </div>
          Physics
        </label>
        <button onclick="togglePresetPanel()" style="font-size:11px;padding:4px 10px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--border);color:var(--text-muted);box-shadow:var(--shadow);cursor:pointer">💾 Speicherstände</button>
      </div>
      <div id="presetPanel" style="display:none;position:absolute;bottom:50px;right:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);width:280px;z-index:20">
        <div style="padding:10px 14px 6px;font-size:12px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          Speicherstände
          <button onclick="togglePresetPanel()" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:13px;padding:0">✕</button>
        </div>
        <div id="presetList" style="max-height:220px;overflow-y:auto;padding:6px 8px"></div>
        <div style="padding:8px;border-top:1px solid var(--border)">
          <div style="display:flex;gap:5px">
            <input id="presetNameInput" type="text" placeholder="Name eingeben…" style="flex:1;padding:5px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
            <button type="button" id="presetSaveBtn" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius);padding:5px 10px;font-size:12px;cursor:pointer">Speichern</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('presetSaveBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void savePreset();
  });
  // Restore link mode button if active
  const lmBtn = document.getElementById('linkModeBtn');
  if(lmBtn&&linkModeActive){ lmBtn.style.background='var(--teal)'; lmBtn.style.color='#fff'; }
  const wrap2 = document.getElementById('mapWrap');
  if(wrap2) wrap2.style.cursor = linkModeActive?'crosshair':'default';
  // Always call buildGraph after DOM settles
  // ResizeObserver handles the case where dimensions aren't ready yet
  const _wrap = document.getElementById('mapWrap');
  if(_wrap) {
    if(_wrap.offsetWidth > 100 && _wrap.offsetHeight > 100) {
      // Dimensions already good — call directly
      buildGraph();
    } else {
      // Wait for dimensions via ResizeObserver
      const _ro = new ResizeObserver((entries, obs) => {
        const entry = entries[0];
        if(entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          obs.disconnect();
          buildGraph();
        }
      });
      _ro.observe(_wrap);
    }
  }
}

// ─── The simulation reference ─────────────────────────────────────────────────
// _sim, selectedNodeId, hiddenCats declared at top level
// ─── buildGraph ───────────────────────────────────────────────────────────────
let _buildGraphPending = null;
let _buildGraphRunning = false;

function buildGraph() {
  // Stop any running simulation immediately to prevent stale tick handlers
  if(_sim) { _sim.stop(); _sim = null; }
  // Debounce: if called rapidly, only run the last call
  if(_buildGraphPending) clearTimeout(_buildGraphPending);
  _buildGraphPending = setTimeout(_buildGraphNow, 50);
}

function _buildGraphNow() {
  _buildGraphPending = null;
  const wrap = document.getElementById('mapWrap');
  if(!wrap) return;
  const W = wrap.offsetWidth, H = wrap.offsetHeight;
  // Hard stop — never run with bad dimensions (causes stacked nodes)
  if(!W || !H || W < 100 || H < 100) return;
  // Clean stale bad positions from previous buggy builds
  Object.keys(nodePos).forEach(k => {
    const p = nodePos[k];
    if(!p || !isFinite(p.x) || !isFinite(p.y) || p.x < 20 || p.y < 20) delete nodePos[k];
  });

  if(_sim) { _sim.stop(); _sim = null; }

  const svg = d3.select('#mapSvg').attr('width',W).attr('height',H);
  // Save current zoom transform before rebuild
  const _existingG = document.querySelector('#mapSvg g');
  const _savedTransform = _existingG ? d3.zoomTransform(document.querySelector('#mapSvg')) : null;
  svg.selectAll('*').remove();

  // Arrow markers
  const defs = svg.append('defs');
  // Arrow markers - colors: grey, teal (outgoing), blue (incoming), idea
  ['arr:#bbb','arr-idea:#f0b429','arr-pot:#f0b429','arr-accent:var(--accent-mid)','arr-blue:var(--blue)'].forEach(s=>{
    const [id,fill]=s.split(':');
    defs.append('marker').attr('id',id).attr('viewBox','0 -4 8 8').attr('refX',8).attr('refY',0)
      .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
      .attr('markerUnits','strokeWidth')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill',fill);
  });

  const g = svg.append('g');

  // ── Filter data ──
  const mapData = data.filter(d=>{
    if(ideaMode==='hide'&&isIdea(d)) return false;
    if(ideaMode==='only'&&!isIdea(d)) return false;
    if(activeFilter && activeFilter.values?.size > 0){
      const raw = d[activeFilter.colId];
      const vals = Array.isArray(raw) ? raw : [String(raw||'')];
      if(!vals.some(v => activeFilter.values.has(String(v)))) return false;
    }
    return true;
  });
  const idSet = new Set(mapData.map(d=>d.id));

  // ── Load saved positions — restore into simulation nodes ──
  const saved = loadSavedPos();
  // Merge saved into nodePos
  Object.keys(saved).forEach(k=>{ if(!nodePos[k]) nodePos[k]=saved[k]; });

  // ── Build nodes with positions ──
  const hasPositions = mapData.some(d=>nodePos[d.id]);
  const nodes = mapData.map((d,i)=>{
    const pos = nodePos[d.id];
    // Only use saved position if it looks valid (not 0,0 and within reasonable bounds)
    const posValid = pos && pos.x > 10 && pos.y > 10 && pos.x < W*3 && pos.y < H*3;
    const angle = (i/mapData.length)*2*Math.PI;
    const spread = Math.min(W,H)*0.38;
    return {
      ...d,
      x: posValid ? pos.x : (W/2 + Math.cos(angle)*spread*(0.6+Math.random()*0.4)),
      y: posValid ? pos.y : (H/2 + Math.sin(angle)*spread*(0.6+Math.random()*0.4)),
    };
  });

  // ── Build edges ──
  const seen = new Set(), edges = [], ideaEdges = [], potEdges = [];
  const ideaNodeIds = new Set(nodes.filter(n=>isIdea(n)).map(n=>n.id));
  mapData.forEach(d=>{
    (d.internalLinks||[]).forEach(tid=>{
      if(!idSet.has(tid)) return;
      const k = [d.id,tid].sort().join('|');
      if(seen.has(k)) return; seen.add(k);
      const isIdeaEdge = ideaNodeIds.has(d.id)||ideaNodeIds.has(tid);
      (isIdeaEdge?ideaEdges:edges).push({source:d.id,target:tid});
    });
    if(isIdea(d)){
      (d.potentialLinks||[]).forEach(tid=>{
        if(!idSet.has(tid)) return;
        const k=[d.id,tid].sort().join('|pot');
        if(seen.has(k)) return; seen.add(k);
        potEdges.push({source:d.id,target:tid});
      });
    }
  });
  const allEdges = [...edges,...ideaEdges];

  // ── Degree ──
  const deg = {};
  nodes.forEach(n=>deg[n.id]=0);
  allEdges.forEach(e=>{deg[e.source]=(deg[e.source]||0)+1;deg[e.target]=(deg[e.target]||0)+1;});
  const nr = d => 8 + (deg[d.id]||0)*2.2;

  // ── Adjacency (for highlight + physics) ──
  const adj = {};
  allEdges.forEach(e=>{
    const s=e.source.id||e.source, t=e.target.id||e.target;
    if(!adj[s]) adj[s]=new Set(); if(!adj[t]) adj[t]=new Set();
    adj[s].add(t); adj[t].add(s);
  });

  // ── Category cluster centers (for initial layout only) ──
  const cats=[...new Set(nodes.map(d=>d[colorMode]||'–'))];
  const catCenters={};
  cats.forEach((cat,i)=>{
    const angle=(i/cats.length)*2*Math.PI-Math.PI/2;
    catCenters[cat]={x:W/2+Math.cos(angle)*Math.min(W,H)*0.32,y:H/2+Math.sin(angle)*Math.min(W,H)*0.32};
  });

  // ── Simulation ──
  // All nodes with saved positions get fx/fy pinned immediately
  // Unsaved nodes float freely and settle via forces
  nodes.forEach(n=>{
    if(nodePos[n.id]){ n.fx=nodePos[n.id].x; n.fy=nodePos[n.id].y; }
  });

  _sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(allEdges).id(d=>d.id).distance(200).strength(0.03))
    .force('charge', d3.forceManyBody().strength(d=>-300-(deg[d.id]||0)*30))
    .force('center', d3.forceCenter(W/2,H/2).strength(hasPositions?0.005:0.04))
    .force('collide', d3.forceCollide().radius(d=>nr(d)+30).strength(0.8))
    .force('clusterX', d3.forceX(d=>{
      const cc=catCenters[d[colorMode]||'–'];
      return (deg[d.id]||0)>4?W/2:(cc?.x??W/2);
    }).strength(hasPositions?0:0.10))
    .force('clusterY', d3.forceY(d=>{
      const cc=catCenters[d[colorMode]||'–'];
      return (deg[d.id]||0)>4?H/2:(cc?.y??H/2);
    }).strength(hasPositions?0:0.10));

  // Stop early if all nodes are pinned (no need to simulate)
  if(nodes.every(n=>n.fx!=null)) { _sim.stop(); }

  // ── Render edges ──
  const potLinkSel = g.append('g').selectAll('line').data(potEdges).join('line')
    .attr('stroke','#f0b429').attr('stroke-opacity',0.5).attr('stroke-width',1.5)
    .attr('stroke-dasharray','5,4').attr('marker-end','url(#arr-pot)');

  const ideaLinkSel = g.append('g').selectAll('line').data(ideaEdges).join('line')
    .attr('stroke','#f0b429').attr('stroke-opacity',0.55).attr('stroke-width',1.5)
    .attr('stroke-dasharray','5,4').attr('marker-end','url(#arr-idea)');

  const linkSel = g.append('g').selectAll('line').data(edges).join('line')
    .attr('stroke','#bbb').attr('stroke-opacity',0.4).attr('stroke-width',1.3)
    .attr('marker-end','url(#arr)');

  // Drag line for link mode
  const dragLine = g.append('line')
    .attr('stroke','var(--teal-light)').attr('stroke-width',2).attr('stroke-dasharray','5,4')
    .attr('opacity',0).attr('marker-end','url(#arr)');

  // ── Render nodes ──
  const pcol = columns.find(c=>c.id==='phase');
  const nodeG = g.append('g').selectAll('g').data(nodes).join('g')
    .style('cursor','pointer')
    .on('mousedown', function(){ d3.select(this).raise(); })
    .on('click',(e,d)=>{
      e.stopPropagation();
      if(selectedNodeId===d.id){ selectedNodeId=null; applyHighlight(null,linkSel,ideaLinkSel,nodeG,adj); }
      else { selectedNodeId=d.id; applyHighlight(d.id,linkSel,ideaLinkSel,nodeG,adj); }
    })
    .on('contextmenu',(e,d)=>{
      e.preventDefault(); e.stopPropagation();
      showStaticTT(e,d,deg,linkSel,nodeG,adj);
    })
    .on('dblclick',(e)=>{ e.stopPropagation(); e.preventDefault(); })
    .call(d3.drag()
      .on('start',(e,d)=>{
        if(linkModeActive){
          _linkDragSource=d;
          dragLine.attr('x1',d.x).attr('y1',d.y).attr('x2',d.x).attr('y2',d.y).attr('opacity',1);
          return;
        }
        // Save undo + original positions of ALL nodes before drag
        pushUndo({type:'move',id:d.id,prevX:nodePos[d.id]?.x??d.x,prevY:nodePos[d.id]?.y??d.y});
        d._dragStartX = d.x;
        d._dragStartY = d.y;
        nodes.forEach(n=>{ n._origX=n.x; n._origY=n.y; });
        if(d._returnAnim){ cancelAnimationFrame(d._returnAnim); d._returnAnim=null; }
      })
      .on('drag',(e,d)=>{
        if(linkModeActive){
          if(_linkDragSource) dragLine.attr('x1',_linkDragSource.x).attr('y1',_linkDragSource.y).attr('x2',e.x).attr('y2',e.y);
          return;
        }
        // Move dragged node
        const ddx = e.x - (d._dragStartX??d.x);
        const ddy = e.y - (d._dragStartY??d.y);
        d.x=e.x; d.y=e.y; d.fx=e.x; d.fy=e.y;

        if(mapPhysicsEnabled){
          // Pull connected neighbors softly (15% of drag delta)
          const nbIds = adj[d.id]||new Set();
          nodes.forEach(n=>{
            if(!nbIds.has(n.id)) return;
            n.x = (n._origX??n.x) + ddx*0.15;
            n.y = (n._origY??n.y) + ddy*0.15;
          });
        }
        tick();
      })
      .on('end',(e,d)=>{
        if(linkModeActive&&_linkDragSource){
          dragLine.attr('opacity',0);
          const svgRect=document.getElementById('mapSvg').getBoundingClientRect();
          const gEl=document.getElementById('mapSvg').querySelector('g');
          const tf=gEl?.getCTM();
          const simX=tf?(e.sourceEvent.clientX-svgRect.left-tf.e)/tf.a:(e.sourceEvent.clientX-svgRect.left);
          const simY=tf?(e.sourceEvent.clientY-svgRect.top-tf.f)/tf.d:(e.sourceEvent.clientY-svgRect.top);
          const hit=nodes.find(n=>{
            if(n.id===_linkDragSource.id) return false;
            const dx=n.x-simX, dy=n.y-simY;
            return Math.sqrt(dx*dx+dy*dy)<nr(n)+20;
          });
          if(hit) createLinkBetween(_linkDragSource.id,hit.id);
          else toast('Kein Knoten getroffen');
          _linkDragSource=null;
          return;
        }

        // Pin dragged node at final position
        nodePos[d.id]={x:d.x,y:d.y};
        persistPos();

        if(mapPhysicsEnabled){
          // Float connected neighbors back to their original positions
          const nbIds = adj[d.id]||new Set();
          // Capture their current (slightly displaced) positions as animation start
          const fromPos={}, toPos={};
          nodes.forEach(n=>{
            if(!nbIds.has(n.id)) return;
            fromPos[n.id]={x:n.x, y:n.y};
            toPos[n.id]={x:n._origX??n.x, y:n._origY??n.y};
          });

          const duration = 800;
          const t0 = performance.now();
          function floatBack(ts){
            const t = Math.min(1, (ts-t0)/duration);
            const ease = 1 - Math.pow(1-t, 3); // ease-out cubic = gentle deceleration
            nodes.forEach(n=>{
              if(!nbIds.has(n.id)||!fromPos[n.id]) return;
              n.x = fromPos[n.id].x + (toPos[n.id].x - fromPos[n.id].x)*ease;
              n.y = fromPos[n.id].y + (toPos[n.id].y - fromPos[n.id].y)*ease;
              if(t>=1){ n.x=toPos[n.id].x; n.y=toPos[n.id].y; n.fx=n.x; n.fy=n.y; }
            });
            tick();
            if(t<1) d._returnAnim = requestAnimationFrame(floatBack);
            else d._returnAnim = null;
          }
          d._returnAnim = requestAnimationFrame(floatBack);
        }
      })
    );

  // Disable double-click zoom
  svg.on('dblclick.zoom',null);

  // Idea glow ring
  nodeG.filter(d=>isIdea(d)).append('circle')
    .attr('r',d=>nr(d)+7).attr('fill','rgba(240,180,41,.12)')
    .attr('stroke','#f0b429').attr('stroke-width',1.5).attr('stroke-opacity',0.5)
    .attr('stroke-dasharray','3,3').attr('pointer-events','none');

  // Status ring
  nodeG.append('circle').attr('r',d=>nr(d)+3.5).attr('fill','none')
    .attr('stroke',d=>{ const o=(pcol?.options||[]).find(x=>x.label===d.phase); return o?.color||'#888'; })
    .attr('stroke-width',2.5).attr('stroke-opacity',0.38).attr('pointer-events','none')
    .attr('class','node-ring');

  // Main circle
  nodeG.append('circle').attr('r',nr)
    .attr('fill',d=>hiddenCats.has(getNodeLabel(d))?'#ccc':getNodeColor(d))
    .attr('fill-opacity',d=>hiddenCats.has(getNodeLabel(d))?0.15:0.88)
    .attr('stroke','#fff').attr('stroke-width',2).attr('class','node-circle');

  // Idea emoji
  nodeG.filter(d=>isIdea(d)).append('text')
    .text('💡').attr('text-anchor','middle').attr('dy',d=>-nr(d)-5)
    .attr('font-size',10).attr('pointer-events','none');

  // Label
  nodeG.append('text')
    .text(d=>{ const w=(d.title||'').split(' '); return(w.slice(0,2).join(' ')+(w.length>2?'…':'')).slice(0,18); })
    .attr('text-anchor','middle').attr('dy',d=>nr(d)+13)
    .attr('font-size',9.5).attr('fill','var(--text-muted)').attr('pointer-events','none')
    .attr('class','node-label');

  // ── Tick function ──
  function tick(){
    linkSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>{
        const dx=d.target.x-d.source.x,dy=d.target.y-d.source.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
        const r=nr(d.target)+3; // stop just outside target circle
        return d.target.x-dx/dist*r;
      })
      .attr('y2',d=>{
        const dx=d.target.x-d.source.x,dy=d.target.y-d.source.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
        const r=nr(d.target)+3;
        return d.target.y-dy/dist*r;
      });
    ideaLinkSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    potLinkSel.attr('x1',d=>{const n=nodes.find(x=>x.id===(d.source.id||d.source));return n?.x||0;})
              .attr('y1',d=>{const n=nodes.find(x=>x.id===(d.source.id||d.source));return n?.y||0;})
              .attr('x2',d=>{const n=nodes.find(x=>x.id===(d.target.id||d.target));return n?.x||0;})
              .attr('y2',d=>{const n=nodes.find(x=>x.id===(d.target.id||d.target));return n?.y||0;});
    nodeG.attr('transform',d=>`translate(${d.x},${d.y})`);
    // Save positions of unpinned nodes as simulation settles
    if(W>100&&H>100) nodes.forEach(n=>{ if(n.x>50&&n.y>50&&n.x<W*2&&n.y<H*2&&!isNaN(n.x)&&!isNaN(n.y)) { if(!nodePos[n.id]||n.fx==null) nodePos[n.id]={x:n.x,y:n.y}; } });
  }

  _sim.on('tick', tick);
  _sim.on('end', ()=>{ persistPos(); });
  // Force initial tick so fixed nodes get their transform set immediately
  tick();

  // ── Zoom ──
  mapZoom = d3.zoom().scaleExtent([0.08,6]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(mapZoom);
  // Restore previous zoom/pan if map was rebuilt due to filter change
  if(_savedTransform && (_savedTransform.k !== 1 || _savedTransform.x !== 0 || _savedTransform.y !== 0)) {
    svg.call(mapZoom.transform, _savedTransform);
  }
  svg.on('dblclick.zoom',null);
  svg.on('click',()=>{ selectedNodeId=null; applyHighlight(null,linkSel,ideaLinkSel,nodeG,adj); hideTT(); });

  // Re-apply selection if one was active
  if(selectedNodeId) setTimeout(()=>applyHighlight(selectedNodeId,linkSel,ideaLinkSel,nodeG,adj),100);

  buildLegend();
}

// ─── Highlight ────────────────────────────────────────────────────────────────
function applyHighlight(nodeId, linkSel, ideaLinkSel, nodeG, adj) {
  if(!nodeId){
    nodeG.selectAll('.node-circle').attr('fill-opacity',d=>hiddenCats.has(getNodeLabel(d))?0.15:0.88);
    nodeG.selectAll('.node-ring').attr('stroke-opacity',0.38);
    nodeG.selectAll('.node-label').attr('fill','var(--text-muted)').attr('font-weight','normal');
    linkSel.attr('stroke','#bbb').attr('stroke-opacity',0.4).attr('stroke-width',1.3).attr('marker-end','url(#arr)');
    ideaLinkSel.attr('stroke-opacity',0.55);
    return;
  }
  const nb = adj[nodeId]||new Set();
  nodeG.selectAll('.node-circle').attr('fill-opacity',d=>d.id===nodeId?1:nb.has(d.id)?0.9:0.12);
  nodeG.selectAll('.node-ring').attr('stroke-opacity',d=>d.id===nodeId?0.9:nb.has(d.id)?0.6:0.08);
  nodeG.selectAll('.node-label')
    .attr('fill',d=>(d.id===nodeId||nb.has(d.id))?'var(--text)':'var(--text-faint)')
    .attr('font-weight',d=>d.id===nodeId?'600':'normal');
  // Outgoing links (from selected node) = teal/accent, Incoming links (to selected node) = blue
  linkSel.attr('stroke',d=>{
      const s=d.source.id||d.source,t=d.target.id||d.target;
      if(s===nodeId) return'var(--accent-mid)'; // outgoing → teal
      if(t===nodeId) return'var(--blue)';        // incoming → blue
      return'#bbb';
    })
    .attr('stroke-opacity',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?0.9:0.06;})
    .attr('stroke-width',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?2.5:1;})
    .attr('marker-end',d=>{
      const s=d.source.id||d.source,t=d.target.id||d.target;
      if(s===nodeId) return'url(#arr-accent)'; // outgoing → teal arrow
      if(t===nodeId) return'url(#arr-blue)';   // incoming → blue arrow
      return'url(#arr)';
    });
  ideaLinkSel.attr('stroke-opacity',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?0.9:0.06;});
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function buildLegend(){
  const el=document.getElementById('legendItems'); if(!el) return; el.innerHTML='';
  const col=columns.find(c=>c.id===colorMode); if(!col) return;
  (col.options||[]).forEach(opt=>{
    const used=data.some(d=>d[col.id]===opt.label); if(!used) return;
    const div=document.createElement('div');
    div.className='legend-item'+(hiddenCats.has(opt.label)?' muted':'');
    div.onclick=()=>{hiddenCats.has(opt.label)?hiddenCats.delete(opt.label):hiddenCats.add(opt.label);renderMap();};
    div.innerHTML=`<span class="legend-dot" style="background:${opt.color}"></span><span style="color:var(--text-muted)">${esc(opt.label)}</span>`;
    el.appendChild(div);
  });
  const n=document.createElement('div');
  n.style.cssText='font-size:10px;color:var(--text-faint);margin-top:7px;border-top:1px solid var(--border);padding-top:5px';
  n.innerHTML='Rechtsklick = Details · 🔗 = Verknüpfen';
  el.appendChild(n);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function showStaticTT(event,d,deg,linkSel,nodeG,adj){
  const wrap=document.getElementById('mapWrap'); if(!wrap) return;
  const r=wrap.getBoundingClientRect();
  const tt=document.getElementById('mapTooltip'); if(!tt) return;
  const col=columns.find(c=>c.id===colorMode);
  const colVal=d[colorMode]||'';
  const colOpt=(col?.options||[]).find(o=>o.label===colVal);
  const linkedTo=(d.internalLinks||[]).map(id=>{const t=data.find(x=>x.id===id);return t?.title||'';}).filter(Boolean);
  tt.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
      <div class="tt-title">${esc(d.title)}</div>
      <button onclick="openDrawer('${d.id}');hideTT()" style="font-size:11px;padding:2px 8px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✏️ Bearbeiten</button>
    </div>
    ${colVal?`<div class="tt-row"><span class="cell-tag" style="background:${colOpt?.color||'#888'}22;color:${colOpt?.color||'#888'}">${esc(colVal)}</span></div>`:''}
    <div class="tt-row">Verbindungen: <span style="color:var(--text)">${deg[d.id]||0}</span></div>
    ${linkedTo.length?`<div class="tt-row">→ ${linkedTo.slice(0,5).map(t=>`<span style="color:var(--text)">${esc(t.slice(0,30))}</span>`).join('<br>→ ')}</div>`:''}
    <div style="font-size:10px;color:var(--text-faint);margin-top:6px;border-top:1px solid var(--border);padding-top:5px">Linksklick außerhalb zum Schließen</div>`;
  let x=event.clientX-r.left+14, y=event.clientY-r.top-10;
  if(x+270>r.width) x=event.clientX-r.left-280;
  if(y+280>r.height) y=Math.max(10,event.clientY-r.top-290);
  tt.style.left=x+'px'; tt.style.top=y+'px'; tt.style.opacity='1';
}
function hideTT(){ const tt=document.getElementById('mapTooltip'); if(tt) tt.style.opacity='0'; }
function moveTT(){}

// ═══════════════════════════════════════════
// DRAWER
// ═══════════════════════════════════════════
function openDrawer(id) {
  const item = data.find(d=>d.id===id);
  if (!item) return;
  drawerItem = item;
  drawerKws = [...(item.kws||[])];
  drawerLinks = [...(item.internalLinks||[])];
  drawerPotLinks = [...(item.potentialLinks||[])];
  document.getElementById('drawerTitle').textContent = item.title || 'Eintrag bearbeiten';
  const meta = document.getElementById('drawerMeta');
  if (item.updatedAt) {
    meta.style.display = 'block';
    const d = new Date(item.updatedAt);
    meta.textContent = `Zuletzt bearbeitet: ${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  } else { meta.style.display = 'none'; }
  renderDrawerBody(item);
  document.getElementById('deleteBtn').style.display = appSession.isReadOnly || appSession.currentProfile?.role!=='admin' ? 'none' : 'inline-block';
  document.getElementById('saveBtn').disabled = appSession.isReadOnly;
  document.getElementById('overlay').classList.add('open');
}

function openNewDrawer() {
  if (appSession.isReadOnly) { toast('Nur Editoren können Inhalte erstellen.'); return; }
  drawerItem = null;
  drawerKws = [];
  drawerLinks = [];
  drawerPotLinks = [];
  document.getElementById('drawerTitle').textContent = 'Neuer Inhalt';
  document.getElementById('drawerMeta').style.display = 'none';
  renderDrawerBody(null);
  document.getElementById('deleteBtn').style.display = 'none';
  document.getElementById('saveBtn').disabled = false;
  document.getElementById('overlay').classList.add('open');
}

function renderDrawerBody(item) {
  const body = document.getElementById('drawerBody');
  /** Gleiche Logik wie in Tabelle/Kanban/Map: explizite Flag ODER Phase (inkl. Fallback „Idee“). */
  const ideaFlag = item ? isIdea(item) : false;
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;background:${ideaFlag?'rgba(240,180,41,.12)':'var(--surface2)'};border:1px solid ${ideaFlag?'#f0b429':'var(--border)'};border-radius:var(--radius);padding:10px 14px;margin-bottom:14px">
    <div>
      <div style="font-size:13px;font-weight:600;color:${ideaFlag?'#8a6000':'var(--text)'}">💡 Als Idee markieren</div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Ideen werden gelb hervorgehoben und können potenzielle Links haben</div>
    </div>
    <label style="cursor:pointer;flex-shrink:0">
      <div onclick="toggleDrawerIdea(this)" data-on="${ideaFlag?'1':'0'}" style="width:36px;height:20px;border-radius:10px;background:${ideaFlag?'#f0b429':'var(--border-mid)'};position:relative;transition:background .2s;cursor:pointer">
        <div style="position:absolute;top:2px;left:${ideaFlag?'16':'2'}px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div>
      </div>
    </label>
  </div>`;
  // All columns (including invisible ones)
  const allCols = columns.filter(c => !['internalLinks','createdBy','kws'].includes(c.id));
  // Show createdBy if set
  const createdByVal = item?.createdBy || '';

  // CreatedBy badge
  if (createdByVal) {
    html += `<div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;display:flex;align-items:center;gap:5px">
      <span>👤 Erstellt von:</span>
      <span style="font-weight:500;color:var(--text-muted)">${esc(createdByVal)}</span>
    </div>`;
  }

  allCols.forEach(col => {
    const val = item ? (item[col.id] || '') : '';
    html += `<div class="form-row"><label>${esc(col.name)}</label>`;
    if (col.type === 'select') {
      const opts = (col.options||[]).map(o=>`<option value="${esc(o.label)}" ${val===o.label?'selected':''}>${esc(o.label)}</option>`).join('');
      html += `<select id="df_${col.id}"><option value="">– wählen –</option>${opts}</select>`;
    } else if (col.type === 'multiselect') {
      html += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px" id="ms_${col.id}">`;
      // Handle both arrays and legacy strings
      const vals = Array.isArray(val) ? val : (val ? [val] : []);
      (col.options||[]).forEach(o => {
        const checked = vals.includes(o.label);
        html += `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;background:${o.color}22;border:1px solid ${o.color}55;padding:3px 9px;border-radius:20px;color:${o.color}">
          <input type="checkbox" value="${esc(o.label)}" ${checked?'checked':''} style="margin:0"> ${esc(o.label)}</label>`;
      });
      html += `</div>`;
    } else if (col.type === 'date') {
      html += `<input type="date" id="df_${col.id}" value="${esc(val)}">`;
    } else if (col.type === 'number') {
      html += `<input type="number" id="df_${col.id}" value="${esc(val)}">`;
    } else if (col.type === 'url') {
      html += `<input type="url" id="df_${col.id}" value="${esc(val)}" placeholder="https://…">`;
    } else {
      const isNotes = col.id === 'notes';
      if (isNotes) {
        html += `<textarea id="df_${col.id}" rows="3">${esc(val)}</textarea>`;
      } else {
        html += `<input type="text" id="df_${col.id}" value="${esc(val)}">`;
      }
    }
    html += `</div>`;
  });

  // Keywords section removed — user manages via custom categories

  // Potential links (ideas)
  if (isIdea(item||{})) {
    html += `<div class="section-heading">💡 Potenzielle Verlinkungen</div>
    <div class="form-row">
      <label>Potenzielle Links (Freitext)</label>
      <textarea id="df_potentialLinksText" rows="2" placeholder="z.B. → ModPCB Seite, → Blog KI">${esc((item?.potentialLinksText)||'')}</textarea>
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">Werden als gestrichelte Linien in der Link Map angezeigt</div>
    </div>
    <div class="form-row">
      <label>Potenzielle Links (Seiten auswählen)</label>
      <div class="link-chips" id="drawerPotLinkChips"></div>
      <div class="add-row" style="margin-top:6px">
        <select id="drawerPotLinkSelect" style="flex:1;padding:6px 9px;border:1px solid var(--border-mid);border-radius:var(--radius);font-family:var(--sans);font-size:13px;color:var(--text);background:var(--surface);outline:none">
          <option value="">— Seite wählen —</option>
          ${data.filter(d=>d.id!==item?.id).sort((a,b)=>a.title.localeCompare(b.title,'de')).map(d=>`<option value="${d.id}">${esc(d.title.slice(0,52))}</option>`).join('')}
        </select>
        <button class="btn-ghost" onclick="addDrawerPotLink()" style="font-size:12px">+ Link</button>
      </div>
    </div>`;
  }

  // Internal links — with filter by first select column + search
  {
    // First select-type column after title (e.g. "Format")
    const filterCol = columns.find(c => c.type === 'select' && c.id !== 'title');
    const filterOpts = filterCol ? (filterCol.options||[]).map(o=>o.label) : [];
    const filterSelectHtml = filterCol ? `
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
        <label style="font-size:11px;color:var(--text-muted);white-space:nowrap">${esc(filterCol.name)}:</label>
        <select id="drawerLinkFilter" onchange="filterDrawerLinkOptions()" style="flex:1;padding:4px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
          <option value="">Alle</option>
          ${filterOpts.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('')}
        </select>
        <input type="text" id="drawerLinkSearch" oninput="filterDrawerLinkOptions()" placeholder="🔍 Suchen…" style="flex:2;padding:4px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
      </div>` : `
      <div style="margin-bottom:6px">
        <input type="text" id="drawerLinkSearch" oninput="filterDrawerLinkOptions()" placeholder="🔍 Suchen…" style="width:100%;box-sizing:border-box;padding:5px 9px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
      </div>`;
    html += `<div class="section-heading">🔗 Interne Verlinkungen</div>
      <div class="form-row">
        <div class="link-chips" id="drawerLinkChips"></div>
        ${filterSelectHtml}
        <div class="add-row" style="margin-top:0">
          <select id="drawerLinkSelect" style="flex:1;padding:6px 9px;border:1px solid var(--border-mid);border-radius:var(--radius);font-family:var(--sans);font-size:13px;color:var(--text);background:var(--surface);outline:none">
            <option value="">— Seite wählen —</option>
            ${data.filter(d=>d.id!==item?.id).sort((a,b)=>a.title.localeCompare(b.title,'de')).map(d=>`<option value="${d.id}" data-filter="${esc(d[filterCol?.id]||'')}">${esc(d.title.slice(0,52))}</option>`).join('')}
          </select>
          <button class="btn-ghost" onclick="addDrawerLink()" style="font-size:12px">+ Link</button>
        </div>
      </div>`;
  }

  body.innerHTML = html;

  renderDrawerKws(); // kept for backwards compat
  renderDrawerLinks();
  setTimeout(renderDrawerPotLinks, 0);
  if (!appSession.isReadOnly) body.querySelectorAll('input,select,textarea').forEach(el=>el.removeAttribute('disabled'));
  else body.querySelectorAll('input,select,textarea').forEach(el=>el.setAttribute('disabled',''));
}

function toggleDrawerIdea(el) {
  const on = el.getAttribute('data-on') === '1';
  const newOn = !on;
  el.setAttribute('data-on', newOn?'1':'0');
  el.style.background = newOn ? '#f0b429' : 'var(--border-mid)';
  el.querySelector('div').style.left = newOn ? '16px' : '2px';
  const wrap = el.closest('div[style]');
  if (wrap) {
    wrap.style.background = newOn ? 'rgba(240,180,41,.12)' : 'var(--surface2)';
    wrap.style.borderColor = newOn ? '#f0b429' : 'var(--border)';
    const title = wrap.querySelector('div[style*="font-weight:600"]');
    if (title) title.style.color = newOn ? '#8a6000' : 'var(--text)';
  }
}

function renderDrawerKws() {
  const el = document.getElementById('drawerKwList');
  if (!el) return;
  el.innerHTML = drawerKws.map((kw,i)=>`<span class="kw-tag">${esc(kw)}<button onclick="removeDrawerKw(${i})">✕</button></span>`).join('');
}
function addDrawerKw() {
  const inp = document.getElementById('drawerKwInput');
  const v = inp.value.trim();
  if (!v || drawerKws.includes(v)) { inp.value=''; return; }
  drawerKws.push(v); inp.value=''; renderDrawerKws();
}
function removeDrawerKw(i) { drawerKws.splice(i,1); renderDrawerKws(); }

function filterDrawerLinkOptions() {
  const sel = document.getElementById('drawerLinkSelect');
  const filterVal = document.getElementById('drawerLinkFilter')?.value || '';
  const searchVal = (document.getElementById('drawerLinkSearch')?.value || '').toLowerCase().trim();
  if (!sel) return;
  [...sel.options].forEach(opt => {
    if (!opt.value) return; // keep "— Seite wählen —"
    const matchFilter = !filterVal || opt.dataset.filter === filterVal;
    const matchSearch = !searchVal || opt.text.toLowerCase().includes(searchVal);
    opt.hidden = !(matchFilter && matchSearch);
  });
  // Reset selection if hidden
  if (sel.selectedOptions[0]?.hidden) sel.value = '';
}

function renderDrawerLinks() {
  const el = document.getElementById('drawerLinkChips');
  if (!el) return;
  el.innerHTML = drawerLinks.map((id,i)=>{
    const t = data.find(d=>d.id===id);
    return `<span class="link-chip">🔗 ${esc((t?.title||'?').slice(0,34))}<button onclick="removeDrawerLink(${i})">✕</button></span>`;
  }).join('');
}
function addDrawerLink() {
  const sel = document.getElementById('drawerLinkSelect');
  const v = sel.value;
  if (!v || drawerLinks.includes(v)) return;
  drawerLinks.push(v); sel.value=''; renderDrawerLinks();
}
function removeDrawerLink(i) { drawerLinks.splice(i,1); renderDrawerLinks(); }

// Potential links (ideas/planning)
let drawerPotLinks = [];
function renderDrawerPotLinks() {
  const el = document.getElementById('drawerPotLinkChips');
  if (!el) return;
  el.innerHTML = drawerPotLinks.map((id,i)=>{
    const t = data.find(d=>d.id===id);
    return `<span class="link-chip" style="background:rgba(240,180,41,.15);color:#8a6000;border:1px dashed #f0b429">⚡ ${esc((t?.title||'?').slice(0,34))}<button onclick="removeDrawerPotLink(${i})" style="color:#8a6000">✕</button></span>`;
  }).join('');
}
function addDrawerPotLink() {
  const sel = document.getElementById('drawerPotLinkSelect');
  if (!sel) return;
  const v = sel.value;
  if (!v || drawerPotLinks.includes(v)) return;
  drawerPotLinks.push(v); sel.value=''; renderDrawerPotLinks();
}
function removeDrawerPotLink(i) { drawerPotLinks.splice(i,1); renderDrawerPotLinks(); }

function getDrawerValues() {
  const body = document.getElementById('drawerBody');
  const item = {};
  columns.forEach(col => {
    if (col.id === 'internalLinks') return;
    if (col.type === 'multiselect') {
      const checks = body.querySelectorAll(`#ms_${col.id} input[type=checkbox]:checked`);
      item[col.id] = [...checks].map(c=>c.value);
    } else {
      const el = body.querySelector(`#df_${col.id}`);
      if (el) item[col.id] = el.value;
    }
  });
  item.kws = [...drawerKws];
  item.internalLinks = [...drawerLinks];
  item.potentialLinks = [...drawerPotLinks];
  const ideaToggle = document.querySelector('[data-on]');
  item.isIdeaFlag = ideaToggle?.getAttribute('data-on') === '1';
  const ptText = document.getElementById('df_potentialLinksText');
  if (ptText) item.potentialLinksText = ptText.value;
  return item;
}

/** Wenn der Nutzer „Als Idee“ ausschaltet, Phase-Werte entfernen, die allein die Idee-Anzeige triggern (sonst bleibt die Zeile gelb). */
function stripIdeaPhaseIfIdeaToggledOff(vals) {
  if (vals.isIdeaFlag) return;
  const phaseCol = columns.find((c) => c.id === 'phase');
  if (phaseCol?.type === 'multiselect' && Array.isArray(vals.phase)) {
    const ideaLabels = (phaseCol.options || []).filter((o) => o.isIdea).map((o) => o.label);
    if (ideaLabels.length) vals.phase = vals.phase.filter((l) => !ideaLabels.includes(l));
  } else {
    const p = vals.phase;
    if (p === 'Idee' || p === 'Idea') {
      vals.phase = '';
    } else if (typeof p === 'string' && p && phaseCol?.type === 'select') {
      const opt = (phaseCol.options || []).find((o) => o.label === p);
      if (opt?.isIdea) vals.phase = '';
    }
  }
}

function itemToRow(item, options = {}) {
  const { forInsert = false } = options;
  return itemToDbRow(item, {
    forInsert,
    currentProfile: appSession.currentProfile,
    currentUser: appSession.currentUser,
  });
}

function _sortDataByTitle() {
  data.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'de', { sensitivity: 'base' }));
}

/** Kein Web-Standard — Kompromiss: genug für schwaches Mobilnetz, aber nicht ewig „Speichere…“. */
const SAVE_NETWORK_TIMEOUT_MS = 15000;

async function saveEntry() {
  try {
    const vals = getDrawerValues();
    stripIdeaPhaseIfIdeaToggledOff(vals);
    if (!vals.title) { toast('Bitte Titel eingeben'); return; }
    const row = itemToRow({ ...(drawerItem || {}), ...vals }, { forInsert: !drawerItem });
    setSyncStatus('loading','Speichere…');
    // Save scroll before DB write (realtime may still trigger re-render)
    preserveTableScrollPosition();
    const dbPromise = drawerItem
      ? appSession.sb.from('content_items').update(row).eq('id', drawerItem.id).select('*').maybeSingle()
      : appSession.sb.from('content_items').insert(row).select('*').maybeSingle();
    let res;
    try {
      res = await withTimeout(dbPromise, SAVE_NETWORK_TIMEOUT_MS, '__save_timeout__');
    } catch (e) {
      if (e?.message === '__save_timeout__') {
        setSyncStatus('error', 'Zeitüberschreitung');
        toast('Keine Antwort vom Server. Verbindung prüfen oder Seite neu laden (F5).');
        return;
      }
      throw e;
    }
    const { data: savedRow, error } = res;
    if (error) { setSyncStatus('error','Fehler'); toast('Fehler: '+error.message); return; }
    if (savedRow) {
      const savedItem = rowToItem(savedRow);
      if (drawerItem) {
        const idx = data.findIndex((d) => d.id === drawerItem.id);
        if (idx >= 0) data[idx] = savedItem;
      } else {
        data.push(savedItem);
        _sortDataByTitle();
      }
      render();
    } else {
      try {
        await withTimeout(loadData({ quiet: true }), SAVE_NETWORK_TIMEOUT_MS, '__save_timeout__');
      } catch (e) {
        if (e?.message === '__save_timeout__') {
          setSyncStatus('error', 'Zeitüberschreitung');
          toast('Keine Antwort vom Server. Verbindung prüfen oder Seite neu laden (F5).');
          return;
        }
        throw e;
      }
    }
    setSyncStatus('ok', 'Gespeichert');
    closeDrawer();
    toast(drawerItem ? 'Gespeichert ✓' : 'Erstellt ✓');
    notifyOtherTabsContentChanged();
  } catch (err) {
    console.error(err);
    setSyncStatus('error','Fehler');
    toast('Speichern fehlgeschlagen: ' + (err?.message || String(err)));
  }
}

async function deleteEntry() {
  if (!drawerItem) return;
  if (appSession.currentProfile?.role !== 'admin') { toast('Nur Admins können löschen.'); return; }
  showConfirm('Eintrag wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.', async () => {
    const {error} = await appSession.sb.from('content_items').delete().eq('id', drawerItem.id);
    if (error) { toast('Fehler: '+error.message); return; }
    closeDrawer(); toast('Gelöscht');
  }, 'Eintrag löschen');
  return; // actual delete happens in callback
// handled in showConfirm callback
}

function closeDrawer() { document.getElementById('overlay').classList.remove('open'); }
function closeDrawerOnBg(e) { if(e.target===document.getElementById('overlay')) closeDrawer(); }

// ═══════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════
function setView(v){
  if (v !== currentView) clearSelectionOnViewChange();
  currentView=v;
  ['table','kanban','map'].forEach(n=>document.getElementById('view'+n.charAt(0).toUpperCase()+n.slice(1)).classList.toggle('active',v===n));
  const isMap = v==='map';
  document.getElementById('searchWrap').style.visibility = isMap?'hidden':'visible';
  const kgw = document.getElementById('kanbanGroupByWrap');
  if(kgw) kgw.style.display = v==='kanban' ? 'flex' : 'none';
  const rhw = document.getElementById('rowHeightWrap');
  if(rhw) { rhw.style.display = v==='table' ? 'flex' : 'none'; }
  const slider = document.getElementById('rowHeightSlider');
  if (slider && v === 'table') slider.value = getCurrentRowHeight();
  if(v==='kanban') populateKanbanGroupBy();
  render();
}

function initViewControls() {
  // Call on boot to set correct initial state for table view
  const rhw = document.getElementById('rowHeightWrap');
  if(rhw) rhw.style.display = 'flex';
  const slider = document.getElementById('rowHeightSlider');
  if (slider) slider.value = getCurrentRowHeight();
  const kgw = document.getElementById('kanbanGroupByWrap');
  if(kgw) kgw.style.display = 'none';
}
function cycleSortBy(colId) {
  if(sortColId === colId) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortColId = colId;
    sortDir = 'asc';
  }
  render();
}

document.getElementById('exportBtn').onclick = (e) => {
  e.stopPropagation();
  document.getElementById('exportPanel')?.classList.toggle('open');
};
document.addEventListener('click', closeExport);
document.getElementById('exportPanel')?.addEventListener('click', (e) => e.stopPropagation());
// Direkt gebunden: gleiche Ursache wie früher beim Speichern-Button — Inline-onclick + async/Modul.
document.getElementById('saveBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  void saveEntry();
});
document.getElementById('bulkApplyBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  void applyBulkEdit();
});
document.getElementById('bulkDeleteBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  void bulkDelete();
});
document.getElementById('bulkClearBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearBulkSelection();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDrawer();closeColModal();}
  if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();openNewDrawer();}
  if((e.metaKey||e.ctrlKey)&&e.key==='z'){
    e.preventDefault();
    if(currentView==='map') undoMapAction();
  }
});

// ═══════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════
/** Inline onclick/onchange in index.html + innerHTML: ES-Module haben kein globales `window` – hier explizit anbinden. */
function attachInlineHandlers() {
  Object.assign(window, {
    COL_STORE,
    DATA_STORE,
    RECENT_ACCOUNTS_KEY,
    ROW_HEIGHT_KEY,
    MAP_PRESETS_KEY,
    MAP_POS_KEY,
    LEGACY_MAP_POSITIONS_KEY,
    addDrawerLink,
    addDrawerPotLink,
    addEditOption,
    addOption,
    applyBulkEdit,
    applyBulkMultiselect,
    bulkDelete,
    cancelEditColumn,
    clearBulkSelection,
    closeAdminPanel,
    closeColModal,
    closeDrawer,
    closeDrawerOnBg,
    closeExport,
    createColumn,
    cycleSortBy,
    deleteEntry,
    deletePreset,
    doLogin,
    doLogout,
    exportCSV,
    exportJSON,
    filterDrawerLinkOptions,
    handleImportFile,
    hideTT,
    loadColumns,
    loadPreset,
    onBulkFieldChange,
    onEditColTypeChange,
    onNewColTypeChange,
    openAdminPanelFromMenu,
    openColModal,
    openDrawer,
    openNewDrawer,
    removeDrawerKw,
    removeDrawerLink,
    removeDrawerPotLink,
    removeEditOption,
    removeOption,
    render,
    renderColList,
    saveEditColumn,
    saveEntry,
    setIdeaMode,
    setView,
    showConfirm,
    switchAccount,
    toggleDrawerIdea,
    toggleLinkMode,
    toggleMapPhysics,
    togglePresetPanel,
    toggleSignup,
    toggleSelectAll,
    toggleUserMenu,
    undoMapAction,
    updateUserRole,
    zoomIn,
    zoomOut,
    toast,
    renderMap,
    setRowHeight,
  });
  Object.defineProperty(window, 'activeFilterColId', {
    get() { return activeFilterColId; },
    set(v) { activeFilterColId = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'activeFilter', {
    get() { return activeFilter; },
    set(v) { activeFilter = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'ideaMode', {
    get() { return ideaMode; },
    set(v) { ideaMode = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'colorMode', {
    get() { return colorMode; },
    set(v) { colorMode = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'hiddenCats', {
    get() { return hiddenCats; },
    set(v) { hiddenCats = v; },
    configurable: true,
  });
}

async function boot() {
  if (typeof SUPABASE_URL==='undefined'||SUPABASE_URL==='YOUR_SUPABASE_URL') {
    document.body.innerHTML='<div style="padding:40px;font-family:sans-serif;color:#c0392b">⚠️ Bitte config.js ausfüllen!</div>';
    return;
  }
  appSession.sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: window.localStorage,
      storageKey: getSupabaseAuthStorageKey(),
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  loadColumns();

  // One-time cleanup: remove bad map positions saved by old buggy builds
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_MAP_POSITIONS_KEY)||'{}');
    const clean = {};
    let removed = 0;
    Object.entries(raw).forEach(([k,v]) => {
      if(v && isFinite(v.x) && isFinite(v.y) && v.x > 20 && v.y > 20) clean[k] = v;
      else removed++;
    });
    if(removed > 0) {
      localStorage.setItem(LEGACY_MAP_POSITIONS_KEY, JSON.stringify(clean));
      console.log('Cleaned', removed, 'bad map positions from localStorage');
    }
  } catch(e) {}

  const { data: { session: supaSession } } = await appSession.sb.auth.getSession();
  if (supaSession) {
    appSession.currentUser = supaSession.user;
    document.getElementById('appShell').style.display='flex';
    await loadProfile(appSession.currentUser.id);
    await syncColumnsFromSupabase(); // sync categories from Supabase
    initViewControls();
    await loadData();
    await runPruneStaleCategoryValues();
    subscribeRealtime();
  } else {
    document.getElementById('login-screen').classList.add('visible');
  }

  appSession.sb.auth.onAuthStateChange(async (event, supaSession) => {
    if (event === 'SIGNED_IN' && supaSession) {
      appSession.currentUser = supaSession.user;
      document.getElementById('login-screen').classList.remove('visible');
      document.getElementById('appShell').style.display='flex';
      await loadProfile(appSession.currentUser.id);
      await syncColumnsFromSupabase(); // sync categories from Supabase
      initViewControls();
      try {
        await loadData();
      } catch (e) {
        console.error(e);
        toast('Daten konnten nicht geladen werden. Bitte Seite neu laden (F5) oder neu anmelden.');
      }
      await runPruneStaleCategoryValues();
      subscribeRealtime();
    }
    if (event === 'SIGNED_OUT') {
      realtimeChannels.forEach((ch) => {
        try { appSession.sb.removeChannel(ch); } catch (e) { /* ignore */ }
      });
      realtimeChannels = [];
      appSession.currentUser = null;
      appSession.currentProfile = null;
      document.getElementById('appShell').style.display = 'none';
      document.getElementById('login-screen').classList.add('visible');
    }
  });
}
initContentSyncChannel();
initTabReturnRecovery();
setTableAppHooks({
  getData: () => data,
  render,
  loadData,
  itemToRow,
  isIdea,
  getSortColId: () => sortColId,
  getSortDir: () => sortDir,
  getBulkOperationRunning: () => bulkOperationRunning,
  setBulkOperationRunning: (v) => { bulkOperationRunning = v; },
  openDrawer,
  notifyPeers: notifyOtherTabsContentChanged,
});
setKanbanHooks({ isIdea, openDrawer });
setImportExportHooks({
  getData: () => data,
  itemToRow,
  loadData,
  isIdea,
  notifyPeers: notifyOtherTabsContentChanged,
});
setColumnsAppHooks({ render, runPruneStaleCategoryValues });
attachInlineHandlers();
boot();
