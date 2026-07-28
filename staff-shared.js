// Shared by staff-admissions.html and learners.html
// Requires: window.supabase (Supabase JS loaded via CDN in each page)

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EzlLIeKJDqtMs0mKD0gfgA_C86iHZal';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: 'staff-dashboard.html', group: 'Home' },
  { key: 'admissions', label: 'Admissions', href: 'staff-admissions.html', group: 'Students' },
  { key: 'learners', label: 'Learners', href: 'learners.html', group: 'Students' },
  { key: 'archive', label: 'Archive', href: 'archive.html', group: 'Students' },
  { key: 'team', label: 'Team', href: 'staff-team.html', group: 'Staff' },
  { key: 'permissions', label: 'Permissions', href: 'staff-permissions.html', group: 'Staff', adminOnly: true }
];

function injectSidebarStyles(){
  if(document.getElementById('sidebar-shell-styles')) return;
  const style = document.createElement('style');
  style.id = 'sidebar-shell-styles';
  style.textContent = `
    body.has-sidebar{display:flex;min-height:100vh;}
    .sidebar{width:220px;flex-shrink:0;background:#F7F3EC;border-right:1px solid #E8E3D8;
      display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;z-index:50;}
    .sidebar-logo{font-family:Georgia,serif;font-size:19px;font-weight:700;color:#2C2C2A;
      padding:22px 20px 18px;text-decoration:none;border-bottom:1px solid #E8E3D8;display:block;}
    .sidebar-nav{flex:1;padding:16px 12px;}
    .sidebar-group{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;
      color:#A8A39A;margin:16px 8px 6px;}
    .sidebar-group:first-child{margin-top:0;}
    .sidebar-link{display:block;font-size:14px;font-weight:600;color:#5F5E5A;padding:9px 12px;
      border-radius:8px;text-decoration:none;margin-bottom:2px;}
    .sidebar-link:hover{background:#EFEAE0;}
    .sidebar-link.active{background:#534AB7;color:#fff;}
    .sidebar-footer{border-top:1px solid #E8E3D8;padding:14px 20px;font-size:12px;}
    .sidebar-footer .name{font-weight:700;color:#2C2C2A;font-size:13px;}
    .sidebar-footer .role{color:#888780;margin-bottom:8px;}
    .sidebar-footer .signout{color:#888780;cursor:pointer;text-decoration:underline;}
    .page-content{margin-left:220px;flex:1;min-width:0;}
    @media (max-width: 768px) {
      body.has-sidebar{display:block;}
      .sidebar{position:static;width:100%;height:auto;border-right:none;border-bottom:1px solid #E8E3D8;}
      .sidebar-nav{display:flex;flex-wrap:wrap;padding:10px 12px;}
      .sidebar-group{display:none;}
      .sidebar-link{margin-right:4px;padding:7px 10px;}
      .page-content{margin-left:0;}
    }
  `;
  document.head.appendChild(style);
}

function renderSidebar(activeKey){
  injectSidebarStyles();
  document.body.classList.add('has-sidebar');

  const isAdminOrIt = window.currentStaffRole === 'admin' || window.currentStaffRole === 'it';
  const groups = [];
  NAV_ITEMS.forEach(item => {
    if(item.adminOnly && !isAdminOrIt) return;
    let group = groups.find(g => g.name === item.group);
    if(!group){ group = { name: item.group, items: [] }; groups.push(group); }
    group.items.push(item);
  });

  const navHtml = groups.map(g => `
    <div class="sidebar-group">${g.name}</div>
    ${g.items.map(item => `
      <a href="${item.href}" class="sidebar-link ${item.key === activeKey ? 'active' : ''}">${item.label}</a>
    `).join('')}
  `).join('');

  const el = document.createElement('div');
  el.className = 'sidebar';
  el.innerHTML = `
    <a href="staff-dashboard.html" class="sidebar-logo">Bloom Chiangmai</a>
    <div class="sidebar-nav">${navHtml}</div>
    <div class="sidebar-footer">
      <div class="name">${window.currentStaff ? window.currentStaff.name : ''}</div>
      <div class="role">${roleLabelShared(window.currentStaffRole)}</div>
      <span class="signout" onclick="doLogout()">Sign out</span>
    </div>
  `;
  document.body.insertBefore(el, document.body.firstChild);
}

function roleLabelShared(role){
  return {
    admin:'Admin', admissions:'Admissions', education_lead:'Education Lead',
    learning_coach:'Learning Coach', it:'IT', enrollment:'Enrollment'
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

  let resolveRes;
  try {
    resolveRes = await fetch('https://ndlcfgkhxjoancdvmgmr.supabase.co/functions/v1/resolve-staff-login-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id_code: staffIdCode })
    });
  } catch (e) {
    errEl.textContent = 'Network error: ' + e.message;
    return;
  }
  const resolveData = await resolveRes.json();
  if(!resolveRes.ok){
    errEl.textContent = resolveData.error || 'Could not find that Staff ID.';
    return;
  }

  const { error } = await sb.auth.signInWithPassword({ email: resolveData.email, password });
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
