import { columns } from './columns.js';
import { esc, toast, showConfirm, setSyncStatus, withTimeout } from './lib.js';
import { appSession } from './session.js';
import { rowToItem } from './data-pipeline.js';
import { preserveTableScrollPosition } from './table.js';

let drawerKws = [];
let drawerLinks = [];
let drawerPotLinks = [];
let drawerItem = null; // null = new

/** Kein Web-Standard — Kompromiss: genug für schwaches Mobilnetz, aber nicht ewig „Speichere…“. */
const SAVE_NETWORK_TIMEOUT_MS = 15000;

let _hooks = {
  getData: () => [],
  setData: () => {},
  isIdea: () => false,
  render: () => {},
  loadData: async () => {},
  itemToRow: () => ({}),
  notifyPeers: () => {},
};

export function setDrawerHooks(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

export function openDrawer(id) {
  const item = _hooks.getData().find((d) => d.id === id);
  if (!item) return;
  drawerItem = item;
  drawerKws = [...(item.kws || [])];
  drawerLinks = [...(item.internalLinks || [])];
  drawerPotLinks = [...(item.potentialLinks || [])];
  document.getElementById('drawerTitle').textContent = item.title || 'Eintrag bearbeiten';
  const meta = document.getElementById('drawerMeta');
  if (item.updatedAt) {
    meta.style.display = 'block';
    const d = new Date(item.updatedAt);
    meta.textContent = `Zuletzt bearbeitet: ${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  } else { meta.style.display = 'none'; }
  renderDrawerBody(item);
  document.getElementById('deleteBtn').style.display = appSession.isReadOnly || appSession.currentProfile?.role !== 'admin' ? 'none' : 'inline-block';
  document.getElementById('saveBtn').disabled = appSession.isReadOnly;
  document.getElementById('overlay').classList.add('open');
}

export function openNewDrawer() {
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
  const data = _hooks.getData();
  const ideaFlag = item ? _hooks.isIdea(item) : false;
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;background:${ideaFlag ? 'rgba(240,180,41,.12)' : 'var(--surface2)'};border:1px solid ${ideaFlag ? '#f0b429' : 'var(--border)'};border-radius:var(--radius);padding:10px 14px;margin-bottom:14px">
    <div>
      <div style="font-size:13px;font-weight:600;color:${ideaFlag ? '#8a6000' : 'var(--text)'}">💡 Als Idee markieren</div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Ideen werden gelb hervorgehoben und können potenzielle Links haben</div>
    </div>
    <label style="cursor:pointer;flex-shrink:0">
      <div onclick="toggleDrawerIdea(this)" data-on="${ideaFlag ? '1' : '0'}" style="width:36px;height:20px;border-radius:10px;background:${ideaFlag ? '#f0b429' : 'var(--border-mid)'};position:relative;transition:background .2s;cursor:pointer">
        <div style="position:absolute;top:2px;left:${ideaFlag ? '16' : '2'}px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div>
      </div>
    </label>
  </div>`;

  const allCols = columns.filter((c) => !['internalLinks', 'createdBy', 'kws'].includes(c.id));
  const createdByVal = item?.createdBy || '';

  if (createdByVal) {
    html += `<div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;display:flex;align-items:center;gap:5px">
      <span>👤 Erstellt von:</span>
      <span style="font-weight:500;color:var(--text-muted)">${esc(createdByVal)}</span>
    </div>`;
  }

  allCols.forEach((col) => {
    const val = item ? (item[col.id] || '') : '';
    html += `<div class="form-row"><label>${esc(col.name)}</label>`;
    if (col.type === 'select') {
      const opts = (col.options || []).map((o) => `<option value="${esc(o.label)}" ${val === o.label ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
      html += `<select id="df_${col.id}"><option value="">– wählen –</option>${opts}</select>`;
    } else if (col.type === 'multiselect') {
      html += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px" id="ms_${col.id}">`;
      const vals = Array.isArray(val) ? val : (val ? [val] : []);
      (col.options || []).forEach((o) => {
        const checked = vals.includes(o.label);
        html += `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;background:${o.color}22;border:1px solid ${o.color}55;padding:3px 9px;border-radius:20px;color:${o.color}">
          <input type="checkbox" value="${esc(o.label)}" ${checked ? 'checked' : ''} style="margin:0"> ${esc(o.label)}</label>`;
      });
      html += '</div>';
    } else if (col.type === 'date') {
      html += `<input type="date" id="df_${col.id}" value="${esc(val)}">`;
    } else if (col.type === 'number') {
      html += `<input type="number" id="df_${col.id}" value="${esc(val)}">`;
    } else if (col.type === 'url') {
      html += `<input type="url" id="df_${col.id}" value="${esc(val)}" placeholder="https://…">`;
    } else {
      const isNotes = col.id === 'notes';
      html += isNotes
        ? `<textarea id="df_${col.id}" rows="3">${esc(val)}</textarea>`
        : `<input type="text" id="df_${col.id}" value="${esc(val)}">`;
    }
    html += '</div>';
  });

  if (_hooks.isIdea(item || {})) {
    html += `<div class="section-heading">💡 Potenzielle Verlinkungen</div>
    <div class="form-row">
      <label>Potenzielle Links (Freitext)</label>
      <textarea id="df_potentialLinksText" rows="2" placeholder="z.B. → ModPCB Seite, → Blog KI">${esc((item?.potentialLinksText) || '')}</textarea>
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">Werden als gestrichelte Linien in der Link Map angezeigt</div>
    </div>
    <div class="form-row">
      <label>Potenzielle Links (Seiten auswählen)</label>
      <div class="link-chips" id="drawerPotLinkChips"></div>
      <div class="add-row" style="margin-top:6px">
        <select id="drawerPotLinkSelect" style="flex:1;padding:6px 9px;border:1px solid var(--border-mid);border-radius:var(--radius);font-family:var(--sans);font-size:13px;color:var(--text);background:var(--surface);outline:none">
          <option value="">— Seite wählen —</option>
          ${data.filter((d) => d.id !== item?.id).sort((a, b) => a.title.localeCompare(b.title, 'de')).map((d) => `<option value="${d.id}">${esc(d.title.slice(0, 52))}</option>`).join('')}
        </select>
        <button class="btn-ghost" onclick="addDrawerPotLink()" style="font-size:12px">+ Link</button>
      </div>
    </div>`;
  }

  const filterCol = columns.find((c) => c.type === 'select' && c.id !== 'title');
  const filterOpts = filterCol ? (filterCol.options || []).map((o) => o.label) : [];
  const filterSelectHtml = filterCol ? `
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
        <label style="font-size:11px;color:var(--text-muted);white-space:nowrap">${esc(filterCol.name)}:</label>
        <select id="drawerLinkFilter" onchange="filterDrawerLinkOptions()" style="flex:1;padding:4px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
          <option value="">Alle</option>
          ${filterOpts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
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
            ${data.filter((d) => d.id !== item?.id).sort((a, b) => a.title.localeCompare(b.title, 'de')).map((d) => `<option value="${d.id}" data-filter="${esc(d[filterCol?.id] || '')}">${esc(d.title.slice(0, 52))}</option>`).join('')}
          </select>
          <button class="btn-ghost" onclick="addDrawerLink()" style="font-size:12px">+ Link</button>
        </div>
      </div>`;

  body.innerHTML = html;
  renderDrawerKws();
  renderDrawerLinks();
  setTimeout(renderDrawerPotLinks, 0);
  if (!appSession.isReadOnly) body.querySelectorAll('input,select,textarea').forEach((el) => el.removeAttribute('disabled'));
  else body.querySelectorAll('input,select,textarea').forEach((el) => el.setAttribute('disabled', ''));
}

export function toggleDrawerIdea(el) {
  const on = el.getAttribute('data-on') === '1';
  const newOn = !on;
  el.setAttribute('data-on', newOn ? '1' : '0');
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
  el.innerHTML = drawerKws.map((kw, i) => `<span class="kw-tag">${esc(kw)}<button onclick="removeDrawerKw(${i})">✕</button></span>`).join('');
}

export function removeDrawerKw(i) { drawerKws.splice(i, 1); renderDrawerKws(); }
export function addDrawerKw() {
  const inp = document.getElementById('drawerKwInput');
  const v = inp.value.trim();
  if (!v || drawerKws.includes(v)) { inp.value = ''; return; }
  drawerKws.push(v);
  inp.value = '';
  renderDrawerKws();
}

export function filterDrawerLinkOptions() {
  const sel = document.getElementById('drawerLinkSelect');
  const filterVal = document.getElementById('drawerLinkFilter')?.value || '';
  const searchVal = (document.getElementById('drawerLinkSearch')?.value || '').toLowerCase().trim();
  if (!sel) return;
  [...sel.options].forEach((opt) => {
    if (!opt.value) return;
    const matchFilter = !filterVal || opt.dataset.filter === filterVal;
    const matchSearch = !searchVal || opt.text.toLowerCase().includes(searchVal);
    opt.hidden = !(matchFilter && matchSearch);
  });
  if (sel.selectedOptions[0]?.hidden) sel.value = '';
}

function renderDrawerLinks() {
  const el = document.getElementById('drawerLinkChips');
  if (!el) return;
  const data = _hooks.getData();
  el.innerHTML = drawerLinks.map((id, i) => {
    const t = data.find((d) => d.id === id);
    return `<span class="link-chip">🔗 ${esc((t?.title || '?').slice(0, 34))}<button onclick="removeDrawerLink(${i})">✕</button></span>`;
  }).join('');
}

export function addDrawerLink() {
  const sel = document.getElementById('drawerLinkSelect');
  const v = sel.value;
  if (!v || drawerLinks.includes(v)) return;
  drawerLinks.push(v);
  sel.value = '';
  renderDrawerLinks();
}
export function removeDrawerLink(i) { drawerLinks.splice(i, 1); renderDrawerLinks(); }

function renderDrawerPotLinks() {
  const el = document.getElementById('drawerPotLinkChips');
  if (!el) return;
  const data = _hooks.getData();
  el.innerHTML = drawerPotLinks.map((id, i) => {
    const t = data.find((d) => d.id === id);
    return `<span class="link-chip" style="background:rgba(240,180,41,.15);color:#8a6000;border:1px dashed #f0b429">⚡ ${esc((t?.title || '?').slice(0, 34))}<button onclick="removeDrawerPotLink(${i})" style="color:#8a6000">✕</button></span>`;
  }).join('');
}

export function addDrawerPotLink() {
  const sel = document.getElementById('drawerPotLinkSelect');
  if (!sel) return;
  const v = sel.value;
  if (!v || drawerPotLinks.includes(v)) return;
  drawerPotLinks.push(v);
  sel.value = '';
  renderDrawerPotLinks();
}
export function removeDrawerPotLink(i) { drawerPotLinks.splice(i, 1); renderDrawerPotLinks(); }

function getDrawerValues() {
  const body = document.getElementById('drawerBody');
  const item = {};
  columns.forEach((col) => {
    if (col.id === 'internalLinks') return;
    if (col.type === 'multiselect') {
      const checks = body.querySelectorAll(`#ms_${col.id} input[type=checkbox]:checked`);
      item[col.id] = [...checks].map((c) => c.value);
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

function _sortDataByTitle(items) {
  items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'de', { sensitivity: 'base' }));
}

export async function saveEntry() {
  try {
    const vals = getDrawerValues();
    stripIdeaPhaseIfIdeaToggledOff(vals);
    if (!vals.title) { toast('Bitte Titel eingeben'); return; }
    const row = _hooks.itemToRow({ ...(drawerItem || {}), ...vals }, { forInsert: !drawerItem });
    setSyncStatus('loading', 'Speichere…');
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
    if (error) { setSyncStatus('error', 'Fehler'); toast(`Fehler: ${error.message}`); return; }
    if (savedRow) {
      const savedItem = rowToItem(savedRow);
      const next = [..._hooks.getData()];
      if (drawerItem) {
        const idx = next.findIndex((d) => d.id === drawerItem.id);
        if (idx >= 0) next[idx] = savedItem;
      } else {
        next.push(savedItem);
        _sortDataByTitle(next);
      }
      _hooks.setData(next);
      _hooks.render();
    } else {
      try {
        await withTimeout(_hooks.loadData({ quiet: true }), SAVE_NETWORK_TIMEOUT_MS, '__save_timeout__');
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
    _hooks.notifyPeers();
  } catch (err) {
    console.error(err);
    setSyncStatus('error', 'Fehler');
    toast(`Speichern fehlgeschlagen: ${err?.message || String(err)}`);
  }
}

export async function deleteEntry() {
  if (!drawerItem) return;
  if (appSession.currentProfile?.role !== 'admin') { toast('Nur Admins können löschen.'); return; }
  showConfirm('Eintrag wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.', async () => {
    const { error } = await appSession.sb.from('content_items').delete().eq('id', drawerItem.id);
    if (error) { toast(`Fehler: ${error.message}`); return; }
    closeDrawer();
    toast('Gelöscht');
  }, 'Eintrag löschen');
}

export function closeDrawer() { document.getElementById('overlay').classList.remove('open'); }
export function closeDrawerOnBg(e) { if (e.target === document.getElementById('overlay')) closeDrawer(); }
