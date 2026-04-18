/**
 * CSV/JSON-Export und -Import (Semikolon-CSV, Kategorie-Optionen ergänzen).
 */
import { columns, ensureImportOptionsForFields } from './columns.js';
import { toast, dlFile, closeExport, setSyncStatus } from './lib.js';
import { appSession } from './session.js';

let _hooks = {
  getData: () => /** @type {any[]} */ ([]),
  /** @type {(item: object, options?: { forInsert?: boolean }) => object} */
  itemToRow: () => ({}),
  loadData: async () => {},
  isIdea: () => false,
  notifyPeers: () => {},
};

export function setImportExportHooks(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

export function exportCSV() {
  const visCols = columns.filter((c) => c.visible);
  const headers = visCols.map((c) => c.name);
  const rows = [headers.join(';')];
  _hooks.getData().forEach((d) => {
    rows.push(
      visCols
        .map((c) => {
          const v = Array.isArray(d[c.id]) ? d[c.id].join(', ') : d[c.id] || '';
          return `"${String(v).replace(/"/g, '""')}"`;
        })
        .join(';')
    );
  });
  dlFile('Content_Map.csv', rows.join('\n'), 'text/csv');
  closeExport();
}

export function exportJSON() {
  dlFile('Content_Map.json', JSON.stringify(_hooks.getData(), null, 2), 'application/json');
  closeExport();
}

export async function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  closeExport();
  const text = await file.text();
  try {
    if (file.name.endsWith('.json')) {
      await importJSON(text);
    } else {
      await importCSV(text);
    }
  } catch (e) {
    toast('Import-Fehler: ' + e.message);
  }
}

async function importJSON(text) {
  const items = JSON.parse(text);
  if (!Array.isArray(items)) throw new Error('JSON muss ein Array sein');
  await importItems(items);
}

async function importCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV ist leer');
  const headers = lines[0].split(';').map((h) => h.replace(/^"|"$/g, '').trim());
  const items = lines.slice(1).map((line) => {
    const fields = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') {
        inQ = !inQ;
      } else if (ch === ';' && !inQ) {
        fields.push(cur);
        cur = '';
      } else cur += ch;
    }
    fields.push(cur);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = fields[i]?.replace(/^"|"$/g, '').trim() || '';
    });
    return obj;
  });
  await importItems(items);
}

function importPhaseStripIdeaTokens(tokens) {
  return tokens.filter((t) => !_hooks.isIdea({ isIdeaFlag: false, phase: String(t).trim() }));
}

function collectPhaseTokensFromCsvRow(row, colMap) {
  const out = [];
  const seen = new Set();
  for (const [k, v] of Object.entries(row)) {
    const field = colMap[k] !== undefined ? colMap[k] : k;
    if (field !== 'phase') continue;
    if (v == null) continue;
    const iter = Array.isArray(v)
      ? v.map((x) => String(x ?? '').trim()).filter(Boolean)
      : String(v)
          .split(/[,;|]/)
          .map((piece) => piece.trim())
          .filter(Boolean);
    iter.forEach((t) => {
      const lk = t.toLowerCase();
      if (seen.has(lk)) return;
      seen.add(lk);
      out.push(t);
    });
  }
  return out;
}

/**
 * Datenbank (Postgres) erwartet ein Datum wie 2026-04-15. Excel/deutsche CSV liefern oft 15.04.2026.
 */
function normalizeImportDate(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const t = Date.parse(`${iso}T12:00:00`);
    if (!Number.isNaN(t)) return iso;
  }
  return '';
}

const COL_MAP = {
  Titel: 'title',
  Title: 'title',
  TITEL: 'title',
  Thema: 'topic',
  Plattform: 'topic',
  Status: 'phase',
  Keywords: 'phase',
  Keyword: 'phase',
  Phase: 'phase',
  Format: 'format',
  Persona: 'persona',
  Speicherort: 'persona',
  'Verantw.': 'owner',
  Verantwortlich: 'owner',
  Verantwortliche: 'owner',
  URL: 'url',
  Notizen: 'notes',
  Datum: 'date',
};

