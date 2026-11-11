// Shared by staff-admissions.html and learners.html
// Requires: window.supabase (Supabase JS loaded via CDN in each page)

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EzlLIeKJDqtMs0mKD0gfgA_C86iHZal';

// Shared cross-subdomain session storage for the whole Bloom Space Hub
// (Internal Admin + Calendar + Bloombrary + Portal). Same cookie key/domain
// scheme everywhere, so signing in on any one of them is recognized on the rest.
const bloomHubCookieStorage = {
  getItem(key){
    const m = document.cookie.match('(^|; )' + key.replace(/[-[\]{}()*+?.,\\^$|#\s]/g,'\\$&') + '=([^;]*)');
    return m ? decodeURIComponent(m[2]) : null;
  },
  setItem(key, value){
    let cookie = key + '=' + encodeURIComponent(value) + '; Max-Age=' + (60*60*24*30) + '; Path=/; SameSite=Lax; Secure';
    if(location.hostname.endsWith('learn2bloom.org')) cookie += '; Domain=.learn2bloom.org';
    document.cookie = cookie;
  },
  removeItem(key){
    let cookie = key + '=; Max-Age=0; Path=/; SameSite=Lax; Secure';
    if(location.hostname.endsWith('learn2bloom.org')) cookie += '; Domain=.learn2bloom.org';
    document.cookie = cookie;
  }
};

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: bloomHubCookieStorage, storageKey: 'bloom-hub-auth', persistSession: true, autoRefreshToken: true }
});

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(()=>{ t.style.display='none'; }, 3000);
}

