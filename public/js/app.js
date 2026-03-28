// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
let sb = null;
let currentUser = null;
let currentProfile = null;
let isReadOnly = false;

// ═══════════════════════════════════════════
// COLUMN DEFINITIONS
// Stored in localStorage + Supabase (settings table optional)
// Each column: { id, name, type, options:[{label,color}], visible, width }
// ═══════════════════════════════════════════
const COL_STORE = 'v4q_columns_v3';
const DATA_STORE = 'v4q_data_v2';

let columns = [];  // active column definitions
let data = [];     // content items
let activeFilter = null; // {colId, values: Set<string>}
let activeFilterColId = null; // which select-column the sidebar filter uses
let showIdeas = true; // toggle for idea visibility
let currentView = 'table';
let colorMode = 'type';
let hiddenCats = new Set();
let simulation = null; // legacy reference kept for compatibility
let onlineUsers = {}; // { userId: { display_name, color } } — realtime presence
let sortColId = 'title'; // which column to sort by
let sortDir = 'asc';     // 'asc' or 'desc'
let _sim = null;       // new simulation reference
let selectedNodeId = null;
let mapZoom = null;

// Temp state for drawer
let drawerKws = [];
let drawerLinks = [];
let drawerItem = null; // null = new

// Temp state for option builder
let newColOptions = [];

// ── Default columns ──
function defaultColumns() {
  return [
    { id:'title',    name:'Titel',       type:'text',        visible:true,  locked:true },
    { id:'format',   name:'Format',      type:'select',      visible:true,
      options:[
        {label:'Page',  color:'#2f9e44'},
        {label:'Video', color:'#222222'}
      ]},
    { id:'topic',    name:'Plattform',   type:'multiselect', visible:true,
      options:[
        {label:'Youtube',  color:'#e03131'},
        {label:'LinkedIn', color:'#1971c2'},
        {label:'Website',  color:'#2f9e44'},
        {label:'Reddit',   color:'#e8590c'}
      ]},
    { id:'phase',    name:'Keywords',    type:'multiselect', visible:true,
      options:[
        {label:'Core',           color:'#868e96'},
        {label:'Produkt',        color:'#2f9e44'},
        {label:'Branche',        color:'#1971c2'},
        {label:'Blog',           color:'#e67700'},
        {label:'Lead-Gen',       color:'#9b4dca'},
        {label:'Content',        color:'#e8590c'},
        {label:'Unternehmen',    color:'#6741d9'},
        {label:'Customer Center',color:'#495057'},
        {label:'Kontakt',        color:'#2f9e44'},
        {label:'ModSPOT',        color:'#e8590c'},
        {label:'ModOFFICE',      color:'#40c057'},
        {label:'ModHYL',         color:'#c0eb75'},
        {label:'ACR',            color:'#cc5de8'},
        {label:'Werkerführung',  color:'#5c7cfa'},
        {label:'KI',             color:'#40c057'},
        {label:'ModPCB',         color:'#74c0fc'}
      ]},
    { id:'owner',    name:'Verantw.',    type:'select',      visible:true,
      options:[
        {label:'Frederick W', color:'#868e96'},
        {label:'Thomas M',    color:'#868e96'}
      ]},
    { id:'date',     name:'Datum',       type:'date',        visible:true  },
    { id:'internalLinks', name:'Links',  type:'links',       visible:true,  locked:true },
    { id:'persona',  name:'Speicherort', type:'text',        visible:true  },
    { id:'url',      name:'URL',         type:'url',         visible:false },
    { id:'notes',    name:'Notizen',     type:'text',        visible:false, locked:true },
    { id:'createdBy',name:'Erstellt von',type:'text',        visible:false, locked:true, system:true },
  ];
}

function loadColumns() {
  try {
    const r = localStorage.getItem(COL_STORE);
    columns = r ? JSON.parse(r) : defaultColumns();
    const SYSTEM_IDS = ['title','internalLinks','notes','createdBy'];
    columns.forEach(col => { if(!SYSTEM_IDS.includes(col.id)) delete col.locked; });
  } catch { columns = defaultColumns(); }
}

async function syncColumnsFromSupabase() {
  // Load columns from Supabase so all users see the same categories
  try {
    const { data, error } = await sb.from('app_settings').select('value').eq('key','columns').single();
    if(error || !data) {
      // No columns in Supabase yet — upload current localStorage columns
      await saveColumnsToSupabase();
      return;
    }
    const remote = data.value;
    if(Array.isArray(remote) && remote.length > 0) {
      columns = remote;
      const SYSTEM_IDS = ['title','internalLinks','notes','createdBy'];
      columns.forEach(col => { if(!SYSTEM_IDS.includes(col.id)) delete col.locked; });
      localStorage.setItem(COL_STORE, JSON.stringify(columns));
    }
  } catch(e) { /* Supabase not available, use localStorage */ }
}

async function saveColumnsToSupabase() {
  try {
    await sb.from('app_settings').upsert({ key: 'columns', value: columns, updated_at: new Date().toISOString() });
  } catch(e) { /* ignore */ }
}
function saveColumns() {
  localStorage.setItem(COL_STORE, JSON.stringify(columns));
  saveColumnsToSupabase(); // sync to Supabase for all users
}

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════
let isSignupMode = false;
function toggleSignup() {
  isSignupMode = !isSignupMode;
  document.getElementById('signupToggleBtn').textContent = isSignupMode ? '← Zurück zum Login' : 'Noch kein Konto? Registrieren';
  document.getElementById('login-subtitle').textContent = isSignupMode ? 'Neues Konto erstellen' : 'Anmelden';
  document.getElementById('loginError').textContent = '';
}
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pw = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!email || !pw) { errEl.textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
  setSyncStatus('loading', 'Anmelden…');
  try {
    let res;
    if (isSignupMode) {
      res = await sb.auth.signUp({ email, password: pw });
      if (!res.error) { errEl.style.color = 'var(--accent)'; errEl.textContent = 'Registrierung erfolgreich! Bitte E-Mail bestätigen.'; setSyncStatus(''); return; }
    } else {
      res = await sb.auth.signInWithPassword({ email, password: pw });
    }
    if (res.error) throw res.error;
    rememberAccountEmail(email);
  } catch(e) {
    errEl.style.color = 'var(--red)';
    errEl.textContent = e.message === 'Invalid login credentials' ? 'E-Mail oder Passwort falsch.' : e.message;
    setSyncStatus('');
  }
}

function hideUserMenu(){ const m=document.getElementById('userMenu'); if(m) m.style.display='none'; }
function showUserMenu(){
  const m = document.getElementById('userMenu');
  if(!m) return;
  document.getElementById('userMenuName').textContent = currentProfile?.display_name || 'Konto';
  document.getElementById('userMenuEmail').textContent = currentProfile?.email || currentUser?.email || '';
  document.getElementById('adminMenuBtn').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
  m.style.display='block';
}
function toggleUserMenu(e){
  e?.stopPropagation?.();
  const m = document.getElementById('userMenu');
  if(!m) return;
  if(m.style.display==='none' || !m.style.display) showUserMenu();
  else hideUserMenu();
}
document.addEventListener('click', (e)=>{
  const m=document.getElementById('userMenu');
  const chip=document.getElementById('userChip');
  if(!m || m.style.display==='none') return;
  if(m.contains(e.target) || chip?.contains(e.target)) return;
  hideUserMenu();
});

function rememberAccountEmail(email){
  try{
    if(!email) return;
    const key='v4q_recent_accounts_v1';
    const raw=JSON.parse(localStorage.getItem(key)||'[]');
    const list=Array.isArray(raw)?raw:[];
    const next=[email, ...list.filter(x=>x!==email)].slice(0,6);
    localStorage.setItem(key, JSON.stringify(next));
  }catch{}
}
function getRememberedAccounts(){
  try{
    const raw=JSON.parse(localStorage.getItem('v4q_recent_accounts_v1')||'[]');
    return Array.isArray(raw)?raw:[];
  }catch{ return []; }
}

function switchAccount(){
  hideUserMenu();
  const accounts = getRememberedAccounts();
  if(accounts.length){
    document.getElementById('loginEmail').value = accounts[0];
  }
  document.getElementById('login-screen').classList.add('visible');
  document.getElementById('appShell').style.display='none';
  toast(accounts.length ? 'Konto wechseln: E-Mail ist vorausgefüllt.' : 'Bitte mit anderem Konto anmelden.');
}

function openAdminPanelFromMenu(){
  hideUserMenu();
  openAdminPanel();
}

async function doLogout(forceReload=false) {
  hideUserMenu();
  setSyncStatus('loading', 'Abmelden…');
  try{
    const { error } = await sb.auth.signOut();
    if(error) throw error;
  }catch(e){
    toast('Logout-Fehler: ' + (e?.message || e));
  }finally{
    setSyncStatus('');
    if(forceReload) setTimeout(()=>location.reload(), 150);
  }
}

// ── ADMIN PANEL ──
async function openAdminPanel() {
  if (currentProfile?.role !== 'admin') return; // silently ignore for non-admins
  document.getElementById('adminOverlay').classList.add('open');
  await loadAdminUsers();
}
function closeAdminPanel() {
  document.getElementById('adminOverlay').classList.remove('open');
}

async function loadAdminUsers() {
  const tbody = document.getElementById('adminUserList');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-faint)">Lädt…</td></tr>';
  const { data: users, error } = await sb.from('profiles').select('*').order('email');
  if (error) { tbody.innerHTML = '<tr><td colspan="4" style="color:var(--red);padding:12px">Fehler: '+error.message+'</td></tr>'; return; }
  if (!users?.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-faint)">Keine Nutzer gefunden</td></tr>'; return; }
  tbody.innerHTML = users.map(u => {
    const name = esc(u.display_name || '–');
    const email = esc(u.email || '');
    const isMe = u.id === currentUser?.id;
    const roleOpts = ['admin','editor','viewer'].map(r =>
      `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`
    ).join('');
    return `<tr>
      <td style="font-weight:500">${name}${isMe?' <span style="font-size:10px;color:var(--accent)">(du)</span>':''}</td>
      <td style="color:var(--text-muted)">${email}</td>
      <td>
        ${isMe
          ? `<span class="role-badge">${u.role}</span>`
          : `<select class="role-select" onchange="updateUserRole('${u.id}', this.value, this)">${roleOpts}</select>`
        }
      </td>
    </tr>`;
  }).join('');
}

async function updateUserRole(userId, newRole, selectEl) {
  selectEl.disabled = true;
  const { error } = await sb.from('profiles').update({ role: newRole }).eq('id', userId);
  if (error) {
    toast('Fehler: ' + error.message);
    selectEl.disabled = false;
    return;
  }
  toast(`✅ Rolle auf "${newRole}" geändert`);
  selectEl.disabled = false;
  // Reload user list to reflect change
  await loadAdminUsers();
}

async function loadProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
  currentProfile = data;
  isReadOnly = data?.role === 'viewer';
  renderUserChip();
}
function renderUserChip() {
  if (!currentProfile) return;
  const initial = (currentProfile.display_name || currentProfile.email || '?')[0].toUpperCase();
  const isAdmin = currentProfile.role === 'admin';
  document.getElementById('userChip').innerHTML = `
    <div class="user-avatar">${initial}</div>
    <span style="font-size:12px;color:var(--text-muted);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${currentProfile.display_name || currentProfile.email}</span>
    <span class="role-badge">${currentProfile.role}</span>
    ${isAdmin ? '<span style="font-size:10px;opacity:.7;color:rgba(255,255,255,.7)" title="Nutzerverwaltung öffnen">👥</span>' : ''}`;
  document.getElementById('userChip').style.cursor = 'pointer';
  if (isReadOnly) { document.getElementById('newBtn').disabled = true; }
}

