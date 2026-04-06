/**
 * Spalten-/Kategorien-Definitionen: LocalStorage, Supabase app_settings, Modal „Kategorien“.
 */
import { COL_STORE } from './storage-keys.js';
import { defaultColumns, SYSTEM_COLUMN_IDS } from './columns-defaults.js';
import { appSession } from './session.js';
import { esc, toast, showConfirm, typeLabel } from './lib.js';

export let columns = [];

let _render = () => {};
let _runPrune = async () => {};

/** Muss vor UI-Aktionen angebunden werden (render + Aufräumen nach Optionsänderung). */
export function setColumnsAppHooks(hooks) {
  _render = hooks.render;
  _runPrune = hooks.runPruneStaleCategoryValues;
}

function renderAfterColumnsChange() {
  _render();
}

let newColOptions = [];
let editingColIndex = null;
let editColOptions = [];
const _autoColors = ['#e03131', '#1971c2', '#2f9e44', '#e8590c', '#9b4dca', '#f0b429', '#495057', '#0ca678', '#d6336c', '#1098ad', '#6741d9', '#5c7cfa', '#74c0fc', '#96f2d7', '#ffd43b', '#ff922b'];

export function loadColumns() {
  try {
    const r = localStorage.getItem(COL_STORE);
    columns = r ? JSON.parse(r) : defaultColumns();
    columns.forEach((col) => { if (!SYSTEM_COLUMN_IDS.includes(col.id)) delete col.locked; });
  } catch {
    columns = defaultColumns();
  }
}

export async function syncColumnsFromSupabase() {
  try {
    const { data, error } = await appSession.sb.from('app_settings').select('value').eq('key', 'columns').single();
    if (error || !data) {
      await saveColumnsToSupabase();
      return;
    }
    const remote = data.value;
    if (Array.isArray(remote) && remote.length > 0) {
      columns = remote;
      columns.forEach((col) => { if (!SYSTEM_COLUMN_IDS.includes(col.id)) delete col.locked; });
      localStorage.setItem(COL_STORE, JSON.stringify(columns));
    }
  } catch (e) {
    /* Supabase nicht erreichbar — LocalStorage */
  }
}

