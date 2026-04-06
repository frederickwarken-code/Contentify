/**
 * Kleine Hilfsfunktionen (Strings, Dialoge, Downloads) — ohne App-State.
 * Von überall importierbar; bei Bedarf zusätzlich über attachInlineHandlers auf window.
 */

let toastTimer;

/** Text für HTML-Einbettung escapen. */
export function esc(s) {
  if (Array.isArray(s)) s = s.join(', ');
  return (String(s || ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Statuszeile in der Kopfleiste (Sync / Laden / Fehler). */
export function setSyncStatus(type, msg) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (!type) { el.innerHTML = ''; return; }
  if (type === 'loading') el.innerHTML = `<div class="sync-spinner"></div><span>${msg}</span>`;
  if (type === 'ok') el.innerHTML = `<span style="color:var(--accent-mid)">✓</span><span style="color:var(--text-faint)">${msg}</span>`;
  if (type === 'error') el.innerHTML = `<span style="color:var(--red)">⚠</span><span style="color:var(--red)">${msg}</span>`;
}

/** Kurzer Hinweis unten in der Mitte. */
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

/**
 * Eigenes Bestätigungs-Overlay (Teams blockiert oft window.confirm).
 * @param {string} message
 * @param {() => void} onOk
 * @param {string} [title]
 */
export function showConfirm(message, onOk, title = 'Bestätigung') {
  const overlay = document.getElementById('confirmOverlay');
  const msgEl = document.getElementById('confirmMsg');
  const titleEl = document.getElementById('confirmTitle');
  const okBtn = document.getElementById('confirmOk');
  const cancelBtn = document.getElementById('confirmCancel');
  if (!overlay) {
    if (window.confirm(message)) onOk();
    return;
  }
  msgEl.textContent = message;
  titleEl.textContent = title;
  overlay.classList.add('open');
  const close = () => overlay.classList.remove('open');
  const handleOk = () => {
    close();
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
    onOk();
  };
  const handleCancel = () => {
    close();
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
  };
  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
}

/** Datei-Download im Browser auslösen. */
export function dlFile(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

/**
 * Bricht ab, wenn eine Promise (z. B. Supabase) zu lange nicht antwortet.
 * Hintergrund: hängende Requests sonst „Speichere…“ / „Abmelden…“ ohne Ende; Reload hilft, weil der Tab neu startet.
 */
export function withTimeout(promise, ms, errMsg = '__timeout__') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(errMsg)), ms);
    }),
  ]);
}

/** Import/Export-Popup schließen. */
export function closeExport() {
  document.getElementById('exportPanel')?.classList.remove('open');
}

/** Anzeigename für Spaltentyp (Kategorien-UI). */
export function typeLabel(t) {
  return {
    text: 'Text',
    number: 'Zahl',
    select: 'Auswahl',
    multiselect: 'Mehrfachauswahl',
    date: 'Datum',
    url: 'URL',
    links: 'Interne Links',
  }[t] || t;
}