async function importItems(items) {
  if (!items.length) {
    toast('Keine Einträge zum Importieren');
    return;
  }
  const data = _hooks.getData();
  const existingTitles = new Set(data.map((d) => (d.title || '').toLowerCase()));
  const toInsert = [];
  let skipped = 0;

  const formatLabels = new Set();
  const topicLabels = new Set();
  const phaseLabels = new Set();
  const ownerLabels = new Set();
  for (const item of items) {
    const mapped = {};
    Object.entries(item).forEach(([k, v]) => {
      const field = COL_MAP[k] !== undefined ? COL_MAP[k] : k;
      if (field === 'phase') return;
      mapped[field] = v;
    });
    const title = mapped.title || mapped.Titel || mapped.Title || '';
    if (!title) continue;
    if (existingTitles.has(title.toLowerCase())) continue;
    if (mapped.format) formatLabels.add(String(mapped.format).trim());
    if (mapped.topic) {
      String(mapped.topic)
        .split(/[,;|]/)
        .forEach((p) => {
          const t = p.trim();
          if (t) topicLabels.add(t);
        });
    }
    importPhaseStripIdeaTokens(collectPhaseTokensFromCsvRow(item, COL_MAP)).forEach((t) => phaseLabels.add(t));
    if (mapped.owner) ownerLabels.add(String(mapped.owner).trim());
  }
  ensureImportOptionsForFields({
    format: [...formatLabels],
    topic: [...topicLabels],
    phase: [...phaseLabels],
    owner: [...ownerLabels],
  });

  items.forEach((item) => {
    const mapped = {};
    Object.entries(item).forEach(([k, v]) => {
      const field = COL_MAP[k] !== undefined ? COL_MAP[k] : k;
      if (field === 'phase') return;
      mapped[field] = v;
    });
    const title = mapped.title || mapped.Titel || mapped.Title || '';
    if (!title) {
      skipped++;
      return;
    }
    if (existingTitles.has(title.toLowerCase())) {
      skipped++;
      return;
    }
    const phaseTokens = importPhaseStripIdeaTokens(collectPhaseTokensFromCsvRow(item, COL_MAP));
    const phaseForItem =
      phaseTokens.length === 0 ? '' : phaseTokens.length === 1 ? phaseTokens[0] : phaseTokens;
    const appItem = {
      title,
      topic: mapped.topic || '',
      phase: phaseForItem,
      format: mapped.format || '',
      persona: mapped.persona || '',
      owner: mapped.owner || '',
      mainKw: '',
      url: mapped.url || '',
      notes: mapped.notes || '',
      date: normalizeImportDate(mapped.date),
      kws: [],
      internalLinks: [],
      isIdeaFlag: false,
    };
    toInsert.push(_hooks.itemToRow(appItem, { forInsert: true }));
  });
  if (!toInsert.length) {
    toast(`Keine neuen Einträge (${skipped} übersprungen — doppelt oder ohne Titel)`);
    return;
  }
  setSyncStatus('loading', `Importiere ${toInsert.length} Einträge…`);
  const { error } = await appSession.sb.from('content_items').insert(toInsert);
  if (error) {
    setSyncStatus('error', 'Fehler');
    toast('Import-Fehler: ' + error.message);
    return;
  }
  try {
    await _hooks.loadData({ quiet: true });
  } catch (e) {
    setSyncStatus('error', e?.message?.slice(0, 80) || 'Fehler');
    toast('Import: Liste konnte nicht neu geladen werden — ' + (e?.message || e));
    return;
  }
  setSyncStatus('ok', `${_hooks.getData().length} Einträge`);
  toast(`✅ ${toInsert.length} Einträge importiert${skipped ? ', ' + skipped + ' übersprungen' : ''}`);
  _hooks.notifyPeers();
}