async function saveColumnsToSupabase() {
  try {
    const { error } = await appSession.sb.from('app_settings').upsert({
      key: 'columns',
      value: columns,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    toast('Kategorien konnten nicht in Supabase gespeichert werden: ' + (e?.message || e));
  }
}

function saveColumns() {
  localStorage.setItem(COL_STORE, JSON.stringify(columns));
  saveColumnsToSupabase();
}

/** Realtime: Spalten von anderem Client übernehmen. */
export function applyRemoteColumns(remote) {
  if (!Array.isArray(remote)) return;
  columns = remote;
  columns.forEach((col) => { if (!SYSTEM_COLUMN_IDS.includes(col.id)) delete col.locked; });
  localStorage.setItem(COL_STORE, JSON.stringify(columns));
}

export function openColModal() {
  newColOptions = [];
  editingColIndex = null;
  editColOptions = [];
  document.getElementById('editColPanel').style.display = 'none';
  renderColList();
  document.getElementById('newColName').value = '';
  document.getElementById('newColType').value = 'text';
  document.getElementById('newColOptions').style.display = 'none';
  document.getElementById('optionList').innerHTML = '';
  document.getElementById('colModal').classList.add('open');
}

export function closeColModal() {
  document.getElementById('colModal').classList.remove('open');
  editingColIndex = null;
}

export function renderColList() {
  columns.forEach((col) => { if (!SYSTEM_COLUMN_IDS.includes(col.id)) delete col.locked; });

  const el = document.getElementById('colList');
  el.innerHTML = '';

  columns.forEach((col, i) => {
    const div = document.createElement('div');
    div.className = 'col-item';
    div.dataset.index = String(i);

    const handle = document.createElement('span');
    handle.className = 'col-item-drag';
    handle.title = 'Ziehen zum Sortieren';
    handle.textContent = '⠿';
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      div.classList.add('dragging');
      e.stopPropagation();
    });
    handle.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      document.querySelectorAll('.col-item').forEach((el2) => el2.classList.remove('drag-over'));
    });

    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.col-item').forEach((el2) => el2.classList.remove('drag-over'));
      div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = parseInt(div.dataset.index, 10);
      if (isNaN(fromIdx) || fromIdx === toIdx) return;
      const moved = columns.splice(fromIdx, 1)[0];
      columns.splice(toIdx, 0, moved);
      saveColumns();
      renderColList();
      renderAfterColumnsChange();
    });

    const info = document.createElement('div');
    info.className = 'col-item-info';
    info.innerHTML = `<div class="col-item-name">${esc(col.name)}</div><div class="col-item-type">${typeLabel(col.type)}${col.options ? ' · ' + col.options.length + ' Optionen' : ''}</div>`;

    const visLabel = document.createElement('label');
    visLabel.className = 'col-visible-toggle';
    visLabel.title = 'In Tabelle anzeigen';
    visLabel.innerHTML = `<input type="checkbox" ${col.visible ? 'checked' : ''}> sichtbar`;
    visLabel.querySelector('input').addEventListener('change', function () {
      toggleColVisible(i, this.checked);
    });

    const actions = document.createElement('div');
    actions.className = 'col-item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.title = 'Bearbeiten';
    editBtn.style.color = 'var(--accent-mid)';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditColumn(i);
    });

    const isSystem = SYSTEM_COLUMN_IDS.includes(col.id);
    if (isSystem) {
      const lockBtn = document.createElement('button');
      lockBtn.className = 'btn-icon';
      lockBtn.style.opacity = '0.2';
      lockBtn.style.cursor = 'default';
      lockBtn.title = 'Systemkategorie – nicht löschbar';
      lockBtn.textContent = '🔒';
      actions.appendChild(editBtn);
      actions.appendChild(lockBtn);
    } else {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon';
      delBtn.title = 'Kategorie löschen';
      delBtn.style.color = 'var(--red)';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        deleteColumn(i);
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
    }

    div.appendChild(handle);
    div.appendChild(info);
    div.appendChild(visLabel);
    div.appendChild(actions);
    el.appendChild(div);
  });
}

function toggleColVisible(i, visible) {
  columns[i].visible = visible;
  saveColumns();
  renderAfterColumnsChange();
}

function deleteColumn(i) {
  const col = columns[i];
  if (SYSTEM_COLUMN_IDS.includes(col.id)) {
    toast('Diese Systemkategorie kann nicht gelöscht werden.');
    return;
  }
  showConfirm(
    `Kategorie "${col.name}" wirklich löschen? Daten dieser Kategorie gehen verloren.`,
    () => {
      columns.splice(i, 1);
      saveColumns();
      renderColList();
      renderAfterColumnsChange();
      toast('Kategorie gelöscht');
    },
    'Kategorie löschen'
  );
}

