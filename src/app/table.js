/**
 * Tabellenansicht: Zeilenauswahl, Bulk-Bar, Inline-Zellenedit, Zeilenhöhe, Spaltenbreite.
 */
import { columns } from './columns.js';
import { ROW_HEIGHT_KEY } from './storage-keys.js';
import { esc, toast, showConfirm, setSyncStatus } from './lib.js';
import { appSession } from './session.js';
import { normalizeMultiselectToOptions, sameMultiValue } from './field-normalize.js';

let _hooks = {
  getData: () => [],
  render: () => {},
  loadData: async () => {},
  itemToRow: () => ({}),
  isIdea: () => false,
  getSortColId: () => 'title',
  getSortDir: () => 'asc',
  getBulkOperationRunning: () => false,
  setBulkOperationRunning: () => {},
  openDrawer: () => {},
  notifyPeers: () => {},
};

/** Muss vor erster Tabellen-Render aufgerufen werden (Daten + Callbacks aus app.js). */
export function setTableAppHooks(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

function notifyPeersIfAny() {
  try {
    _hooks.notifyPeers?.();
  } catch (e) { /* ignore */ }
}

const selectedIds = new Set();
let _lastCheckedIndex = -1;
let _preservedScroll = 0;

function _getScrollEl() {
  return document.querySelector('.tbl-wrap') || document.getElementById('contentArea');
}

/** Vor Drawer-Speichern / Map-Verknüpfung: Scroll der Tabelle merken (Realtime-Re-Render). */
export function preserveTableScrollPosition() {
  const el = _getScrollEl();
  if (el) _preservedScroll = el.scrollTop;
}

let currentRowHeight = parseInt(localStorage.getItem(ROW_HEIGHT_KEY) || '34', 10);

export function getCurrentRowHeight() {
  return currentRowHeight;
}

export function clearSelectionOnViewChange() {
  selectedIds.clear();
  _lastCheckedIndex = -1;
  updateBulkBar();
}

export function renderTable(items, area) {
  const sortColId = _hooks.getSortColId();
  const sortDir = _hooks.getSortDir();
  const contentArea = _getScrollEl();
  const scrollTop = Math.max(contentArea?.scrollTop || 0, _preservedScroll);
  if (contentArea?.scrollTop > 0) _preservedScroll = contentArea.scrollTop;
  const visCols = columns.filter((c) => c.visible);
  let html = `<div class="tbl-wrap"><table><thead><tr>`;
  html += `<th class="th-check"><input type="checkbox" class="row-check" id="selectAllCb" title="Alle auswählen" onchange="toggleSelectAll(this.checked)"></th>`;
  visCols.forEach((col) => {
    const isSorted = sortColId === col.id;
    const sortIcon = isSorted ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    html += `<th style="min-width:80px;cursor:pointer" title="Nach ${esc(col.name)} sortieren"><div class="th-inner" onclick="cycleSortBy('${col.id}')">${esc(col.name)}<span style="color:var(--accent);font-size:10px">${sortIcon}</span></div></th>`;
  });
  html += `<th class="th-actions"></th></tr></thead><tbody id="tBody"></tbody></table></div>`;
  area.innerHTML = html;
  if (scrollTop > 0) {
    if (contentArea) contentArea.scrollTop = scrollTop;
    requestAnimationFrame(() => {
      const el = _getScrollEl();
      if (el) el.scrollTop = scrollTop;
    });
    _preservedScroll = 0;
  }
  const tbody = document.getElementById('tBody');
  items.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    tr.dataset.index = String(idx);
    tr.style.height = `${currentRowHeight}px`;
    if (_hooks.isIdea(item)) tr.setAttribute('data-idea', '1');
    if (selectedIds.has(item.id)) tr.classList.add('row-selected');

    const tdCb = document.createElement('td');
    tdCb.className = 'td-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'row-check';
    cb.checked = selectedIds.has(item.id);
    cb.addEventListener('mousedown', (e) => {
      if (e.shiftKey && _lastCheckedIndex >= 0) {
        e.preventDefault();
        const rows = [...document.querySelectorAll('#tBody tr')];
        const currentIndex = parseInt(tr.dataset.index, 10);
        const start = Math.min(_lastCheckedIndex, currentIndex);
        const end = Math.max(_lastCheckedIndex, currentIndex);
        const shouldCheck = !cb.checked;
        rows.forEach((row) => {
          const ri = parseInt(row.dataset.index, 10);
          if (ri >= start && ri <= end) {
            const rId = row.dataset.id;
            const rCb = row.querySelector('.row-check');
            if (shouldCheck) {
              selectedIds.add(rId);
              row.classList.add('row-selected');
              if (rCb) rCb.checked = true;
            } else {
              selectedIds.delete(rId);
              row.classList.remove('row-selected');
              if (rCb) rCb.checked = false;
            }
          }
        });
        _lastCheckedIndex = currentIndex;
        updateBulkBar();
      }
    });
    cb.addEventListener('change', (e) => {
      if (!e.shiftKey) {
        toggleRowSelect(item.id, cb.checked, tr);
        _lastCheckedIndex = parseInt(tr.dataset.index, 10);
      }
    });
    tdCb.appendChild(cb);
    tr.appendChild(tdCb);

    visCols.forEach((col) => {
      const td = document.createElement('td');
      td.dataset.col = col.id;
      td.dataset.id = item.id;
      const view = document.createElement('div');
      view.className = 'cell-view';
      view.style.minHeight = `${currentRowHeight}px`;
      const ideaPrefix = _hooks.isIdea(item) && col.id === 'title' ? '<span title="Idee" style="margin-right:4px">💡</span>' : '';
      view.innerHTML = ideaPrefix + renderCellValue(item, col);
      view.onclick = () => {
        if (!appSession.isReadOnly) startCellEdit(td, item, col);
      };
      const edit = document.createElement('div');
      edit.className = 'cell-edit';
      edit.innerHTML = buildCellEditor(item, col);
      const editorEl = edit.querySelector('input,select,textarea');
      edit.addEventListener('mousedown', (e) => e.stopPropagation());
      edit.addEventListener('click', (e) => e.stopPropagation());
      edit.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelCellEdit(td);
        }
      });
      if (col.type !== 'multiselect') {
        editorEl?.addEventListener('blur', () => commitCellEdit(td, item, col));
        editorEl?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && col.type !== 'text') commitCellEdit(td, item, col);
        });
        if (editorEl?.tagName === 'SELECT') {
          editorEl.addEventListener('change', () => commitCellEdit(td, item, col));
        }
      }
      edit.querySelector('.cell-ms-apply')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void commitCellEdit(td, item, col);
      });
      td.appendChild(view);
      td.appendChild(edit);
      tr.appendChild(td);
    });
    const tdAct = document.createElement('td');
    tdAct.innerHTML = `<button class="row-open-btn" onclick="openDrawer('${item.id}')" title="Alle Felder bearbeiten">↗</button>`;
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  });
  setTimeout(addColResizeHandles, 0);
  updateBulkBar();
}

