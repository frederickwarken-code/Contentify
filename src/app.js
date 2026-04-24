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
import { esc, toast, showConfirm, closeExport, setSyncStatus } from './app/lib.js';
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
import {
  setDrawerHooks,
  openDrawer,
  openNewDrawer,
  addDrawerLink,
  addDrawerPotLink,
  removeDrawerKw,
  removeDrawerLink,
  removeDrawerPotLink,
  filterDrawerLinkOptions,
  saveEntry,
  deleteEntry,
  closeDrawer,
  closeDrawerOnBg,
  toggleDrawerIdea,
} from './app/drawer.js';
import {
  setMapHooks,
  renderMap,
  buildGraph,
  toggleLinkMode,
  toggleMapPhysics,
  undoMapAction,
  zoomIn,
  zoomOut,
  hideTT,
  loadPreset,
  deletePreset,
  togglePresetPanel,
} from './app/map.js';

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
let onlineUsers = {}; // { userId: { display_name, color } } — realtime presence
let sortColId = 'title'; // which column to sort by
let sortDir = 'asc';     // 'asc' or 'desc'
let realtimeChannels = [];
/** True während Mehrfachänderungen — blockiert parallele Realtime-Refreshes (verhindert Sync-„Loops“). */
let bulkOperationRunning = false;

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

function itemToRow(item, options = {}) {
  const { forInsert = false } = options;
  return itemToDbRow(item, {
    forInsert,
    currentProfile: appSession.currentProfile,
    currentUser: appSession.currentUser,
  });
}

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
setMapHooks({
  getData: () => data,
  getIdeaMode: () => ideaMode,
  getActiveFilter: () => activeFilter,
  setActiveFilter: (v) => { activeFilter = v; },
  getActiveFilterColId: () => activeFilterColId,
  setActiveFilterColId: (v) => { activeFilterColId = v; },
  getColorMode: () => colorMode,
  setColorMode: (v) => { colorMode = v; },
  getHiddenCats: () => hiddenCats,
  render,
  renderSidebar,
  isIdea,
  notifyPeers: notifyOtherTabsContentChanged,
});
setDrawerHooks({
  getData: () => data,
  setData: (next) => { data = next; },
  isIdea,
  render,
  loadData,
  itemToRow,
  notifyPeers: notifyOtherTabsContentChanged,
});
setColumnsAppHooks({ render, runPruneStaleCategoryValues });
attachInlineHandlers();
boot();
