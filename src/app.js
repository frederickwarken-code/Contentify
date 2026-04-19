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
setColumnsAppHooks({ render, runPruneStaleCategoryValues });
attachInlineHandlers();
boot();
