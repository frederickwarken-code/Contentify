/**
 * Auswahlwerte gegen Kategorie-Optionen normalisieren (Pruning, Inline-Edit, Tabelle).
 */

/** Ordnet einen gespeicherten Wert der passenden Options-Bezeichnung zu (Groß/Klein egal). */
export function canonicalOptionLabel(col, raw) {
  const opts = col.options || [];
  return opts.find((o) => o.label.toLowerCase() === String(raw ?? '').trim().toLowerCase())?.label ?? null;
}

/** Nur noch gültige Mehrfach-Auswahl-Labels (laut aktueller Kategorie-Definition). */
export function normalizeMultiselectToOptions(col, raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const c = canonicalOptionLabel(col, v);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

export function normalizeSelectToOptions(col, raw) {
  return canonicalOptionLabel(col, raw) ?? '';
}

export function sameMultiValue(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}