function genCode(len=6){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function nextStudentIdCode(existingCodes){
  const yy = String(new Date().getFullYear()).slice(-2);
  let n = 1;
  const prefix = `BMS${yy}`;
  const nums = existingCodes
    .filter(c => c && c.startsWith(prefix))
    .map(c => parseInt(c.slice(prefix.length),10))
    .filter(x => !isNaN(x));
  if(nums.length) n = Math.max(...nums) + 1;
  return prefix + String(n).padStart(3,'0');
}

// ---- Sidebar shell (persistent left nav across all staff pages) ----

// The staff sidebar is a launcher: one link per system. A system with several sections
// (Students, Staff) swaps the sidebar for its own menu, with a way back to the dashboard.
const NAV_ITEMS = [
  // S27 (10 Nov): three headings, School, Operations and Admin; a heading shows only when someone can open a link under it
  { key: 'dashboard', label: 'Dashboard', href: 'staff-dashboard.html' },
  { key: 'students', label: 'Students', href: 'staff-admissions.html', module: 'students', group: 'School' },
  { key: 'calendar', label: 'School calendar', href: 'staff-calendar.html', module: 'calendar', group: 'School' },
  { key: 'library', label: 'Bloombrary', href: 'https://bloombrary.learn2bloom.org/admin', module: 'library', external: true, group: 'School' },
  { key: 'marketing', label: 'Marketing HQ', href: 'staff-marketing.html', module: 'marketing', group: 'Operations' },
  { key: 'backoffice', label: 'Back office', href: 'backoffice/', module: 'backoffice', group: 'Operations' },
  { key: 'staff', label: 'Staff', href: 'staff-team.html', group: 'Admin' },
  { key: 'admin', label: 'Access and settings', href: 'staff-permissions.html#roles', adminOnly: true, group: 'Admin' }
];
const SYSTEMS = {
  students: { label: 'Students', pages: ['admissions','learners','archive','absences'], groups: [
    { name: 'Admissions', items: [
      { key: 'new', label: 'Enquiries', href: 'staff-admissions.html#new', page: 'admissions', hash: 'new', def: true },
      { key: 'progress', label: 'In progress', href: 'staff-admissions.html#progress', page: 'admissions', hash: 'progress' },
      { key: 'withdrawn', label: 'Withdrawn', href: 'staff-admissions.html#withdrawn', page: 'admissions', hash: 'withdrawn' } ] },
    { name: 'Learners', items: [
      { key: 'enrolled', label: 'Enrolled', href: 'learners.html', page: 'learners' },
      { key: 'absences', label: 'Student absences', href: 'student-absences.html', page: 'absences' },
      { key: 'archived', label: 'Archived', href: 'archive.html', page: 'archive' } ] } ] },
  staff: { label: 'Staff', pages: ['team','staff-archive'], groups: [
    { name: '', items: [
      { key: 'directory', label: 'Staff directory', href: 'staff-team.html', page: 'team' },
      { key: 'archived-staff', label: 'Archived staff', href: 'staff-archive.html', page: 'staff-archive', adminOnly: true } ] } ] },
  // S16: admin tools have their own place, for admin, director and IT.
  admin: { label: 'Access and settings', pages: ['permissions'], groups: [
    { name: '', adminOnly: true, items: [
      { key: 'roles', label: 'Roles and access', href: 'staff-permissions.html#roles', page: 'permissions', hash: 'roles', def: true },
      { key: 'approvals', label: 'Change requests', href: 'staff-permissions.html#approvals', page: 'permissions', hash: 'approvals' },
      { key: 'features', label: 'Site features', href: 'staff-permissions.html#features', page: 'permissions', hash: 'features' } ] } ] }
};
const systemOf = page => Object.keys(SYSTEMS).find(k => SYSTEMS[k].pages.includes(page));
function sysItemOn(item, page){
  if(item.page !== page) return false;
  if(!item.hash) return true;
  const h = location.hash.slice(1);
  const sys = SYSTEMS[systemOf(page)], hashes = sys.groups.flatMap(g => g.items).filter(i => i.page === page && i.hash).map(i => i.hash);
  return hashes.includes(h) ? h === item.hash : !!item.def;
}
// Pages call these to keep the menu in step: setSysActive() after changing their hash, setSysCount(key, n) for a count.
function setSysActive(){
  const page = window.STAFF_PAGE_KEY || '', sys = SYSTEMS[systemOf(page)]; if(!sys) return;
  sys.groups.flatMap(g => g.items).forEach(i => { const a = document.querySelector(`.sys-link[data-k="${i.key}"]`); if(a) a.classList.toggle('active', sysItemOn(i, page)); });
}
// S26: counts next to the main links, from the dashboard's "Waiting on you" lines (kept for this browser tab)
const NAV_TAG_KEY = { 'Admissions':'students', 'Learners':'students', 'School calendar':'calendar', 'Calendar':'calendar', 'Back office':'backoffice', 'Timesheets':'backoffice', 'Marketing HQ':'marketing', 'Access and settings':'admin', 'Admin':'admin' };
function applyNavCounts(c){ ['students','calendar','marketing','backoffice','admin'].forEach(k => setSysCount(k, c[k] || 0)); }
function setNavCounts(lines){
  const c = {}; (lines || []).forEach(l => { const k = NAV_TAG_KEY[l.tag]; if(k) c[k] = (c[k] || 0) + 1; });
  try{ sessionStorage.setItem('bloomNavCounts', JSON.stringify(c)); }catch(e){}
  applyNavCounts(c);
}
async function refreshNavCounts(){
  try{
    if(typeof collectTodos !== 'function'){
      await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'staff-todos.js'; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc); });
    }
    const res = await collectTodos();
    setNavCounts(res.flatMap(r => r.lines || []));
  }catch(e){ console.log('nav counts failed', e); }
}
function setSysCount(key, n){
  const el = document.querySelector(`.sys-link[data-k="${key}"] .sys-n`); if(!el) return;
  el.textContent = n ? n : ''; el.style.display = n ? '' : 'none';
}
async function loadStudentCounts(){
  try{
    const { data } = await sb.from('students').select('status');
    if(!data) return;
    const c = { new: 0, progress: 0, withdrawn: 0, enrolled: 0 };
    data.forEach(s => { if(s.status === 'enquiry') c.new++; else if(s.status === 'withdrawn') c.withdrawn++; else if(s.status === 'enrolled') c.enrolled++; else if(s.status !== 'archived') c.progress++; });
    const { count: abs } = await sb.from('bloom_absence_reports').select('id', { count: 'exact', head: true }).eq('status', 'new');
    c.absences = abs || 0;
    Object.entries(c).forEach(([k,n]) => setSysCount(k, n));
  }catch(e){}
}
// Archives are tabs inside their tool now: archive.html lights up Learners, staff-archive.html lights up Team.
const NAV_ALIASES = { 'archive': 'learners', 'staff-archive': 'team' };
const EXT_MARK = '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="margin-left:6px;vertical-align:-1px"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

