/**
 * Daten-Pipeline: Mapping DB ↔ App, `loadData`, Supabase-Realtime-Kanäle.
 * App-spezifische Reaktionen (Spalten, Bulk, UI) kommen per Callbacks aus `app.js`.
 */

export function rowToItem(row) {
  const cf = row.custom_fields || {};
  const item = {
    id: row.id,
    title: row.title || '',
    // For multiselect cols using DB string fields: prefer array from custom_fields
    topic: (() => {
      const v = cf.topic !== undefined ? cf.topic : row.topic;
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && v.startsWith('[')) {
        try { return JSON.parse(v); } catch (e) { /* ignore */ }
      }
      return v || '';
    })(),
    phase: (() => {
      const v = cf.phase !== undefined ? cf.phase : row.phase;
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && v.startsWith('[')) {
        try { return JSON.parse(v); } catch (e) { /* ignore */ }
      }
      return v || '';
    })(),
    format: row.format || '',
    persona: row.persona || '',
    owner: row.owner || '',
    mainKw: row.main_keyword || '',
    kws: row.keywords || [],
    url: row.url || '',
    notes: row.description || '',
    date: row.planned_date || '',
    internalLinks: row.internal_links || [],
    createdBy: cf.createdBy || row.profiles?.display_name || row.profiles?.email || '',
    potentialLinks: cf.potentialLinks || [],
    potentialLinksText: cf.potentialLinksText || '',
    isIdeaFlag: cf.isIdeaFlag || false,
    updatedAt: row.updated_at,
  };
  Object.keys(cf).forEach((k) => {
    if (!['topic', 'phase', 'createdBy', 'potentialLinks', 'potentialLinksText', 'isIdeaFlag'].includes(k)) {
      item[k] = cf[k];
    }
  });
  return item;
}

export function itemToRow(item, options = {}) {
  const {
    forInsert = false,
    currentProfile = null,
    currentUser = null,
  } = options;

  // Map app fields to DB columns
  const coreFields = ['title', 'topic', 'phase', 'format', 'persona', 'owner', 'mainKw', 'url', 'notes', 'date', 'kws', 'internalLinks'];
  const custom = {};
  Object.keys(item).forEach((k) => {
    if (!coreFields.includes(k) && !['id', 'updatedAt'].includes(k)) custom[k] = item[k];
  });
  return {
    title: item.title || '',
    topic: Array.isArray(item.topic) ? '' : (item.topic || ''), // array stored in custom_fields below
    phase: Array.isArray(item.phase) ? '' : (item.phase || ''), // array stored in custom_fields below
    format: item.format || '',
    persona: item.persona || '',
    owner: item.owner || '',
    main_keyword: item.mainKw || '',
    url: item.url || '',
    description: item.notes || '',
    planned_date: item.date || null,
    keywords: item.kws || [],
    internal_links: item.internalLinks || [],
    custom_fields: {
      ...custom,
      // Store multiselect arrays in custom_fields since DB columns are strings
      ...(Array.isArray(item.topic) ? { topic: item.topic } : (item.topic ? { topic: [item.topic] } : {})),
      ...(Array.isArray(item.phase) ? { phase: item.phase } : (item.phase ? { phase: [item.phase] } : {})),
      potentialLinks: item.potentialLinks || [],
      potentialLinksText: item.potentialLinksText || '',
      isIdeaFlag: item.isIdeaFlag || false,
      createdBy: item.createdBy || currentProfile?.display_name || currentUser?.email || '',
    },
    ...(forInsert ? { created_by: currentUser?.id } : {}),
  };
}

/**
 * Lädt alle Einträge aus Supabase, mappt sie in App-Objekte und ruft `render` auf.
 * @param {object} ctx
 * @param {import('@supabase/supabase-js').SupabaseClient} ctx.sb
 * @param {(type: string, msg?: string) => void} ctx.setSyncStatus
 * @param {(items: object[]) => void} ctx.setData
 * @param {() => void} ctx.render
 * @param {boolean} [ctx.quiet] — kein Sync-Status „Lade…“ / „OK“
 */
export async function loadData(ctx) {
  const {
    sb,
    setSyncStatus,
    setData,
    render,
    quiet = false,
  } = ctx;
  if (!quiet) setSyncStatus('loading', 'Lade…');
  const { data: rows, error } = await sb.from('content_items').select('*').order('title');
  if (error) {
    if (!quiet) setSyncStatus('error', 'Fehler');
    return;
  }
  const mapped = (rows || []).map(rowToItem);
  setData(mapped);
  if (!quiet) setSyncStatus('ok', `${mapped.length} Einträge`);
  render();
}

/**
 * Registriert Realtime: `content_items`, `app_settings`, Presence.
 * Entfernt zuvor alle Kanäle in `channels` (verhindert Doppel-Subscribe bei erneutem Login).
 */
export function subscribeRealtimeChannels(ctx) {
  const {
    sb,
    channels,
    onContentItemsEvent,
    onAppSettingsEvent,
    presence,
  } = ctx;

  if (channels.length) {
    channels.forEach((ch) => {
      try { sb.removeChannel(ch); } catch (e) { /* ignore */ }
    });
    channels.length = 0;
  }

  const contentChannel = sb.channel('cm_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'content_items' }, onContentItemsEvent)
    .subscribe();
  channels.push(contentChannel);

  const settingsChannel = sb.channel('cm_settings')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, onAppSettingsEvent)
    .subscribe();
  channels.push(settingsChannel);

  const { userId, displayName, color, onPresenceSync } = presence;
  const presenceChannel = sb.channel('cm_presence', { config: { presence: { key: userId } } });
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      const onlineUsers = {};
      Object.entries(state).forEach(([uid, presences]) => {
        const p = presences[0];
        if (p) onlineUsers[uid] = { display_name: p.display_name, color: p.color };
      });
      onPresenceSync(onlineUsers);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({
          display_name: displayName,
          color,
        });
      }
    });
  channels.push(presenceChannel);
}