// ═══════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════
function rowToItem(row) {
  const cf = row.custom_fields || {};
  const item = {
    id: row.id,
    title: row.title || '',
    // For multiselect cols using DB string fields: prefer array from custom_fields
    topic: (() => {
      const v = cf.topic !== undefined ? cf.topic : row.topic;
      if(Array.isArray(v)) return v;
      if(typeof v === 'string' && v.startsWith('[')) { try { return JSON.parse(v); } catch(e){} }
      return v || '';
    })(),
    phase: (() => {
      const v = cf.phase !== undefined ? cf.phase : row.phase;
      if(Array.isArray(v)) return v;
      if(typeof v === 'string' && v.startsWith('[')) { try { return JSON.parse(v); } catch(e){} }
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
  // Merge custom fields (but don't overwrite the fields we explicitly set above)
  Object.keys(cf).forEach(k => {
    if (!['topic','phase','createdBy','potentialLinks','potentialLinksText','isIdeaFlag'].includes(k)) {
      item[k] = cf[k];
    }
  });
  return item;
}

async function loadData() {
  setSyncStatus('loading', 'Lade…');
  const { data: rows, error } = await sb.from('content_items').select('*').order('title');
  if (error) { setSyncStatus('error', 'Fehler'); return; }
  data = rows.map(rowToItem);
  setSyncStatus('ok', `${data.length} Einträge`);

  render();
  // renderTable handles scroll restoration via _preservedScroll
}

function subscribeRealtime() {
  // Content items realtime
  sb.channel('cm_rt')
    .on('postgres_changes',{event:'*',schema:'public',table:'content_items'},async(p)=>{
      await loadData();
      const icons = {INSERT:'✨',UPDATE:'✏️',DELETE:'🗑️'};
      showActivity(icons[p.eventType]||'●', p.new?.title || p.old?.title || 'Eintrag');
    })
    .subscribe();

  // Categories realtime — sync when any user saves columns
  sb.channel('cm_settings')
    .on('postgres_changes',{event:'*',schema:'public',table:'app_settings'},async(p)=>{
      if(p.new?.key === 'columns' && Array.isArray(p.new?.value)) {
        columns = p.new.value;
        const SYSTEM_IDS = ['title','internalLinks','notes','createdBy'];
        columns.forEach(col => { if(!SYSTEM_IDS.includes(col.id)) delete col.locked; });
        localStorage.setItem(COL_STORE, JSON.stringify(columns));
        render();
        toast('🔄 Kategorien aktualisiert');
      }
    })
    .subscribe();

  // Presence — who is online
  const presenceColors = ['#e03131','#1971c2','#2f9e44','#e8590c','#9b4dca','#f0b429','#0ca678','#d6336c'];
  const myColor = presenceColors[Math.abs(currentUser.id.split('').reduce((a,c)=>a+c.charCodeAt(0),0)) % presenceColors.length];
  const presenceChannel = sb.channel('cm_presence', { config: { presence: { key: currentUser.id } } });
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      onlineUsers = {};
      Object.entries(state).forEach(([uid, presences]) => {
        const p = presences[0];
        if(p) onlineUsers[uid] = { display_name: p.display_name, color: p.color };
      });
      renderOnlineUsers();
    })
    .subscribe(async status => {
      if(status === 'SUBSCRIBED') {
        await presenceChannel.track({
          display_name: currentProfile?.display_name || currentUser.email,
          color: myColor
        });
      }
    });
}

function renderOnlineUsers() {
  let el = document.getElementById('onlineUsersBar');
  if(!el) return;
  const users = Object.values(onlineUsers);
  el.innerHTML = users.map(u => {
    const initials = (u.display_name || '?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    return `<div title="${esc(u.display_name || '')}" style="width:28px;height:28px;border-radius:50%;background:${u.color};color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-left:-6px;border:2px solid var(--surface);flex-shrink:0">${initials}</div>`;
  }).join('');
  el.style.display = users.length > 0 ? 'flex' : 'none';
}

// ═══════════════════════════════════════════
// SYNC STATUS
// ═══════════════════════════════════════════
function setSyncStatus(type, msg) {
  const el = document.getElementById('syncStatus');
  if (!type) { el.innerHTML = ''; return; }
  if (type==='loading') el.innerHTML = `<div class="sync-spinner"></div><span>${msg}</span>`;
  if (type==='ok')      el.innerHTML = `<span style="color:var(--accent-mid)">✓</span><span style="color:var(--text-faint)">${msg}</span>`;
  if (type==='error')   el.innerHTML = `<span style="color:var(--red)">⚠</span><span style="color:var(--red)">${msg}</span>`;
}

// ═══════════════════════════════════════════
// ACTIVITY FEED
// ═══════════════════════════════════════════
function showActivity(icon, text) {
  const panel = document.getElementById('activityPanel');
  const pill = document.createElement('div');
  pill.className = 'activity-pill';
  pill.innerHTML = `<span>${icon}</span><span style="flex:1;color:var(--text-muted)">${esc(text)}</span>`;
  panel.appendChild(pill);
  setTimeout(()=>{ pill.classList.add('fade-out'); setTimeout(()=>pill.remove(),500); }, 4000);
}

// ═══════════════════════════════════════════
// FILTER & SORT
// ═══════════════════════════════════════════
function getFiltered() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  let items = data.filter(d => {
    if (ideaMode === 'hide' && isIdea(d)) return false;
    if (ideaMode === 'only' && !isIdea(d)) return false;
    if (activeFilter && activeFilter.values.size > 0) {
      const raw = d[activeFilter.colId];
      // Handle both single values (select) and arrays (multiselect)
      const vals = Array.isArray(raw) ? raw : [String(raw || '')];
      const hasMatch = vals.some(v => activeFilter.values.has(String(v)));
      if (!hasMatch) return false;
    }
    if (q) {
      const h = Object.values(d).join(' ').toLowerCase();
      if (!h.includes(q)) return false;
    }
    return true;
  });
  const col = columns.find(c => c.id === sortColId);
  items.sort((a,b) => {
    let va = a[sortColId], vb = b[sortColId];
    let cmp = 0;
    if(col?.type === 'links') {
      // Sort by number of links
      cmp = (Array.isArray(va) ? va.length : 0) - (Array.isArray(vb) ? vb.length : 0);
    } else if(col?.type === 'number') {
      cmp = (parseFloat(va)||0) - (parseFloat(vb)||0);
    } else if(col?.type === 'date') {
      cmp = (va||'').localeCompare(vb||'');
    } else if(col?.type === 'multiselect') {
      // Use first item alphabetically
      const a0 = (Array.isArray(va) ? va[0] : va) || '';
      const b0 = (Array.isArray(vb) ? vb[0] : vb) || '';
      cmp = a0.localeCompare(b0, 'de');
    } else {
      cmp = (String(va||'')).localeCompare(String(vb||''), 'de');
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return items;
}

// ═══════════════════════════════════════════
// RENDER SIDEBAR
// ═══════════════════════════════════════════
function renderSidebar() {
  const selectCols = columns.filter(c => c.type === 'select');
  const filterableCols = columns.filter(c => c.type === 'select' || c.type === 'multiselect');
  // Populate filter column picker
  const picker = document.getElementById('filterColPicker');
  if (picker) {
    picker.innerHTML = filterableCols.map(c =>
      `<option value="${c.id}" ${activeFilterColId===c.id?'selected':''}>${esc(c.name)}</option>`
    ).join('');
    if (!activeFilterColId && selectCols.length > 0) activeFilterColId = selectCols[0].id;
    if (picker.value !== activeFilterColId && activeFilterColId) picker.value = activeFilterColId;
  }
  const filterCol = filterableCols.find(c => c.id === activeFilterColId) || filterableCols[0];
  const el = document.getElementById('dynamicFilters');
  el.innerHTML = '';
  if (filterCol) {
    const visibleData = showIdeas ? data : data.filter(d => !isIdea(d));
    const hasFilter = activeFilter && activeFilter.values?.size > 0;
    // "Alle" clears all selections
    const all = document.createElement('button');
    all.className = 'filter-btn' + (!hasFilter ? ' active' : '');
    all.onclick = () => { activeFilter = null; render(); };
    all.innerHTML = `Alle <span class="cnt">${visibleData.length}</span>`;
    el.appendChild(all);
    const counts = {};
    visibleData.forEach(d => {
      const raw = d[filterCol.id];
      // Handle multiselect (array) and select (string)
      const vals = Array.isArray(raw) ? raw : (raw ? [raw] : ['—']);
      vals.forEach(v => { counts[v] = (counts[v]||0) + 1; });
    });
    (filterCol.options||[]).forEach(opt => {
      if (!counts[opt.label]) return;
      const isActive = activeFilter?.values?.has(opt.label);
      const b = document.createElement('button');
      b.className = 'filter-btn' + (isActive ? ' active' : '');
      b.onclick = () => {
        if (!activeFilter) activeFilter = {colId: filterCol.id, values: new Set()};
        const newValues = new Set(activeFilter.values);
        if (newValues.has(opt.label)) {
          newValues.delete(opt.label);
          activeFilter = newValues.size > 0 ? {colId: filterCol.id, values: newValues} : null;
        } else {
          newValues.add(opt.label);
          activeFilter = {colId: filterCol.id, values: newValues};
        }
        render();
      };
      b.innerHTML = `${esc(opt.label)} <span class="cnt">${counts[opt.label]||0}</span>`;
      el.appendChild(b);
    });
  }
  // Update ideas toggle UI
  const track = document.getElementById('ideasToggleTrack');
  const thumb = document.getElementById('ideasToggleThumb');
  const label = document.getElementById('ideasToggleLabel');
  if (track) track.style.background = ideaMode!=='hide' ? 'var(--accent)' : 'var(--border-mid)';
  if (thumb) thumb.style.left = ideaMode!=='hide' ? '14px' : '2px';
  if (label) label.textContent = ideaMode==='hide' ? 'Ideen versteckt' : 'Ideen sichtbar';
  const onlyBtn = document.getElementById('onlyIdeasBtn');
  if (onlyBtn) {
    onlyBtn.classList.toggle('active', ideaMode==='only');
  }
  // Stats
  const phaseCol = columns.find(c=>c.id==='phase');
  const done = phaseCol ? data.filter(d=>d.phase==='Fertig').length : 0;
  const ideas = data.filter(d=>isIdea(d)).length;
  const totalLinks = data.reduce((s,d)=>s+(d.internalLinks||[]).length,0);
  const withUrl = data.filter(d=>d.url).length;
  const avgLinks = data.length ? (totalLinks/data.length).toFixed(1) : 0;
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-num">${data.length}</div><div class="stat-lbl">Seiten gesamt</div></div>
    <div class="stat-card"><div class="stat-num">${ideas}</div><div class="stat-lbl">💡 Ideen</div></div>
    <div class="stat-card"><div class="stat-num">${totalLinks}</div><div class="stat-lbl">🔗 Links</div></div>
    <div class="stat-card"><div class="stat-num">${avgLinks}</div><div class="stat-lbl">Ø Links/Seite</div></div>`;
}

function isIdea(d) {
  // First check explicit isIdeaFlag (set via drawer toggle)
  if (d.isIdeaFlag) return true;
  // Then check phase column isIdea flag
  const phaseCol = columns.find(c=>c.id==='phase');
  if (!phaseCol) return false;
  const ideaOpts = (phaseCol.options||[]).filter(o=>o.isIdea).map(o=>o.label);
  if (ideaOpts.length) return ideaOpts.includes(d[phaseCol.id]);
  return d.phase === 'Idee';
}

// ideaMode: 'show' = all visible, 'hide' = ideas hidden, 'only' = only ideas
let ideaMode = 'show';
function setIdeaMode(mode) {
  if (ideaMode === mode) {
    ideaMode = 'show'; // toggle off
  } else {
    ideaMode = mode;
  }
  showIdeas = ideaMode !== 'hide';
  render();
}
function toggleIdeas() { setIdeaMode(showIdeas ? 'hide' : 'show'); }

// ═══════════════════════════════════════════
// RENDER MAIN
// ═══════════════════════════════════════════
function render() {
  renderSidebar();
  if (currentView==='map') {
    // If map is already rendered with good dimensions, just rebuild graph
    const existingWrap = document.getElementById('mapWrap');
    const existingW = existingWrap?.offsetWidth;
    const existingH = existingWrap?.offsetHeight;
    if(existingWrap && existingW > 100 && existingH > 100) {
      buildGraph(); // dimensions already good, skip HTML rebuild
    } else {
      renderMap(); // first load or bad dimensions — full rebuild
    }
    return;
  }
  const items = getFiltered();
  const area = document.getElementById('contentArea');
  if (!items.length) { area.innerHTML=`<div class="empty"><div style="font-size:32px">📭</div><p>Keine Einträge.</p></div>`; return; }
  if (currentView==='table') renderTable(items, area);
  else renderKanban(items, area);
}

// ── TABLE ──
// ── TABLE ──
// Bulk selection state
const selectedIds = new Set();
let _lastCheckedIndex = -1; // for shift-click range selection
let _preservedScroll = 0; // scroll position to preserve across renders
function _getScrollEl() { return document.querySelector('.tbl-wrap') || document.getElementById('contentArea'); }

function renderTable(items, area) {
  // Preserve scroll position - use max of current and globally preserved
  const contentArea = _getScrollEl();
  const scrollTop = Math.max(contentArea?.scrollTop || 0, _preservedScroll);
  if(contentArea?.scrollTop > 0) _preservedScroll = contentArea.scrollTop;
  const visCols = columns.filter(c => c.visible);
  let html = `<div class="tbl-wrap"><table><thead><tr>`;
  // Select-all checkbox column
  html += `<th class="th-check"><input type="checkbox" class="row-check" id="selectAllCb" title="Alle auswählen" onchange="toggleSelectAll(this.checked)"></th>`;
  visCols.forEach(col => {
    const isSorted = sortColId === col.id;
  const sortIcon = isSorted ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  html += `<th style="min-width:80px;cursor:pointer" title="Nach ${esc(col.name)} sortieren"><div class="th-inner" onclick="cycleSortBy('${col.id}')">${esc(col.name)}<span style="color:var(--accent);font-size:10px">${sortIcon}</span></div></th>`;
  });
  html += `<th class="th-actions"></th></tr></thead><tbody id="tBody"></tbody></table></div>`;
  area.innerHTML = html;
  // Restore scroll position
  if(scrollTop > 0) {
    if(contentArea) contentArea.scrollTop = scrollTop;
    requestAnimationFrame(() => { const el = _getScrollEl(); if(el) el.scrollTop = scrollTop; });
    _preservedScroll = 0; // reset after restore
  }
  const tbody = document.getElementById('tBody');
  items.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    tr.dataset.index = idx;
    tr.style.height = currentRowHeight + 'px';
    if (isIdea(item)) tr.setAttribute('data-idea','1');
    if (selectedIds.has(item.id)) tr.classList.add('row-selected');

    // Checkbox cell
    const tdCb = document.createElement('td');
    tdCb.className = 'td-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'row-check';
    cb.checked = selectedIds.has(item.id);
    // Use mousedown to detect shift before checked state changes
    cb.addEventListener('mousedown', (e) => {
      if (e.shiftKey && _lastCheckedIndex >= 0) {
        e.preventDefault(); // prevent default check toggle, we handle it manually
        const rows = [...document.querySelectorAll('#tBody tr')];
        const currentIndex = parseInt(tr.dataset.index);
        const start = Math.min(_lastCheckedIndex, currentIndex);
        const end = Math.max(_lastCheckedIndex, currentIndex);
        const shouldCheck = !cb.checked; // toggle based on current state
        rows.forEach(row => {
          const ri = parseInt(row.dataset.index);
          if (ri >= start && ri <= end) {
            const rId = row.dataset.id;
            const rCb = row.querySelector('.row-check');
            if (shouldCheck) { selectedIds.add(rId); row.classList.add('row-selected'); if(rCb) rCb.checked=true; }
            else { selectedIds.delete(rId); row.classList.remove('row-selected'); if(rCb) rCb.checked=false; }
          }
        });
        _lastCheckedIndex = currentIndex;
        updateBulkBar();
      }
    });
    cb.addEventListener('change', (e) => {
      if (!e.shiftKey) { // normal click (shift is handled by mousedown)
        toggleRowSelect(item.id, cb.checked, tr);
        _lastCheckedIndex = parseInt(tr.dataset.index);
      }
    });
    tdCb.appendChild(cb);
    tr.appendChild(tdCb);

    visCols.forEach(col => {
      const td = document.createElement('td');
      td.dataset.col = col.id;
      td.dataset.id = item.id;
      const view = document.createElement('div');
      view.className = 'cell-view';
      view.style.minHeight = currentRowHeight + 'px';
      const ideaPrefix = (isIdea(item) && col.id === 'title') ? '<span title="Idee" style="margin-right:4px">💡</span>' : '';
      view.innerHTML = ideaPrefix + renderCellValue(item, col);
      view.onclick = (e) => { if (!isReadOnly) startCellEdit(td, item, col); };
      const edit = document.createElement('div');
      edit.className = 'cell-edit';
      edit.innerHTML = buildCellEditor(item, col);
      edit.querySelector('input,select,textarea')?.addEventListener('blur', () => commitCellEdit(td, item, col));
      edit.querySelector('input,select,textarea')?.addEventListener('keydown', e => {
        if (e.key==='Enter' && col.type!=='text') commitCellEdit(td, item, col);
        if (e.key==='Escape') cancelCellEdit(td);
      });
      td.appendChild(view);
      td.appendChild(edit);
      tr.appendChild(td);
    });
    const tdAct = document.createElement('td');
    tdAct.innerHTML = `<button class="row-open-btn" onclick="openDrawer('${item.id}')" title="Alle Felder bearbeiten">↗</button>`;
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  });
  // Add resize handles after DOM is ready
  setTimeout(addColResizeHandles, 0);
  updateBulkBar();
}

function toggleRowSelect(id, checked, tr) {
  if (checked) { selectedIds.add(id); tr?.classList.add('row-selected'); }
  else { selectedIds.delete(id); tr?.classList.remove('row-selected'); }
  updateBulkBar();
  // Update select-all checkbox state
  const allCb = document.getElementById('selectAllCb');
  if (allCb) {
    const allRows = document.querySelectorAll('#tBody tr');
    const allChecked = allRows.length > 0 && [...allRows].every(r => selectedIds.has(r.dataset.id));
    allCb.checked = allChecked;
    allCb.indeterminate = selectedIds.size > 0 && !allChecked;
  }
}

function toggleSelectAll(checked) {
  const rows = document.querySelectorAll('#tBody tr');
  rows.forEach(tr => {
    const id = tr.dataset.id;
    if (!id) return;
    if (checked) { selectedIds.add(id); tr.classList.add('row-selected'); }
    else { selectedIds.delete(id); tr.classList.remove('row-selected'); }
    const cb = tr.querySelector('.row-check');
    if (cb) cb.checked = checked;
  });
  updateBulkBar();
}

function clearBulkSelection() {
  selectedIds.clear();
  _lastCheckedIndex = -1;
  document.querySelectorAll('#tBody tr').forEach(tr => {
    tr.classList.remove('row-selected');
    const cb = tr.querySelector('.row-check');
    if (cb) cb.checked = false;
  });
  const allCb = document.getElementById('selectAllCb');
  if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  const countEl = document.getElementById('bulkCount');
  const fieldsEl = document.getElementById('bulkFields');
  if (!bar) return;
  if (selectedIds.size === 0) {
    bar.classList.remove('visible');
    return;
  }
  bar.classList.add('visible');
  countEl.textContent = `${selectedIds.size} ausgewählt`;
  // Build controls for all select/multiselect columns
  const selectCols = columns.filter(c => c.type === 'select' || c.type === 'multiselect');
  fieldsEl.innerHTML = selectCols.map(col => {
    if (col.type === 'multiselect') {
      // Multi-checkbox dropdown for multiselect columns
      const opts = (col.options||[]).map(o =>
        `<label class="dropdown-label" style="display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;white-space:nowrap;font-size:12px">
          <input type="checkbox" value="${esc(o.label)}" class="bulk-ms-opt" data-col="${col.id}">
          <span style="width:10px;height:10px;border-radius:50%;background:${o.color||'#888'};display:inline-block;flex-shrink:0"></span>
          ${esc(o.label)}
        </label>`
      ).join('');
      return `<div class="bulk-field" style="position:relative">
        <label>${esc(col.name)}:</label>
        <div style="position:relative;display:inline-block">
          <button onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'"
            style="padding:4px 10px;border:1px solid var(--border-mid);border-radius:var(--radius);background:var(--surface);color:var(--text);font-size:12px;cursor:pointer;font-family:var(--sans)">
            Auswählen ▾
          </button>
          <div style="display:none;position:absolute;top:100%;left:0;background:var(--surface);border:1px solid var(--border-mid);border-radius:var(--radius);box-shadow:var(--shadow-lg);z-index:100;min-width:220px;max-height:280px;overflow-y:auto;padding:4px 0">
            ${opts}
            <div style="border-top:1px solid var(--border);margin-top:4px;padding:4px 8px;display:flex;gap:6px">
              <button onclick="applyBulkMultiselect('${col.id}','add')" style="flex:1;padding:3px;font-size:11px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">+ Hinzufügen</button>
              <button onclick="applyBulkMultiselect('${col.id}','remove')" style="flex:1;padding:3px;font-size:11px;background:var(--red);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">− Entfernen</button>
            </div>
          </div>
        </div>
      </div>`;
    } else {
      return `<div class="bulk-field">
        <label>${esc(col.name)}:</label>
        <select id="bulk_${col.id}" onchange="onBulkFieldChange('${col.id}')">
          <option value="">– nicht ändern –</option>
          ${(col.options||[]).map(o=>`<option value="${esc(o.label)}">${esc(o.label)}</option>`).join('')}
        </select>
      </div>`;
    }
  }).join('');
}

function onBulkFieldChange(colId) {
  // Preview: highlight the changed column header
  const sel = document.getElementById(`bulk_${colId}`);
  if (sel) sel.style.background = sel.value ? 'rgba(0,169,140,.4)' : 'rgba(255,255,255,.12)';
}

async function bulkDelete() {
  const ids = [...selectedIds];
  if(!ids.length) return;
  showConfirm(
    `${ids.length} Eintrag${ids.length>1?'e':''} wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
    async () => {
      setSyncStatus('loading','Lösche...');
      const {error} = await sb.from('content_items').delete().in('id', ids);
      if(error){ setSyncStatus('error','Fehler'); toast('Fehler: '+error.message); return; }
      clearBulkSelection();
      toast(`🗑 ${ids.length} Eintrag${ids.length>1?'e':''} gelöscht`);
    },
    'Einträge löschen'
  );
}

async function applyBulkMultiselect(colId, mode) {
  // Get checked options
  const checked = [...document.querySelectorAll(`.bulk-ms-opt[data-col="${colId}"]:checked`)].map(c=>c.value);
  if(!checked.length) { toast('Bitte mindestens eine Option auswählen'); return; }
  const ids = [...selectedIds];
  setSyncStatus('loading', 'Speichere…');
  let errors = 0;
  for(const id of ids) {
    const item = data.find(d=>d.id===id);
    if(!item) continue;
    let current = Array.isArray(item[colId]) ? [...item[colId]] : (item[colId] ? [item[colId]] : []);
    if(mode === 'add') {
      checked.forEach(v => { if(!current.includes(v)) current.push(v); });
    } else {
      current = current.filter(v => !checked.includes(v));
    }
    item[colId] = current;
    const row = itemToRow(item);
    const {error} = await sb.from('content_items').update(row).eq('id', id);
    if(error) errors++;
  }
  setSyncStatus(errors ? 'error' : 'ok', errors ? 'Fehler' : `${ids.length} Einträge`);
  toast(errors ? `${errors} Fehler` : `✅ ${ids.length} Einträge aktualisiert`);
}

async function applyBulkEdit() {
  if (selectedIds.size === 0) return;
  const selectCols = columns.filter(c => c.type === 'select' || c.type === 'multiselect');
  const changes = {};
  selectCols.forEach(col => {
    const sel = document.getElementById(`bulk_${col.id}`);
    if (sel?.value) changes[col.id] = sel.value;
  });
  if (Object.keys(changes).length === 0) { toast('Bitte zuerst einen Wert auswählen'); return; }
  const ids = [...selectedIds];
  setSyncStatus('loading', `${ids.length} Einträge werden aktualisiert…`);
  let errorCount = 0;
  for (const id of ids) {
    const item = data.find(d => d.id === id);
    if (!item) continue;
    // Apply each change to the item
    Object.assign(item, changes);
    const row = itemToRow(item);
    const { error } = await sb.from('content_items').update(row).eq('id', id);
    if (error) errorCount++;
  }
  if (errorCount > 0) {
    toast(`⚠ ${errorCount} Fehler beim Speichern`);
  } else {
    toast(`✅ ${ids.length} Einträge aktualisiert`);
  }
  clearBulkSelection();
  setSyncStatus('ok', `${data.length} Einträge`);
}

function renderCellValue(item, col) {
  const val = item[col.id];
  if (col.id === 'internalLinks') {
    const cnt = (val||[]).length;
    return cnt ? `<span style="color:var(--accent);font-weight:600">${cnt}</span>` : `<span style="color:var(--text-faint)">–</span>`;
  }
  if (col.type === 'select' || col.type === 'multiselect') {
    const vals = Array.isArray(val) ? val : [val];
    return vals.filter(Boolean).map(v => {
      const opt = (col.options||[]).find(o=>o.label===v);
      const color = opt?.color || '#888';
      return `<span class="cell-tag" style="background:${color}22;color:${color}">${esc(v)}</span>`;
    }).join(' ') || '<span style="color:var(--text-faint)">–</span>';
  }
  if (col.type === 'url' && val) {
    const short = val.replace(/^https?:\/\/(www\.)?/,'').slice(0,30);
    return `<a href="${esc(val)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--accent);text-decoration:none;font-size:12px">↗ ${esc(short)}</a>`;
  }
  if (col.type === 'date' && val) {
    try { const [y,m,d]=val.split('-'); return `${d}.${m}.${y}`; } catch { return val; }
  }
  return val ? esc(String(val).slice(0,60)) : '<span style="color:var(--text-faint)">–</span>';
}

function buildCellEditor(item, col) {
  const val = item[col.id] || '';
  if (col.id === 'internalLinks') return ''; // handled in drawer only
  if (col.type === 'select') {
    const opts = (col.options||[]).map(o=>`<option value="${esc(o.label)}" ${val===o.label?'selected':''}>${esc(o.label)}</option>`).join('');
    return `<select><option value="">–</option>${opts}</select>`;
  }
  if (col.type === 'date') return `<input type="date" value="${esc(val)}">`;
  if (col.type === 'number') return `<input type="number" value="${esc(val)}">`;
  if (col.type === 'url') return `<input type="url" value="${esc(val)}" placeholder="https://…">`;
  return `<input type="text" value="${esc(val)}">`;
}

function startCellEdit(td, item, col) {
  if (col.id==='internalLinks') { openDrawer(item.id); return; }
  if (col.type==='multiselect') { openDrawer(item.id); return; }
  td.classList.add('editing');
  const input = td.querySelector('.cell-edit input, .cell-edit select, .cell-edit textarea');
  if (input) { input.focus(); if(input.select) input.select(); }
}

function cancelCellEdit(td) {
  td.classList.remove('editing');
}

async function commitCellEdit(td, item, col) {
  td.classList.remove('editing');
  const input = td.querySelector('.cell-edit input, .cell-edit select');
  if (!input) return;
  const newVal = input.value;
  if (String(item[col.id]||'') === newVal) return; // no change
  item[col.id] = newVal;
  // Save scroll before DB write (realtime will trigger re-render)
  const _ca = _getScrollEl();
  if(_ca) _preservedScroll = _ca.scrollTop;
  // Build DB payload
  const dbPayload = itemToRow(item);
  const { error } = await sb.from('content_items').update(dbPayload).eq('id', item.id);
  if (error) { toast('Fehler beim Speichern: ' + error.message); return; }
  // Update view cell without full re-render
  const view = td.querySelector('.cell-view');
  if (view) view.innerHTML = renderCellValue(item, col);
  setSyncStatus('ok', `${data.length} Einträge`);
}

// ── KANBAN ──
let kanbanGroupColId = null;
// Store kanban card order: {colLabel: [itemId, itemId, ...]}
const kanbanOrder = {};
// Store column order: [label, label, ...]
let kanbanColOrder = [];

function populateKanbanGroupBy() {
  const sel = document.getElementById('kanbanGroupBy');
  if (!sel) return;
  const selectCols = columns.filter(c => c.type === 'select');
  sel.innerHTML = selectCols.map(c => `<option value="${c.id}" ${kanbanGroupColId===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
  if (!kanbanGroupColId && selectCols.length > 0) kanbanGroupColId = selectCols[0].id;
}

function renderKanban(items, area) {
  const selEl = document.getElementById('kanbanGroupBy');
  if (selEl?.value) kanbanGroupColId = selEl.value;
  const groupCol = columns.find(c => c.id === kanbanGroupColId) || columns.find(c=>c.type==='select');
  if (!groupCol) { area.innerHTML = '<div class="empty"><p>Keine Auswahl-Spalte zum Gruppieren vorhanden.</p></div>'; return; }

  area.innerHTML = `<div class="kanban" id="kanbanGrid"></div>`;
  const grid = document.getElementById('kanbanGrid');

  // Build groups
  const optionOrder = (groupCol.options || []).map(o => o.label);
  const groups = {};
  optionOrder.forEach(l => { groups[l] = []; });
  groups['–'] = [];
  items.forEach(item => {
    const g = item[groupCol.id] || '–';
    if (!groups[g]) groups[g] = [];
    groups[g].push(item);
  });

  // Apply saved column order
  let colLabels = kanbanColOrder.filter(l=>groups[l]?.length);
  optionOrder.forEach(l=>{ if(!colLabels.includes(l)&&groups[l]?.length) colLabels.push(l); });
  if(groups['–']?.length && !colLabels.includes('–')) colLabels.push('–');

  colLabels.forEach(group => {
    const gitems = groups[group];
    if (!gitems?.length) return;

    // Apply saved card order within this group
    if (kanbanOrder[group]) {
      const ordered = [];
      kanbanOrder[group].forEach(id => { const i = gitems.find(x=>x.id===id); if(i) ordered.push(i); });
      gitems.forEach(i => { if(!ordered.includes(i)) ordered.push(i); });
      gitems.length = 0; gitems.push(...ordered);
    }

    const opt = (groupCol.options||[]).find(o=>o.label===group);
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

    // Column drag & drop
    colEl.addEventListener('dragstart', e => {
      e.dataTransfer.setData('kanban-col', group);
      e.dataTransfer.effectAllowed = 'move';
      colEl.style.opacity = '.4';
    });
    colEl.addEventListener('dragend', () => { colEl.style.opacity = '1'; });
    colEl.addEventListener('dragover', e => {
      const fromCol = e.dataTransfer.types.includes('kanban-col');
      if (fromCol) { e.preventDefault(); colEl.style.outline = '2px dashed var(--accent-mid)'; }
    });
    colEl.addEventListener('dragleave', () => { colEl.style.outline = ''; });
    colEl.addEventListener('drop', e => {
      colEl.style.outline = '';
      const fromGroup = e.dataTransfer.getData('kanban-col');
      if (!fromGroup || fromGroup === group) return;
      e.preventDefault();
      // Reorder columns
      const cols = [...grid.querySelectorAll('.kanban-col')].map(c=>c.dataset.group);
      const fi = cols.indexOf(fromGroup), ti = cols.indexOf(group);
      if (fi < 0 || ti < 0) return;
      const newOrder = [...cols];
      newOrder.splice(fi, 1); newOrder.splice(ti, 0, fromGroup);
      kanbanColOrder = newOrder;
      renderKanban(items, area);
    });

    const cardsEl = colEl.querySelector('.kanban-cards');
    gitems.forEach(item => {
      const card = document.createElement('div');
      card.className = 'kcard';
      card.dataset.id = item.id;
      card.draggable = true;
      if (isIdea(item)) {
        card.style.borderLeft = '3px solid #f0b429';
        card.style.background = 'linear-gradient(135deg,rgba(255,200,50,.1) 0%,var(--surface) 60%)';
      }
      const visCols = columns.filter(c=>c.visible&&c.id!==groupCol.id&&c.id!=='internalLinks'&&c.id!=='title').slice(0,3);
      card.innerHTML = `<div style="display:flex;align-items:center;gap:5px">
          <span style="color:var(--text-faint);font-size:11px;cursor:grab;flex-shrink:0">⠿</span>
          <div class="kcard-title" style="flex:1">${isIdea(item)?'💡 ':''}${esc(item.title||'')}</div>
        </div>
        <div class="kcard-meta">${visCols.map(c=>{
          const v=item[c.id]; if(!v)return '';
          const o=c.type==='select'?(c.options||[]).find(x=>x.label===v):null;
          const cl=o?.color||'#888';
          return c.type==='select'?`<span class="cell-tag" style="background:${cl}22;color:${cl}">${esc(v)}</span>`:`<span style="font-size:11px;color:var(--text-faint)">${esc(String(v).slice(0,25))}</span>`;
        }).join('')}</div>`;

      // Click to open (not on drag handle)
      card.onclick = (e) => { if (!e.target.closest('[style*="cursor:grab"]')) openDrawer(item.id); };

      // Card drag
      card.addEventListener('dragstart', e => {
        e.stopPropagation();
        e.dataTransfer.setData('kanban-card', item.id);
        e.dataTransfer.setData('kanban-card-from', group);
        e.dataTransfer.effectAllowed = 'move';
        card.style.opacity = '.4';
      });
      card.addEventListener('dragend', () => { card.style.opacity = '1'; });
      card.addEventListener('dragover', e => {
        if(e.dataTransfer.types.includes('kanban-card')){
          e.preventDefault(); card.style.outline='2px dashed var(--accent-mid)';
        }
      });
      card.addEventListener('dragleave', ()=>{ card.style.outline=''; });
      card.addEventListener('drop', e => {
        card.style.outline='';
        const fromId = e.dataTransfer.getData('kanban-card');
        const fromGroup = e.dataTransfer.getData('kanban-card-from');
        if(!fromId) return;
        e.preventDefault(); e.stopPropagation();
        if(fromId===item.id) return;
        if(!kanbanOrder[group]) kanbanOrder[group]=gitems.map(x=>x.id);
        const arr=kanbanOrder[group];
        const fi=arr.indexOf(fromId),ti=arr.indexOf(item.id);
        if(fi<0){arr.splice(ti,0,fromId);}else{arr.splice(fi,1);arr.splice(arr.indexOf(item.id),0,fromId);}
        renderKanban(items,area);
      });

      cardsEl.appendChild(card);
    });

    // Drop on empty column area
    cardsEl.addEventListener('dragover', e=>{
      if(e.dataTransfer.types.includes('kanban-card')) e.preventDefault();
    });
    cardsEl.addEventListener('drop', e=>{
      const fromId=e.dataTransfer.getData('kanban-card');
      if(!fromId)return;
      e.preventDefault();
      if(!kanbanOrder[group])kanbanOrder[group]=gitems.map(x=>x.id);
      if(!kanbanOrder[group].includes(fromId))kanbanOrder[group].push(fromId);
      renderKanban(items,area);
    });

    grid.appendChild(colEl);
  });
}

// ── ROW HEIGHT ──
let currentRowHeight = parseInt(localStorage.getItem('v4q_row_height')||'34');
function setRowHeight(h) {
  currentRowHeight = parseInt(h);
  localStorage.setItem('v4q_row_height', h);
  document.querySelectorAll('#tBody tr').forEach(tr => { tr.style.height = h + 'px'; });
  document.querySelectorAll('.cell-view').forEach(cv => { cv.style.minHeight = h + 'px'; });
  // Sync slider
  const slider = document.getElementById('rowHeightSlider');
  if(slider) slider.value = h;
}

// ── COLUMN RESIZE ──
let resizing = null;
function addColResizeHandles() {
  document.querySelectorAll('thead th').forEach((th, i) => {
    if (th.classList.contains('th-actions')) return;
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      resizing = { th, startX: e.clientX, startW: th.offsetWidth };
      handle.classList.add('resizing');
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeUp);
    });
  });
}
function onResizeMove(e) {
  if (!resizing) return;
  const w = Math.max(60, resizing.startW + e.clientX - resizing.startX);
  resizing.th.style.width = w + 'px';
  resizing.th.style.minWidth = w + 'px';
}
function onResizeUp() {
  if (!resizing) return;
  resizing.th.querySelector('.col-resize-handle')?.classList.remove('resizing');
  resizing = null;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
}

// ─────────────────────────────────────────
// LINK MAP
// ─────────────────────────────────────────
function getNodeColor(d) {
  const col = columns.find(c => c.id === colorMode);
  if (col) {
    const val = d[colorMode];
    const opt = (col.options||[]).find(o => o.label === val);
    return opt?.color || '#888';
  }
  return '#888';
}
function getNodeLabel(d) {
  return d[colorMode] || '–';
}


let linkModeActive = false;
// Map state
let mapPhysicsEnabled = true;
const MAP_PRESETS_KEY = 'v4q_map_presets';
const MAP_POS_KEY = 'v4q_map_pos_v2';

// ─── Position store ───────────────────────────────────────────────────────────
// nodePos: { [id]: {x, y} } — the ONLY source of truth for node positions
const nodePos = {};

function loadSavedPos() {
  try {
    const raw = JSON.parse(localStorage.getItem(MAP_POS_KEY)||'{}');
    // Strip invalid positions from buggy 0-dimension builds
    const clean = {};
    Object.entries(raw).forEach(([k,v]) => {
      if(v && isFinite(v.x) && isFinite(v.y) && v.x > 20 && v.y > 20) clean[k] = v;
    });
    return clean;
  } catch { return {}; }
}
function persistPos() {
  // Only persist if we have valid canvas dimensions
  const wrap = document.getElementById('mapWrap');
  if(!wrap || wrap.offsetWidth < 100 || wrap.offsetHeight < 100) return;
  localStorage.setItem(MAP_POS_KEY, JSON.stringify(nodePos));
}
function clearSavedPos() {
  Object.keys(nodePos).forEach(k=>delete nodePos[k]);
  localStorage.removeItem(MAP_POS_KEY);
}

// ─── Presets ─────────────────────────────────────────────────────────────────
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(MAP_PRESETS_KEY)||'[]'); } catch { return []; }
}
function savePresetsStore(p) { localStorage.setItem(MAP_PRESETS_KEY, JSON.stringify(p)); }

function togglePresetPanel() {
  const panel = document.getElementById('presetPanel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) renderPresetList();
}

function renderPresetList() {
  const el = document.getElementById('presetList');
  if (!el) return;
  const presets = loadPresets();
  if (!presets.length) {
    el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-faint);text-align:center">Noch keine Speicherstände</div>';
    return;
  }
  el.innerHTML = presets.map((p, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 4px;border-radius:6px" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:500;color:var(--text)">${esc(p.name)}</div>
        <div style="font-size:10px;color:var(--text-faint)">${new Date(p.ts).toLocaleDateString('de-DE')} · ${p.count||0} Einträge · ${esc(p.filterLabel||'Alle')}</div>
      </div>
      <button onclick="loadPreset(${i})" style="font-size:11px;padding:3px 8px;background:var(--accent-light);color:var(--accent);border:none;border-radius:5px;cursor:pointer">Laden</button>
      <button onclick="deletePreset(${i})" style="font-size:11px;padding:3px 6px;background:none;color:var(--red);border:none;border-radius:5px;cursor:pointer">🗑</button>
    </div>`).join('');
}

function savePreset() {
  const nameEl = document.getElementById('presetNameInput');
  const name = nameEl?.value.trim();
  if (!name) { toast('Bitte einen Namen eingeben'); return; }
  // Snapshot current positions
  if (_sim) _sim.nodes().forEach(n=>{ if(n.id) nodePos[n.id]={x:n.x,y:n.y}; });
  const presets = loadPresets();
  const filterLabel = activeFilter?.values?.size > 0 ? `${activeFilter.colId}:[${[...activeFilter.values].join(',')}]` : 'Alle';
  presets.unshift({
    name, ts: Date.now(),
    count: Object.keys(nodePos).length,
    filterLabel,
    colorMode,
    activeFilter: activeFilter ? {...activeFilter, values: [...(activeFilter.values||[])]} : null,
    activeFilterColId,
    positions: {...nodePos},
  });
  savePresetsStore(presets);
  if(nameEl) nameEl.value = '';
  renderPresetList();
  toast(`💾 "${name}" gespeichert`);
}

function loadPreset(i) {
  const preset = loadPresets()[i];
  if (!preset) return;
  // Restore positions
  Object.keys(nodePos).forEach(k=>delete nodePos[k]);
  Object.assign(nodePos, preset.positions||{});
  persistPos();
  // Restore filters
  if (preset.colorMode) colorMode = preset.colorMode;
  if (preset.activeFilterColId) activeFilterColId = preset.activeFilterColId;
  // Restore activeFilter — convert values array back to Set
  if (preset.activeFilter) {
    activeFilter = {...preset.activeFilter, values: new Set(preset.activeFilter.values||[])};
  } else { activeFilter = null; }
  togglePresetPanel();
  renderSidebar();
  renderMap(); // full rebuild with correct colorMode/filter
  toast(`✅ "${preset.name}" geladen`);
}

function deletePreset(i) {
  const presets = loadPresets();
  const name = presets[i]?.name;
  presets.splice(i, 1);
  savePresetsStore(presets);
  renderPresetList();
  toast(`🗑 "${name}" gelöscht`);
}

// ─── Physics toggle ──────────────────────────────────────────────────────────
function toggleMapPhysics() {
  mapPhysicsEnabled = !mapPhysicsEnabled;
  const track = document.getElementById('physicsTrack');
  const thumb = document.getElementById('physicsThumb');
  if(track) track.style.background = mapPhysicsEnabled ? 'var(--accent)' : 'var(--border-mid)';
  if(thumb) thumb.style.left = mapPhysicsEnabled ? '12px' : '2px';
  toast(mapPhysicsEnabled ? '▶ Physics aktiv' : '⏸ Physics aus');
}

// ─── Undo ────────────────────────────────────────────────────────────────────
const undoStack = [];
function pushUndo(action) { undoStack.push(action); if(undoStack.length>30) undoStack.shift(); }
async function undoMapAction() {
  const action = undoStack.pop();
  if(!action) { toast('Nichts rückgängig zu machen'); return; }
  if(action.type==='move') {
    nodePos[action.id] = {x:action.prevX, y:action.prevY};
    persistPos();
    renderMap();
    toast('↩ Position wiederhergestellt');
  } else if(action.type==='link') {
    const src = data.find(d=>d.id===action.sourceId);
    if(!src) return;
    const newLinks = (src.internalLinks||[]).filter(id=>id!==action.targetId);
    const {error} = await sb.from('content_items').update({internal_links:newLinks}).eq('id',action.sourceId);
    if(!error) toast('↩ Verlinkung entfernt');
  }
}

// ─── Link drag mode ───────────────────────────────────────────────────────────
let linkModeActiveInMap = false;
let _linkDragSource = null;

function toggleLinkMode() {
  linkModeActive = !linkModeActive;
  linkModeActiveInMap = linkModeActive;
  const btn = document.getElementById('linkModeBtn');
  if(btn) {
    btn.style.background = linkModeActive ? 'var(--teal)' : '';
    btn.style.color = linkModeActive ? '#fff' : '';
  }
  const wrap = document.getElementById('mapWrap');
  if(wrap) wrap.style.cursor = linkModeActive ? 'crosshair' : 'default';
  toast(linkModeActive ? '🔗 Zieh von Kreis zu Kreis zum Verknüpfen' : 'Verknüpfungs-Modus aus');
}

async function createLinkBetween(sourceId, targetId) {
  const source = data.find(d=>d.id===sourceId);
  const target = data.find(d=>d.id===targetId);
  if (!source||!target) return;
  if ((source.internalLinks||[]).includes(targetId)) { toast('Bereits verlinkt'); return; }
  const newLinks = [...(source.internalLinks||[]), targetId];
  const _lCa = _getScrollEl();
  if(_lCa) _preservedScroll = _lCa.scrollTop;
  const {error} = await sb.from('content_items').update({internal_links:newLinks}).eq('id',sourceId);
  if(error) { toast('Fehler: '+error.message); return; }
  pushUndo({type:'link', sourceId, targetId});
  toast(`✅ ${source.title.slice(0,20)} → ${target.title.slice(0,20)}`);
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
// mapZoom declared at top level (line 539)
function zoomIn(){ if(mapZoom) d3.select('#mapSvg').transition().duration(250).call(mapZoom.scaleBy,1.4); }
function zoomOut(){ if(mapZoom) d3.select('#mapSvg').transition().duration(250).call(mapZoom.scaleBy,0.7); }
function zoomReset(){ if(!mapZoom)return; const w=document.getElementById('mapWrap'); const W=w?w.offsetWidth:900,H=w?w.offsetHeight:600; d3.select('#mapSvg').transition().duration(350).call(mapZoom.transform, d3.zoomIdentity.translate(W/2,H/2).scale(0.9).translate(-W/2,-H/2)); }

// ─── Color helpers ────────────────────────────────────────────────────────────
function getNodeColor(d) {
  const col = columns.find(c=>c.id===colorMode);
  const opt = (col?.options||[]).find(o=>o.label===d[colorMode]);
  return opt?.color || '#888';
}
function getNodeLabel(d) { return d[colorMode]||'–'; }

// ─── renderMap ────────────────────────────────────────────────────────────────
function renderMap() {
  const area = document.getElementById('contentArea');
  const selectCols = columns.filter(c=>c.type==='select');
  if(!colorMode||!selectCols.find(c=>c.id===colorMode)) colorMode=selectCols[0]?.id||'';
  const colorByOpts = selectCols.map(c=>`<option value="${c.id}" ${colorMode===c.id?'selected':''}>${esc(c.name)}</option>`).join('');

  area.innerHTML = `
    <div id="mapWrap">
      <svg id="mapSvg"></svg>
      <div id="mapTooltip"></div>
      <div id="mapColorBy">
        <label>Einfärben</label>
        <select id="colorBySelect" onchange="colorMode=this.value;hiddenCats=new Set();renderMap()">${colorByOpts}</select>
      </div>
      <div id="mapLegend"><h4>Legende</h4><div id="legendItems"></div></div>
      <div id="mapControls">
        <button onclick="zoomIn()" title="Zoom in">+</button>
        <button onclick="zoomOut()" title="Zoom out">−</button>
        <button id="linkModeBtn" onclick="toggleLinkMode()" title="Verknüpfen" style="font-size:11px">🔗</button>
        <button onclick="undoMapAction()" title="Rückgängig (Strg+Z)" style="font-size:11px">↩</button>
      </div>
      <div id="mapBottomBar">
        <label style="display:flex;align-items:center;gap:5px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 10px;font-size:11px;color:var(--text-muted);cursor:pointer;box-shadow:var(--shadow)">
          <div id="physicsTrack" onclick="toggleMapPhysics()" style="width:26px;height:14px;border-radius:7px;background:${mapPhysicsEnabled?'var(--accent)':'var(--border-mid)'};position:relative;cursor:pointer;transition:background .2s;flex-shrink:0">
            <div id="physicsThumb" style="position:absolute;top:2px;left:${mapPhysicsEnabled?'12':'2'}px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .2s"></div>
          </div>
          Physics
        </label>
        <button onclick="togglePresetPanel()" style="font-size:11px;padding:4px 10px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--border);color:var(--text-muted);box-shadow:var(--shadow);cursor:pointer">💾 Speicherstände</button>
      </div>
      <div id="presetPanel" style="display:none;position:absolute;bottom:50px;right:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);width:280px;z-index:20">
        <div style="padding:10px 14px 6px;font-size:12px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          Speicherstände
          <button onclick="togglePresetPanel()" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:13px;padding:0">✕</button>
        </div>
        <div id="presetList" style="max-height:220px;overflow-y:auto;padding:6px 8px"></div>
        <div style="padding:8px;border-top:1px solid var(--border)">
          <div style="display:flex;gap:5px">
            <input id="presetNameInput" type="text" placeholder="Name eingeben…" style="flex:1;padding:5px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
            <button onclick="savePreset()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius);padding:5px 10px;font-size:12px;cursor:pointer">Speichern</button>
          </div>
        </div>
      </div>
    </div>`;
  // Restore link mode button if active
  const lmBtn = document.getElementById('linkModeBtn');
  if(lmBtn&&linkModeActive){ lmBtn.style.background='var(--teal)'; lmBtn.style.color='#fff'; }
  const wrap2 = document.getElementById('mapWrap');
  if(wrap2) wrap2.style.cursor = linkModeActive?'crosshair':'default';
  // Always call buildGraph after DOM settles
  // ResizeObserver handles the case where dimensions aren't ready yet
  const _wrap = document.getElementById('mapWrap');
  if(_wrap) {
    if(_wrap.offsetWidth > 100 && _wrap.offsetHeight > 100) {
      // Dimensions already good — call directly
      buildGraph();
    } else {
      // Wait for dimensions via ResizeObserver
      const _ro = new ResizeObserver((entries, obs) => {
        const entry = entries[0];
        if(entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          obs.disconnect();
          buildGraph();
        }
      });
      _ro.observe(_wrap);
    }
  }
}

// ─── The simulation reference ─────────────────────────────────────────────────
// _sim, selectedNodeId, hiddenCats declared at top level
// ─── buildGraph ───────────────────────────────────────────────────────────────
let _buildGraphPending = null;
let _buildGraphRunning = false;

function buildGraph() {
  // Stop any running simulation immediately to prevent stale tick handlers
  if(_sim) { _sim.stop(); _sim = null; }
  // Debounce: if called rapidly, only run the last call
  if(_buildGraphPending) clearTimeout(_buildGraphPending);
  _buildGraphPending = setTimeout(_buildGraphNow, 50);
}

function _buildGraphNow() {
  _buildGraphPending = null;
  const wrap = document.getElementById('mapWrap');
  if(!wrap) return;
  const W = wrap.offsetWidth, H = wrap.offsetHeight;
  // Hard stop — never run with bad dimensions (causes stacked nodes)
  if(!W || !H || W < 100 || H < 100) return;
  // Clean stale bad positions from previous buggy builds
  Object.keys(nodePos).forEach(k => {
    const p = nodePos[k];
    if(!p || !isFinite(p.x) || !isFinite(p.y) || p.x < 20 || p.y < 20) delete nodePos[k];
  });

  if(_sim) { _sim.stop(); _sim = null; }

  const svg = d3.select('#mapSvg').attr('width',W).attr('height',H);
  // Save current zoom transform before rebuild
  const _existingG = document.querySelector('#mapSvg g');
  const _savedTransform = _existingG ? d3.zoomTransform(document.querySelector('#mapSvg')) : null;
  svg.selectAll('*').remove();

  // Arrow markers
  const defs = svg.append('defs');
  // Arrow markers - colors: grey, teal (outgoing), blue (incoming), idea
  ['arr:#bbb','arr-idea:#f0b429','arr-pot:#f0b429','arr-accent:var(--accent-mid)','arr-blue:var(--blue)'].forEach(s=>{
    const [id,fill]=s.split(':');
    defs.append('marker').attr('id',id).attr('viewBox','0 -4 8 8').attr('refX',8).attr('refY',0)
      .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
      .attr('markerUnits','strokeWidth')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill',fill);
  });

  const g = svg.append('g');

  // ── Filter data ──
  const mapData = data.filter(d=>{
    if(ideaMode==='hide'&&isIdea(d)) return false;
    if(ideaMode==='only'&&!isIdea(d)) return false;
    if(activeFilter && activeFilter.values?.size > 0){
      const raw = d[activeFilter.colId];
      const vals = Array.isArray(raw) ? raw : [String(raw||'')];
      if(!vals.some(v => activeFilter.values.has(String(v)))) return false;
    }
    return true;
  });
  const idSet = new Set(mapData.map(d=>d.id));

  // ── Load saved positions — restore into simulation nodes ──
  const saved = loadSavedPos();
  // Merge saved into nodePos
  Object.keys(saved).forEach(k=>{ if(!nodePos[k]) nodePos[k]=saved[k]; });

  // ── Build nodes with positions ──
  const hasPositions = mapData.some(d=>nodePos[d.id]);
  const nodes = mapData.map((d,i)=>{
    const pos = nodePos[d.id];
    // Only use saved position if it looks valid (not 0,0 and within reasonable bounds)
    const posValid = pos && pos.x > 10 && pos.y > 10 && pos.x < W*3 && pos.y < H*3;
    const angle = (i/mapData.length)*2*Math.PI;
    const spread = Math.min(W,H)*0.38;
    return {
      ...d,
      x: posValid ? pos.x : (W/2 + Math.cos(angle)*spread*(0.6+Math.random()*0.4)),
      y: posValid ? pos.y : (H/2 + Math.sin(angle)*spread*(0.6+Math.random()*0.4)),
    };
  });

  // ── Build edges ──
  const seen = new Set(), edges = [], ideaEdges = [], potEdges = [];
  const ideaNodeIds = new Set(nodes.filter(n=>isIdea(n)).map(n=>n.id));
  mapData.forEach(d=>{
    (d.internalLinks||[]).forEach(tid=>{
      if(!idSet.has(tid)) return;
      const k = [d.id,tid].sort().join('|');
      if(seen.has(k)) return; seen.add(k);
      const isIdeaEdge = ideaNodeIds.has(d.id)||ideaNodeIds.has(tid);
      (isIdeaEdge?ideaEdges:edges).push({source:d.id,target:tid});
    });
    if(isIdea(d)){
      (d.potentialLinks||[]).forEach(tid=>{
        if(!idSet.has(tid)) return;
        const k=[d.id,tid].sort().join('|pot');
        if(seen.has(k)) return; seen.add(k);
        potEdges.push({source:d.id,target:tid});
      });
    }
  });
  const allEdges = [...edges,...ideaEdges];

  // ── Degree ──
  const deg = {};
  nodes.forEach(n=>deg[n.id]=0);
  allEdges.forEach(e=>{deg[e.source]=(deg[e.source]||0)+1;deg[e.target]=(deg[e.target]||0)+1;});
  const nr = d => 8 + (deg[d.id]||0)*2.2;

  // ── Adjacency (for highlight + physics) ──
  const adj = {};
  allEdges.forEach(e=>{
    const s=e.source.id||e.source, t=e.target.id||e.target;
    if(!adj[s]) adj[s]=new Set(); if(!adj[t]) adj[t]=new Set();
    adj[s].add(t); adj[t].add(s);
  });

  // ── Category cluster centers (for initial layout only) ──
  const cats=[...new Set(nodes.map(d=>d[colorMode]||'–'))];
  const catCenters={};
  cats.forEach((cat,i)=>{
    const angle=(i/cats.length)*2*Math.PI-Math.PI/2;
    catCenters[cat]={x:W/2+Math.cos(angle)*Math.min(W,H)*0.32,y:H/2+Math.sin(angle)*Math.min(W,H)*0.32};
  });

  // ── Simulation ──
  // All nodes with saved positions get fx/fy pinned immediately
  // Unsaved nodes float freely and settle via forces
  nodes.forEach(n=>{
    if(nodePos[n.id]){ n.fx=nodePos[n.id].x; n.fy=nodePos[n.id].y; }
  });

  _sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(allEdges).id(d=>d.id).distance(200).strength(0.03))
    .force('charge', d3.forceManyBody().strength(d=>-300-(deg[d.id]||0)*30))
    .force('center', d3.forceCenter(W/2,H/2).strength(hasPositions?0.005:0.04))
    .force('collide', d3.forceCollide().radius(d=>nr(d)+30).strength(0.8))
    .force('clusterX', d3.forceX(d=>{
      const cc=catCenters[d[colorMode]||'–'];
      return (deg[d.id]||0)>4?W/2:(cc?.x??W/2);
    }).strength(hasPositions?0:0.10))
    .force('clusterY', d3.forceY(d=>{
      const cc=catCenters[d[colorMode]||'–'];
      return (deg[d.id]||0)>4?H/2:(cc?.y??H/2);
    }).strength(hasPositions?0:0.10));

  // Stop early if all nodes are pinned (no need to simulate)
  if(nodes.every(n=>n.fx!=null)) { _sim.stop(); }

  // ── Render edges ──
  const potLinkSel = g.append('g').selectAll('line').data(potEdges).join('line')
    .attr('stroke','#f0b429').attr('stroke-opacity',0.5).attr('stroke-width',1.5)
    .attr('stroke-dasharray','5,4').attr('marker-end','url(#arr-pot)');

  const ideaLinkSel = g.append('g').selectAll('line').data(ideaEdges).join('line')
    .attr('stroke','#f0b429').attr('stroke-opacity',0.55).attr('stroke-width',1.5)
    .attr('stroke-dasharray','5,4').attr('marker-end','url(#arr-idea)');

  const linkSel = g.append('g').selectAll('line').data(edges).join('line')
    .attr('stroke','#bbb').attr('stroke-opacity',0.4).attr('stroke-width',1.3)
    .attr('marker-end','url(#arr)');

  // Drag line for link mode
  const dragLine = g.append('line')
    .attr('stroke','var(--teal-light)').attr('stroke-width',2).attr('stroke-dasharray','5,4')
    .attr('opacity',0).attr('marker-end','url(#arr)');

  // ── Render nodes ──
  const pcol = columns.find(c=>c.id==='phase');
  const nodeG = g.append('g').selectAll('g').data(nodes).join('g')
    .style('cursor','pointer')
    .on('mousedown', function(){ d3.select(this).raise(); })
    .on('click',(e,d)=>{
      e.stopPropagation();
      if(selectedNodeId===d.id){ selectedNodeId=null; applyHighlight(null,linkSel,ideaLinkSel,nodeG,adj); }
      else { selectedNodeId=d.id; applyHighlight(d.id,linkSel,ideaLinkSel,nodeG,adj); }
    })
    .on('contextmenu',(e,d)=>{
      e.preventDefault(); e.stopPropagation();
      showStaticTT(e,d,deg,linkSel,nodeG,adj);
    })
    .on('dblclick',(e)=>{ e.stopPropagation(); e.preventDefault(); })
    .call(d3.drag()
      .on('start',(e,d)=>{
        if(linkModeActive){
          _linkDragSource=d;
          dragLine.attr('x1',d.x).attr('y1',d.y).attr('x2',d.x).attr('y2',d.y).attr('opacity',1);
          return;
        }
        // Save undo + original positions of ALL nodes before drag
        pushUndo({type:'move',id:d.id,prevX:nodePos[d.id]?.x??d.x,prevY:nodePos[d.id]?.y??d.y});
        d._dragStartX = d.x;
        d._dragStartY = d.y;
        nodes.forEach(n=>{ n._origX=n.x; n._origY=n.y; });
        if(d._returnAnim){ cancelAnimationFrame(d._returnAnim); d._returnAnim=null; }
      })
      .on('drag',(e,d)=>{
        if(linkModeActive){
          if(_linkDragSource) dragLine.attr('x1',_linkDragSource.x).attr('y1',_linkDragSource.y).attr('x2',e.x).attr('y2',e.y);
          return;
        }
        // Move dragged node
        const ddx = e.x - (d._dragStartX??d.x);
        const ddy = e.y - (d._dragStartY??d.y);
        d.x=e.x; d.y=e.y; d.fx=e.x; d.fy=e.y;

        if(mapPhysicsEnabled){
          // Pull connected neighbors softly (15% of drag delta)
          const nbIds = adj[d.id]||new Set();
          nodes.forEach(n=>{
            if(!nbIds.has(n.id)) return;
            n.x = (n._origX??n.x) + ddx*0.15;
            n.y = (n._origY??n.y) + ddy*0.15;
          });
        }
        tick();
      })
      .on('end',(e,d)=>{
        if(linkModeActive&&_linkDragSource){
          dragLine.attr('opacity',0);
          const svgRect=document.getElementById('mapSvg').getBoundingClientRect();
          const gEl=document.getElementById('mapSvg').querySelector('g');
          const tf=gEl?.getCTM();
          const simX=tf?(e.sourceEvent.clientX-svgRect.left-tf.e)/tf.a:(e.sourceEvent.clientX-svgRect.left);
          const simY=tf?(e.sourceEvent.clientY-svgRect.top-tf.f)/tf.d:(e.sourceEvent.clientY-svgRect.top);
          const hit=nodes.find(n=>{
            if(n.id===_linkDragSource.id) return false;
            const dx=n.x-simX, dy=n.y-simY;
            return Math.sqrt(dx*dx+dy*dy)<nr(n)+20;
          });
          if(hit) createLinkBetween(_linkDragSource.id,hit.id);
          else toast('Kein Knoten getroffen');
          _linkDragSource=null;
          return;
        }

        // Pin dragged node at final position
        nodePos[d.id]={x:d.x,y:d.y};
        persistPos();

        if(mapPhysicsEnabled){
          // Float connected neighbors back to their original positions
          const nbIds = adj[d.id]||new Set();
          // Capture their current (slightly displaced) positions as animation start
          const fromPos={}, toPos={};
          nodes.forEach(n=>{
            if(!nbIds.has(n.id)) return;
            fromPos[n.id]={x:n.x, y:n.y};
            toPos[n.id]={x:n._origX??n.x, y:n._origY??n.y};
          });

          const duration = 800;
          const t0 = performance.now();
          function floatBack(ts){
            const t = Math.min(1, (ts-t0)/duration);
            const ease = 1 - Math.pow(1-t, 3); // ease-out cubic = gentle deceleration
            nodes.forEach(n=>{
              if(!nbIds.has(n.id)||!fromPos[n.id]) return;
              n.x = fromPos[n.id].x + (toPos[n.id].x - fromPos[n.id].x)*ease;
              n.y = fromPos[n.id].y + (toPos[n.id].y - fromPos[n.id].y)*ease;
              if(t>=1){ n.x=toPos[n.id].x; n.y=toPos[n.id].y; n.fx=n.x; n.fy=n.y; }
            });
            tick();
            if(t<1) d._returnAnim = requestAnimationFrame(floatBack);
            else d._returnAnim = null;
          }
          d._returnAnim = requestAnimationFrame(floatBack);
        }
      })
    );

  // Disable double-click zoom
  svg.on('dblclick.zoom',null);

  // Idea glow ring
  nodeG.filter(d=>isIdea(d)).append('circle')
    .attr('r',d=>nr(d)+7).attr('fill','rgba(240,180,41,.12)')
    .attr('stroke','#f0b429').attr('stroke-width',1.5).attr('stroke-opacity',0.5)
    .attr('stroke-dasharray','3,3').attr('pointer-events','none');

  // Status ring
  nodeG.append('circle').attr('r',d=>nr(d)+3.5).attr('fill','none')
    .attr('stroke',d=>{ const o=(pcol?.options||[]).find(x=>x.label===d.phase); return o?.color||'#888'; })
    .attr('stroke-width',2.5).attr('stroke-opacity',0.38).attr('pointer-events','none')
    .attr('class','node-ring');

  // Main circle
  nodeG.append('circle').attr('r',nr)
    .attr('fill',d=>hiddenCats.has(getNodeLabel(d))?'#ccc':getNodeColor(d))
    .attr('fill-opacity',d=>hiddenCats.has(getNodeLabel(d))?0.15:0.88)
    .attr('stroke','#fff').attr('stroke-width',2).attr('class','node-circle');

  // Idea emoji
  nodeG.filter(d=>isIdea(d)).append('text')
    .text('💡').attr('text-anchor','middle').attr('dy',d=>-nr(d)-5)
    .attr('font-size',10).attr('pointer-events','none');

  // Label
  nodeG.append('text')
    .text(d=>{ const w=(d.title||'').split(' '); return(w.slice(0,2).join(' ')+(w.length>2?'…':'')).slice(0,18); })
    .attr('text-anchor','middle').attr('dy',d=>nr(d)+13)
    .attr('font-size',9.5).attr('fill','var(--text-muted)').attr('pointer-events','none')
    .attr('class','node-label');

  // ── Tick function ──
  function tick(){
    linkSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>{
        const dx=d.target.x-d.source.x,dy=d.target.y-d.source.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
        const r=nr(d.target)+3; // stop just outside target circle
        return d.target.x-dx/dist*r;
      })
      .attr('y2',d=>{
        const dx=d.target.x-d.source.x,dy=d.target.y-d.source.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
        const r=nr(d.target)+3;
        return d.target.y-dy/dist*r;
      });
    ideaLinkSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    potLinkSel.attr('x1',d=>{const n=nodes.find(x=>x.id===(d.source.id||d.source));return n?.x||0;})
              .attr('y1',d=>{const n=nodes.find(x=>x.id===(d.source.id||d.source));return n?.y||0;})
              .attr('x2',d=>{const n=nodes.find(x=>x.id===(d.target.id||d.target));return n?.x||0;})
              .attr('y2',d=>{const n=nodes.find(x=>x.id===(d.target.id||d.target));return n?.y||0;});
    nodeG.attr('transform',d=>`translate(${d.x},${d.y})`);
    // Save positions of unpinned nodes as simulation settles
    if(W>100&&H>100) nodes.forEach(n=>{ if(n.x>50&&n.y>50&&n.x<W*2&&n.y<H*2&&!isNaN(n.x)&&!isNaN(n.y)) { if(!nodePos[n.id]||n.fx==null) nodePos[n.id]={x:n.x,y:n.y}; } });
  }

  _sim.on('tick', tick);
  _sim.on('end', ()=>{ persistPos(); });
  // Force initial tick so fixed nodes get their transform set immediately
  tick();

  // ── Zoom ──
  mapZoom = d3.zoom().scaleExtent([0.08,6]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(mapZoom);
  // Restore previous zoom/pan if map was rebuilt due to filter change
  if(_savedTransform && (_savedTransform.k !== 1 || _savedTransform.x !== 0 || _savedTransform.y !== 0)) {
    svg.call(mapZoom.transform, _savedTransform);
  }
  svg.on('dblclick.zoom',null);
  svg.on('click',()=>{ selectedNodeId=null; applyHighlight(null,linkSel,ideaLinkSel,nodeG,adj); hideTT(); });

  // Re-apply selection if one was active
  if(selectedNodeId) setTimeout(()=>applyHighlight(selectedNodeId,linkSel,ideaLinkSel,nodeG,adj),100);

  buildLegend();
}

// ─── Highlight ────────────────────────────────────────────────────────────────
function applyHighlight(nodeId, linkSel, ideaLinkSel, nodeG, adj) {
  if(!nodeId){
    nodeG.selectAll('.node-circle').attr('fill-opacity',d=>hiddenCats.has(getNodeLabel(d))?0.15:0.88);
    nodeG.selectAll('.node-ring').attr('stroke-opacity',0.38);
    nodeG.selectAll('.node-label').attr('fill','var(--text-muted)').attr('font-weight','normal');
    linkSel.attr('stroke','#bbb').attr('stroke-opacity',0.4).attr('stroke-width',1.3).attr('marker-end','url(#arr)');
    ideaLinkSel.attr('stroke-opacity',0.55);
    return;
  }
  const nb = adj[nodeId]||new Set();
  nodeG.selectAll('.node-circle').attr('fill-opacity',d=>d.id===nodeId?1:nb.has(d.id)?0.9:0.12);
  nodeG.selectAll('.node-ring').attr('stroke-opacity',d=>d.id===nodeId?0.9:nb.has(d.id)?0.6:0.08);
  nodeG.selectAll('.node-label')
    .attr('fill',d=>(d.id===nodeId||nb.has(d.id))?'var(--text)':'var(--text-faint)')
    .attr('font-weight',d=>d.id===nodeId?'600':'normal');
  // Outgoing links (from selected node) = teal/accent, Incoming links (to selected node) = blue
  linkSel.attr('stroke',d=>{
      const s=d.source.id||d.source,t=d.target.id||d.target;
      if(s===nodeId) return'var(--accent-mid)'; // outgoing → teal
      if(t===nodeId) return'var(--blue)';        // incoming → blue
      return'#bbb';
    })
    .attr('stroke-opacity',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?0.9:0.06;})
    .attr('stroke-width',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?2.5:1;})
    .attr('marker-end',d=>{
      const s=d.source.id||d.source,t=d.target.id||d.target;
      if(s===nodeId) return'url(#arr-accent)'; // outgoing → teal arrow
      if(t===nodeId) return'url(#arr-blue)';   // incoming → blue arrow
      return'url(#arr)';
    });
  ideaLinkSel.attr('stroke-opacity',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?0.9:0.06;});
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function buildLegend(){
  const el=document.getElementById('legendItems'); if(!el) return; el.innerHTML='';
  const col=columns.find(c=>c.id===colorMode); if(!col) return;
  (col.options||[]).forEach(opt=>{
    const used=data.some(d=>d[col.id]===opt.label); if(!used) return;
    const div=document.createElement('div');
    div.className='legend-item'+(hiddenCats.has(opt.label)?' muted':'');
    div.onclick=()=>{hiddenCats.has(opt.label)?hiddenCats.delete(opt.label):hiddenCats.add(opt.label);renderMap();};
    div.innerHTML=`<span class="legend-dot" style="background:${opt.color}"></span><span style="color:var(--text-muted)">${esc(opt.label)}</span>`;
    el.appendChild(div);
  });
  const n=document.createElement('div');
  n.style.cssText='font-size:10px;color:var(--text-faint);margin-top:7px;border-top:1px solid var(--border);padding-top:5px';
  n.innerHTML='Rechtsklick = Details · 🔗 = Verknüpfen';
  el.appendChild(n);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function showStaticTT(event,d,deg,linkSel,nodeG,adj){
  const wrap=document.getElementById('mapWrap'); if(!wrap) return;
  const r=wrap.getBoundingClientRect();
  const tt=document.getElementById('mapTooltip'); if(!tt) return;
  const col=columns.find(c=>c.id===colorMode);
  const colVal=d[colorMode]||'';
  const colOpt=(col?.options||[]).find(o=>o.label===colVal);
  const linkedTo=(d.internalLinks||[]).map(id=>{const t=data.find(x=>x.id===id);return t?.title||'';}).filter(Boolean);
  tt.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
      <div class="tt-title">${esc(d.title)}</div>
      <button onclick="openDrawer('${d.id}');hideTT()" style="font-size:11px;padding:2px 8px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✏️ Bearbeiten</button>
    </div>
    ${colVal?`<div class="tt-row"><span class="cell-tag" style="background:${colOpt?.color||'#888'}22;color:${colOpt?.color||'#888'}">${esc(colVal)}</span></div>`:''}
    <div class="tt-row">Verbindungen: <span style="color:var(--text)">${deg[d.id]||0}</span></div>
    ${linkedTo.length?`<div class="tt-row">→ ${linkedTo.slice(0,5).map(t=>`<span style="color:var(--text)">${esc(t.slice(0,30))}</span>`).join('<br>→ ')}</div>`:''}
    <div style="font-size:10px;color:var(--text-faint);margin-top:6px;border-top:1px solid var(--border);padding-top:5px">Linksklick außerhalb zum Schließen</div>`;
  let x=event.clientX-r.left+14, y=event.clientY-r.top-10;
  if(x+270>r.width) x=event.clientX-r.left-280;
  if(y+280>r.height) y=Math.max(10,event.clientY-r.top-290);
  tt.style.left=x+'px'; tt.style.top=y+'px'; tt.style.opacity='1';
}
function hideTT(){ const tt=document.getElementById('mapTooltip'); if(tt) tt.style.opacity='0'; }
function moveTT(){}

// ═══════════════════════════════════════════
// COLUMN MANAGER — Drag & Drop, Edit, Delete
// ═══════════════════════════════════════════
let editingColIndex = null; // index of column being edited
let editColOptions = [];    // options for the column being edited
const _autoColors = ['#e03131','#1971c2','#2f9e44','#e8590c','#9b4dca','#f0b429','#495057','#0ca678','#d6336c','#1098ad','#6741d9','#5c7cfa','#74c0fc','#96f2d7','#ffd43b','#ff922b'];

function openColModal() {
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
function closeColModal() {
  document.getElementById('colModal').classList.remove('open');
  editingColIndex = null;
}

function renderColList() {
  // Strip locked from non-system columns (fix old localStorage data)
  const SYSTEM_IDS = ['title','internalLinks','notes','createdBy'];
  columns.forEach(col => { if(!SYSTEM_IDS.includes(col.id)) delete col.locked; });

  const el = document.getElementById('colList');
  el.innerHTML = '';

  columns.forEach((col, i) => {
    const div = document.createElement('div');
    div.className = 'col-item';
    div.dataset.index = String(i);

    // ── Drag handle (only the ⠿ icon is draggable) ──
    const handle = document.createElement('span');
    handle.className = 'col-item-drag';
    handle.title = 'Ziehen zum Sortieren';
    handle.textContent = '⠿';
    handle.draggable = true;
    handle.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      div.classList.add('dragging');
      e.stopPropagation();
    });
    handle.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      document.querySelectorAll('.col-item').forEach(el=>el.classList.remove('drag-over'));
    });

    // ── Drop zone on the row ──
    div.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.col-item').forEach(el=>el.classList.remove('drag-over'));
      div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = parseInt(div.dataset.index);
      if (isNaN(fromIdx) || fromIdx === toIdx) return;
      const moved = columns.splice(fromIdx, 1)[0];
      columns.splice(toIdx, 0, moved);
      saveColumns();
      renderColList();
      render();
    });

    // ── Info ──
    const info = document.createElement('div');
    info.className = 'col-item-info';
    info.innerHTML = `<div class="col-item-name">${esc(col.name)}</div><div class="col-item-type">${typeLabel(col.type)}${col.options?' · '+col.options.length+' Optionen':''}</div>`;

    // ── Visible toggle ──
    const visLabel = document.createElement('label');
    visLabel.className = 'col-visible-toggle';
    visLabel.title = 'In Tabelle anzeigen';
    visLabel.innerHTML = `<input type="checkbox" ${col.visible?'checked':''}> sichtbar`;
    visLabel.querySelector('input').addEventListener('change', function() {
      toggleColVisible(i, this.checked);
    });

    // ── Actions ──
    const actions = document.createElement('div');
    actions.className = 'col-item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.title = 'Bearbeiten';
    editBtn.style.color = 'var(--accent-mid)';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', e => { e.stopPropagation(); startEditColumn(i); });

    const isSystem = SYSTEM_IDS.includes(col.id);
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
      delBtn.addEventListener('click', e => {
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

function typeLabel(t) {
  return {text:'Text',number:'Zahl',select:'Auswahl',multiselect:'Mehrfachauswahl',date:'Datum',url:'URL',links:'Interne Links'}[t]||t;
}

function toggleColVisible(i, visible) {
  columns[i].visible = visible;
  saveColumns();
  render();
}

function deleteColumn(i) {
  const col = columns[i];
  const LOCKED_IDS = ['title', 'internalLinks', 'notes', 'createdBy'];
  if (LOCKED_IDS.includes(col.id)) {
    toast('Diese Systemkategorie kann nicht gelöscht werden.');
    return;
  }
  showConfirm(
    `Kategorie "${col.name}" wirklich löschen? Daten dieser Kategorie gehen verloren.`,
    () => {
      columns.splice(i, 1);
      saveColumns();
      renderColList();
      render();
      toast('Kategorie gelöscht');
    },
    'Kategorie löschen'
  );
}

function startEditColumn(i) {
  editingColIndex = i;
  const col = columns[i];
  editColOptions = col.options ? col.options.map(o=>({...o})) : [];

  const panel = document.getElementById('editColPanel');
  panel.style.display = 'block';
  panel.innerHTML = `
    <h4>✏️ Kategorie bearbeiten <button class="btn-icon" onclick="cancelEditColumn()" style="font-size:11px">✕</button></h4>
    <div class="new-col-grid">
      <input type="text" id="editColName" value="${esc(col.name)}" placeholder="Spaltenname">
      <select id="editColType" onchange="onEditColTypeChange()">
        <option value="text" ${col.type==='text'?'selected':''}>Text</option>
        <option value="number" ${col.type==='number'?'selected':''}>Zahl</option>
        <option value="select" ${col.type==='select'?'selected':''}>Auswahl</option>
        <option value="multiselect" ${col.type==='multiselect'?'selected':''}>Mehrfachauswahl</option>
        <option value="date" ${col.type==='date'?'selected':''}>Datum</option>
        <option value="url" ${col.type==='url'?'selected':''}>URL</option>
      </select>
    </div>
    <div id="editColOptions" style="display:${(col.type==='select'||col.type==='multiselect')?'block':'none'}">
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
  panel.scrollIntoView({behavior:'smooth', block:'nearest'});
}

function cancelEditColumn() {
  editingColIndex = null;
  document.getElementById('editColPanel').style.display = 'none';
}

function onEditColTypeChange() {
  const type = document.getElementById('editColType').value;
  const show = type==='select'||type==='multiselect';
  document.getElementById('editColOptions').style.display = show?'block':'none';
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
      <input type="text" value="${esc(opt.label)}" placeholder="Optionsname" oninput="editColOptions[${i}].label=this.value">
      <input type="color" value="${opt.color||'#888'}" class="option-color" oninput="editColOptions[${i}].color=this.value">
      <button class="btn-icon" onclick="removeEditOption(${i})" style="color:var(--red)">✕</button>`;
    div.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', i); div.style.opacity='0.4'; });
    div.addEventListener('dragend', () => { div.style.opacity='1'; });
    div.addEventListener('dragover', e => { e.preventDefault(); div.style.background='var(--surface2)'; });
    div.addEventListener('dragleave', () => { div.style.background=''; });
    div.addEventListener('drop', e => {
      e.preventDefault(); div.style.background='';
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      const to = i;
      if(from === to) return;
      const moved = editColOptions.splice(from, 1)[0];
      editColOptions.splice(to, 0, moved);
      renderEditOptionList();
    });
    el.appendChild(div);
  });
}

function addEditOption() {
  const inp = document.getElementById('editOptionInput');
  const col = document.getElementById('editOptionColor');
  const label = inp.value.trim();
  if (!label) return;
  editColOptions.push({label, color: col.value});
  inp.value = '';
  if(col) col.value = _autoColors[editColOptions.length % _autoColors.length];
  renderEditOptionList();
}
function removeEditOption(i) { editColOptions.splice(i,1); renderEditOptionList(); }

function saveEditColumn() {
  if (editingColIndex === null) return;
  const nameEl = document.getElementById('editColName');
  const typeEl = document.getElementById('editColType');
  if (!nameEl || !typeEl) return;
  const name = nameEl.value.trim();
  const type = typeEl.value;
  if (!name) { toast('Bitte Namen eingeben'); return; }

  columns[editingColIndex].name = name;
  columns[editingColIndex].type = type;
  if (type==='select'||type==='multiselect') {
    columns[editingColIndex].options = [...editColOptions];
  } else {
    delete columns[editingColIndex].options;
  }
  saveColumns();
  editingColIndex = null;
  document.getElementById('editColPanel').style.display = 'none';
  renderColList();
  render();
  toast('Kategorie aktualisiert ✓');
}

function onNewColTypeChange() {
  const type = document.getElementById('newColType').value;
  const show = type === 'select' || type === 'multiselect';
  document.getElementById('newColOptions').style.display = show ? 'block' : 'none';
  if (show && newColOptions.length === 0) {
    // Add a starter option
    newColOptions = [{label:'Option 1', color:'#1a5f3c'}];
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
      <input type="text" value="${esc(opt.label)}" placeholder="Optionsname" oninput="newColOptions[${i}].label=this.value">
      <input type="color" value="${opt.color}" class="option-color" oninput="newColOptions[${i}].color=this.value" title="Farbe">
      <button class="btn-icon" onclick="removeOption(${i})" style="color:var(--red)">✕</button>`;
    div.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', i); div.style.opacity='0.4'; });
    div.addEventListener('dragend', () => { div.style.opacity='1'; });
    div.addEventListener('dragover', e => { e.preventDefault(); div.style.background='var(--surface2)'; });
    div.addEventListener('dragleave', () => { div.style.background=''; });
    div.addEventListener('drop', e => {
      e.preventDefault(); div.style.background='';
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      const to = i;
      if(from === to) return;
      const moved = newColOptions.splice(from, 1)[0];
      newColOptions.splice(to, 0, moved);
      renderOptionList();
    });
    el.appendChild(div);
  });
}