// Tabs inside a tool page: <div data-page-tabs='[{"label":"Enrolled","href":"learners.html","on":true},{"label":"Archived","href":"archive.html"}]'></div>
// A tab with "adminOnly": true shows only to admin, director and IT.
function renderPageTabs(){
  const isAdminOrIt = window.currentStaffRole === 'admin' || window.currentStaffRole === 'director' || window.currentStaffRole === 'it';
  document.querySelectorAll('[data-page-tabs]').forEach(el => {
    let tabs = [];
    try { tabs = JSON.parse(el.getAttribute('data-page-tabs')); } catch(e){ return; }
    tabs = tabs.filter(t => !t.adminOnly || isAdminOrIt);
    if(tabs.length < 2){ el.style.display = 'none'; return; }
    el.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:0 0 20px;';
    el.innerHTML = tabs.map(t => `<a href="${t.href}" style="font-size:14px;font-weight:600;padding:8px 16px;border-radius:999px;text-decoration:none;${t.on ? 'background:#534AB7;color:#fff;border:1px solid #534AB7;' : 'background:#fff;color:#2C2C2A;border:1px solid #E8E3D8;'}">${t.label}</a>`).join('');
  });
}

function injectSidebarStyles(){
  if(document.getElementById('sidebar-shell-styles')) return;
  const style = document.createElement('style');
  style.id = 'sidebar-shell-styles';
  style.textContent = `
    body.has-sidebar{display:flex;min-height:100vh;}
    .sidebar{width:220px;flex-shrink:0;background:#F7F3EC;border-right:1px solid #E8E3D8;
      display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;z-index:50;}
    .co-switch{display:flex;align-items:center;gap:8px;margin:12px 16px 0;padding:6px 10px;border:1px solid #e5e2da;border-radius:8px;font-size:12px;font-weight:600;color:#2C2C2A;text-decoration:none;background:#fff}
    .co-switch:hover{border-color:#b4b2a9}
    .co-dot{width:9px;height:9px;border-radius:50%;background:#1D9E75;flex:0 0 auto}
    .sidebar-logo{font-family:Georgia,serif;font-size:19px;font-weight:700;color:#2C2C2A;
      padding:22px 12px 18px 24px;white-space:nowrap;text-decoration:none;border-bottom:1px solid #E8E3D8;display:block;}
    .sidebar-nav{flex:1;padding:16px 12px;}
    .sidebar-group{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;
      color:#A8A39A;margin:16px 12px 6px;}
    .sidebar-group:first-child{margin-top:0;}
    .main-group{margin-top:18px;}
    .sidebar-link{display:block;font-size:14px;font-weight:600;color:#5F5E5A;padding:9px 12px;
      border-radius:8px;text-decoration:none;margin-bottom:2px;}
    .sidebar-link:hover{background:#EFEAE0;}
    .sidebar-link.active{background:#534AB7;color:#fff;}
    .sys-logo{border-bottom:none !important;padding-bottom:4px !important;}
    .sys-head{padding:0 24px 14px;border-bottom:1px solid #E8E3D8;}
    .sys-app{font-size:13px;font-weight:600;color:#534AB7;margin-bottom:8px;}
    .sys-back{font-size:13px;font-weight:600;color:#534AB7;text-decoration:none;}
    .sys-back:hover{text-decoration:underline;}
    .sys-link{display:flex !important;align-items:center;justify-content:space-between;}
    .sys-n{font-size:11px;font-weight:700;color:#fff;background:#534AB7;border-radius:999px;padding:1px 8px;margin-left:8px;}
    .sidebar-link.active .sys-n{background:#fff;color:#534AB7;}
    .sidebar-footer{border-top:1px solid #E8E3D8;padding:14px 24px;font-size:12px;}
    .sidebar-sep{border-top:1px solid #E8E3D8;margin:10px 12px;}
    .sidebar-footer .name{font-weight:700;color:#2C2C2A;font-size:13px;}
    .sidebar-footer .role{color:#888780;margin-bottom:8px;}
    .sidebar-footer .signout{color:#888780;cursor:pointer;text-decoration:underline;}
    .page-content{margin-left:220px;flex:1;min-width:0;}
    @media (max-width: 768px) {
      body.has-sidebar{display:block;}
      .sidebar{position:static;width:100%;height:auto;border-right:none;border-bottom:1px solid #E8E3D8;}
      .sidebar-nav{display:flex;flex-wrap:wrap;padding:10px 12px;}
      .sidebar-group{display:none;}
      .sidebar-sep{display:none;}
      .sidebar-link{margin-right:4px;padding:7px 10px;}
      .page-content{margin-left:0;}
    }
  `;
  document.head.appendChild(style);
}