function startEditColumn(i) {
  editingColIndex = i;
  const col = columns[i];
  editColOptions = col.options ? col.options.map((o) => ({ ...o })) : [];

  const panel = document.getElementById('editColPanel');
  panel.style.display = 'block';
  panel.innerHTML = `
    <h4>✏️ Kategorie bearbeiten <button class="btn-icon" onclick="cancelEditColumn()" style="font-size:11px">✕</button></h4>
    <div class="new-col-grid">
      <input type="text" id="editColName" value="${esc(col.name)}" placeholder="Spaltenname">
      <select id="editColType" onchange="onEditColTypeChange()">
        <option value="text" ${col.type === 'text' ? 'selected' : ''}>Text</option>
        <option value="number" ${col.type === 'number' ? 'selected' : ''}>Zahl</option>
        <option value="select" ${col.type === 'select' ? 'selected' : ''}>Auswahl</option>
        <option value="multiselect" ${col.type === 'multiselect' ? 'selected' : ''}>Mehrfachauswahl</option>
        <option value="date" ${col.type === 'date' ? 'selected' : ''}>Datum</option>
        <option value="url" ${col.type === 'url' ? 'selected' : ''}>URL</option>
      </select>
    </div>
    <div id="editColOptions" style="display:${col.type === 'select' || col.type === 'multiselect' ? 'block' : 'none'}">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:5px">Auswahloptionen:</div>
      <div class="option-list" id="editOptionList"></div>
      <div class="add-row">
        <input type="text" id="editOptionInput" placeholder="Option hinzufügen…" onkeydown="if(event.key==='Enter'){event.preventDefault();addEditOption()}">
        <input type="color" id="editOptionColor" value="#1a5f3c" class="option-color">
        <button class="btn-ghost" onclick="addEditOption()" style="padding:5px 10px;font-size:12px">+ Add</button>
      </div>
    </div>
    <div style="margin-top:10px">
      <button class="btn-primary" onclick="saveEditColumn()" style="width:100%">Änderungen speichern</button>
    </div>`;

  renderEditOptionList();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function cancelEditColumn() {
  editingColIndex = null;
  document.getElementById('editColPanel').style.display = 'none';
}

export function onEditColTypeChange() {
  const type = document.getElementById('editColType').value;
  const show = type === 'select' || type === 'multiselect';
  document.getElementById('editColOptions').style.display = show ? 'block' : 'none';
}

function renderEditOptionList() {
  const el = document.getElementById('editOptionList');
  if (!el) return;
  el.innerHTML = '';
  editColOptions.forEach((opt, i) => {
    const div = document.createElement('div');
    div.className = 'option-item';
    div.setAttribute('draggable', 'true');
    div.dataset.index = i;
    div.innerHTML = `
      <span style="cursor:grab;color:var(--text-faint);padding:0 4px;font-size:14px" title="Reihenfolge ändern">⠿</span>
      <input type="text" value="${esc(opt.label)}" placeholder="Optionsname">
      <input type="color" value="${opt.color || '#888'}" class="option-color">
      <button class="btn-icon" type="button" style="color:var(--red)">✕</button>`;
    const nameInput = div.querySelector('input[type="text"]');
    const colorInput = div.querySelector('input[type="color"]');
    const removeBtn = div.querySelector('button');
    nameInput?.addEventListener('input', (e) => { editColOptions[i].label = e.target.value; });
    colorInput?.addEventListener('input', (e) => { editColOptions[i].color = e.target.value; });
    removeBtn?.addEventListener('click', () => removeEditOption(i));
    div.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', i); div.style.opacity = '0.4'; });
    div.addEventListener('dragend', () => { div.style.opacity = '1'; });
    div.addEventListener('dragover', (e) => { e.preventDefault(); div.style.background = 'var(--surface2)'; });
    div.addEventListener('dragleave', () => { div.style.background = ''; });
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.style.background = '';
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const to = i;
      if (from === to) return;
      const moved = editColOptions.splice(from, 1)[0];
      editColOptions.splice(to, 0, moved);
      renderEditOptionList();
    });
    el.appendChild(div);
  });
}

export function addEditOption() {
  const inp = document.getElementById('editOptionInput');
  const col = document.getElementById('editOptionColor');
  const label = inp.value.trim();
  if (!label) return;
  editColOptions.push({ label, color: col.value });
  inp.value = '';
  if (col) col.value = _autoColors[editColOptions.length % _autoColors.length];
  renderEditOptionList();
}

export function removeEditOption(i) {
  editColOptions.splice(i, 1);
  renderEditOptionList();
}

