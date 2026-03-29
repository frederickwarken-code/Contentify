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