function toggleRowSelect(id, checked, tr) {
  if (checked) {
    selectedIds.add(id);
    tr?.classList.add('row-selected');
  } else {
    selectedIds.delete(id);
    tr?.classList.remove('row-selected');
  }
  updateBulkBar();
  const allCb = document.getElementById('selectAllCb');
  if (allCb) {
    const allRows = document.querySelectorAll('#tBody tr');
    const allChecked = allRows.length > 0 && [...allRows].every((r) => selectedIds.has(r.dataset.id));
    allCb.checked = allChecked;
    allCb.indeterminate = selectedIds.size > 0 && !allChecked;
  }
}

export function toggleSelectAll(checked) {
  const rows = document.querySelectorAll('#tBody tr');
  rows.forEach((tr) => {
    const id = tr.dataset.id;
    if (!id) return;
    if (checked) {
      selectedIds.add(id);
      tr.classList.add('row-selected');
    } else {
      selectedIds.delete(id);
      tr.classList.remove('row-selected');
    }
    const cb = tr.querySelector('.row-check');
    if (cb) cb.checked = checked;
  });
  updateBulkBar();
}

export function clearBulkSelection() {
  selectedIds.clear();
  _lastCheckedIndex = -1;
  document.querySelectorAll('#tBody tr').forEach((tr) => {
    tr.classList.remove('row-selected');
    const cb = tr.querySelector('.row-check');
    if (cb) cb.checked = false;
  });
  const allCb = document.getElementById('selectAllCb');
  if (allCb) {
    allCb.checked = false;
    allCb.indeterminate = false;
  }
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  const countEl = document.getElementById('bulkCount');
  const fieldsEl = document.getElementById('bulkFields');
  if (!bar) return;
  if (selectedIds.size === 0) {
    bar.classList.remove('visible');
    return;
  }
  bar.classList.add('visible');
  countEl.textContent = `${selectedIds.size} ausgewählt`;
  const selectCols = columns.filter((c) => c.type === 'select' || c.type === 'multiselect');
  fieldsEl.innerHTML = selectCols
    .map((col) => {
      if (col.type === 'multiselect') {
        const opts = (col.options || [])
          .map(
            (o) =>
              `<label class="dropdown-label" style="display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;white-space:nowrap;font-size:12px">
          <input type="checkbox" value="${esc(o.label)}" class="bulk-ms-opt" data-col="${col.id}">
          <span style="width:10px;height:10px;border-radius:50%;background:${o.color || '#888'};display:inline-block;flex-shrink:0"></span>
          ${esc(o.label)}
        </label>`
          )
          .join('');
        return `<div class="bulk-field" style="position:relative">
        <label>${esc(col.name)}:</label>
        <div style="position:relative;display:inline-block">
          <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'"
            style="padding:4px 10px;border:1px solid var(--border-mid);border-radius:var(--radius);background:var(--surface);color:var(--text);font-size:12px;cursor:pointer;font-family:var(--sans)">
            Auswählen ▾
          </button>
          <div style="display:none;position:absolute;top:100%;left:0;background:var(--surface);border:1px solid var(--border-mid);border-radius:var(--radius);box-shadow:var(--shadow-lg);z-index:100;min-width:220px;max-height:280px;overflow-y:auto;padding:4px 0">
            ${opts}
            <div style="border-top:1px solid var(--border);margin-top:4px;padding:4px 8px;display:flex;gap:6px">
              <button type="button" onclick="event.stopPropagation();applyBulkMultiselect('${col.id}','add')" style="flex:1;padding:3px;font-size:11px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">+ Hinzufügen</button>
              <button type="button" onclick="event.stopPropagation();applyBulkMultiselect('${col.id}','remove')" style="flex:1;padding:3px;font-size:11px;background:var(--red);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">− Entfernen</button>
            </div>
          </div>
        </div>
      </div>`;
      }
      return `<div class="bulk-field">
        <label>${esc(col.name)}:</label>
        <select id="bulk_${col.id}" onchange="onBulkFieldChange('${col.id}')">
          <option value="">– nicht ändern –</option>
          ${(col.options || []).map((o) => `<option value="${esc(o.label)}">${esc(o.label)}</option>`).join('')}
        </select>
      </div>`;
    })
    .join('');
}