export function saveEditColumn() {
  if (editingColIndex === null) return;
  const nameEl = document.getElementById('editColName');
  const typeEl = document.getElementById('editColType');
  if (!nameEl || !typeEl) return;
  const name = nameEl.value.trim();
  const type = typeEl.value;
  if (!name) {
    toast('Bitte Namen eingeben');
    return;
  }

  columns[editingColIndex].name = name;
  columns[editingColIndex].type = type;
  if (type === 'select' || type === 'multiselect') {
    columns[editingColIndex].options = [...editColOptions];
  } else {
    delete columns[editingColIndex].options;
  }
  saveColumns();
  editingColIndex = null;
  document.getElementById('editColPanel').style.display = 'none';
  renderColList();
  renderAfterColumnsChange();
  toast('Kategorie aktualisiert ✓');
  void _runPrune();
}

export function onNewColTypeChange() {
  const type = document.getElementById('newColType').value;
  const show = type === 'select' || type === 'multiselect';
  document.getElementById('newColOptions').style.display = show ? 'block' : 'none';
  if (show && newColOptions.length === 0) {
    newColOptions = [{ label: 'Option 1', color: '#1a5f3c' }];
    renderOptionList();
  }
}

function renderOptionList() {
  const el = document.getElementById('optionList');
  el.innerHTML = '';
  newColOptions.forEach((opt, i) => {
    const div = document.createElement('div');
    div.className = 'option-item';
    div.setAttribute('draggable', 'true');
    div.dataset.index = i;
    div.innerHTML = `
      <span style="cursor:grab;color:var(--text-faint);padding:0 4px;font-size:14px" title="Reihenfolge ändern">⠿</span>
      <input type="text" value="${esc(opt.label)}" placeholder="Optionsname">
      <input type="color" value="${opt.color}" class="option-color" title="Farbe">
      <button class="btn-icon" type="button" style="color:var(--red)">✕</button>`;
    const nameInput = div.querySelector('input[type="text"]');
    const colorInput = div.querySelector('input[type="color"]');
    const removeBtn = div.querySelector('button');
    nameInput?.addEventListener('input', (e) => { newColOptions[i].label = e.target.value; });
    colorInput?.addEventListener('input', (e) => { newColOptions[i].color = e.target.value; });
    removeBtn?.addEventListener('click', () => removeOption(i));
    div.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', i); div.style.opacity = '0.4'; });
    div.addEventListener('dragend', () => { div.style.opacity = '1'; });
    div.addEventListener('dragover', (e) => { e.preventDefault(); div.style.background = 'var(--surface2)'; });
    div.addEventListener('dragleave', () => { div.style.background = ''; });
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.style.background = '';
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const to = i;
      if (from === to) return;
      const moved = newColOptions.splice(from, 1)[0];
      newColOptions.splice(to, 0, moved);
      renderOptionList();
    });
    el.appendChild(div);
  });
}

export function addOption() {
  const inp = document.getElementById('newOptionInput');
  const col = document.getElementById('newOptionColor');
  const label = inp.value.trim();
  if (!label) return;
  newColOptions.push({ label, color: col.value });
  inp.value = '';
  if (col) col.value = _autoColors[newColOptions.length % _autoColors.length];
  renderOptionList();
}

export function removeOption(i) {
  newColOptions.splice(i, 1);
  renderOptionList();
}

export function createColumn() {
  const name = document.getElementById('newColName').value.trim();
  const type = document.getElementById('newColType').value;
  if (!name) {
    toast('Bitte Spaltenname eingeben');
    return;
  }
  const id = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
  const col = { id, name, type, visible: true };
  if ((type === 'select' || type === 'multiselect') && newColOptions.length > 0) {
    col.options = [...newColOptions];
  }
  columns.push(col);
  saveColumns();
  newColOptions = [];
  document.getElementById('newColName').value = '';
  document.getElementById('optionList').innerHTML = '';
  document.getElementById('newColOptions').style.display = 'none';
  renderColList();
  renderAfterColumnsChange();
  toast(`Kategorie "${name}" erstellt ✓`);
  void _runPrune();
}
