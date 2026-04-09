/**
 * LocalStorage-Schlüssel + einmalige Migration alter Keys (v4q_* → contentify_*).
 * Wird von der App importiert; Migration läuft beim ersten Import.
 */
export const COL_STORE = 'contentify_columns_v3';
export const DATA_STORE = 'contentify_data_v2';
export const RECENT_ACCOUNTS_KEY = 'contentify_recent_accounts_v1';
export const ROW_HEIGHT_KEY = 'contentify_row_height';
export const MAP_PRESETS_KEY = 'contentify_map_presets';
export const MAP_POS_KEY = 'contentify_map_pos_v2';
export const LEGACY_MAP_POSITIONS_KEY = 'contentify_map_positions';
/** @deprecated Nur noch für Migration / alte Referenzen; Auth liegt in localStorage unter `getSupabaseAuthStorageKey()`. */
export const SB_AUTH_TAB_META_KEY = 'contentify_sb_auth_storage_key';

/** Fester Key wie Supabase-Default: `sb-<projekt>-auth-token` — alle Tabs teilen dieselbe Session (siehe app.js). */
export function getSupabaseAuthStorageKey() {
  const url = typeof globalThis.SUPABASE_URL !== 'undefined' ? globalThis.SUPABASE_URL : '';
  let ref = 'project';
  try {
    if (url) ref = new URL(url).hostname.split('.')[0];
  } catch (_) { /* ignore */ }
  return `sb-${ref}-auth-token`;
}
/** Cross-Tab: Timestamp-Bump — andere Tabs hören auf `storage` und laden Daten neu. */
export const CONTENT_SYNC_BUMP_KEY = 'contentify_content_sync_bump';

(function migrateLegacyStorageKeys() {
  try {
    const pairs = [
      ['v4q_columns_v3', COL_STORE],
      ['v4q_data_v2', DATA_STORE],
      ['v4q_recent_accounts_v1', RECENT_ACCOUNTS_KEY],
      ['v4q_row_height', ROW_HEIGHT_KEY],
      ['v4q_map_presets', MAP_PRESETS_KEY],
      ['v4q_map_pos_v2', MAP_POS_KEY],
      ['v4q_map_positions', LEGACY_MAP_POSITIONS_KEY],
    ];
    for (const [oldK, newK] of pairs) {
      const oldV = localStorage.getItem(oldK);
      if (oldV == null) continue;
      if (!localStorage.getItem(newK)) localStorage.setItem(newK, oldV);
      localStorage.removeItem(oldK);
    }
  } catch (_) { /* ignore */ }
})();