export function onBulkFieldChange(colId) {
  const sel = document.getElementById(`bulk_${colId}`);
  if (sel) sel.style.background = sel.value ? 'rgba(0,169,140,.4)' : 'rgba(255,255,255,.12)';
}

export async function bulkDelete() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  showConfirm(
    `${ids.length} Eintrag${ids.length > 1 ? 'e' : ''} wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
    async () => {
      setSyncStatus('loading', 'Lösche...');
      const { error } = await appSession.sb.from('content_items').delete().in('id', ids);
      if (error) {
        setSyncStatus('error', 'Fehler');
        toast(`Fehler: ${error.message}`);
        return;
      }
      clearBulkSelection();
      toast(`🗑 ${ids.length} Eintrag${ids.length > 1 ? 'e' : ''} gelöscht`);
      notifyPeersIfAny();
    },
    'Einträge löschen'
  );
}

function _normLabel(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

export async function applyBulkMultiselect(colId, mode) {
  if (_hooks.getBulkOperationRunning()) {
    toast('Bitte warten, vorige Änderung läuft noch.');
    return;
  }
  const checked = [...document.querySelectorAll(`.bulk-ms-opt[data-col="${colId}"]:checked`)].map((c) => c.value);
  if (!checked.length) {
    toast('Bitte mindestens eine Option auswählen');
    return;
  }
  const ids = [...selectedIds];
  if (!ids.length) {
    toast('Keine Einträge ausgewählt');
    return;
  }
  _hooks.setBulkOperationRunning(true);
  setSyncStatus('loading', 'Speichere…');
  try {
    let errors = 0;
    const checkedNorm = new Set(checked.map(_normLabel));
    const data = _hooks.getData();
    for (const id of ids) {
      const item = data.find((d) => d.id === id);
      if (!item) continue;
      let current = Array.isArray(item[colId]) ? [...item[colId]] : item[colId] ? [item[colId]] : [];
      if (mode === 'add') {
        checked.forEach((v) => {
          if (!current.some((x) => _normLabel(x) === _normLabel(v))) current.push(v);
        });
      } else {
        current = current.filter((v) => !checkedNorm.has(_normLabel(v)));
      }
      item[colId] = current;
      const row = _hooks.itemToRow(item);
      const { error } = await appSession.sb.from('content_items').update(row).eq('id', id);
      if (error) {
        errors++;
        console.error('Bulk multiselect update failed', id, error);
      }
    }
    setSyncStatus(errors ? 'error' : 'ok', errors ? 'Fehler' : `${ids.length} Einträge`);
    toast(errors ? `${errors} Fehler` : `✅ ${ids.length} Einträge aktualisiert`);
    if (!errors) {
      await _hooks.loadData({ quiet: true });
      notifyPeersIfAny();
    }
  } catch (e) {
    setSyncStatus('error', 'Fehler');
    toast(`Mehrfachänderung fehlgeschlagen: ${e?.message || e}`);
  } finally {
    _hooks.setBulkOperationRunning(false);
  }
}

export async function applyBulkEdit() {
  if (selectedIds.size === 0) return;
  if (_hooks.getBulkOperationRunning()) {
    toast('Bitte warten, vorige Änderung läuft noch.');
    return;
  }
  const selectCols = columns.filter((c) => c.type === 'select' || c.type === 'multiselect');
  const changes = {};
  const multiselectChanges = {};
  selectCols.forEach((col) => {
    if (col.type === 'multiselect') {
      const checked = [...document.querySelectorAll(`.bulk-ms-opt[data-col="${col.id}"]:checked`)].map((c) => c.value);
      if (checked.length) multiselectChanges[col.id] = checked;
      return;
    }
    const sel = document.getElementById(`bulk_${col.id}`);
    if (sel?.value) changes[col.id] = sel.value;
  });
  if (Object.keys(changes).length === 0 && Object.keys(multiselectChanges).length === 0) {
    toast('Bitte zuerst einen Wert auswählen');
    return;
  }
  const ids = [...selectedIds];
  _hooks.setBulkOperationRunning(true);
  setSyncStatus('loading', `${ids.length} Einträge werden aktualisiert…`);
  try {
    let errorCount = 0;
    const data = _hooks.getData();
    for (const id of ids) {
      const item = data.find((d) => d.id === id);
      if (!item) continue;
      Object.assign(item, changes);
      Object.entries(multiselectChanges).forEach(([colId, vals]) => {
        item[colId] = [...vals];
      });
      const row = _hooks.itemToRow(item);
      const { error } = await appSession.sb.from('content_items').update(row).eq('id', id);
      if (error) {
        errorCount++;
        console.error('Bulk edit update failed', id, error);
      }
    }
    await _hooks.loadData({ quiet: true });
    clearBulkSelection();
    if (errorCount > 0) {
      toast(`⚠ ${errorCount} Fehler beim Speichern`);
      setSyncStatus('error', 'Fehler');
    } else {
      toast(`✅ ${ids.length} Einträge aktualisiert`);
      setSyncStatus('ok', `${data.length} Einträge`);
      notifyPeersIfAny();
    }
  } catch (e) {
    setSyncStatus('error', 'Fehler');
    toast(`Mehrfachänderung fehlgeschlagen: ${e?.message || e}`);
  } finally {
    _hooks.setBulkOperationRunning(false);
  }
}

function renderCellValue(item, col) {
  const val = item[col.id];
  if (col.id === 'internalLinks') {
    const cnt = (val || []).length;
    return cnt ? `<span style="color:var(--accent);font-weight:600">${cnt}</span>` : `<span style="color:var(--text-faint)">–</span>`;
  }
  if (col.type === 'select') {
    const o = (col.options || []).find((x) => x.label.toLowerCase() === String(val ?? '').trim().toLowerCase());
    if (!o) return '<span style="color:var(--text-faint)">–</span>';
    return `<span class="cell-tag" style="background:${o.color}22;color:${o.color}">${esc(o.label)}</span>`;
  }
  if (col.type === 'multiselect') {
    const raw = Array.isArray(val) ? val : val ? [val] : [];
    const tags = raw
      .map((v) => {
        const o = (col.options || []).find((x) => x.label.toLowerCase() === String(v).trim().toLowerCase());
        if (!o) return '';
        return `<span class="cell-tag" style="background:${o.color}22;color:${o.color}">${esc(o.label)}</span>`;
      })
      .filter(Boolean);
    return tags.join(' ') || '<span style="color:var(--text-faint)">–</span>';
  }
  if (col.type === 'url' && val) {
    const short = val.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30);
    return `<a href="${esc(val)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--accent);text-decoration:none;font-size:12px">↗ ${esc(short)}</a>`;
  }
  if (col.type === 'date' && val) {
    try {
      const [y, m, d] = val.split('-');
      return `${d}.${m}.${y}`;
    } catch {
      return val;
    }
  }
  return val ? esc(String(val).slice(0, 60)) : '<span style="color:var(--text-faint)">–</span>';
}

function buildCellEditor(item, col) {
  const val = item[col.id] || '';
  if (col.id === 'internalLinks') return '';
  if (col.type === 'select') {
    const opts = (col.options || [])
      .map((o) => `<option value="${esc(o.label)}" ${val === o.label ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('');
    return `<select><option value="">–</option>${opts}</select>`;
  }
  if (col.type === 'multiselect') {
    const current = normalizeMultiselectToOptions(col, val);
    const curSet = new Set(current);
    const n = current.length;
    const triggerLabel = n ? `${n} ausgewählt ▾` : 'Auswählen ▾';
    const opts = (col.options || [])
      .map(
        (o) => `
      <label class="cell-ms-opt-row">
        <input type="checkbox" class="cell-ms-opt" value="${esc(o.label)}" ${curSet.has(o.label) ? 'checked' : ''}>
        <span class="cell-ms-dot" style="background:${o.color || '#888'}"></span>
        <span class="cell-ms-label">${esc(o.label)}</span>
      </label>`
      )
      .join('');
    return `<div class="cell-ms-inner">
      <div class="cell-ms-trigger" aria-hidden="true">${esc(triggerLabel)}</div>
      <div class="cell-ms-dropdown">
        <div class="cell-ms-dropdown-body">${opts}</div>
        <div class="cell-ms-footer"><button type="button" class="cell-ms-apply">OK</button></div>
      </div>
    </div>`;
  }
  if (col.type === 'date') return `<input type="date" value="${esc(val)}">`;
  if (col.type === 'number') return `<input type="number" value="${esc(val)}">`;
  if (col.type === 'url') return `<input type="url" value="${esc(val)}" placeholder="https://…">`;
  return `<input type="text" value="${esc(val)}">`;
}