// Group login: linked staff open the INGROUP ASIA back office with a one-time 60-second pass
async function goIGA(){
  let pass = '';
  try { const { data } = await sb.rpc('hub_pass_create'); if (typeof data === 'string') pass = data; } catch(e) {}
  location.href = 'https://iga-backoffice.netlify.app/#/home' + (pass ? '?hub=' + pass : '');
}
function renderSidebar(activeKey){
  injectSidebarStyles();
  document.body.classList.add('has-sidebar');

  const isAdminOrIt = window.currentStaffRole === 'admin' || window.currentStaffRole === 'director' || window.currentStaffRole === 'it';
  const sysKey = systemOf(activeKey), sys = SYSTEMS[sysKey];
  let head = '', navHtml = '';
  if(sys){
    head = `<div class="sys-head"><div class="sys-app">${sys.label}</div><a class="sys-back" href="staff-dashboard.html">&#8249; Staff dashboard</a></div>`;
    navHtml = sys.groups.filter(g => !g.adminOnly || isAdminOrIt).map(g => {
      const items = g.items.filter(i => !i.adminOnly || isAdminOrIt);
      if(!items.length) return '';
      return (g.name ? `<div class="sidebar-group">${g.name}</div>` : '') + items.map(i =>
        `<a href="${i.page === activeKey && i.hash ? '#' + i.hash : i.href}" data-k="${i.key}" class="sidebar-link sys-link ${sysItemOn(i, activeKey) ? 'active' : ''}">${i.label}<span class="sys-n" style="display:none"></span></a>`).join('');
    }).join('');
  } else {
    // S27: headings School, Operations, Admin (shown only above links this person can open); counts come from staff-todos.js
    let lastGroup = null;
    navHtml = NAV_ITEMS.filter(item => !(item.module && !canAccess(item.module, 'view')) && (!item.adminOnly || isAdminOrIt)).map(item => {
      const head = item.group && item.group !== lastGroup ? `<div class="sidebar-group main-group">${item.group}</div>` : '';
      lastGroup = item.group || null;
      return head +
      `<a href="${item.href}" data-k="${item.key}" class="sidebar-link sys-link ${item.key === activeKey ? 'active' : ''}"${item.external ? ' target="_blank" rel="noopener"' : ''}><span>${item.label}${item.external ? EXT_MARK : ''}</span><span class="sys-n" style="display:none"></span></a>`;
    }).join('');
  }

  const el = document.createElement('div');
  el.className = 'sidebar';
  el.innerHTML = `
    <a href="staff-dashboard.html" class="sidebar-logo${sys ? ' sys-logo' : ''}">Bloom Chiangmai</a>
    ${window.currentStaff?.hub_id ? `<a href="https://iga-backoffice.netlify.app/" class="co-switch" onclick="event.preventDefault(); goIGA()"><span class="co-dot"></span>Switch to INGROUP ASIA</a>` : ''}
    ${head}
    <div class="sidebar-nav">${navHtml}</div>
    <div class="sidebar-footer">
      <div class="name">${window.currentStaff ? escShared(window.currentStaff.name) : ''}</div>
      <div class="role">${escShared((window.currentStaffRole === 'admin' && window.currentStaff?.job_title && window.currentStaff.job_title !== 'Admin') ? window.currentStaff.job_title : roleLabelShared(window.currentStaffRole))}</div>
      <span class="signout" onclick="doLogout()">Sign out</span>
    </div>
  `;
  document.body.insertBefore(el, document.body.firstChild);
  if(!sys){ try{ applyNavCounts(JSON.parse(sessionStorage.getItem('bloomNavCounts') || '{}')); }catch(e){} }
  // Other pages with the main menu work the counts out fresh (the dashboard does it itself)
  if(!sys && !['dashboard','marketing'].includes(activeKey)) refreshNavCounts();
  if(sys){
    window.addEventListener('hashchange', setSysActive);
    if(sysKey === 'students') loadStudentCounts();
  }
}
function escShared(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function roleLabelShared(role){
  return {
    admin:'Admin', director:'Director', operations_manager:'Operations Manager', admissions:'Admissions', education_lead:'Education Lead',
    learning_coach:'Learning Coach', it:'IT', enrollment:'Enrollment', marketing:'Marketing'
  }[role] || role;
}

// ---- Auth ----

async function checkStaffAndInit(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session){
    window.location.href = 'staff-login.html?redirect=' + encodeURIComponent(window.location.pathname.split('/').pop());
    return;
  }
  const { data: staffRow } = await sb.from('staff').select('*').eq('auth_user_id', session.user.id).maybeSingle();
  if(!staffRow){
    await sb.auth.signOut();
    window.location.href = 'staff-login.html?error=not_staff';
    return;
  }

  window.currentStaff = staffRow;
  window.currentStaffRole = staffRow.role;
  await loadPermissions(staffRow);

  const loading = document.getElementById('authLoading');
  if(loading) loading.style.display = 'none';
  const content = document.getElementById('pageContent');
  if(content) content.style.display = 'block';

  renderSidebar(window.STAFF_PAGE_KEY || '');
  renderPageTabs();

  if(typeof loadStudents === 'function') loadStudents();
  if(typeof onStaffReady === 'function') onStaffReady(staffRow);
}

