/**
 * Auswahlwerte gegen Kategorie-Optionen normalisieren (Pruning, Inline-Edit, Tabelle).
 */

/** Ordnet einen gespeicherten Wert der passenden Options-Bezeichnung zu (Groß/Klein egal). */
export function canonicalOptionLabel(col, raw) {
  const opts = col.options || [];
  return opts.find((o) => o.label.toLowerCase() === String(raw ?? '').trim().toLowerCase())?.label ?? null;
}

/**
 * Mehrfach-Auswahl: gültige Optionen (exakte Schreibweise) + **Werte, die noch nicht in der Liste stehen**
 * (z. B. nach Import oder umbenannten Kategorien), damit `runPruneStaleCategoryValues` sie nicht leer speichert.
 */
export function normalizeMultiselectToOptions(col, raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const c = canonicalOptionLabel(col, v);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
      continue;
    }
    const orphan = String(v ?? '').trim();
    if (!c && orphan && !seen.has(orphan)) {
      seen.add(orphan);
      out.push(orphan);
    }
  }
  return out;
}

/** Einzelauswahl: passende Option oder Rohwert behalten (Import / alte Bezeichnung). */
export function normalizeSelectToOptions(col, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return canonicalOptionLabel(col, raw) ?? s;
}

export function sameMultiValue(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}