function startCellEdit(td, item, col) {
  if (col.id === 'internalLinks') {
    _hooks.openDrawer(item.id);
    return;
  }
  if (col.type === 'multiselect') td.classList.add('cell-ms-wrap');
  td.classList.add('editing');
  const input = td.querySelector('.cell-edit input, .cell-edit select, .cell-edit textarea');
  if (input) {
    input.focus();
    if (input.select) input.select();
  }
  if (col.type === 'multiselect') {
    td.querySelector('.cell-ms-opt')?.focus();
  }
}

function cancelCellEdit(td) {
  const dd = td.querySelector('.cell-ms-dropdown');
  if (dd) dd.style.display = 'none';
  td.classList.remove('editing');
  td.classList.remove('cell-ms-wrap');
}

async function commitCellEdit(td, item, col) {
  const data = _hooks.getData();
  /** Nach loadData() im Hintergrund zeigt `item` ggf. auf ein altes Objekt — immer die aktuelle Zeile im Array nutzen. */
  const live = data.find((d) => d.id === item.id) || item;
  if (col.type === 'multiselect') {
    const checked = [...td.querySelectorAll('.cell-edit .cell-ms-opt:checked')].map((c) => c.value);
    const prev = normalizeMultiselectToOptions(col, live[col.id]);
    td.classList.remove('editing');
    td.classList.remove('cell-ms-wrap');
    if (sameMultiValue(checked, prev)) return;
    live[col.id] = checked;
    const _ca = _getScrollEl();
    if (_ca) _preservedScroll = _ca.scrollTop;
    const dbPayload = _hooks.itemToRow(live);
    const { error } = await appSession.sb.from('content_items').update(dbPayload).eq('id', live.id);
    if (error) {
      toast(`Fehler beim Speichern: ${error.message}`);
      return;
    }
    live.updatedAt = new Date().toISOString();
    const view = td.querySelector('.cell-view');
    if (view) view.innerHTML = renderCellValue(live, col);
    setSyncStatus('ok', `${data.length} Einträge`);
    notifyPeersIfAny();
    return;
  }
  td.classList.remove('editing');
  td.classList.remove('cell-ms-wrap');
  const input = td.querySelector('.cell-edit input, .cell-edit select');
  if (!input) return;
  const newVal = input.value;
  if (String(live[col.id] || '') === newVal) return;
  live[col.id] = newVal;
  const _ca = _getScrollEl();
  if (_ca) _preservedScroll = _ca.scrollTop;
  const dbPayload = _hooks.itemToRow(live);
  const { error } = await appSession.sb.from('content_items').update(dbPayload).eq('id', live.id);
  if (error) {
    toast(`Fehler beim Speichern: ${error.message}`);
    return;
  }
  live.updatedAt = new Date().toISOString();
  const view = td.querySelector('.cell-view');
  if (view) view.innerHTML = renderCellValue(live, col);
  setSyncStatus('ok', `${data.length} Einträge`);
  notifyPeersIfAny();
}

export function setRowHeight(h) {
  currentRowHeight = parseInt(h, 10);
  localStorage.setItem(ROW_HEIGHT_KEY, String(h));
  document.querySelectorAll('#tBody tr').forEach((tr) => {
    tr.style.height = `${h}px`;
  });
  document.querySelectorAll('.cell-view').forEach((cv) => {
    cv.style.minHeight = `${h}px`;
  });
  const slider = document.getElementById('rowHeightSlider');
  if (slider) slider.value = h;
}

let resizing = null;

function addColResizeHandles() {
  document.querySelectorAll('thead th').forEach((th) => {
    if (th.classList.contains('th-actions')) return;
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = { th, startX: e.clientX, startW: th.offsetWidth };
      handle.classList.add('resizing');
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeUp);
    });
  });
}

function onResizeMove(e) {
  if (!resizing) return;
  const w = Math.max(60, resizing.startW + e.clientX - resizing.startX);
  resizing.th.style.width = `${w}px`;
  resizing.th.style.minWidth = `${w}px`;
}

function onResizeUp() {
  if (!resizing) return;
  resizing.th.querySelector('.col-resize-handle')?.classList.remove('resizing');
  resizing = null;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
}