// ---- Permissions ----
// Loads the effective permission level for each module: per-staff override wins,
// otherwise falls back to the role's default from role_permissions.
window.currentPermissions = {};

async function loadPermissions(staffRow){
  const { data: roleDefaults } = await sb.from('role_permissions').select('*').eq('role', staffRow.role);
  const { data: overrides } = await sb.from('staff_permission_overrides').select('*').eq('staff_id', staffRow.id);

  const perms = {};
  (roleDefaults || []).forEach(r => {
    perms[r.module] = { level: r.level, requires_approval: r.requires_approval };
  });
  (overrides || []).forEach(o => {
    perms[o.module] = { level: o.level, requires_approval: (perms[o.module] && perms[o.module].requires_approval) || false };
  });
  window.currentPermissions = perms;
}

function canAccess(module, minLevel){
  const order = { none: 0, view: 1, edit: 2, full: 3 };
  const perm = window.currentPermissions[module];
  if(!perm) return false;
  return order[perm.level] >= order[minLevel];
}

function requiresApproval(module){
  const perm = window.currentPermissions[module];
  return !!(perm && perm.requires_approval);
}

// ---- Approval request helper ----
// Instead of writing directly, sensitive actions can route through this to
// create a pending approval_requests row for an admin/IT to review.
async function submitForApproval(module, actionType, entityTable, entityId, payload){
  const { error } = await sb.from('approval_requests').insert({
    module, action_type: actionType, entity_table: entityTable,
    entity_id: entityId, payload, requested_by: window.currentStaff.id
  });
  return { error };
}

