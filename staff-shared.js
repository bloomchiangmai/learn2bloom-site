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

// ---- Auth ----

async function checkStaffAndInit(){
  const { data: { session } } = await sb.auth.getSession();
  document.getElementById('authLoading').style.display = 'none';
  if(!session){
    document.getElementById('loginView').style.display = 'block';
    document.getElementById('adminView').style.display = 'none';
    return;
  }
  const { data: staffRow } = await sb.from('staff').select('*').eq('auth_user_id', session.user.id).maybeSingle();
  if(!staffRow){
    document.getElementById('loginError').textContent = 'This account is not registered as staff.';
    document.getElementById('loginView').style.display = 'block';
    document.getElementById('adminView').style.display = 'none';
    await sb.auth.signOut();
    return;
  }
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('adminView').style.display = 'block';

  window.currentStaff = staffRow;
  window.currentStaffRole = staffRow.role;
  await loadPermissions(staffRow);
  applyTeamTabVisibility();

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

function applyTeamTabVisibility(){
  const tab = document.getElementById('teamNavTab');
  if(tab){
    const isAdminOrIt = window.currentStaffRole === 'admin' || window.currentStaffRole === 'it';
    tab.style.display = isAdminOrIt ? '' : 'none';
  }
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
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if(!email || !password){ errEl.textContent = 'Enter email and password.'; return; }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if(error){ errEl.textContent = error.message; return; }
  checkStaffAndInit();
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
