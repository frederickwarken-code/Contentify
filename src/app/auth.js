/**
 * Login, Session, Profil, Nutzer-Menü, Admin-Liste.
 */
import { RECENT_ACCOUNTS_KEY, SB_AUTH_TAB_META_KEY } from './storage-keys.js';
import { esc, toast, setSyncStatus, withTimeout } from './lib.js';
import { appSession } from './session.js';

let isSignupMode = false;

export function toggleSignup() {
  isSignupMode = !isSignupMode;
  document.getElementById('signupToggleBtn').textContent = isSignupMode ? '← Zurück zum Login' : 'Noch kein Konto? Registrieren';
  document.getElementById('login-subtitle').textContent = isSignupMode ? 'Neues Konto erstellen' : 'Anmelden';
  document.getElementById('loginError').textContent = '';
}

export async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pw = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!email || !pw) { errEl.textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
  setSyncStatus('loading', 'Anmelden…');
  try {
    let res;
    if (isSignupMode) {
      res = await appSession.sb.auth.signUp({ email, password: pw });
      if (!res.error) { errEl.style.color = 'var(--accent)'; errEl.textContent = 'Registrierung erfolgreich! Bitte E-Mail bestätigen.'; setSyncStatus(''); return; }
    } else {
      res = await appSession.sb.auth.signInWithPassword({ email, password: pw });
    }
    if (res.error) throw res.error;
    rememberAccountEmail(email);
  } catch (e) {
    errEl.style.color = 'var(--red)';
    errEl.textContent = e.message === 'Invalid login credentials' ? 'E-Mail oder Passwort falsch.' : e.message;
    setSyncStatus('');
  }
}

export function hideUserMenu() { const m = document.getElementById('userMenu'); if (m) m.style.display = 'none'; }
export function showUserMenu() {
  const m = document.getElementById('userMenu');
  if (!m) return;
  document.getElementById('userMenuName').textContent = appSession.currentProfile?.display_name || 'Konto';
  document.getElementById('userMenuEmail').textContent = appSession.currentProfile?.email || appSession.currentUser?.email || '';
  document.getElementById('adminMenuBtn').style.display = appSession.currentProfile?.role === 'admin' ? 'block' : 'none';
  m.style.display = 'block';
}
export function toggleUserMenu(e) {
  e?.stopPropagation?.();
  const m = document.getElementById('userMenu');
  if (!m) return;
  if (m.style.display === 'none' || !m.style.display) showUserMenu();
  else hideUserMenu();
}

document.addEventListener('click', (e) => {
  const m = document.getElementById('userMenu');
  const chip = document.getElementById('userChip');
  if (!m || m.style.display === 'none') return;
  if (m.contains(e.target) || chip?.contains(e.target)) return;
  hideUserMenu();
});

function rememberAccountEmail(email) {
  try {
    if (!email) return;
    const key = RECENT_ACCOUNTS_KEY;
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    const list = Array.isArray(raw) ? raw : [];
    const next = [email, ...list.filter(x => x !== email)].slice(0, 6);
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* ignore */ }
}

export function getRememberedAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_ACCOUNTS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function switchAccount() {
  hideUserMenu();
  const accounts = getRememberedAccounts();
  if (accounts.length) {
    document.getElementById('loginEmail').value = accounts[0];
  }
  document.getElementById('login-screen').classList.add('visible');
  document.getElementById('appShell').style.display = 'none';
  toast(accounts.length ? 'Konto wechseln: E-Mail ist vorausgefüllt.' : 'Bitte mit anderem Konto anmelden.');
}

export function openAdminPanelFromMenu() {
  hideUserMenu();
  openAdminPanel();
}

const LOGOUT_TIMEOUT_MS = 12000;