async function doLogin(){
  const staffIdCode = document.getElementById('loginStaffId').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if(!staffIdCode || !password){ errEl.textContent = 'Enter your Staff ID and password.'; return; }

  // Sign-in happens on the server, so the page never learns which email belongs to a Staff ID.
  let res, out;
  try {
    res = await fetch('https://ndlcfgkhxjoancdvmgmr.supabase.co/functions/v1/id-sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'staff', id: staffIdCode, password })
    });
    out = await res.json();
  } catch (e) {
    errEl.textContent = 'Network error: ' + e.message;
    return;
  }
  if(!res.ok || !out.access_token){
    errEl.textContent = out.error || 'Incorrect Staff ID or password.';
    return;
  }
  const { error } = await sb.auth.setSession({ access_token: out.access_token, refresh_token: out.refresh_token });
  if(error){ errEl.textContent = error.message; return; }

  const { data: { session } } = await sb.auth.getSession();
  const { data: staffRow } = await sb.from('staff').select('id').eq('auth_user_id', session.user.id).maybeSingle();
  if(!staffRow){
    errEl.textContent = 'This account is not registered as staff.';
    await sb.auth.signOut();
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const redirect = params.get('redirect');
  window.location.href = (redirect && redirect !== 'staff-login.html') ? redirect : 'staff-dashboard.html';
}

async function doLogout(){
  await sb.auth.signOut();
  checkStaffAndInit();
}

// ---- Delete / archive confirmation flow ----
// Requires the page to define loadStudents(), and to have the
// #deleteModal / #deleteModalSub / #deleteMatchLabel / #deleteConfirmInput /
// #confirmDeleteBtn elements in the page HTML.

let pendingDeleteId = null;
let pendingDeleteMatch = null;

function archiveStudent(studentId, label){
  const cleanLabel = (label || '').trim() || 'DELETE';
  pendingDeleteId = studentId;
  pendingDeleteMatch = cleanLabel;
  document.getElementById('deleteModalSub').textContent = cleanLabel;
  document.getElementById('deleteMatchLabel').textContent = pendingDeleteMatch;
  document.getElementById('deleteConfirmInput').value = '';
  document.getElementById('confirmDeleteBtn').style.opacity = '.5';
  document.getElementById('confirmDeleteBtn').style.pointerEvents = 'none';
  document.getElementById('deleteModal').classList.add('open');
}

function checkDeleteMatch(){
  const val = document.getElementById('deleteConfirmInput').value.trim();
  const btn = document.getElementById('confirmDeleteBtn');
  const matches = val === pendingDeleteMatch;
  btn.style.opacity = matches ? '1' : '.5';
  btn.style.pointerEvents = matches ? 'auto' : 'none';
}

function closeDeleteModal(){
  document.getElementById('deleteModal').classList.remove('open');
  pendingDeleteId = null;
  pendingDeleteMatch = null;
}

async function confirmDelete(){
  if(!pendingDeleteId) return;

  if(!canAccess('students', 'edit')){
    showToast('You do not have permission to archive learners.');
    closeDeleteModal();
    return;
  }

  if(requiresApproval('students')){
    const { error } = await submitForApproval('students', 'delete', 'students', pendingDeleteId, {
      student_id: pendingDeleteId, requested_action: 'archive'
    });
    if(error){ showToast('Error submitting for approval: ' + error.message); return; }
    showToast('Submitted for approval — an admin will review this archive request.');
    closeDeleteModal();
    return;
  }

  // Remember their current status so Restore can send them back to it later
  const { data: current } = await sb.from('students').select('status').eq('id', pendingDeleteId).maybeSingle();
  const priorStatus = current ? current.status : 'enquiry';

  const { error } = await sb.from('students').update({ status: 'archived', previous_status: priorStatus }).eq('id', pendingDeleteId);
  if(error){ showToast('Error archiving: ' + error.message); return; }
  showToast('Archived');
  closeDeleteModal();
  loadStudents();
}
