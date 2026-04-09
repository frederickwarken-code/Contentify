/**
 * Kanban-Ansicht: Gruppierung nach Auswahl-Spalte, Spalten- und Karten-DnD (nur UI-Reihenfolge).
 */
import { columns } from './columns.js';
import { esc } from './lib.js';

let _hooks = {
  isIdea: () => false,
  openDrawer: () => {},
};

export function setKanbanHooks(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

let kanbanGroupColId = null;
/** @type {Record<string, string[]>} */
const kanbanOrder = {};
let kanbanColOrder = [];

export function populateKanbanGroupBy() {
  const sel = document.getElementById('kanbanGroupBy');
  if (!sel) return;
  const selectCols = columns.filter((c) => c.type === 'select');
  sel.innerHTML = selectCols
    .map((c) => `<option value="${c.id}" ${kanbanGroupColId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  if (!kanbanGroupColId && selectCols.length > 0) kanbanGroupColId = selectCols[0].id;
}

export function renderKanban(items, area) {
  const selEl = document.getElementById('kanbanGroupBy');
  if (selEl?.value) kanbanGroupColId = selEl.value;
  const groupCol = columns.find((c) => c.id === kanbanGroupColId) || columns.find((c) => c.type === 'select');
  if (!groupCol) {
    area.innerHTML = '<div class="empty"><p>Keine Auswahl-Spalte zum Gruppieren vorhanden.</p></div>';
    return;
  }

  area.innerHTML = `<div class="kanban" id="kanbanGrid"></div>`;
  const grid = document.getElementById('kanbanGrid');

  const optionOrder = (groupCol.options || []).map((o) => o.label);
  const groups = {};
  optionOrder.forEach((l) => {
    groups[l] = [];
  });
  groups['–'] = [];
  items.forEach((item) => {
    const g = item[groupCol.id] || '–';
    if (!groups[g]) groups[g] = [];
    groups[g].push(item);
  });

  let colLabels = kanbanColOrder.filter((l) => groups[l]?.length);
  optionOrder.forEach((l) => {
    if (!colLabels.includes(l) && groups[l]?.length) colLabels.push(l);
  });
  if (groups['–']?.length && !colLabels.includes('–')) colLabels.push('–');

  colLabels.forEach((group) => {
    const gitems = groups[group];
    if (!gitems?.length) return;

    if (kanbanOrder[group]) {
      const ordered = [];
      kanbanOrder[group].forEach((id) => {
        const i = gitems.find((x) => x.id === id);
        if (i) ordered.push(i);
      });
      gitems.forEach((i) => {
        if (!ordered.includes(i)) ordered.push(i);
      });
      gitems.length = 0;
      gitems.push(...ordered);
    }

    const opt = (groupCol.options || []).find((o) => o.label === group);
    const color = opt?.color || '#888';
    const colEl = document.createElement('div');
    colEl.className = 'kanban-col';
    colEl.dataset.group = group;
    colEl.draggable = true;
    colEl.innerHTML = `
      <div class="kanban-col-header" style="cursor:grab" title="Spalte verschieben">
        <span style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;opacity:.4;margin-right:2px">⠿</span>
          <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>
          ${esc(group)}
        </span>
        <span class="kanban-cnt">${gitems.length}</span>
      </div>
      <div class="kanban-cards" data-group="${group}"></div>`;

    colEl.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('kanban-col', group);
      e.dataTransfer.effectAllowed = 'move';
      colEl.style.opacity = '.4';
    });
    colEl.addEventListener('dragend', () => {
      colEl.style.opacity = '1';
    });
    colEl.addEventListener('dragover', (e) => {
      const fromCol = e.dataTransfer.types.includes('kanban-col');
      if (fromCol) {
        e.preventDefault();
        colEl.style.outline = '2px dashed var(--accent-mid)';
      }
    });
    colEl.addEventListener('dragleave', () => {
      colEl.style.outline = '';
    });
    colEl.addEventListener('drop', (e) => {
      colEl.style.outline = '';
      const fromGroup = e.dataTransfer.getData('kanban-col');
      if (!fromGroup || fromGroup === group) return;
      e.preventDefault();
      const cols = [...grid.querySelectorAll('.kanban-col')].map((c) => c.dataset.group);
      const fi = cols.indexOf(fromGroup);
      const ti = cols.indexOf(group);
      if (fi < 0 || ti < 0) return;
      const newOrder = [...cols];
      newOrder.splice(fi, 1);
      newOrder.splice(ti, 0, fromGroup);
      kanbanColOrder = newOrder;
      renderKanban(items, area);
    });

    const cardsEl = colEl.querySelector('.kanban-cards');
    gitems.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'kcard';
      card.dataset.id = item.id;
      card.draggable = true;
      if (_hooks.isIdea(item)) {
        card.style.borderLeft = '3px solid #f0b429';
        card.style.background = 'linear-gradient(135deg,rgba(255,200,50,.1) 0%,var(--surface) 60%)';
      }
      const visCols = columns
        .filter((c) => c.visible && c.id !== groupCol.id && c.id !== 'internalLinks' && c.id !== 'title')
        .slice(0, 3);
      card.innerHTML = `<div style="display:flex;align-items:center;gap:5px">
          <span style="color:var(--text-faint);font-size:11px;cursor:grab;flex-shrink:0">⠿</span>
          <div class="kcard-title" style="flex:1">${_hooks.isIdea(item) ? '💡 ' : ''}${esc(item.title || '')}</div>
        </div>
        <div class="kcard-meta">${visCols
          .map((c) => {
            const v = item[c.id];
            if (!v) return '';
            const o = c.type === 'select' ? (c.options || []).find((x) => x.label === v) : null;
            const cl = o?.color || '#888';
            return c.type === 'select'
              ? `<span class="cell-tag" style="background:${cl}22;color:${cl}">${esc(v)}</span>`
              : `<span style="font-size:11px;color:var(--text-faint)">${esc(String(v).slice(0, 25))}</span>`;
          })
          .join('')}</div>`;

      card.onclick = (e) => {
        if (!e.target.closest('[style*="cursor:grab"]')) _hooks.openDrawer(item.id);
      };

      card.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('kanban-card', item.id);
        e.dataTransfer.setData('kanban-card-from', group);
        e.dataTransfer.effectAllowed = 'move';
        card.style.opacity = '.4';
      });
      card.addEventListener('dragend', () => {
        card.style.opacity = '1';
      });
      card.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('kanban-card')) {
          e.preventDefault();
          card.style.outline = '2px dashed var(--accent-mid)';
        }
      });
      card.addEventListener('dragleave', () => {
        card.style.outline = '';
      });
      card.addEventListener('drop', (e) => {
        card.style.outline = '';
        const fromId = e.dataTransfer.getData('kanban-card');
        const fromGroup = e.dataTransfer.getData('kanban-card-from');
        if (!fromId) return;
        e.preventDefault();
        e.stopPropagation();
        if (fromId === item.id) return;
        if (!kanbanOrder[group]) kanbanOrder[group] = gitems.map((x) => x.id);
        const arr = kanbanOrder[group];
        const fi = arr.indexOf(fromId);
        const ti = arr.indexOf(item.id);
        if (fi < 0) {
          arr.splice(ti, 0, fromId);
        } else {
          arr.splice(fi, 1);
          arr.splice(arr.indexOf(item.id), 0, fromId);
        }
        renderKanban(items, area);
      });

      cardsEl.appendChild(card);
    });

    cardsEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('kanban-card')) e.preventDefault();
    });
    cardsEl.addEventListener('drop', (e) => {
      const fromId = e.dataTransfer.getData('kanban-card');
      if (!fromId) return;
      e.preventDefault();
      if (!kanbanOrder[group]) kanbanOrder[group] = gitems.map((x) => x.id);
      if (!kanbanOrder[group].includes(fromId)) kanbanOrder[group].push(fromId);
      renderKanban(items, area);
    });

    grid.appendChild(colEl);
  });
}