/** Wenn `signOut()` hängt (z. B. Lock/Netz), Session-Zeilen in diesem Tab entfernen. */
function clearSupabaseSessionFromTabStorage() {
  try {
    const storageKey = sessionStorage.getItem(SB_AUTH_TAB_META_KEY);
    if (!storageKey) return;
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(`${storageKey}-user`);
    sessionStorage.removeItem(`${storageKey}-code-verifier`);
  } catch (_) { /* ignore */ }
}

export async function doLogout(forceReload = false) {
  hideUserMenu();
  setSyncStatus('loading', 'Abmelden…');
  let timedOut = false;
  try {
    const { error } = await withTimeout(
      appSession.sb.auth.signOut(),
      LOGOUT_TIMEOUT_MS,
      '__logout_timeout__'
    );
    if (error) throw error;
  } catch (e) {
    if (e?.message === '__logout_timeout__') {
      timedOut = true;
      toast('Abmelden dauert zu lange — lokale Session wird entfernt.');
      clearSupabaseSessionFromTabStorage();
    } else {
      toast('Logout-Fehler: ' + (e?.message || e));
    }
  } finally {
    setSyncStatus('');
    if (timedOut) {
      location.reload();
      return;
    }
    if (forceReload) setTimeout(() => location.reload(), 150);
  }
}

export async function openAdminPanel() {
  if (appSession.currentProfile?.role !== 'admin') return;
  document.getElementById('adminOverlay').classList.add('open');
  await loadAdminUsers();
}

export function closeAdminPanel() {
  document.getElementById('adminOverlay').classList.remove('open');
}

export async function loadAdminUsers() {
  const tbody = document.getElementById('adminUserList');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-faint)">Lädt…</td></tr>';
  const { data: users, error } = await appSession.sb.from('profiles').select('*').order('email');
  if (error) { tbody.innerHTML = '<tr><td colspan="4" style="color:var(--red);padding:12px">Fehler: ' + error.message + '</td></tr>'; return; }
  if (!users?.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-faint)">Keine Nutzer gefunden</td></tr>'; return; }
  tbody.innerHTML = users.map(u => {
    const name = esc(u.display_name || '–');
    const email = esc(u.email || '');
    const isMe = u.id === appSession.currentUser?.id;
    const roleOpts = ['admin', 'editor', 'viewer'].map(r =>
      `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`
    ).join('');
    return `<tr>
      <td style="font-weight:500">${name}${isMe ? ' <span style="font-size:10px;color:var(--accent)">(du)</span>' : ''}</td>
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

export async function updateUserRole(userId, newRole, selectEl) {
  selectEl.disabled = true;
  const { error } = await appSession.sb.from('profiles').update({ role: newRole }).eq('id', userId);
  if (error) {
    toast('Fehler: ' + error.message);
    selectEl.disabled = false;
    return;
  }
  toast(`✅ Rolle auf "${newRole}" geändert`);
  selectEl.disabled = false;
  await loadAdminUsers();
}

export async function loadProfile(userId) {
  const { data } = await appSession.sb.from('profiles').select('*').eq('id', userId).single();
  appSession.currentProfile = data;
  appSession.isReadOnly = data?.role === 'viewer';
  renderUserChip();
}

export function renderUserChip() {
  if (!appSession.currentProfile) return;
  const initial = (appSession.currentProfile.display_name || appSession.currentProfile.email || '?')[0].toUpperCase();
  const isAdmin = appSession.currentProfile.role === 'admin';
  document.getElementById('userChip').innerHTML = `
    <div class="user-avatar">${initial}</div>
    <span style="font-size:12px;color:var(--text-muted);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${appSession.currentProfile.display_name || appSession.currentProfile.email}</span>
    <span class="role-badge">${appSession.currentProfile.role}</span>
    ${isAdmin ? '<span style="font-size:10px;opacity:.7;color:rgba(255,255,255,.7)" title="Nutzerverwaltung öffnen">👥</span>' : ''}`;
  document.getElementById('userChip').style.cursor = 'pointer';
  if (appSession.isReadOnly) { document.getElementById('newBtn').disabled = true; }
}