function addOption() {
  const inp = document.getElementById('newOptionInput');
  const col = document.getElementById('newOptionColor');
  const label = inp.value.trim();
  if (!label) return;
  newColOptions.push({ label, color: col.value });
  inp.value = '';
  // Auto-advance to next color
  if(col) col.value = _autoColors[newColOptions.length % _autoColors.length];
  renderOptionList();
}
function removeOption(i) { newColOptions.splice(i, 1); renderOptionList(); }

function createColumn() {
  const name = document.getElementById('newColName').value.trim();
  const type = document.getElementById('newColType').value;
  if (!name) { toast('Bitte Spaltenname eingeben'); return; }
  const id = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g,'_') + '_' + Date.now();
  const col = { id, name, type, visible: true };
  if ((type==='select'||type==='multiselect') && newColOptions.length > 0) {
    col.options = [...newColOptions];
  }
  columns.push(col);
  saveColumns();
  newColOptions = [];
  document.getElementById('newColName').value = '';
  document.getElementById('optionList').innerHTML = '';
  document.getElementById('newColOptions').style.display = 'none';
  renderColList();
  render();
  toast(`Kategorie "${name}" erstellt ✓`);
}

// ═══════════════════════════════════════════
// DRAWER
// ═══════════════════════════════════════════
function openDrawer(id) {
  const item = data.find(d=>d.id===id);
  if (!item) return;
  drawerItem = item;
  drawerKws = [...(item.kws||[])];
  drawerLinks = [...(item.internalLinks||[])];
  drawerPotLinks = [...(item.potentialLinks||[])];
  document.getElementById('drawerTitle').textContent = item.title || 'Eintrag bearbeiten';
  const meta = document.getElementById('drawerMeta');
  if (item.updatedAt) {
    meta.style.display = 'block';
    const d = new Date(item.updatedAt);
    meta.textContent = `Zuletzt bearbeitet: ${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  } else { meta.style.display = 'none'; }
  renderDrawerBody(item);
  document.getElementById('deleteBtn').style.display = isReadOnly || currentProfile?.role!=='admin' ? 'none' : 'inline-block';
  document.getElementById('saveBtn').disabled = isReadOnly;
  document.getElementById('overlay').classList.add('open');
}

function openNewDrawer() {
  if (isReadOnly) { toast('Nur Editoren können Inhalte erstellen.'); return; }
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
  const ideaFlag = item?.isIdeaFlag || false;
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;background:${ideaFlag?'rgba(240,180,41,.12)':'var(--surface2)'};border:1px solid ${ideaFlag?'#f0b429':'var(--border)'};border-radius:var(--radius);padding:10px 14px;margin-bottom:14px">
    <div>
      <div style="font-size:13px;font-weight:600;color:${ideaFlag?'#8a6000':'var(--text)'}">💡 Als Idee markieren</div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Ideen werden gelb hervorgehoben und können potenzielle Links haben</div>
    </div>
    <label style="cursor:pointer;flex-shrink:0">
      <div onclick="toggleDrawerIdea(this)" data-on="${ideaFlag?'1':'0'}" style="width:36px;height:20px;border-radius:10px;background:${ideaFlag?'#f0b429':'var(--border-mid)'};position:relative;transition:background .2s;cursor:pointer">
        <div style="position:absolute;top:2px;left:${ideaFlag?'16':'2'}px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div>
      </div>
    </label>
  </div>`;
  // All columns (including invisible ones)
  const allCols = columns.filter(c => !['internalLinks','createdBy','kws'].includes(c.id));
  // Show createdBy if set
  const createdByVal = item?.createdBy || '';

  // CreatedBy badge
  if (createdByVal) {
    html += `<div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;display:flex;align-items:center;gap:5px">
      <span>👤 Erstellt von:</span>
      <span style="font-weight:500;color:var(--text-muted)">${esc(createdByVal)}</span>
    </div>`;
  }

  allCols.forEach(col => {
    const val = item ? (item[col.id] || '') : '';
    html += `<div class="form-row"><label>${esc(col.name)}</label>`;
    if (col.type === 'select') {
      const opts = (col.options||[]).map(o=>`<option value="${esc(o.label)}" ${val===o.label?'selected':''}>${esc(o.label)}</option>`).join('');
      html += `<select id="df_${col.id}"><option value="">– wählen –</option>${opts}</select>`;
    } else if (col.type === 'multiselect') {
      html += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px" id="ms_${col.id}">`;
      // Handle both arrays and legacy strings
      const vals = Array.isArray(val) ? val : (val ? [val] : []);
      (col.options||[]).forEach(o => {
        const checked = vals.includes(o.label);
        html += `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;background:${o.color}22;border:1px solid ${o.color}55;padding:3px 9px;border-radius:20px;color:${o.color}">
          <input type="checkbox" value="${esc(o.label)}" ${checked?'checked':''} style="margin:0"> ${esc(o.label)}</label>`;
      });
      html += `</div>`;
    } else if (col.type === 'date') {
      html += `<input type="date" id="df_${col.id}" value="${esc(val)}">`;
    } else if (col.type === 'number') {
      html += `<input type="number" id="df_${col.id}" value="${esc(val)}">`;
    } else if (col.type === 'url') {
      html += `<input type="url" id="df_${col.id}" value="${esc(val)}" placeholder="https://…">`;
    } else {
      const isNotes = col.id === 'notes';
      if (isNotes) {
        html += `<textarea id="df_${col.id}" rows="3">${esc(val)}</textarea>`;
      } else {
        html += `<input type="text" id="df_${col.id}" value="${esc(val)}">`;
      }
    }
    html += `</div>`;
  });

  // Keywords section removed — user manages via custom categories

  // Potential links (ideas)
  if (isIdea(item||{})) {
    html += `<div class="section-heading">💡 Potenzielle Verlinkungen</div>
    <div class="form-row">
      <label>Potenzielle Links (Freitext)</label>
      <textarea id="df_potentialLinksText" rows="2" placeholder="z.B. → ModPCB Seite, → Blog KI">${esc((item?.potentialLinksText)||'')}</textarea>
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">Werden als gestrichelte Linien in der Link Map angezeigt</div>
    </div>
    <div class="form-row">
      <label>Potenzielle Links (Seiten auswählen)</label>
      <div class="link-chips" id="drawerPotLinkChips"></div>
      <div class="add-row" style="margin-top:6px">
        <select id="drawerPotLinkSelect" style="flex:1;padding:6px 9px;border:1px solid var(--border-mid);border-radius:var(--radius);font-family:var(--sans);font-size:13px;color:var(--text);background:var(--surface);outline:none">
          <option value="">— Seite wählen —</option>
          ${data.filter(d=>d.id!==item?.id).sort((a,b)=>a.title.localeCompare(b.title,'de')).map(d=>`<option value="${d.id}">${esc(d.title.slice(0,52))}</option>`).join('')}
        </select>
        <button class="btn-ghost" onclick="addDrawerPotLink()" style="font-size:12px">+ Link</button>
      </div>
    </div>`;
  }

  // Internal links — with filter by first select column + search
  {
    // First select-type column after title (e.g. "Format")
    const filterCol = columns.find(c => c.type === 'select' && c.id !== 'title');
    const filterOpts = filterCol ? (filterCol.options||[]).map(o=>o.label) : [];
    const filterSelectHtml = filterCol ? `
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
        <label style="font-size:11px;color:var(--text-muted);white-space:nowrap">${esc(filterCol.name)}:</label>
        <select id="drawerLinkFilter" onchange="filterDrawerLinkOptions()" style="flex:1;padding:4px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
          <option value="">Alle</option>
          ${filterOpts.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('')}
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
            ${data.filter(d=>d.id!==item?.id).sort((a,b)=>a.title.localeCompare(b.title,'de')).map(d=>`<option value="${d.id}" data-filter="${esc(d[filterCol?.id]||'')}">${esc(d.title.slice(0,52))}</option>`).join('')}
          </select>
          <button class="btn-ghost" onclick="addDrawerLink()" style="font-size:12px">+ Link</button>
        </div>
      </div>`;
  }

  body.innerHTML = html;

  renderDrawerKws(); // kept for backwards compat
  renderDrawerLinks();
  setTimeout(renderDrawerPotLinks, 0);
  if (!isReadOnly) body.querySelectorAll('input,select,textarea').forEach(el=>el.removeAttribute('disabled'));
  else body.querySelectorAll('input,select,textarea').forEach(el=>el.setAttribute('disabled',''));
}

function toggleDrawerIdea(el) {
  const on = el.getAttribute('data-on') === '1';
  const newOn = !on;
  el.setAttribute('data-on', newOn?'1':'0');
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
  el.innerHTML = drawerKws.map((kw,i)=>`<span class="kw-tag">${esc(kw)}<button onclick="removeDrawerKw(${i})">✕</button></span>`).join('');
}
function addDrawerKw() {
  const inp = document.getElementById('drawerKwInput');
  const v = inp.value.trim();
  if (!v || drawerKws.includes(v)) { inp.value=''; return; }
  drawerKws.push(v); inp.value=''; renderDrawerKws();
}
function removeDrawerKw(i) { drawerKws.splice(i,1); renderDrawerKws(); }

function filterDrawerLinkOptions() {
  const sel = document.getElementById('drawerLinkSelect');
  const filterVal = document.getElementById('drawerLinkFilter')?.value || '';
  const searchVal = (document.getElementById('drawerLinkSearch')?.value || '').toLowerCase().trim();
  if (!sel) return;
  [...sel.options].forEach(opt => {
    if (!opt.value) return; // keep "— Seite wählen —"
    const matchFilter = !filterVal || opt.dataset.filter === filterVal;
    const matchSearch = !searchVal || opt.text.toLowerCase().includes(searchVal);
    opt.hidden = !(matchFilter && matchSearch);
  });
  // Reset selection if hidden
  if (sel.selectedOptions[0]?.hidden) sel.value = '';
}

function renderDrawerLinks() {
  const el = document.getElementById('drawerLinkChips');
  if (!el) return;
  el.innerHTML = drawerLinks.map((id,i)=>{
    const t = data.find(d=>d.id===id);
    return `<span class="link-chip">🔗 ${esc((t?.title||'?').slice(0,34))}<button onclick="removeDrawerLink(${i})">✕</button></span>`;
  }).join('');
}
function addDrawerLink() {
  const sel = document.getElementById('drawerLinkSelect');
  const v = sel.value;
  if (!v || drawerLinks.includes(v)) return;
  drawerLinks.push(v); sel.value=''; renderDrawerLinks();
}
function removeDrawerLink(i) { drawerLinks.splice(i,1); renderDrawerLinks(); }

// Potential links (ideas/planning)
let drawerPotLinks = [];
function renderDrawerPotLinks() {
  const el = document.getElementById('drawerPotLinkChips');
  if (!el) return;
  el.innerHTML = drawerPotLinks.map((id,i)=>{
    const t = data.find(d=>d.id===id);
    return `<span class="link-chip" style="background:rgba(240,180,41,.15);color:#8a6000;border:1px dashed #f0b429">⚡ ${esc((t?.title||'?').slice(0,34))}<button onclick="removeDrawerPotLink(${i})" style="color:#8a6000">✕</button></span>`;
  }).join('');
}
function addDrawerPotLink() {
  const sel = document.getElementById('drawerPotLinkSelect');
  if (!sel) return;
  const v = sel.value;
  if (!v || drawerPotLinks.includes(v)) return;
  drawerPotLinks.push(v); sel.value=''; renderDrawerPotLinks();
}
function removeDrawerPotLink(i) { drawerPotLinks.splice(i,1); renderDrawerPotLinks(); }

function getDrawerValues() {
  const body = document.getElementById('drawerBody');
  const item = {};
  columns.forEach(col => {
    if (col.id === 'internalLinks') return;
    if (col.type === 'multiselect') {
      const checks = body.querySelectorAll(`#ms_${col.id} input[type=checkbox]:checked`);
      item[col.id] = [...checks].map(c=>c.value);
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

function itemToRow(item) {
  // Map app fields to DB columns
  const coreFields = ['title','topic','phase','format','persona','owner','mainKw','url','notes','date','kws','internalLinks'];
  const custom = {};
  Object.keys(item).forEach(k => {
    if (!coreFields.includes(k) && !['id','updatedAt'].includes(k)) custom[k] = item[k];
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
      ...(Array.isArray(item.topic) ? {topic: item.topic} : (item.topic ? {topic: [item.topic]} : {})),
      ...(Array.isArray(item.phase) ? {phase: item.phase} : (item.phase ? {phase: [item.phase]} : {})),
      potentialLinks: item.potentialLinks||[],
      potentialLinksText: item.potentialLinksText||'',
      isIdeaFlag: item.isIdeaFlag||false,
      createdBy: item.createdBy || currentProfile?.display_name || currentUser?.email || ''
    },
    created_by: currentUser?.id,
  };
}

async function saveEntry() {
  const vals = getDrawerValues();
  if (!vals.title) { toast('Bitte Titel eingeben'); return; }
  const row = itemToRow({...(drawerItem||{}), ...vals});
  setSyncStatus('loading','Speichere…');
  // Save scroll before DB write (realtime will trigger re-render)
  const _seCa = _getScrollEl();
  if(_seCa) _preservedScroll = _seCa.scrollTop;
  let error;
  if (drawerItem) {
    const r = await sb.from('content_items').update(row).eq('id', drawerItem.id);
    error = r.error;
  } else {
    const r = await sb.from('content_items').insert(row);
    error = r.error;
  }
  if (error) { setSyncStatus('error','Fehler'); toast('Fehler: '+error.message); return; }
  closeDrawer();
  toast(drawerItem ? 'Gespeichert ✓' : 'Erstellt ✓');
}

async function deleteEntry() {
  if (!drawerItem) return;
  if (currentProfile?.role !== 'admin') { toast('Nur Admins können löschen.'); return; }
  showConfirm('Eintrag wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.', async () => {
    const {error} = await sb.from('content_items').delete().eq('id', drawerItem.id);
    if (error) { toast('Fehler: '+error.message); return; }
    closeDrawer(); toast('Gelöscht');
  }, 'Eintrag löschen');
  return; // actual delete happens in callback
// handled in showConfirm callback
}

function closeDrawer() { document.getElementById('overlay').classList.remove('open'); }
function closeDrawerOnBg(e) { if(e.target===document.getElementById('overlay')) closeDrawer(); }

// ═══════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════
function exportCSV() {
  const visCols = columns.filter(c=>c.visible);
  const headers = visCols.map(c=>c.name);
  const rows = [headers.join(';')];
  data.forEach(d=>{
    rows.push(visCols.map(c=>{
      const v = Array.isArray(d[c.id]) ? d[c.id].join(', ') : (d[c.id]||'');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
  });
  dlFile('V4Q_Content_Map.csv', rows.join('\n'), 'text/csv');
  closeExport();
}
function exportJSON(){ dlFile('V4Q_Content_Map.json',JSON.stringify(data,null,2),'application/json'); closeExport(); }
function dlFile(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();}

// ── IMPORT ──
async function handleImportFile(input) {
  const file = input.files[0];
  if(!file) return;
  input.value = ''; // reset so same file can be re-imported
  closeExport();
  const text = await file.text();
  try {
    if(file.name.endsWith('.json')) {
      await importJSON(text);
    } else {
      await importCSV(text);
    }
  } catch(e) {
    toast('Import-Fehler: ' + e.message);
  }
}

async function importJSON(text) {
  const items = JSON.parse(text);
  if(!Array.isArray(items)) throw new Error('JSON muss ein Array sein');
  await importItems(items);
}

async function importCSV(text) {
  const lines = text.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length < 2) throw new Error('CSV ist leer');
  const headers = lines[0].split(';').map(h=>h.replace(/^"|"$/g,'').trim());
  const items = lines.slice(1).map(line => {
    // Handle quoted fields with semicolons
    const fields = [];
    let cur = '', inQ = false;
    for(const ch of line) {
      if(ch==='"') { inQ=!inQ; }
      else if(ch===';' && !inQ) { fields.push(cur); cur=''; }
      else cur+=ch;
    }
    fields.push(cur);
    const obj = {};
    headers.forEach((h,i) => { obj[h] = fields[i]?.replace(/^"|"$/g,'').trim()||''; });
    return obj;
  });
  await importItems(items);
}

async function importItems(items) {
  if(!items.length) { toast('Keine Einträge zum Importieren'); return; }
  const existingTitles = new Set(data.map(d=>(d.title||'').toLowerCase()));
  const toInsert = [];
  let skipped = 0;
  const colMap = {
    'Titel':'title','Title':'title','TITEL':'title',
    'Thema':'topic','Status':'phase','Format':'format',
    'Persona':'persona','Verantw.':'owner','Keyword':'mainKw',
    'URL':'url','Notizen':'notes','Datum':'date',
  };
  items.forEach(item => {
    // Map column names to internal field names
    const mapped = {};
    Object.entries(item).forEach(([k,v]) => {
      const field = colMap[k] || k;
      mapped[field] = v;
    });
    const title = mapped.title || mapped.Titel || mapped.Title || '';
    if(!title) { skipped++; return; }
    if(existingTitles.has(title.toLowerCase())) { skipped++; return; } // skip duplicates
    toInsert.push({
      title,
      topic: mapped.topic||'',
      phase: mapped.phase||'Idee',
      format: mapped.format||'',
      persona: mapped.persona||'',
      owner: mapped.owner||'',
      main_keyword: mapped.mainKw||mapped.main_keyword||'',
      url: mapped.url||'',
      description: mapped.notes||mapped.description||'',
      planned_date: mapped.date||mapped.planned_date||null,
      keywords: [],
      internal_links: [],
      custom_fields: {},
      created_by: currentUser?.id,
    });
  });
  if(!toInsert.length) {
    toast(`Keine neuen Einträge (${skipped} übersprungen — doppelt oder ohne Titel)`);
    return;
  }
  setSyncStatus('loading', `Importiere ${toInsert.length} Einträge…`);
  const {error} = await sb.from('content_items').insert(toInsert);
  if(error) { setSyncStatus('error','Fehler'); toast('Import-Fehler: '+error.message); return; }
  toast(`✅ ${toInsert.length} Einträge importiert${skipped?', '+skipped+' übersprungen':''}`);
}

// ═══════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════
function setView(v){
  if(v !== currentView) selectedIds.clear();
  currentView=v;
  ['table','kanban','map'].forEach(n=>document.getElementById('view'+n.charAt(0).toUpperCase()+n.slice(1)).classList.toggle('active',v===n));
  const isMap = v==='map';
  document.getElementById('searchWrap').style.visibility = isMap?'hidden':'visible';
  const kgw = document.getElementById('kanbanGroupByWrap');
  if(kgw) kgw.style.display = v==='kanban' ? 'flex' : 'none';
  const rhw = document.getElementById('rowHeightWrap');
  if(rhw) { rhw.style.display = v==='table' ? 'flex' : 'none'; }
  const slider = document.getElementById('rowHeightSlider');
  if(slider && v==='table') { slider.value = currentRowHeight; }
  if(v==='kanban') populateKanbanGroupBy();
  render();
}

function initViewControls() {
  // Call on boot to set correct initial state for table view
  const rhw = document.getElementById('rowHeightWrap');
  if(rhw) rhw.style.display = 'flex';
  const slider = document.getElementById('rowHeightSlider');
  if(slider) slider.value = currentRowHeight;
  const kgw = document.getElementById('kanbanGroupByWrap');
  if(kgw) kgw.style.display = 'none';
}
function cycleSortBy(colId) {
  if(sortColId === colId) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortColId = colId;
    sortDir = 'asc';
  }
  render();
}
function closeExport(){ document.getElementById('exportPanel').classList.remove('open'); }
// Custom confirm dialog — Teams blocks window.confirm()
function showConfirm(message, onOk, title='Bestätigung') {
  const overlay = document.getElementById('confirmOverlay');
  const msgEl = document.getElementById('confirmMsg');
  const titleEl = document.getElementById('confirmTitle');
  const okBtn = document.getElementById('confirmOk');
  const cancelBtn = document.getElementById('confirmCancel');
  if(!overlay) { if(window.confirm(message)) onOk(); return; }
  msgEl.textContent = message;
  titleEl.textContent = title;
  overlay.classList.add('open');
  const close = () => overlay.classList.remove('open');
  const handleOk = () => { close(); okBtn.removeEventListener('click', handleOk); cancelBtn.removeEventListener('click', handleCancel); onOk(); };
  const handleCancel = () => { close(); okBtn.removeEventListener('click', handleOk); cancelBtn.removeEventListener('click', handleCancel); };
  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
}

function esc(s){ if(Array.isArray(s)) s=s.join(', '); return(String(s||'')).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
let toastTimer;
function toast(msg){ const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2500); }

document.getElementById('exportBtn').onclick=(e)=>{e.stopPropagation();document.getElementById('exportPanel').classList.toggle('open');};
document.addEventListener('click',closeExport);
document.getElementById('exportPanel').addEventListener('click',e=>e.stopPropagation());
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDrawer();closeColModal();}
  if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();openNewDrawer();}
  if((e.metaKey||e.ctrlKey)&&e.key==='z'){
    e.preventDefault();
    if(currentView==='map') undoMapAction();
  }
});

// ═══════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════
async function boot() {
  if (typeof SUPABASE_URL==='undefined'||SUPABASE_URL==='YOUR_SUPABASE_URL') {
    document.body.innerHTML='<div style="padding:40px;font-family:sans-serif;color:#c0392b">⚠️ Bitte config.js ausfüllen!</div>';
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  loadColumns();

  // One-time cleanup: remove bad map positions saved by old buggy builds
  try {
    const raw = JSON.parse(localStorage.getItem('v4q_map_positions')||'{}');
    const clean = {};
    let removed = 0;
    Object.entries(raw).forEach(([k,v]) => {
      if(v && isFinite(v.x) && isFinite(v.y) && v.x > 20 && v.y > 20) clean[k] = v;
      else removed++;
    });
    if(removed > 0) {
      localStorage.setItem('v4q_map_positions', JSON.stringify(clean));
      console.log('Cleaned', removed, 'bad map positions from localStorage');
    }
  } catch(e) {}

  const {data:{session}} = await sb.auth.getSession();
  if (session) {
    currentUser = session.user;
    document.getElementById('appShell').style.display='flex';
    await loadProfile(currentUser.id);
    await syncColumnsFromSupabase(); // sync categories from Supabase
    initViewControls();
    await loadData();
    subscribeRealtime();
  } else {
    document.getElementById('login-screen').classList.add('visible');
  }

  sb.auth.onAuthStateChange(async(event,session)=>{
    if(event==='SIGNED_IN'&&session){
      currentUser=session.user;
      document.getElementById('login-screen').classList.remove('visible');
      document.getElementById('appShell').style.display='flex';
      await loadProfile(currentUser.id);
      await syncColumnsFromSupabase(); // sync categories from Supabase
      initViewControls();
      await loadData();
      subscribeRealtime();
    }
    if(event==='SIGNED_OUT'){
      currentUser=null;
      document.getElementById('appShell').style.display='none';
      document.getElementById('login-screen').classList.add('visible');
    }
  });
}
boot();
