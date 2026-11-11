// Bloom Chiangmai back office (S23): staff expenses, receipts and approvals.
// Ported from the IGA back office. Data lives in Bloom's Supabase, schema "bo"; sign-in is the staff system's.
import { createClient } from './vendor/supabase.js'; // supabase-js 2.118.0, bundled locally

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EzlLIeKJDqtMs0mKD0gfgA_C86iHZal'; // publishable, safe in browser
// Same cookie session as the rest of the staff system (staff-shared.js)
const bloomHubCookieStorage = {
  getItem(key) { const m = document.cookie.match('(^|; )' + key.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '=([^;]*)'); return m ? decodeURIComponent(m[2]) : null; },
  setItem(key, value) { let c = key + '=' + encodeURIComponent(value) + '; Max-Age=' + (60 * 60 * 24 * 30) + '; Path=/; SameSite=Lax; Secure'; if (location.hostname.endsWith('learn2bloom.org')) c += '; Domain=.learn2bloom.org'; document.cookie = c; },
  removeItem(key) { let c = key + '=; Max-Age=0; Path=/; SameSite=Lax; Secure'; if (location.hostname.endsWith('learn2bloom.org')) c += '; Domain=.learn2bloom.org'; document.cookie = c; },
};
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: 'bo' }, auth: { storage: bloomHubCookieStorage, storageKey: 'bloom-hub-auth', persistSession: true, autoRefreshToken: true } });
// All 3 stages on: Expenses and Approvals, Time, Accounting.
const STAGE = 3;
const ORG = 'Bloom Chiangmai';
const BUCKET = 'bo-receipts';
const LOGIN = '/staff-login.html?redirect=' + encodeURIComponent('backoffice/');

const app = document.getElementById('app');
const S = { user: null, profile: null, categories: [], inboxCount: 0, pendingCount: 0 };

/* ---------- helpers ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => fmt.format(Number(n || 0));
const thb = (n) => `THB ${money(n)}`;
const staffEmail = (no) => `${no.toLowerCase()}@staff.ingroup.asia`;
const normStaffNo = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthStart = (key) => `${key}-01`;
const monthLabel = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const shiftMonth = (key, n) => { const d = new Date(`${key}-01T00:00:00`); d.setMonth(d.getMonth() + n); return monthKey(d); };
const dateLabel = (d) => d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const isAdmin = () => S.profile?.role === 'admin';
const isApprover = () => ['admin', 'approver'].includes(S.profile?.role);
// Access: role = staff / approver (office approver) / admin, plus ticks for accountant and data entry; PICs come from projects
const isAccountant = () => isAdmin() || !!S.profile?.is_accountant;
// BCM: who keeps a timesheet is a per-person switch (Settings › Timesheet), not the admin role
const keepsTS = () => !S.profile?.no_timesheet;
// S30: cash advances only for people an admin set to Yes (admins always); a form that already has one keeps showing it
const canAdv = (r) => isAdmin() || !!S.profile?.gets_advance || Number(r?.advance_topup || 0) > 0;
const seg = (attr, id, on, yes = 'Yes', no = 'No', dis = false) => `<span class="yn" role="group">${[[1, yes], [0, no]].map(([v, l]) => `<button type="button" class="${(v === 1) === !!on ? 'on' : ''}" ${attr}="${id}" data-v="${v}" ${dis ? 'disabled' : ''}>${l}</button>`).join('')}</span>`;
const seesTime = () => keepsTS() || isAdmin() || isHR() || isAccountant();
// BCM: the Operations Manager (back office role 'approver') gives final approval and pays forms up to MGR_LIMIT, never her own
const MGR_LIMIT = 10000;
const isMgr = () => S.profile?.role === 'approver';
const withinMgr = (r) => !!r && r.staff_id !== S.user?.id && !(S.overLimit || new Set()).has(r.id);
const canFinal = (r) => isAdmin() || (isMgr() && (!r || withinMgr(r)));
const canPay = (r) => isAdmin() || (isMgr() && (!r || withinMgr(r)));
// Forms over the limit (Operations Manager only)
async function loadOverLimit() {
  if (!isMgr()) return;
  const { data: rs } = await sb.from('expense_reports').select('id').in('status', ['submitted', 'checked', 'approved']);
  const ids = (rs || []).map((r) => r.id);
  const { data } = ids.length ? await sb.from('expense_report_totals').select('report_id, total_spent').in('report_id', ids) : { data: [] };
  S.overLimit = new Set((data || []).filter((t) => Number(t.total_spent) > MGR_LIMIT).map((t) => t.report_id));
}
const isDataEntry = () => !!S.profile?.is_data_entry;
const isHR = () => !!S.profile?.is_hr;
const canFA = () => isAdmin() || isDataEntry(); // FlowAccount lists (Settings)
const canEnterFA = () => isAdmin() || isDataEntry(); // Month close: admin and data entry
const isPic = () => (S.myPics || []).length > 0;
const isReviewer = () => true; // anyone can be picked to check a form
// Step 1 (check): the person the sender picked (BCM); never the owner
const canCheck = (r) => r.staff_id !== S.user?.id && r.checker_id === S.user?.id;
// What needs this person: step 1 / final approval, paying (accountant), entering in FlowAccount (data entry)
const myTodo = (r) => canActOn(r) || (canPay(r) && r.status === 'approved') || (isDataEntry() && ['approved', 'paid'].includes(r.status) && !r.fa_entered_at);
const todoHint = () => ['check forms you are picked for (step 1)', isAdmin() ? 'give final approval' : isMgr() ? `give final approval up to ${MGR_LIMIT.toLocaleString('en-US')} THB` : '', isAdmin() ? 'pay approved forms' : isMgr() ? `pay them (not your own)` : '', isDataEntry() ? 'enter approved forms in FlowAccount' : ''].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) + '.';
// Step 1 first, admin included: the PIC (project) or an office approver (Petty Cash). Admin skips it only when nobody else can check
const canActOn = (r) => r.staff_id !== S.user?.id && ((r.status === 'submitted' && canCheck(r)) || (r.status === 'checked' && canFinal(r) && r.checked_by !== S.user?.id));
// BCM: the sender picks who checks each form. "No checker" sends it straight to an admin.
const noChkKey = (id) => 'bo_nochk_' + id;
const chkChosen = (r) => !!r.checker_id || (() => { try { return !!sessionStorage.getItem(noChkKey(r.id)); } catch { return false; } })();
const firstName = (n) => String(n || '').trim().split(/\s+/)[0];
// Short name for chips: first name, plus the last initial when 2 people share a first name (Paul, Paul P.)
const chipName = (p) => { const f = firstName(p.full_name), parts = String(p.full_name || '').trim().split(/\s+/); const twin = (S.people || []).filter((x) => firstName(x.full_name) === f).length > 1; return twin && parts.length > 1 ? `${f} ${parts[parts.length - 1][0]}.` : f; };
function checkerPicker(r) {
  const ppl = (S.people || []).filter((p) => p.id !== S.user.id);
  const none = !r.checker_id && chkChosen(r);
  return `<div class="field"><label>Who checks this form?</label><div class="chkpick">${ppl.map((p) => `<button type="button" class="chkchip${r.checker_id === p.id ? ' on' : ''}" data-chk="${p.id}" title="${esc(p.full_name)}">${esc(chipName(p))}</button>`).join('')}<button type="button" class="chkchip${none ? ' on' : ''}" data-chk="none">No checker, send to admin</button></div>
  <span class="faint" style="font-size:12px">${r.checker_id ? `${esc(firstName(r.checker_name))} checks it first, then an admin gives the final approval and pays.` : none ? 'It goes straight to an admin for final approval.' : 'Pick one person. They check it first, then an admin gives the final approval and pays.'}</span></div>`;
}
function wireChecker(root, r, after) {
  root.querySelectorAll('[data-chk]').forEach((b) => (b.onclick = async () => {
    const v = b.dataset.chk;
    try { if (v === 'none') sessionStorage.setItem(noChkKey(r.id), '1'); else sessionStorage.removeItem(noChkKey(r.id)); } catch { /* ignore */ }
    try { await run(async () => must(await sb.from('expense_reports').update({ checker_id: v === 'none' ? null : v }).eq('id', r.id))); } catch { return; }
    after();
  }));
}
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const isTouch = () => matchMedia('(pointer: coarse)').matches || isPhone();
const PAY = { cash_advance: 'Petty cash', company_card: 'Company card', kbiz: 'KBIZ', own_money: 'Personal (own money)' };
// Document types from the accounting handbook (what FlowAccount needs to know)
const MILE_RATE = 10;
const MILE_RE = /^Mileage: (.*) → (.*), ([\d.]+) km$/;
const DOCT = { tax_invoice: 'Tax invoice', receipt: 'Receipt', cash_bill: 'Cash bill (บิลเงินสด)', voucher: 'Receipt voucher (ใบสำคัญรับเงิน)', receipt_form: 'Receipt form (ใบรับรองแทนใบเสร็จ)', online: 'Online order screenshot' };
const STATUS_TEXT = { draft: 'Draft', submitted: 'Submitted', checked: 'Checked, waiting final', approved: 'Approved', rejected: 'Returned', paid: 'Paid' };
const pill = (s) => `<span class="pill ${esc(s)}">${esc(STATUS_TEXT[s] || s)}</span>`;
// Reference exchange rate (THB per 1 unit) for a date. Source: frankfurter.dev (European Central Bank reference rates).
const fxCache = {};
async function fxRate(cur, date) {
  cur = String(cur || '').toUpperCase(); if (!cur || cur === 'THB' || !date) return null;
  const k = cur + date; if (k in fxCache) return fxCache[k];
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${encodeURIComponent(cur)}&symbols=THB`);
    const j = await r.json(); fxCache[k] = Number(j?.rates?.THB) || null;
  } catch { fxCache[k] = null; }
  return fxCache[k];
}
const fxNote = (i) => (i.currency && i.currency !== 'THB' && i.original_amount ? `${esc(i.currency)} ${money(i.original_amount)}${i.exchange_rate ? ' @ ' + Number(i.exchange_rate).toFixed(4) : ''}` : '');
// "Ugreen charger" + "Ugreen" -> "Ugreen charger", not "Ugreen charger, Ugreen"
const joinItem = (what, shop) => { what = String(what || '').trim(); shop = String(shop || '').trim(); return (shop && !what.toLowerCase().includes(shop.toLowerCase()) ? [what, shop].filter(Boolean).join(', ') : what || shop).slice(0, 60); };
// Where each category is offered is set with the ticks on Settings › Categories
const catFor = (form, keepId) => S.categories.filter((c) => c.id === keepId || (c.active && (form?.form_type === 'project' ? c.on_project : c.on_petty)));
const catName = (id) => S.categories.find((c) => c.id === id)?.name || '';

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2800);
}
let undoTimer;
function toastUndo(msg, rowIds, after) {
  const t = document.getElementById('toast');
  t.className = ''; t.hidden = false;
  t.innerHTML = `${esc(msg)} <button class="btn small" id="undo" style="margin-left:10px;background:#fff;color:var(--ink)">Undo</button>`;
  clearTimeout(toastTimer); clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (t.hidden = true), 10000);
  document.getElementById('undo').onclick = async () => {
    t.hidden = true;
    const { error } = await sb.rpc('restore_deleted', { p_row_ids: rowIds });
    if (error) return toast(friendly(error), true);
    toast('Restored'); await refreshCounts(); after && after();
  };
}
function friendly(err) {
  const m = err?.message || String(err || 'Something went wrong');
  return m.replace(/^.*?ERROR:\s*/, '');
}
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.error(e); toast(friendly(e), true); throw e; }
}
const must = ({ data, error }) => { if (error) throw error; return data; };

/* ---------- receipt files ---------- */
const urlCache = new Map();
async function signedUrl(path) {
  if (!path) return null;
  const hit = urlCache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) return null;
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}
async function compress(file) {
  if (!file.type.startsWith('image/') || /hei[cf]/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
async function fileHash(file) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function uploadReceipt(file, { itemId = null, reportId = null, via = 'desktop' } = {}) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB`);
  const hash = await fileHash(file);
  const { data: dup } = await sb.from('receipts').select('created_at').eq('staff_id', S.user.id).eq('file_hash', hash).maybeSingle();
  if (dup) throw new Error(`Duplicate: this exact receipt was already uploaded on ${dateLabel(dup.created_at)}. Skipped.`);
  const f = await compress(file);
  const ext = (f.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${S.user.id}/${crypto.randomUUID()}.${ext}`;
  must(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream' }));
  return must(await sb.from('receipts').insert({
    staff_id: S.user.id, item_id: itemId, report_id: reportId, storage_path: path, file_name: file.name, mime_type: f.type, captured_via: via,
    ai_status: itemId ? 'off' : 'pending', file_hash: hash,
  }).select().single());
}
// Ask the server to read the receipt. When it can, it creates the expense line itself.
async function readReceipt(id) {
  const { data, error } = await sb.functions.invoke('bo-read-receipt', { body: { receipt_id: id } });
  if (error) return { status: 'failed' };
  return data || { status: 'failed' };
}
// Cut a multi-receipt photo into 1 image per receipt, using the positions found when reading
async function autoSplit(storagePath, results) {
  const withBox = results.filter((x) => Array.isArray(x.data?.box) && x.data.box.length === 4 && x.receipt_id);
  if (withBox.length < 2) return 0;
  const url = await signedUrl(storagePath);
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  let done = 0;
  for (const x of withBox) {
    let [l, t, r, b] = x.data.box.map(Number);
    if (![l, t, r, b].every(Number.isFinite) || r <= l || b <= t) continue;
    // small margin so edges of the receipt are not cut off
    const padX = (r - l) * 0.04, padY = (b - t) * 0.03;
    l = Math.max(0, l - padX); t = Math.max(0, t - padY); r = Math.min(1, r + padX); b = Math.min(1, b + padY);
    const sx = Math.round(l * bmp.width), sy = Math.round(t * bmp.height), sw = Math.round((r - l) * bmp.width), sh = Math.round((b - t) * bmp.height);
    if (sw < 40 || sh < 40) continue;
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
    const path = `${S.user.id}/${crypto.randomUUID()}.jpg`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
    if (up.error) continue;
    const { error } = await sb.from('receipts').update({ storage_path: path, mime_type: 'image/jpeg', rotation: 0, file_name: `receipt-${x.data.part?.split(' ')[0] || done + 1}.jpg` }).eq('id', x.receipt_id);
    if (!error) done++;
  }
  // Remove the full photo if no receipt uses it any more
  const { count } = await sb.from('receipts').select('id', { count: 'exact', head: true }).eq('storage_path', storagePath);
  if (!count) await sb.storage.from(BUCKET).remove([storagePath]);
  return done;
}
// Upload, then read. Returns a short human summary.
async function snapAndRead(file, report, via) {
  const r = await uploadReceipt(file, { reportId: report?.id || null, via });
  const res = await readReceipt(r.id);
  const ids = [res.item_id, ...(res.results || []).map((x) => x.item_id)].filter(Boolean);
  const out = await snapSummary(res, r);
  out.itemIds = ids;
  return out;
}
async function snapSummary(res, r) {
  if (res.status === 'done' && (res.count || 1) > 1) {
    try { res.split = await autoSplit(r.storage_path, res.results || []); } catch { res.split = 0; }
  }
  if (res.status === 'done' && (res.count || 1) > 1) {
    const filed = (res.results || []).filter((x) => x.item_id);
    const lines = filed.map((x) => `${catName(x.data.category_id)} · THB ${money(x.data.total_amount)}${x.data.merchant ? ' · ' + x.data.merchant : ''}`);
    const heldN = res.count - filed.length;
    return { ok: true, html: `<b>Found ${res.count} receipts in this photo${res.split ? `, cut into ${res.split} separate images` : ''}. Added ${filed.length}.</b>${lines.length ? '<br>' + lines.map((l, k) => `${k + 1}. ${esc(l)}`).join('<br>') : ''}${heldN ? `<br><b>${heldN} held in Needs attention</b> (possible duplicate or unclear). Decide on your computer.` : ''}` };
  }
  if (res.status === 'done' && res.item_id) {
    const d = res.data || {};
    return { ok: true, text: `Added: ${catName(d.category_id)} · THB ${money(d.total_amount)}${d.merchant ? ' · ' + d.merchant : ''}` };
  }
  if (res.status === 'done') {
    const h = res.data?.held_reason;
    if (h === 'duplicate') return { ok: true, text: 'Held: this looks like a receipt you already added (same store, date, time and amount). Check it in Needs attention.' };
    return { ok: true, text: 'Held in Needs attention: some details are unclear. Finish it on your computer.' };
  }
  if (res.status === 'off') return { ok: true, text: 'Saved to your inbox.' };
  return { ok: true, text: 'Saved, but it could not be read automatically. Finish it on your computer.' };
}
async function thumbHtml(r, cls = 'thumb') {
  const url = await signedUrl(r.storage_path);
  if (r.mime_type?.startsWith('image/') && !/hei[cf]/.test(r.mime_type) && url) {
    return `<div class="${cls}" data-view="${esc(r.storage_path)}" data-mime="${esc(r.mime_type)}" data-rot="${r.rotation || 0}" style="background-image:url('${esc(url)}');transform:rotate(${r.rotation || 0}deg)"></div>`;
  }
  return `<div class="${cls}" data-view="${esc(r.storage_path)}" data-mime="${esc(r.mime_type)}">${r.mime_type === 'application/pdf' ? 'PDF' : 'FILE'}</div>`;
}
const rotCls = (deg) => (deg === 90 || deg === 270 ? ' rot-side' : '');
async function openViewer(path, mime, rot = 0) {
  const url = await signedUrl(path);
  if (!url) return toast('Could not open file', true);
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = mime?.startsWith('image/') && !/hei[cf]/.test(mime) ? `<img class="${rotCls(rot)}" src="${esc(url)}" alt="Receipt" style="transform:rotate(${rot}deg)">` : `<iframe src="${esc(url)}" title="Receipt"></iframe>`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tog]');
  if (t) { const body = t.nextElementSibling, open = body.hidden; document.querySelectorAll('.ln-body').forEach((b) => { b.hidden = true; b.parentElement.classList.remove('open'); }); body.hidden = !open; t.parentElement.classList.toggle('open', open); if (open) body.querySelector('input, select')?.focus({ preventScroll: true }); return; }
  const v = e.target.closest('[data-view]');
  if (v && !v.closest('.inbox-item') && !v.closest('.tile') && !v.closest('.line-thumbs')) { e.stopPropagation(); openViewer(v.dataset.view, v.dataset.mime, Number(v.dataset.rot || 0)); }
});

/* ---------- auth ---------- */
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  S.user = session?.user || null;
  if (!S.user) { S.profile = null; return; }
  const { data: p } = await sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle();
  S.profile = p;
  if (!p || !p.active) { S.noAccess = true; S.profile = null; return; }
  S.categories = must(await sb.from('expense_categories').select('*').order('sort_order'));
  loadFAVendors();
  S.myPics = ((await sb.from('project_pics').select('project_id').eq('staff_id', S.user.id)).data || []).map((x) => x.project_id);
  S.picProjects = new Set(((await sb.from('project_pics').select('project_id')).data || []).map((x) => x.project_id));
  S.approverIds = [];
  S.people = must(await sb.from('profiles').select('id, full_name, staff_no').eq('active', true).order('full_name'));
  await refreshCounts();
}
async function refreshCounts() {
  if (!S.user) return;
  // Counts belong to the form being worked on (each form only sees its own receipts)
  let fid = null; try { fid = sessionStorage.getItem('bo_form'); } catch { /* ignore */ }
  let q = sb.from('receipts').select('id', { count: 'exact', head: true }).eq('staff_id', S.user.id).is('item_id', null);
  if (fid) q = q.or(`report_id.eq.${fid},report_id.is.null`);
  const { count } = await q;
  S.inboxCount = count || 0;
  let q2 = sb.from('expense_items').select('id, expense_reports!inner(staff_id)', { count: 'exact', head: true })
    .eq('needs_review', true).eq('expense_reports.staff_id', S.user.id);
  if (fid) q2 = q2.eq('report_id', fid);
  const { count: rv } = await q2;
  S.reviewCount = rv || 0;
  { const { count: m } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null); S.msgCount = m || 0; }
  {
    const { count: c2 } = await sb.from('expense_reports').select('id', { count: 'exact', head: true }).eq('status', 'submitted').eq('checker_id', S.user.id);
    S.pendingCount = c2 || 0;
  }
  if (isPhone()) await phoneCount();
}

function renderLogin() { location.href = LOGIN; }
function renderNoAccess() {
  app.innerHTML = `<div class="login"><div class="card"><h1>${ORG}</h1><p>Back office</p><div class="banner info">Your account does not have back office access. Ask an admin to set it in Admin › Roles and access.</div><p style="margin:16px 0 0"><a href="/staff-dashboard.html">‹ Staff dashboard</a></p></div></div>`;
}
function renderForgot(no0 = '') {
  app.innerHTML = `<div class="login"><div class="card"><h1>${ORG}</h1><p>Reset your password</p>
    <form id="ff"><div class="field"><label for="fno">Staff number</label><input class="input" id="fno" placeholder="IGASTF001" autocapitalize="characters" value="${esc(no0)}" required></div>
    <div class="faint" style="font-size:13px;margin:0 0 12px">We email a link to the address registered for this staff number.</div>
    <div class="error" id="ferr"></div><button class="btn primary" type="submit">Send reset link</button></form>
    <p class="faint" style="margin:18px 0 0;font-size:12px"><a href="#" id="fback">‹ Back to sign in</a></p></div></div>`;
  document.getElementById('fback').onclick = (e) => { e.preventDefault(); renderLogin(); };
  const f = document.getElementById('ff');
  f.onsubmit = async (e) => {
    e.preventDefault(); const no = normStaffNo(f.fno.value); const b = f.querySelector('button'); b.disabled = true;
    const { data, error } = await sb.functions.invoke('reset-request', { body: { staff_no: no } });
    b.disabled = false;
    if (error) { document.getElementById('ferr').textContent = 'Could not send right now. Try again in a minute.'; return; }
    if (data && data.setup === false) { document.getElementById('ferr').textContent = 'Email reset is not switched on yet. Ask the office to reset it.'; return; }
    f.outerHTML = `<div class="banner info">If <b>${esc(no)}</b> has a registered email, a link is on its way. Open it within 1 hour to set a new password. Check spam if it does not arrive.</div>`;
  };
}

function renderChangePin(forced) {
  const inner = `
    <form id="pf" class="stack">
      ${forced ? '<div class="banner info">Please choose your own password before continuing.</div>' : ''}
      <div class="field"><label>New password (at least 8 characters)</label><input class="input" name="p1" type="password" autocomplete="new-password" required></div>
      <div class="field"><label>Repeat new password</label><input class="input" name="p2" type="password" autocomplete="new-password" required></div>
      <div class="error" id="perr"></div>
      <div class="row"><button class="btn primary">Save password</button>${forced ? '<button type="button" class="btn ghost" id="out">Sign out</button>' : ''}</div>
    </form>`;
  if (forced) {
    app.innerHTML = `<div class="login"><div class="card"><h1>${ORG}</h1><p>Set your password</p>${inner}</div></div>`;
    document.getElementById('out').onclick = signOut;
  }
  return { html: inner, bind: () => bindPinForm(forced) };
}
function bindPinForm(forced) {
  const f = document.getElementById('pf');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('perr');
    const p1 = f.p1.value, p2 = f.p2.value;
    if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
    if (/^(.)\1+$/.test(p1) || /^(12345678|password|igaiga)/i.test(p1)) { err.textContent = 'Please choose a less obvious password.'; return; }
    if (p1 !== p2) { err.textContent = 'The 2 passwords do not match.'; return; }
    const { error } = await sb.auth.updateUser({ password: p1, data: { must_change_pin: false } });
    if (error) { err.textContent = friendly(error); return; }
    toast('Password saved');
    if (forced) await start(); else f.reset();
  };
}
async function signOut() { await sb.auth.signOut(); S.user = null; S.profile = null; location.href = '/staff-login.html'; }

/* ---------- shell and router ---------- */
const SETTINGS = [['#/admin/access', 'Projects', () => isApprover()], ['#/admin/categories', 'Categories', () => isApprover()], ['#/admin/ot', 'Timesheet', () => STAGE >= 2 && (isAdmin() || isHR())], ['#/admin/cash', 'Cash advances', () => isAdmin()], ['#/fa-lists', 'FlowAccount', () => STAGE >= 3 && canFA()]];
function navLinks() {
  const r = (location.hash || '#/').split('?')[0];
  const L = (href, label, count, also = []) => `<a href="${href}" class="${[href, ...also].some((x) => r.startsWith(x)) ? 'on' : ''}">${label}${count ? `<span class="count">${count}</span>` : ''}</a>`;
  const sets = SETTINGS.filter((x) => x[2]());
  let h = `<div class="nav">
    ${L('#/home', 'Overview')}
    <div class="nav-label">Expenses</div>
    ${L('#/forms', 'Expense forms', S.reviewCount, ['#/expenses', '#/report', '#/print'])}
    ${L('#/capture', isTouch() ? 'Snap receipt' : 'Add receipts', S.inboxCount, ['#/inbox', '#/trash'])}
    ${STAGE < 2 || !seesTime() ? '' : `<div class="nav-label">Time</div>
    ${isAdmin() ? `${keepsTS() ? `<a href="#/ot?u=${S.user.id}" class="${r === '#/ot' && params().u === S.user.id ? 'on' : ''}">My timesheet</a>` : ''}<a href="#/ot" class="${r === '#/ot' && params().u !== S.user.id ? 'on' : ''}">Staff timesheets</a>` : !keepsTS() ? '' : `${isHR() ? `<a href="#/ot" class="${r === '#/ot' && !params().all && !params().u ? 'on' : ''}">My timesheet</a><a href="#/ot?all=1" class="${r === '#/ot' && (params().all || params().u) ? 'on' : ''}">Staff timesheets</a>` : L('#/ot', 'My timesheet')}`}
    ${L('#/roster', 'Roster')}${isAdmin() || isHR() || isAccountant() ? L('#/payroll', 'Payroll summary') : ''}`}`;
  if (isReviewer()) h += `<div class="nav-label">Review</div>${L('#/approvals', 'Approvals')}`;
  if (STAGE >= 3 && canFA()) h += `<div class="nav-label">Accounting</div>${L('#/card', 'Card payments')}${L('#/bills', 'Bank transfers')}${L('#/subs', 'Subscriptions')}${canEnterFA() ? L('#/fa-export', 'Month close', 0, ['#/fa/']) : ''}`;
  if (isAdmin()) h += `<div class="nav-label">Admin</div>${L('#/admin/advances', 'Cash advances')}`;
  if (sets.length) h += `${isAdmin() ? '' : '<div class="nav-label">Settings</div>'}${L(sets[0][0], 'Settings', 0, sets.map((x) => x[0]))}`;
  h += `<div class="nav-sep"></div>${L('#/messages', 'Messages', S.msgCount)}`;
  return h + '</div>';
}

// Company switcher: people who work in more than one company move between back offices in 1 click.
// Interim list by staff number; the People and companies page replaces it later.
const CO_HERE = { name: 'Bloom Chiangmai', color: '#7F77DD' };
const CO_OTHER = { name: 'INGROUP ASIA', color: '#1D9E75', url: 'https://iga-backoffice.netlify.app/' };
const CO_MEMBERS = ['ADMIN', 'BMSSTF01', 'BMSSTF08', 'BMSSTF09', 'BMSSTF10', 'IGASTF001'];
const inBoth = () => CO_MEMBERS.includes(String(S.profile?.staff_no || '').toUpperCase());
// Group login: a one-time 60-second pass opens INGROUP ASIA without typing a password
async function coGo() {
  let pass = '';
  try { const { data } = await sb.schema('public').rpc('hub_pass_create'); if (typeof data === 'string') pass = data; } catch { /* fall back to their sign-in page */ }
  location.href = coTarget() + (pass ? '?hub=' + pass : '');
}
const coTarget = () => CO_OTHER.url + '#/' + (((location.hash || '').split('/')[1] || 'home').split('?')[0] || 'home');
function coSwitch() {
  if (!inBoth()) return '';
  const dot = (c) => `<span class="cosw-dot" style="background:${c}"></span>`;
  return `<details class="cosw"><summary>${dot(CO_HERE.color)}<span class="cosw-n">${CO_HERE.name}</span><span class="cosw-c" aria-hidden="true">&#9662;</span></summary><div class="cosw-menu"><div class="cosw-h">Your companies</div><a class="cosw-i on" href="#/home">${dot(CO_HERE.color)}${CO_HERE.name}<span class="cosw-k">&#10003;</span></a><a class="cosw-i" href="${CO_OTHER.url}" data-cosw>${dot(CO_OTHER.color)}${CO_OTHER.name}</a></div></details>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-cosw]'); if (a) { e.preventDefault(); coGo(); return; }
  const open = document.querySelector('details.cosw[open]'); if (open && !open.contains(e.target)) open.removeAttribute('open');
});
function phoneNav() {
  // Snap, To check, Forms and Waiting are the bottom tabs; the menu only holds the rest
  const opts = [...(STAGE >= 2 && seesTime() ? [...(isAdmin() && keepsTS() ? [[`#/ot?u=${S.user.id}`, 'My timesheet']] : []), ...(isAdmin() || keepsTS() ? [['#/ot', isAdmin() ? 'Staff timesheets' : 'My timesheet']] : []), ['#/roster', 'Roster']] : []), ['#/messages', `Messages${S.msgCount ? ' (' + S.msgCount + ')' : ''}`], ['#/account', 'My account'], ['/staff-dashboard.html', '‹ Staff dashboard']];
  const cur0 = (location.hash || '').split('?')[0]; if (!opts.some(([h]) => cur0.startsWith(h))) opts.unshift(['', 'Menu']);
  const cur = (location.hash || '').split('?')[0];
  return `<select id="pnav" aria-label="Menu">${opts.map(([h, l]) => `<option value="${h}" ${cur.startsWith(h) ? 'selected' : ''}>${esc(l)}</option>`).join('')}${inBoth() ? `<option value="cosw">Switch to ${CO_OTHER.name}</option>` : ''}<option value="out">Sign out</option></select>`;
}
function shell(content) {
  app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><b>${ORG}</b><span>Back office</span><a class="brand-back" href="/staff-dashboard.html">‹ Staff dashboard</a></div>${coSwitch()}
      ${navLinks()}
      <div class="side-foot"><a href="#/account" class="side-me" title="My account"><b>${esc(S.profile.full_name || S.profile.staff_no)}</b>My account</a><a href="#" id="so">Sign out</a></div>
    </aside>
    <div>
      <div class="topbar"><b>${ORG}</b>${isPhone() ? phoneNav() : `<a href="#/account" class="faint" style="font-size:13px;text-decoration:none">${esc(S.profile.full_name || S.profile.staff_no)}</a>`}</div>
      <main class="main" id="main">${wrapPage(content)}</main>
      ${isPhone() ? phoneTabs() : ''}
    </div>
  </div>`;
  document.getElementById('so').onclick = (e) => { e.preventDefault(); signOut(); };
  const pn = document.getElementById('pnav'); if (pn) pn.onchange = (e) => { const v = e.target.value; if (v === 'out') signOut(); else if (v === 'cosw') coGo(); else if (v.startsWith('/')) location.href = v; else if (v) location.hash = v; };
  if (S.pendingUnseen != null) applyApprovalBadge();
}
const main = () => document.getElementById('main');
// Pages that now live inside another menu item get a small header or footer
function wrapPage(content) {
  const r = (location.hash || '').split('?')[0];
  const sets = SETTINGS.filter((x) => x[2]());
  if (!isPhone() && sets.some((x) => r.startsWith(x[0])) && sets.length > 1) return `<div class="seg" style="margin-bottom:14px">${sets.map(([h, l]) => `<a href="${h}" class="${r.startsWith(h) ? 'on' : ''}">${l}</a>`).join('')}</div>` + content;
  if (r.startsWith('#/capture')) return `${S.inboxCount ? `<a class="attn-box" href="#/inbox"><span><b>${S.inboxCount} receipt${S.inboxCount > 1 ? 's' : ''} need${S.inboxCount > 1 ? '' : 's'} attention</b></span><span>Fix now</span></a>` : ''}${content}<div style="text-align:right;margin-top:14px"><a href="#/trash" class="faint" style="font-size:13px">Recently deleted</a></div>`;
  if (r.startsWith('#/inbox') || r.startsWith('#/trash')) return `<div style="margin-bottom:10px"><a href="#/capture" class="faint" style="font-size:13px">‹ Add receipts</a></div>` + content;
  return content;
}

function params() { const q = (location.hash.split('?')[1] || ''); return Object.fromEntries(new URLSearchParams(q)); }

// A message can point at one line (?line=<id>): scroll to it and highlight it once the page is drawn
function flashLine() {
  const id = params().line; if (!id) return;
  let tries = 0;
  const go = () => {
    const el = document.querySelector(`[data-open="${CSS.escape(id)}"], [data-line="${CSS.escape(id)}"]`);
    if (!el) { if (++tries < 20) setTimeout(go, 150); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('line-flash'); setTimeout(() => el.classList.remove('line-flash'), 3000);
  };
  go();
}
window.addEventListener('hashchange', () => setTimeout(flashLine, 300));
setTimeout(flashLine, 1200);
const PHONE_OK = ['/', '/home', '/capture', '/check', '/forms', '/expenses', '/history', '/inbox', '/trash', '/approvals', '/ot', '/roster', '/messages', '/account', '/agree'];
const phoneAllowed = (path) => PHONE_OK.includes(path) || path.startsWith('/report/') || path.startsWith('/ot/review/') || path.startsWith('/print/');
async function route() {
  if (S.noAccess) return renderNoAccess();
  if (!S.user) return renderLogin();
  const path = (location.hash || '').replace(/^#/, '').split('?')[0] || '/';
  try {
    // Phone: only the pages made for it. Setup and office pages say "open on a computer".
    if (isPhone() && !phoneAllowed(path)) {
      shell(`<div class="pstack"><h1>Use a computer for this</h1><p class="muted">This page has wide tables and settings that don't fit a phone. Open the back office on a computer to use it.</p><a class="btn primary pbig" href="#/capture">Back to Snap</a></div>`);
      return;
    }
    if (isPhone() && !['/account', '/approvals-desk'].includes(path) && !path.startsWith('/print/') && (!path.startsWith('/admin/') || path === '/admin/staff')) {
      if (S.checkCount == null) await phoneCount();
      if ((await phoneRoute(path)) !== false) return;
    }
    if (path === '/' ) { location.replace('#/home'); return; }
    if (path === '/home') return await pageHome();
    if (path === '/forms') return await pageHistory();
    if (path === '/capture') return await pageCapture();
    if (path === '/inbox') return await pageInbox();
    if (path === '/expenses') return await pageExpenses();
    if (path === '/history') return await pageHistory();
    if (path === '/account') return await pageAccount();
    if (path === '/trash') return await pageTrash();
    if (path.startsWith('/report/')) return await pageReport(path.split('/')[2]);
    if (path.startsWith('/print/')) return await pagePrint(path.split('/')[2]);
    if (path.startsWith('/fa/') && canEnterFA()) return await pageFA(path.split('/')[2]);
    if (path === '/approvals' && isReviewer()) return await pageApprovals();
    if (path === '/admin/access' && isApprover()) return await pageAccess();
    if (STAGE < 2 && (path.startsWith('/ot') || path === '/roster' || path === '/payroll' || path === '/admin/ot')) { location.replace('#/home'); return; }
    if (STAGE < 3 && (['/card', '/subs', '/bills', '/fa-lists', '/fa-export'].includes(path) || path.startsWith('/fa/') || path.startsWith('/sheet/'))) { location.replace('#/home'); return; }
    if (path === '/ot') return await pageOT();
    if (path === '/roster') return await pageRoster();
    if (path === '/payroll' && (isAdmin() || isHR() || isAccountant())) return await pagePayroll();
    if (path === '/messages') return await pageMessages();
    if (path === '/agree') return await pageAgree();
    if (path === '/fa-lists' && canFA()) return await pageFALists();
    if (path === '/fa-export' && canEnterFA()) return await pageFAExport();
    if (path === '/card' && canFA()) return await pageCard();
    if (path === '/subs' && canFA()) return await pageSubs();
    if (path === '/bills' && canFA()) return await pageBills();
    if (path.startsWith('/sheet/') && canFA()) return await pageSheet(path.split('/')[2]);
    if (path.startsWith('/ot/review/') && (isAdmin() || isHR())) return await pageOTReview(path.split('/')[3]);
    if (path === '/admin/ot' && (isAdmin() || isHR())) return await pageOTSettings();
    if (path === '/admin/advances' && isAdmin()) return await pageAdvances();
    if (path === '/admin/cash' && isAdmin()) return await pageCashSettings();
    if (path === '/admin/categories' && isApprover()) return await pageCategories();
    location.replace('#/');
  } catch (e) {
    console.error(e);
    shell(`<div class="banner bad">${esc(friendly(e))}</div>`);
  }
}
window.addEventListener('hashchange', route);

/* ---------- phone capture ---------- */
async function pageCapture() {
  const { forms, form: report } = await currentForm();
  if (!report) {
    shell(`<div class="capture">
      <div><h1>No open expense form</h1><p class="muted" style="margin:6px 0 0">Create an expense form first and choose its month. Then every receipt you add goes into it.</p></div>
      <button class="snap" id="start" style="border:0">New expense form<small>Choose the month</small></button>
    </div>`);
    document.getElementById('start').onclick = async () => { if (await newFormDialog()) pageCapture(); };
    return;
  }
  const key = report.period_month.slice(0, 7);
  const recentAll = must(await sb.from('receipts').select('*').eq('report_id', report.id).order('created_at', { ascending: false }).limit(40));
  // 1 tile per photo, even when the photo held several receipts
  const groups = [];
  recentAll.forEach((r) => { const g = groups.find((x) => x.path === r.storage_path); if (g) g.rows.push(r); else groups.push({ path: r.storage_path, rows: [r] }); });
  const recent = groups.slice(0, 12);
  const thumbs = (await Promise.all(recent.map(async (g) => `<div class="tile" data-tile="${esc(g.path)}" title="Open to edit">${await thumbHtml(g.rows[0])}${g.rows.length > 1 ? `<span class="tile-n">${g.rows.length}</span>` : ''}<button class="tile-x" data-path="${esc(g.path)}" aria-label="Delete photo">×</button></div>`))).join('');
  shell(`
  <div class="capture">
    <div><h1>${isTouch() ? 'Snap a receipt' : 'Add receipts'}</h1>
      <div class="field" style="margin:10px auto 0;max-width:340px;text-align:left"><label>Adding to</label>
        <select class="input" id="formsel">${forms.map((f) => `<option value="${f.id}" ${f.id === report.id ? 'selected' : ''}>${esc(formLabel(f))}</option>`).join('')}<option value="__new">+ New expense form</option></select></div>
      <p class="muted" style="margin:8px 0 0">The system reads each receipt and files it under the right section.</p></div>
    ${isTouch() ? `<label class="snap"><input type="file" class="pick" accept="image/*" capture="environment"><span>Take photo</span><small>Opens the camera</small></label>
    <label class="btn"><input type="file" class="pick" accept="image/*,application/pdf" hidden>Choose from gallery or files</label>`
    : `<label class="drop" id="cdrop" style="padding:46px 20px;font-size:15px"><input type="file" class="pick" accept="image/*,application/pdf" multiple hidden><span><b>Drop receipt files here</b><br>or click to choose. Photos, screenshots or PDFs, several at once.</span></label>`}
    <div id="result"></div>
    ${recent.length ? `<div class="spread" style="width:100%"><span class="faint" style="font-size:12px">Latest in this form</span><button class="btn small ghost" id="tsel">Select</button></div>
    <div class="sel-bar" id="tbar" hidden style="width:100%;padding:0"><label><input type="checkbox" id="tall"> Select all</label><button class="btn small danger" id="tdel" disabled>Delete selected (0)</button></div>
    <div class="recent">${thumbs}</div>` : ''}
  </div>`);
  const handle = async (files) => {
    files = [...files]; if (!files.length) return;
    const lbl = document.querySelector('.snap, #cdrop'); lbl.style.opacity = 0.6;
    const span = lbl.querySelector('span');
    main().querySelectorAll('.pick').forEach((x) => (x.disabled = true));
    const msgs = [];
    for (let k = 0; k < files.length; k++) {
      span.textContent = files.length > 1 ? `Reading receipt ${k + 1} of ${files.length}` : 'Reading receipt';
      try { msgs.push(await run(() => snapAndRead(files[k], report, isTouch() ? 'phone' : 'desktop'))); } catch { /* shown */ }
    }
    await refreshCounts(); await pageCapture();
    if (msgs.length) document.getElementById('result').innerHTML = `<div class="banner info">${msgs.map((m) => m.html || esc(m.text)).join('<br>')}<br><span style="font-size:12px">Add the purpose in My expenses.</span></div>`;
  };
  main().querySelectorAll('.pick').forEach((inp) => inp.onchange = (e) => handle(e.target.files));
  // Tap a photo: open it with zoom, rotate, crop, read again, and its details
  main().querySelectorAll('[data-tile]').forEach((t) => t.onclick = async (e) => {
    if (e.target.closest('.tile-x')) return;
    const rows = recent.find((g) => g.path === t.dataset.tile)?.rows || [];
    const r = rows[0]; if (!r) return;
    const done = async () => { await refreshCounts(); pageCapture(); };
    if (r.item_id) {
      const { data: item } = await sb.from('expense_items').select('*, receipts(*)').eq('id', r.item_id).maybeSingle();
      if (item) return openEditor({ report, item, onDone: done });
    }
    openEditor({ report, receiptIds: [r.id], onDone: done });
  });
  document.getElementById('formsel').onchange = async (e) => {
    if (e.target.value === '__new') { await newFormDialog(); return pageCapture(); }
    chooseForm(e.target.value); await refreshCounts(); pageCapture();
  };
  // Delete photos: their receipts, and lines that use no other photo. Undo restores all.
  const deletePhotos = async (paths) => {
    const rows = recent.filter((g) => paths.includes(g.path)).flatMap((g) => g.rows);
    const removed = [];
    try {
      await run(async () => {
        const itemIds = [...new Set(rows.map((r) => r.item_id).filter(Boolean))];
        for (const id of itemIds) {
          const { data: others } = await sb.from('receipts').select('storage_path').eq('item_id', id);
          if (!(others || []).some((o) => !paths.includes(o.storage_path))) { must(await sb.from('expense_items').delete().eq('id', id)); removed.push(id); }
        }
        must(await sb.from('receipts').delete().in('id', rows.map((r) => r.id)));
        removed.push(...rows.map((r) => r.id));
      });
    } catch { /* shown */ }
    await refreshCounts(); await pageCapture();
    if (removed.length) toastUndo(paths.length > 1 ? `${paths.length} photos deleted.` : (rows.length > 1 ? `Photo deleted, with its ${rows.length} lines.` : 'Photo deleted.'), removed, pageCapture);
  };
  main().querySelectorAll('.tile-x').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete?'; b.classList.add('armed'); setTimeout(() => { delete b.dataset.armed; b.textContent = '×'; b.classList.remove('armed'); }, 3000); return; }
    deletePhotos([b.dataset.path]);
  });
  // Select mode: tap tiles to pick several, then delete them together
  const selBtn = document.getElementById('tsel');
  if (selBtn) {
    const grid = main().querySelector('.recent'), bar = document.getElementById('tbar');
    const all = document.getElementById('tall'), del = document.getElementById('tdel');
    const picked = () => [...grid.querySelectorAll('.tile.picked')].map((t) => t.dataset.tile);
    const sync = () => {
      const k = picked().length, n = grid.querySelectorAll('.tile').length;
      del.disabled = !k; delete del.dataset.armed; del.textContent = `Delete selected (${k})`;
      all.checked = k > 0 && k === n; all.indeterminate = k > 0 && k < n;
    };
    selBtn.onclick = () => {
      const on = !grid.classList.contains('selecting');
      grid.classList.toggle('selecting', on); bar.hidden = !on; selBtn.textContent = on ? 'Done' : 'Select';
      if (!on) grid.querySelectorAll('.tile.picked').forEach((t) => t.classList.remove('picked'));
      sync();
    };
    grid.addEventListener('click', (e) => {
      if (!grid.classList.contains('selecting')) return;
      const t = e.target.closest('.tile'); if (!t) return;
      e.stopPropagation(); e.preventDefault();
      t.classList.toggle('picked'); sync();
    }, true);
    all.onchange = () => { grid.querySelectorAll('.tile').forEach((t) => t.classList.toggle('picked', all.checked)); sync(); };
    del.onclick = () => {
      const paths = picked();
      if (!paths.length || !confirmInline(del, `Delete ${paths.length}?`)) return;
      deletePhotos(paths);
    };
  }
  const cd = document.getElementById('cdrop');
  if (cd) {
    cd.ondragover = (e) => { e.preventDefault(); cd.classList.add('over'); };
    cd.ondragleave = () => cd.classList.remove('over');
    cd.ondrop = (e) => { e.preventDefault(); cd.classList.remove('over'); handle(e.dataTransfer.files); };
  }
}

/* ---------- inbox (desktop) ---------- */
async function pageInbox() {
  // Only the chosen form's receipts (plus any not yet put in a form)
  const { forms, form: cur } = await currentForm();
  const pick = params().f || cur?.id || 'all';
  let iq = sb.from('receipts').select('*').eq('staff_id', S.user.id).is('item_id', null).order('created_at');
  if (pick !== 'all') iq = iq.or(`report_id.eq.${pick},report_id.is.null`);
  const items = must(await iq);
  const formSel = forms.length > 1 ? `<label class="muted" style="display:flex;gap:6px;align-items:center;margin-top:8px">Form <select class="input" id="inform" style="width:auto;padding:5px 8px">${forms.map((f) => `<option value="${f.id}" ${f.id === pick ? 'selected' : ''}>${esc(formLabel(f))}</option>`).join('')}<option value="all" ${pick === 'all' ? 'selected' : ''}>All forms</option></select></label>` : '';
  const nameOf = (r) => {
    const m = r.ai_data && (r.ai_data.merchant || r.ai_data.store);
    if (m) return m;
    const f = (r.file_name || '').replace(/\.[a-z0-9]+$/i, '');
    return !f || /^[0-9a-f-]{16,}$/i.test(f) ? 'Receipt photo' : f;
  };
  const cards = await Promise.all(items.map(async (r) => `
    <div class="inbox-item sel-item" data-id="${r.id}">
      <input type="checkbox" class="sel" data-id="${r.id}" aria-label="Select">
      ${await thumbHtml(r)}
      <div class="ii-text"><div class="ii-name" title="${esc(r.file_name || '')}">${esc(nameOf(r))}</div><div class="faint" style="font-size:12px">${r.captured_via === 'phone' ? 'From phone' : 'Uploaded'} · ${dateLabel(r.created_at)}</div></div>
    </div>`));
  shell(`
  <div class="page-head"><div><h1>Needs attention</h1><p>Receipts the system could not file by itself. Open one to finish it, or delete it.</p>${formSel}</div>
    <div class="row">${items.some((r) => r.ai_status === 'pending' || r.ai_status === 'failed') ? '<button class="btn" id="readall">Read receipts</button>' : ''}<label class="btn">Upload files<input type="file" id="up" multiple accept="image/*,application/pdf" hidden></label></div></div>
  <div class="card">${items.length ? `
    <div class="sel-bar"><label><input type="checkbox" id="selall"> Select all</label><span class="faint" id="seln"></span><button class="btn small danger" id="seldel" hidden>Delete selected</button></div>
    <div class="inbox-list" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${cards.join('')}</div>` : '<div class="empty">Nothing needs attention.</div>'}</div>`);
  document.getElementById('up').onchange = async (e) => {
    const { form: report } = await currentForm();
    if (!report) { toast('Create an expense form first', true); return; }
    for (const f of e.target.files) { try { await run(() => snapAndRead(f, report, 'desktop')); } catch { /* shown */ } }
    await refreshCounts(); pageInbox();
  };
  const inf = document.getElementById('inform');
  if (inf) inf.onchange = () => { if (inf.value !== 'all') chooseForm(inf.value); refreshCounts(); location.hash = '#/inbox?f=' + inf.value; };
  const ra = document.getElementById('readall');
  if (ra) ra.onclick = async () => {
    const { form: report } = await currentForm();
    if (!report) return toast('Create an expense form first', true);
    ra.disabled = true; ra.textContent = 'Reading';
    for (const r of items.filter((x) => x.ai_status === 'pending' || x.ai_status === 'failed')) {
      if (r.report_id !== report.id) await sb.from('receipts').update({ report_id: report.id }).eq('id', r.id);
      try { await readReceipt(r.id); } catch { /* keep going */ }
    }
    await refreshCounts(); pageInbox();
  };
  if (!items.length) return;
  const boxes = [...main().querySelectorAll('.sel')];
  const all = document.getElementById('selall'), del = document.getElementById('seldel'), n = document.getElementById('seln');
  const sync = () => {
    const k = boxes.filter((b) => b.checked).length;
    del.hidden = !k; del.textContent = `Delete selected (${k})`; n.textContent = k ? `${k} selected` : '';
    all.checked = k === boxes.length; all.indeterminate = k > 0 && k < boxes.length;
    boxes.forEach((b) => b.closest('.sel-item').classList.toggle('picked', b.checked));
  };
  boxes.forEach((b) => { b.onclick = (e) => e.stopPropagation(); b.onchange = sync; });
  all.onchange = () => { boxes.forEach((b) => (b.checked = all.checked)); sync(); };
  del.onclick = async () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.id);
    if (!ids.length || !confirmInline(del, `Delete ${ids.length}?`)) return;
    try { await run(async () => must(await sb.from('receipts').delete().in('id', ids))); } catch { return; }
    toastUndo(ids.length > 1 ? `${ids.length} receipts deleted.` : 'Receipt deleted.', ids, pageInbox);
    await refreshCounts(); pageInbox();
  };
  main().querySelectorAll('.sel-item').forEach((b) => b.onclick = async () => {
    const { form: report } = await currentForm();
    if (!report) return toast('Create an expense form first', true);
    openEditor({ report, receiptIds: [b.dataset.id], onDone: async () => { await refreshCounts(); pageInbox(); } });
  });
}

/* ---------- my expenses (desktop) ---------- */
async function getReport(staffId, key) {
  return must(await sb.from('expense_reports').select('*').eq('staff_id', staffId).eq('period_month', monthStart(key)).order('created_at').limit(1)).at(0) || null;
}
async function getReportById(id) {
  return must(await sb.from('expense_reports').select('*').eq('id', id).eq('staff_id', S.user.id).maybeSingle());
}
// Open forms (draft or returned) the staff member can add receipts to
async function openForms() {
  return must(await sb.from('expense_reports').select('*').eq('staff_id', S.user.id).in('status', ['draft', 'rejected']).order('period_month', { ascending: false }));
}
const formKind = (r) => (r.form_type === 'project' ? `Project: ${r.project || ''}` : 'Petty Cash');
const formLabel = (r) => `${monthLabel(r.period_month.slice(0, 7))} · ${formKind(r)} · ${r.ref_no}`;
const formHref = (r) => (['draft', 'rejected'].includes(r.status) ? `#/expenses?id=${r.id}` : `#/report/${r.id || r.report_id}`);
// The form receipts go into: the one chosen earlier, else the only open one, else null
async function currentForm() {
  const forms = await openForms();
  let id = null; try { id = sessionStorage.getItem('bo_form'); } catch { /* ignore */ }
  return { forms, form: forms.find((f) => f.id === id) || (forms.length === 1 ? forms[0] : (forms[0] || null)) };
}
function chooseForm(id) { try { sessionStorage.setItem('bo_form', id); } catch { /* ignore */ } }
// New expense form: pick the month, reference suggested
async function newFormDialog(defaultKey = monthKey()) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal narrow" role="dialog" aria-label="New expense form">
      <div class="modal-head"><h2>New expense form</h2><button class="btn ghost" data-x>Close</button></div>
      <div class="modal-body"><form class="card-pad stack" id="nf">
        <div class="field"><label>Which month is this form for?</label><input class="input" type="month" name="month" value="${defaultKey}" required></div>
        <div class="field"><label>Type</label><div class="row" style="gap:16px">
          <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="ftype" value="personal" checked> Petty Cash</label>
          <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="ftype" value="project"> Project</label></div>
          <span class="hint" id="fthint">Petty Cash: leftover cash advance carries to your next Petty Cash form.</span></div>
        <div class="field" id="projf" hidden><label>Project</label><select class="input" name="project"><option value="">Choose the project</option></select><span class="hint" id="projpic"></span>
          <div id="newproj" class="row" style="gap:6px;margin-top:6px" hidden><input class="input" id="npn" placeholder="Project name" style="flex:1"><input class="input mono" id="npc" placeholder="Code e.g. IGAADHK26" style="width:150px;text-transform:uppercase"><button type="button" class="btn" id="npok">Add</button></div><span class="hint" id="npmsg"></span></div>
        <div class="field"><label>Reference</label><input class="input mono" name="ref" required><span class="hint">Suggested automatically. You can change it.</span></div>
        <div class="error" id="nferr"></div>
      </form></div>
      <div class="modal-foot"><span></span><div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="nfok">Create form</button></div></div></div>`;
    document.body.appendChild(back);
    const f = back.querySelector('#nf');
    const close = (v) => { back.remove(); resolve(v); };
    back.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => close(null));
    const suggest = async () => {
      const { data } = await sb.rpc('suggest_personal_ref', { p_month: f.month.value || defaultKey });
      if (data) f.ref.value = data;
    };
    f.month.onchange = suggest; suggest();
    let PROJ = [];
    (async () => {
      const [ps, pp, pr] = await Promise.all([sb.from('projects').select('id, name, code, needs_setup').eq('active', true).order('name').then(must), sb.from('project_pics').select('project_id, staff_id').then(must), sb.rpc('pic_names')]);
      PROJ = ps.map((x) => ({ ...x, pics: pp.filter((y) => y.project_id === x.id).map((y) => (pr.data || []).find((z) => z.id === y.staff_id)?.full_name).filter(Boolean) }));
      fillProj();
    })();
    const fillProj = (sel = '') => {
      f.project.innerHTML = `<option value="">Choose the project</option>${PROJ.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}${x.code ? ` · ${esc(x.code)}` : ''}</option>`).join('')}<option value="__new">+ New project</option>`;
    };
    const refBox = f.ref;
    f.project.onchange = async () => {
      const np = back.querySelector('#newproj'); np.hidden = f.project.value !== '__new'; back.querySelector('#npmsg').textContent = '';
      if (f.project.value === '__new') { back.querySelector('#projpic').textContent = ''; back.querySelector('#npn').focus(); return; }
      const x = PROJ.find((y) => y.id === f.project.value);
      back.querySelector('#projpic').textContent = x ? (x.pics.length ? `Checked first by ${x.pics.join(' or ')}, then final approval by an admin.` : 'This project has no PIC yet: it goes straight to an admin.') : '';
      if (x?.code) { const { data } = await sb.rpc('preview_project_ref', { p_project: x.id }); if (data) { refBox.value = data; refBox.readOnly = true; } }
      else if (x) { refBox.readOnly = false; suggest(); back.querySelector('#projpic').textContent += ' No project code yet, so the reference stays as suggested.'; }
    };
    back.querySelector('#npok').onclick = async () => {
      const n = back.querySelector('#npn').value.trim(), msg = back.querySelector('#npmsg');
      if (!n) return;
      const norm = (t) => t.toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
      const same = PROJ.find((y) => norm(y.name) === norm(n) || (norm(n).length > 3 && (norm(y.name).includes(norm(n)) || norm(n).includes(norm(y.name)))));
      if (same && msg.dataset.warned !== n) { msg.dataset.warned = n; msg.innerHTML = `<span class="error">"${esc(same.name)}" already exists. Pick it from the list, or press Add again to create "${esc(n)}" anyway.</span>`; return; }
      const code = back.querySelector('#npc').value.trim().toUpperCase().replace(/\s+/g, '') || null;
      const { data, error } = await sb.from('projects').insert({ name: n, code }).select().single();
      if (error) { msg.innerHTML = `<span class="error">${esc(/duplicate|unique/i.test(error.message) ? 'That project already exists.' : error.message)}</span>`; return; }
      PROJ.push({ ...data, pics: [] }); PROJ.sort((a, b) => a.name.localeCompare(b.name)); fillProj(data.id);
      back.querySelector('#newproj').hidden = true;
      msg.textContent = code ? 'Project added.' : 'Project added. Add its code later to get the project reference (code-01).';
      f.project.onchange();
    };
    f.querySelectorAll('[name=ftype]').forEach((r) => r.onchange = () => {
      const proj = f.ftype.value === 'project';
      back.querySelector('#projf').hidden = !proj; f.project.required = proj;
      if (!proj && f.ref.readOnly) { f.ref.readOnly = false; suggest(); }
      back.querySelector('#fthint').textContent = proj ? 'Project: leftover cash advance is returned to the company.' : 'Petty Cash: leftover cash advance carries to your next Petty Cash form.';
    });
    back.querySelector('#nfok').onclick = async () => {
      const err = back.querySelector('#nferr'); err.textContent = '';
      if (!f.reportValidity()) return;
      if (f.ftype.value === 'project' && (!f.project.value || f.project.value === '__new')) { err.textContent = 'Choose the project (or add it first).'; return; }
      const key = f.month.value;
      const proj = f.ftype.value === 'project';
      const { data, error } = await sb.from('expense_reports').insert({ staff_id: S.user.id, ref_no: f.ref.value.trim().toUpperCase().replace(/\s+/g, ''), period_month: monthStart(key), form_type: proj ? 'project' : 'personal', project: proj ? (PROJ.find((y) => y.id === f.project.value)?.name || null) : null, project_id: proj ? f.project.value || null : null }).select().single();
      if (error) { err.textContent = /duplicate|unique/i.test(error.message) ? 'That reference is already used. Please change it.' : friendly(error); return; }
      chooseForm(data.id);
      toast(`${monthLabel(key)} ${proj ? 'project' : 'personal'} form created`);
      close(data);
    };
  });
}

async function loadReportBundle(report) {
  const [items, totals] = await Promise.all([
    sb.from('expense_items').select('*, receipts(*)').eq('report_id', report.id).order('invoice_date').order('created_at').then(must),
    sb.from('expense_report_totals').select('*').eq('report_id', report.id).single().then(must),
  ]);
  return { items, totals };
}

function statsHtml(report, totals, canEditRef = false) {
  return `<div class="stats">
    <div class="stat" id="refcell"><label>Reference</label><div class="mono" id="refval">${esc(report.ref_no)}${canEditRef ? ' <button class="btn small ghost" id="eref" title="Edit reference" style="font-family:var(--font)">Edit</button>' : ''}</div><small>${pill(report.status)}</small></div>
    <div class="stat"><label>Carried forward</label><div>${money(report.opening_advance)}</div><small>${report.form_type === 'project' ? 'project forms start at 0' : (report.staff_id === S.user.id ? 'from your last personal form' : 'from the last personal form')}</small></div>
    <div class="stat"><label>Cash advance</label>${canEditRef && !canAdv(report) ? `<div>${money(0)}</div><small>you pay with your own money and are paid back</small>` : canEditRef ? `<div class="advbox"><input class="input num" id="advin" type="number" step="0.01" min="0" inputmode="decimal" value="${Number(report.advance_topup) || ''}" placeholder="0.00"></div><small>cash the company gave you for this form</small>` : `<div>${money(report.advance_topup)}</div><small>for this form</small>`}</div>
    <div class="stat"><label>Spent</label><div>${money(totals.total_spent)}</div><small>THB</small></div>
    <div class="stat"><label>Balance</label><div>${money(totals.balance)}</div><small>${Number(totals.balance) < 0 ? (report.staff_id === S.user.id ? 'company owes you' : 'company owes the staff member') : (report.form_type === 'project' ? 'return to the company' : 'carries to your next personal form')}</small></div>
  </div>`;
}
// Expenses table: compact rows (1 line each), pages of 15 by default (15 / 30 / 50 / all)
const shortDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const shortCat = (name) => ({ Transportation: 'Transport' }[name] || name);
// A returned line is answered by a reply or a change; a changed amount always needs a reply
function sinceReturnedHtml(items, who) {
  const ls = items.filter((i) => i.return_note && i.returned_snapshot);
  if (!ls.length) return '';
  return `<div class="card sincebox pf-screen"><div class="card-head"><h2>Since you returned it <span class="faint" style="font-weight:400;font-size:13px">· ${ls.length} line${ls.length > 1 ? 's' : ''}</span></h2></div>${ls.map((i) => {
    const c = retChanges(i);
    return `<div class="since-l"><div><b>${esc(shortDate(i.invoice_date))} · ${esc(i.item)}</b> <span class="faint">THB ${money(i.amount)}</span></div><div class="since-g"><span>You</span><span>${esc(i.return_note)}</span><span>${esc(who || 'Staff')}</span><span>${i.staff_reply ? esc(i.staff_reply) : '<span class="faint">no reply</span>'}</span><span>Changed</span><span>${c.length ? c.map((x) => `${x.k}: <s class="faint">${esc(x.a)}</s> → ${esc(x.b)}`).join('<br>') : '<span class="faint">nothing</span>'}</span></div></div>`;
  }).join('')}</div>`;
}
function retChanges(i) {
  const o = i.returned_snapshot || {}, c = [];
  if (String(o.amount) !== String(i.amount) && Number(o.amount) !== Number(i.amount)) c.push({ k: 'Amount', a: money(o.amount), b: money(i.amount), amount: true });
  if ((o.purpose || '') !== (i.purpose || '')) c.push({ k: 'Purpose', a: o.purpose || '-', b: i.purpose || '-' });
  if ((o.item || '') !== (i.item || '')) c.push({ k: 'Item', a: o.item || '-', b: i.item || '-' });
  if ((o.category_id || '') !== (i.category_id || '')) c.push({ k: 'Category', a: catName(o.category_id), b: catName(i.category_id) });
  if ((o.invoice_date || '') !== (i.invoice_date || '')) c.push({ k: 'Date', a: dateLabel(o.invoice_date), b: dateLabel(i.invoice_date) });
  return c;
}
function retState(i) {
  const c = retChanges(i), rep = String(i.staff_reply || '').trim();
  if (c.some((x) => x.amount) && !rep) return { ok: false, html: '<span class="error">Amount changed: add a reply</span>' };
  if (rep) return { ok: true, html: `<span class="okc">Replied${c.length ? ` · changed ${c.map((x) => x.k.toLowerCase()).join(', ')}` : ''}</span>` };
  if (c.length) return { ok: true, html: `<span class="okc">Changed: ${c.map((x) => x.k.toLowerCase()).join(', ')}</span>` };
  return { ok: false, html: '<span class="error">Needs a reply or a change</span>' };
}
document.addEventListener('click', (e) => { if (e.target.closest('.rreply-row')) e.stopPropagation(); }, true);
document.addEventListener('change', async (e) => {
  const inp = e.target.closest('.rreply'); if (!inp) return;
  const id = inp.dataset.reply, v = inp.value.trim();
  const { error } = await sb.from('expense_items').update({ staff_reply: v || null }).eq('id', id);
  if (error) return toast(error.message, true);
  const { data: it } = await sb.from('expense_items').select('id, amount, purpose, item, category_id, invoice_date, staff_reply, returned_snapshot').eq('id', id).single();
  const st = document.querySelector(`[data-rstate="${id}"]`); if (st && it) st.innerHTML = retState(it).html;
  toast(v ? 'Reply saved' : 'Reply removed');
});
async function itemsTable(items, { editable, showActions, sort = null, marks = null }) {
  const [sk, sd] = String(sort || '').split('-');
  const sortTh = (k, label, w = '', cls = '') => {
    const on = sk === k;
    const arrow = on ? (sd === 'a' ? '↑' : '↓') : '⇅';
    return `<th class="sortth${on ? ' on' : ''}${cls ? ' ' + cls : ''}"${w ? ` style="${w}"` : ''} data-sort="${k}" title="Sort by ${label.toLowerCase()}">${label} <span class="sarrow">${arrow}</span></th>`;
  };
  if (!items.length) return '<div class="empty">No expenses yet.</div>';
  const sel = editable && showActions;
  const showQty = items.some((i) => Number(i.qty) !== 1);
  const rows = items.map((i, n) => {
    const todo = i.needs_review || !String(i.purpose || '').trim();
    const dup = i.duplicate_of && !i.duplicate_ok;
    const purpose = String(i.purpose || '').trim();
    const noRc = !(i.receipts || []).length;
    const first = (i.receipts || [])[0];
    return `<tr data-row="${n}" data-open="${i.id}"${i.return_note ? ' class="line-noted"' : ''}${first ? ` data-path="${esc(first.storage_path)}" data-mime="${esc(first.mime_type || '')}" data-rot="${first.rotation || 0}"` : ''} title="${sel ? 'Open to check the photo and details' : 'Open the receipt'}">
      ${sel ? `<td class="selcol"><input type="checkbox" class="lsel" data-id="${i.id}" aria-label="Select line"></td>` : ''}
      <td class="nowrap" title="${esc(dateLabel(i.invoice_date))}">${i.needs_review ? '<span class="new-dot" title="New, added from a receipt photo"></span>' : ''}${shortDate(i.invoice_date)}</td>
      <td title="${esc(i.item)}${i.accounting_code ? ' · ' + esc(i.accounting_code) : ''}"><div class="c2">${esc(i.item)}${dup ? ' <span class="dupflag">· Duplicate?</span>' : ''}</div>${marks?.[i.id]?.tags?.length ? `<div class="ltags">${marks[i.id].tags.map((t) => `<span class="ltag${t === 'Changed' ? ' chg' : ''}">${esc(t)}</span>`).join('')}</div>` : ''}${i.return_note ? `<div class="rnote">Approver: ${esc(i.return_note)}</div>${editable && i.returned_snapshot ? `<div class="rreply-row"><input class="input rreply" data-reply="${i.id}" value="${esc(i.staff_reply || '')}" placeholder="Reply to the approver…" maxlength="300"><span class="rstate" data-rstate="${i.id}">${retState(i).html}</span></div>` : i.staff_reply ? `<div class="faint" style="font-size:12px">Reply: ${esc(i.staff_reply)}</div>` : ''}` : ''}</td>
      <td class="nowrap faint" title="${esc(catName(i.category_id))}">${esc(catName(i.category_id))}</td>
      <td title="${esc(purpose)}"><div class="c2">${purpose ? esc(purpose) : `<span class="error">Missing purpose</span>`}${noRc ? ' <span class="error">· No receipt</span>' : ''}${(S.faVendors || []).length && needsSupplier(i) ? ' <span class="error">· No supplier</span>' : ''}</div></td>
      ${showQty ? `<td class="num">${Number(i.qty)}</td>` : ''}
      <td class="num nowrap"${i.currency && i.currency !== 'THB' ? ` title="${esc(fxNote(i))}"` : ''}>${money(i.amount)}</td>
    </tr>`;
  });
  const total = items.reduce((s2, i) => s2 + Number(i.amount), 0);
  return `<div class="table-wrap"><table class="lines">
    <thead><tr>${sel ? '<th class="selcol"><input type="checkbox" id="lselall" aria-label="Select all on this page"></th>' : ''}${sort ? sortTh('date', 'Date', 'width:96px') : '<th style="width:76px">Date</th>'}${sort ? sortTh('item', 'Item') : '<th>Item</th>'}${sort ? sortTh('cat', 'Category', 'width:132px') : '<th style="width:132px">Category</th>'}${sort ? sortTh('pur', 'Purpose', 'width:27%') : '<th style="width:27%">Purpose</th>'}${showQty ? '<th class="num" style="width:44px">Qty</th>' : ''}${sort ? sortTh('amt', 'THB', 'width:100px', 'num') : '<th class="num" style="width:100px">THB</th>'}</tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr>${sel ? '<td class="selcol"></td>' : ''}<td colspan="${4 + (showQty ? 1 : 0)}">Total, ${items.length} line${items.length === 1 ? '' : 's'}</td><td class="num">${money(total)}</td></tr></tfoot>
  </table></div>
  <div class="pager"></div>`;
}
// Paging for the expenses table. Choice of lines per page is remembered on this device.
function wireLines(root = main()) {
  const tbl = root.querySelector('table.lines'), pg = root.querySelector('.pager');
  if (!tbl || !pg) return;
  const rows = [...tbl.querySelectorAll('tbody tr')], n = rows.length;
  if (!tbl.querySelector('.lsel')) rows.forEach((r) => r.onclick = () => { if (r.dataset.path) openViewer(r.dataset.path, r.dataset.mime, Number(r.dataset.rot || 0)); });
  let per = 15; try { per = Number(localStorage.getItem('bo_lines_per')) || 15; } catch { /* ignore */ }
  let page = 0;
  const draw = () => {
    const size = per === 999 ? n : per, pages = Math.max(1, Math.ceil(n / size));
    page = Math.min(page, pages - 1);
    rows.forEach((r, k) => { r.hidden = !(k >= page * size && k < (page + 1) * size); });
    const from = n ? page * size + 1 : 0, to = Math.min(n, (page + 1) * size);
    const perSel = `<label class="faint perpick">Show <select class="lper">${[15, 30, 50, 999].map((v) => `<option value="${v}" ${v === per ? 'selected' : ''}>${v === 999 ? 'All' : v}</option>`).join('')}</select></label>`;
    const nav = () => `${perSel}<span class="faint">${from} to ${to} of ${n}</span><button type="button" class="chev" data-pg="-1" ${page === 0 ? 'disabled' : ''} aria-label="Previous page">&#8249;</button><button type="button" class="chev" data-pg="1" ${page >= pages - 1 ? 'disabled' : ''} aria-label="Next page">&#8250;</button>`;
    pg.innerHTML = nav();
    const top = root.querySelector('.pager-top'); if (top) top.innerHTML = n > 15 ? nav() : '';
    root.querySelectorAll('.lper').forEach((el) => el.onchange = (e) => { per = Number(e.target.value); try { localStorage.setItem('bo_lines_per', String(per)); } catch { /* ignore */ } page = 0; draw(); });
    root.querySelectorAll('[data-pg]').forEach((b) => b.onclick = () => { page += Number(b.dataset.pg); draw(); });
    tbl.dispatchEvent(new Event('pagechange'));
  };
  draw();
}
function categorySummary(items) {
  const by = {};
  items.forEach((i) => { by[i.category_id] = (by[i.category_id] || 0) + Number(i.amount); });
  const rows = S.categories.filter((c) => by[c.id]).map((c) => `<tr><td>${esc(c.code || '')}</td><td>${esc(c.name)}</td><td class="num">${money(by[c.id])}</td></tr>`).join('');
  return rows ? `<table><thead><tr><th>Code</th><th>Category</th><th class="num">Amount (THB)</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nothing yet.</div>';
}

async function pageExpenses() {
  // On screen only: newest added first by default. Print, preview and approvers stay by date.
  let lineSort = 'new'; try { lineSort = localStorage.getItem('bo_sort2') || 'new'; } catch { /* ignore */ }
  const sortLines = (arr) => {
    const [k, d] = lineSort.split('-'), m = d === 'a' ? 1 : -1;
    const val = { date: (i) => String(i.invoice_date || ''), item: (i) => String(i.item || '').toLowerCase(), cat: (i) => catName(i.category_id).toLowerCase(), pur: (i) => String(i.purpose || '').toLowerCase(), amt: (i) => Number(i.amount) || 0 }[k];
    if (!val) return [...arr].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
    return [...arr].sort((x, y) => { const a = val(x), b = val(y); return (a < b ? -1 : a > b ? 1 : 0) * m; });
  };
  // A form is opened by id (several forms per month are allowed: personal and project)
  const p = params();
  let report = p.id ? await getReportById(p.id) : (p.m ? await getReport(S.user.id, p.m) : null);
  const { forms } = await currentForm();
  if (!report) { const { form } = await currentForm(); report = form; }
  const key = report ? report.period_month.slice(0, 7) : monthKey();
  const others = forms.filter((f) => !report || f.id !== report.id);
  const nav = `<div class="row" style="gap:12px">${others.length ? `<select class="input" id="formjump" style="width:auto;padding:4px 8px;font-size:13px"><option value="">Switch form</option>${others.map((f) => `<option value="${f.id}">${esc(formLabel(f))}</option>`).join('')}</select>` : ''}<a href="#" class="linkbtn" id="newform2">+ New form</a></div>`;
  const wireNav = () => {
    const j = document.getElementById('formjump'); if (j) j.onchange = () => { if (j.value) location.hash = '#/expenses?id=' + j.value; };
    document.getElementById('newform2').onclick = async (e) => { e.preventDefault(); const f = await newFormDialog(); if (f) location.hash = '#/expenses?id=' + f.id; };
  };
  if (!report) {
    shell(`<div class="page-head"><div><h1>No open expense form</h1><p>Start a form for the month you need: personal or for a project.</p></div>${nav}</div>
      <div class="card card-pad spread"><span class="muted">After that, receipts snapped on your phone go straight into it.</span><button class="btn primary" id="start">New expense form</button></div>`);
    wireNav();
    document.getElementById('start').onclick = async () => { const f = await newFormDialog(); if (f) location.hash = '#/expenses?id=' + f.id; };
    return;
  }
  const { items, totals } = await loadReportBundle(report);
  const editable = ['draft', 'rejected'].includes(report.status);
  if (editable) { chooseForm(report.id); await refreshCounts(); }
  const inbox = editable ? must(await sb.from('receipts').select('*').eq('staff_id', S.user.id).is('item_id', null).or(`report_id.eq.${report.id},report_id.is.null`).order('created_at')) : [];
  const aiLine = (r) => r.ai_data && r.ai_data.held_reason === 'not_receipt' ? '' : r.ai_status === 'done' && r.ai_data ? `${esc(catName(r.ai_data.category_id) || '')}${r.ai_data.total_amount ? ' · ' + esc(r.ai_data.currency || 'THB') + ' ' + money(r.ai_data.total_amount) : ''}` : (r.ai_status === 'failed' ? 'Could not be read' : (r.ai_status === 'pending' ? 'Not read yet' : 'Add details'));
  // Possible duplicate: same date + amount as one of my lines, or as an earlier inbox receipt
  const myLines = editable ? must(await sb.from('expense_items').select('invoice_date, amount, expense_reports!inner(staff_id)').eq('expense_reports.staff_id', S.user.id)) : [];
  const isDupRc = (r, idx) => {
    const d = r.ai_data; if (!d || !d.total_amount || !d.invoice_date) return false;
    const amt = Number(d.total_amount);
    return myLines.some((l) => l.invoice_date === d.invoice_date && Number(l.amount) === amt)
      || inbox.slice(0, idx).some((o) => o.ai_data && o.ai_data.invoice_date === d.invoice_date && Number(o.ai_data.total_amount) === amt);
  };
  const heldLabel = (r) => {
    const d = r.ai_data || {}, h = d.held_reason;
    if (h === 'duplicate') { const x = d.duplicate_item || {}; return `<span class="pill rejected">Possible duplicate</span><div style="font-size:11px;color:var(--bad)">Same store, date${x.receipt_time ? ', time' : ''} and amount as the line from ${dateLabel(x.invoice_date)}${x.receipt_time ? ' ' + esc(x.receipt_time) : ''}</div>`; }
    if (h === 'unsure') return '<span class="pill submitted">Please check</span><div style="font-size:11px" class="faint">Date, amount or section unclear</div>';
    if (h === 'not_receipt') return '<span class="pill submitted">Not a receipt</span><div style="font-size:11px" class="faint">e.g. order page or screenshot</div>';
    if (h === 'currency') return `<span class="pill submitted">${esc(d.currency || 'Foreign')} receipt</span><div style="font-size:11px" class="faint">Enter the THB you paid</div>`;
    return isDupRc(r, 0) ? '<span class="pill rejected">Possible duplicate</span><br>' : '';
  };
  const inboxCards = await Promise.all(inbox.map(async (r, idx) => `<div style="position:relative"><button class="inbox-item" data-id="${r.id}" style="width:100%">${await thumbHtml(r)}<div style="font-size:12px">${heldLabel(r)}<div>${aiLine(r)}</div><div class="faint">${dateLabel(r.created_at)}</div></div></button><button class="btn small ghost danger" data-rdel="${r.id}" data-path="${esc(r.storage_path)}" style="position:absolute;bottom:6px;right:6px" title="Delete this receipt">Delete</button></div>`));
  const unread = inbox.filter((r) => r.ai_status === 'pending' || r.ai_status === 'failed');
  const missing = items.filter((i) => !(i.receipts || []).length).length;
  const blockers = [];
  const toCheck = items.filter((i) => i.needs_review || !String(i.purpose || '').trim()).length;
  const dups = items.filter((i) => i.duplicate_of && !i.duplicate_ok).length;
  if (dups) blockers.push(`${dups} possible duplicate${dups > 1 ? 's' : ''} to resolve (delete it, or open it and confirm it is separate)`);
  if (toCheck) blockers.push(`${toCheck} line${toCheck > 1 ? 's need' : ' needs'} checking and a purpose`);
  if (missing) blockers.push(`${missing} line${missing > 1 ? 's have' : ' has'} no receipt`);
  if (!items.length) blockers.push('no expenses added');
  if (!chkChosen(report)) blockers.push('pick who checks it');
  if (!S.faVendors) await loadFAVendors();
  const noSup = (S.faVendors || []).length ? items.filter((i) => needsSupplier(i)).length : 0;
  if (noSup) blockers.push(`${noSup} line${noSup > 1 ? 's need' : ' needs'} a supplier from the list`);

  shell(`
  <div class="page-head" style="display:block"><h1>${monthLabel(key)} · ${esc(formKind(report))}</h1><p>${esc(S.profile.full_name)} · ${esc(S.profile.staff_no || '')}</p>
    <div class="spread" style="margin-top:10px">${nav}<a class="btn" href="#/print/${report.id}">Preview form</a></div></div>
  <div class="stack">
    ${report.status === 'rejected' ? `<div class="banner bad"><b>Returned:</b> ${esc(report.rejection_reason)}<br>Fix the lines below and submit again.</div>` : ''}
    ${report.status === 'submitted' ? '<div class="banner warn">Submitted and waiting for approval. You cannot change it now.</div>' : ''}
    ${toCheck && editable ? `<div class="banner info">${toCheck} line${toCheck > 1 ? 's were' : ' was'} filled in from receipt photos. Click <b>Add purpose</b> on each, check the details and save.</div>` : ''}
    ${statsHtml(report, totals, editable)}
    ${editable && inbox.length ? `<div class="banner warn spread"><span><b>${inbox.length} receipt${inbox.length > 1 ? 's need' : ' needs'} attention</b> before this form is complete.</span><a class="btn small" href="#/inbox">Review</a></div>` : ''}
    <div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Expenses${toCheck ? ` <span class="faint" style="font-size:13px;font-weight:400">· ${toCheck} need${toCheck === 1 ? 's' : ''} a purpose</span>` : ''}</h2><div class="row"><span class="pager-top"></span>${editable ? '<button class="btn" id="add">Add expense</button>' : ''}</div></div><div class="lines-wrap">${editable ? '<div class="selbar" id="selbar" hidden><span id="selcount"></span><button class="btn small ghost danger" id="ldel">Delete selected</button></div>' : ''}${await itemsTable(sortLines(items), { editable, showActions: true, sort: lineSort })}</div></div>
        <div class="card"><div class="card-head"><h2>By category</h2></div>${categorySummary(items)}</div>
        ${editable ? `<div class="card card-pad stack" id="chkbox">
          ${checkerPicker(report)}
          <div class="field"><label>Remarks (optional)</label><textarea class="input" id="remarks">${esc(report.remarks || '')}</textarea></div>
          <div class="spread"><span class="${blockers.length ? 'error' : 'muted'}">${blockers.length ? 'Before submitting: ' + esc(blockers.join(', ')) : 'Ready to submit.'}</span>
          <button class="btn primary" id="submit" ${blockers.length ? 'disabled' : ''}>${report.checker_id ? 'Submit for checking' : 'Submit to admin'}</button></div><div id="subwarn" style="margin-top:10px"></div></div>` : ''}
      </div>
    </div>
  </div>`);

  wireLines();
  main().querySelectorAll('th[data-sort]').forEach((th) => th.onclick = () => {
    const k = th.dataset.sort, [ck, cd] = lineSort.split('-');
    let next = ck === k ? `${k}-${cd === 'a' ? 'd' : 'a'}` : `${k}-${k === 'amt' ? 'd' : 'a'}`;
    if (k === 'date' && ck === 'date' && cd === 'd') next = 'new';
    try { localStorage.setItem('bo_sort2', next); } catch { /* ignore */ } pageExpenses();
  });
  if (!editable) return;
  wireNav();
  const reload = async () => { await refreshCounts(); pageExpenses(); };
  document.getElementById('add').onclick = () => openEditor({ report, onDone: reload });
  const upEl = null;
  if (upEl) upEl.onchange = async (e) => {
    toast('Uploading and reading');
    for (const f of e.target.files) { try { await run(() => snapAndRead(f, report, 'desktop')); } catch { /* shown */ } }
    reload();
  };
  const ra = document.getElementById('readall');
  if (ra) ra.onclick = async () => {
    ra.disabled = true; ra.textContent = 'Reading';
    for (const r of unread) {
      if (r.report_id !== report.id) await sb.from('receipts').update({ report_id: report.id }).eq('id', r.id);
      await readReceipt(r.id);
    }
    reload();
  };
  const advEl = document.getElementById('advin');
  if (advEl) advEl.onchange = async () => {
    const v = Math.max(0, Number(advEl.value || 0));
    try { await run(async () => must(await sb.from('expense_reports').update({ advance_topup: v }).eq('id', report.id)), 'Cash advance saved'); } catch { return; }
    reload();
  };
  const erefEl = document.getElementById('eref'); if (erefEl) erefEl.onclick = () => {
    const box = document.getElementById('refval');
    box.innerHTML = `<div class="row" style="gap:6px"><input class="input mono" id="refin" value="${esc(report.ref_no)}" style="width:170px;padding:4px 8px"><button class="btn small primary" id="refok">Save</button><button class="btn small ghost" id="refx">Cancel</button></div>`;
    const inp = document.getElementById('refin'); inp.focus(); inp.select();
    const save = async () => {
      const ref = inp.value.trim().toUpperCase().replace(/\s+/g, '');
      if (!ref || ref === report.ref_no) return reload();
      try { await run(async () => must(await sb.from('expense_reports').update({ ref_no: ref }).eq('id', report.id)), 'Reference updated'); } catch { /* shown */ }
      reload();
    };
    document.getElementById('refok').onclick = save;
    document.getElementById('refx').onclick = reload;
    inp.onkeydown = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') reload(); };
  };
  main().querySelectorAll('.inbox-item').forEach((b) => b.onclick = () => openEditor({ report, receiptIds: [b.dataset.id], onDone: reload }));
  main().querySelectorAll('[data-rdel]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirmInline(b, 'Sure?')) return;
    try { await run(async () => must(await sb.from('receipts').delete().eq('id', b.dataset.rdel))); } catch { return; }
    toastUndo('Receipt deleted.', [b.dataset.rdel], reload);
    reload();
  });
  // Click a row to open it; in Select mode a click ticks the row instead
  const wrap = main().querySelector('.lines-wrap');
  main().querySelectorAll('tr[data-open]').forEach((r) => r.onclick = (e) => {
    if (e.target.closest('.lsel')) return;
    if (e.target.closest('.selcol')) { const cb = r.querySelector('.lsel'); cb.checked = !cb.checked; cb.onchange(); return; }
    openEditor({ report, item: items.find((i) => i.id === r.dataset.open), onDone: reload });
  });
  // Tap a receipt photo on a line: open the line with that photo, with zoom, rotate and crop
  main().querySelectorAll('.line-thumbs [data-view]').forEach((t) => t.onclick = () => {
    const it = items.find((i) => i.id === t.closest('[data-line]').dataset.line);
    if (it) openEditor({ report, item: it, onDone: reload, startPath: t.dataset.view });
  });
  // Deleting a line also deletes its receipt photos. Undo / Recently deleted bring both back.
  const delLines = async (ids) => {
    const rids = items.filter((i) => ids.includes(i.id)).flatMap((i) => (i.receipts || []).map((r) => r.id));
    try {
      await run(async () => {
        must(await sb.from('expense_items').delete().in('id', ids));
        if (rids.length) must(await sb.from('receipts').delete().in('id', rids));
      });
    } catch { return; }
    toastUndo(ids.length > 1 ? `${ids.length} lines deleted.` : 'Line deleted.', [...ids, ...rids], reload);
    reload();
  };
  main().querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirmInline(b)) return;
    delLines([b.dataset.del]);
  });
  const lboxes = [...main().querySelectorAll('.lsel')], lall = document.getElementById('lselall'), ldel = document.getElementById('ldel');
  const lsync = () => {
    const k = lboxes.filter((b) => b.checked).length;
    const bar = document.getElementById('selbar'); if (bar) bar.hidden = !k;
    const cnt = document.getElementById('selcount'); if (cnt) cnt.textContent = `${k} selected`;
    delete ldel.dataset.armed; ldel.textContent = 'Delete selected';
    // The header box covers the lines on the current page
    const vis = lboxes.filter((b) => !b.closest('tr').hidden), kv = vis.filter((b) => b.checked).length;
    if (lall) { lall.checked = kv > 0 && kv === vis.length; lall.indeterminate = kv > 0 && kv < vis.length; }
    lboxes.forEach((b) => b.closest('tr').classList.toggle('picked', b.checked));
  };
  lboxes.forEach((b) => (b.onchange = lsync));
  if (lall) lall.onchange = () => { lboxes.filter((b) => !b.closest('tr').hidden).forEach((b) => (b.checked = lall.checked)); lsync(); };
  main().querySelector('table.lines')?.addEventListener('pagechange', lsync);
  ldel.onclick = async () => {
    const ids = lboxes.filter((b) => b.checked).map((b) => b.dataset.id);
    if (!ids.length || !confirmInline(ldel, `Delete ${ids.length}?`)) return;
    delLines(ids);
  };
  const rmEl = document.getElementById('remarks'); if (rmEl) rmEl.onchange = async (e) => { await run(async () => must(await sb.from('expense_reports').update({ remarks: e.target.value }).eq('id', report.id))); };
  const chkBox = document.getElementById('chkbox'); if (chkBox) wireChecker(chkBox, report, reload);
  const sub = document.getElementById('submit');
  sub.onclick = async () => {
    if (!(await ensureSignature('submit'))) return;
    if (inbox.length && !sub.dataset.ok) {
      const box = document.getElementById('subwarn');
      box.innerHTML = `<div class="banner warn spread"><span>${inbox.length} receipt${inbox.length > 1 ? "s aren't" : " isn't"} on any line and won't be included. ${inbox.length > 1 ? 'They stay' : 'It stays'} in Needs attention for a later form.</span><span class="row"><a class="btn small" href="#/inbox">Review them</a><button class="btn small primary" id="subany">Submit anyway</button></span></div>`;
      document.getElementById('subany').onclick = () => { sub.dataset.ok = '1'; sub.dataset.armed = '1'; sub.click(); };
      return;
    }
    if (!confirmInline(sub, 'Click again to submit')) return;
    try {
      await run(async () => {
        if (inbox.length) must(await sb.from('receipts').update({ report_id: null }).in('id', inbox.map((r) => r.id)));
        must(await sb.from('expense_reports').update({ status: 'submitted', remarks: document.getElementById('remarks').value }).eq('id', report.id));
      }, report.checker_id ? `Sent to ${firstName(report.checker_name)} to check` : 'Sent to admin');
    } catch { return; } // message already shown
    reload();
  };
}
// 2-click confirm without browser dialogs
function confirmInline(btn, text = 'Click again to confirm') {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = text;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3000);
  return false;
}

/* ---------- expense editor ---------- */
async function openEditor({ report, item = null, receiptIds = [], onDone, startPath = null }) {
  let receipts = [];
  if (item) receipts = item.receipts || [];
  else if (receiptIds.length) receipts = must(await sb.from('receipts').select('*').in('id', receiptIds));
  const newFiles = [];
  let idx = Math.max(0, startPath ? receipts.findIndex((r) => r.storage_path === startPath) : 0);
  const cats = catFor(report, item?.category_id);
  const ai = !item && receipts[0]?.ai_status === 'done' ? (receipts[0].ai_data || {}) : null;
  const v = item || {
    invoice_date: ai?.invoice_date || today(), qty: 1, payment_method: 'cash_advance', merchant: ai?.merchant || '', doc_type: '',
    category_id: ai?.category_id || receipts[0]?.category_id || '',
    item: ai ? joinItem(ai.item, ai.short_name || ai.merchant) : '',
    currency: ai?.currency && ai.currency.length === 3 ? ai.currency : 'THB',
    amount: ai && (ai.currency || 'THB') === 'THB' ? ai.total_amount : '',
    original_amount: ai && ai.currency && ai.currency !== 'THB' ? ai.total_amount : '',
  };

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
  <div class="modal" role="dialog" aria-label="Expense">
    <div class="modal-head"><h2>${item?.needs_review ? 'Check expense' : (item ? 'Edit expense' : 'Add expense')}</h2>${item?.needs_review || ai ? '<span class="pill approved" style="text-transform:none">Filled in from the photo. Please check.</span>' : ''}<button class="btn ghost" data-x>Close</button></div>
    <div class="modal-body"><div class="editor">
      <div class="preview" id="pv"></div>
      <form class="form" id="ef">
        <div class="grid-form">
          <div class="field"><label>Invoice date</label><input class="input" type="date" name="invoice_date" value="${esc(v.invoice_date)}" required></div>
          <div class="field"><label>Category</label><select class="input" name="category_id" required><option value="">Choose</option>${cats.map((c) => `<option value="${c.id}" ${c.id === v.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field full" id="mlrow" hidden><label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="mileage"> Own car (mileage, ${MILE_RATE} THB/km)</label></div>
          <div class="field" data-ml hidden><label>From</label><input class="input" name="ml_from" placeholder="e.g. Office, Nimman"></div>
          <div class="field" data-ml hidden><label>To</label><input class="input" name="ml_to" placeholder="e.g. Mae Rim"></div>
          <div class="field" data-ml hidden><label>Distance (km)</label><input class="input" name="ml_km" type="number" step="0.1" min="0" placeholder="Return trip"></div>
          <div class="field" data-ml hidden><label>Amount</label><div class="input" id="mlamt" style="background:#F4F2EC">0.00 THB</div><span class="hint">km × ${MILE_RATE}, worked out for you</span></div>
          <div class="field full"><label>Item</label><input class="input" name="item" value="${esc(v.item)}" placeholder="e.g. Fuel, PTT Suea Sawat" required></div>
          <div class="field full"><label>Usage / purpose <span class="faint">(you can add it later)</span></label><textarea class="input" name="purpose" placeholder="What was it for? Which project or client?">${esc(v.purpose)}</textarea></div>
          <div class="field"><label>Amount paid (THB)</label><input class="input" name="amount" type="number" step="0.01" min="0" value="${esc(v.amount)}" required></div>
          <div class="field"><label>Qty</label><input class="input" name="qty" type="number" step="0.01" min="0.01" value="${esc(v.qty)}" required></div>
          <div class="field"><label>Paid by</label><select class="input" name="payment_method">${Object.entries(PAY).map(([k, l]) => `<option value="${k}" ${k === v.payment_method ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Document</label><select class="input" name="doc_type"><option value="">Choose</option>${Object.entries(DOCT).map(([k, l]) => `<option value="${k}" ${k === v.doc_type ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <div class="field"><label>VAT (THB) <span class="faint">if on the bill</span></label><input class="input" type="number" step="0.01" min="0" name="vat_amount" value="${v.vat_amount ?? ''}" placeholder="0.00"></div>
          <div class="field"><label>Withholding tax</label><div class="row" style="gap:6px;flex-wrap:nowrap"><select class="input" name="wht_rate" style="width:96px">${[['', 'None'], ['1', '1%'], ['2', '2%'], ['3', '3%'], ['5', '5%']].map(([k, l]) => `<option value="${k}" ${String(v.wht_rate ?? '') === k || (k && Number(v.wht_rate) === Number(k)) ? 'selected' : ''}>${l}</option>`).join('')}</select><input class="input" type="number" step="0.01" min="0" name="wht_amount" value="${v.wht_amount ?? ''}" placeholder="amount"></div><span class="hint" id="whthint">1% transport · 2% advertising · 3% services, contract work · 5% rent</span></div>
          <div class="field full"><label>Supplier <span class="faint">(company or shop name on the bill)</span></label><input class="input" name="merchant" list="favend" autocomplete="off" value="${esc(v.merchant || '')}" placeholder="Start typing, pick from FlowAccount suppliers"><datalist id="favend">${(S.faVendors || []).map((x) => `<option value="${esc(x)}">`).join('')}</datalist><span class="hint" id="favhint">${item?.merchant_raw ? `Matched from receipt (receipt says "${esc(item.merchant_raw)}"). Change if wrong.` : ''}</span><div id="favnew"></div></div>
          <div class="field"><label>Accounting code (optional)</label><input class="input mono" name="accounting_code" value="${esc(v.accounting_code)}"></div>
          <div class="field"><label>Currency on receipt</label><select class="input" name="currency">${['THB', 'USD', 'HKD', 'SGD', 'CNY', 'EUR', 'GBP', 'JPY'].map((c) => `<option ${c === v.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field" id="origf"><label>Amount on receipt</label><input class="input" name="original_amount" type="number" step="0.01" min="0" value="${esc(v.original_amount)}"><span class="hint">Amount in the receipt's currency. The THB above is worked out from the exchange rate.</span></div>
          <div class="field full" id="fxrow" hidden><span class="hint" id="fxnote"></span></div>
        </div>
        ${!item && ai?.held_reason === 'duplicate' ? `<div class="banner bad" style="font-size:13px"><b>Possible duplicate.</b> Same store, date${ai.duplicate_item?.receipt_time ? ', time' : ''} and amount as your line from ${dateLabel(ai.duplicate_item?.invoice_date)}: ${esc(ai.duplicate_item?.item || '')}. Only save if this is really a separate expense. Otherwise press <b>Delete receipt</b> below.</div>` : ''}
        ${item?.duplicate_of ? `<div class="banner bad" style="font-size:13px"><b>Possible duplicate.</b> Another of your expense lines has the same date and amount.<br><label style="display:flex;gap:8px;align-items:center;margin-top:6px;color:var(--ink)"><input type="checkbox" name="duplicate_ok" ${item.duplicate_ok ? 'checked' : ''}> This is a separate expense, not a duplicate</label></div>` : ''}
        <div id="dupnote"></div>
        <div id="grp"></div>
        <div class="field"><label>Receipts</label>
          <div class="thumbs" id="rlist"></div>
          <div class="addmore" id="addmore"><a href="#" id="drop">+ Add another paper</a><a href="#" id="upick">Choose from uploaded</a><span class="faint">or drop files on the photo</span><input type="file" id="df" multiple accept="image/*,application/pdf" hidden></div>
        </div>
        <div class="error" id="eerr"></div>
      </form>
    </div></div>
    <div class="modal-foot"><span class="faint" style="font-size:12px">${esc(report.ref_no)}</span><div class="row">${item || receiptIds.length ? `<button class="btn ghost danger" id="edel">${item ? 'Delete line' : 'Delete receipt'}</button>` : ''}<button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="save">Save</button></div></div>
  </div>`;
  document.body.appendChild(back);
  const f = back.querySelector('#ef');
  // Supplier: pick from FlowAccount's list, or add a new one on the spot (it goes to FlowAccount with the month's file)
  {
    const box = back.querySelector('#favnew'), h = back.querySelector('#favhint'), raw = item?.merchant_raw;
    const guessType = (t) => (/(co\.?,?\s*ltd|company|limited|inc\.?|corp|บริษัท|ห้างหุ้นส่วน|หจก|จำกัด)/i.test(t) ? 'Corporation' : 'Individual');
    const vh = () => {
      if (!box || !(S.faVendors || []).length) return;
      const v2 = f.merchant.value.trim(), known = v2 && S.faVendorSet.has(v2.toLowerCase());
      if (['receipt_form', 'cash_bill'].includes(f.doc_type?.value) || f.mileage?.checked) { box.innerHTML = ''; h.textContent = ''; return; }
      h.textContent = known ? (raw && v2 !== raw ? `Matched from receipt (receipt says "${raw}"). Change if wrong.` : '') : v2 ? 'Not in the list yet. Pick one above or add it as a new supplier.' : 'Pick a supplier from the list (needed before submitting).';
      if (known || !v2) { box.innerHTML = ''; return; }
      const sim = similarSuppliers(v2).filter((x) => x.toLowerCase() !== v2.toLowerCase());
      box.innerHTML = `${sim.length ? `<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap"><span class="faint" style="font-size:12px">Did you mean</span>${sim.map((x) => `<button type="button" class="btn small" data-use="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}<button type="button" class="btn small" id="favadd" style="margin-top:6px">+ Add "${esc(v2)}" as a new supplier</button>`;
      box.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => { f.merchant.value = b.dataset.use; vh(); }));
      box.querySelector('#favadd').onclick = () => {
        const t = guessType(v2);
        box.innerHTML = `<div class="card card-pad" style="margin-top:8px;background:#F8F7F3"><b>New supplier</b><div class="faint" style="font-size:12px;margin-bottom:8px">Goes to FlowAccount with this month's file.</div>
          <div class="grid-form"><div class="field full"><label>Business name (as on the receipt)</label><input class="input" id="nvname" value="${esc(v2)}"></div>
          <div class="field"><label>Type</label><select class="input" id="nvtype"><option value="Corporation" ${t === 'Corporation' ? 'selected' : ''}>Company</option><option value="Individual" ${t === 'Individual' ? 'selected' : ''}>Person</option></select></div>
          <div class="field"><label>Tax ID <span class="faint">(if on the bill)</span></label><input class="input mono" id="nvtax" inputmode="numeric" placeholder="10 or 13 digits"></div>
          <div class="field full"><label>Address <span class="faint">(if on the bill)</span></label><textarea class="input" id="nvaddr" rows="2" placeholder="Number, road, district, province, postcode"></textarea></div>
          <div class="field"><label>Phone number <span class="faint">(if on the bill)</span></label><input class="input mono" id="nvphone" inputmode="tel" placeholder="053 123 456"></div></div>
          <div class="error" id="nverr"></div><div class="row" style="justify-content:flex-end;margin-top:8px"><button type="button" class="btn ghost small" id="nvx">Cancel</button><button type="button" class="btn primary small" id="nvok">Add supplier</button></div></div>`;
        box.querySelector('#nvx').onclick = vh;
        box.querySelector('#nvok').onclick = async () => {
          const name = box.querySelector('#nvname').value.trim(), tax = box.querySelector('#nvtax').value.replace(/\D/g, ''), err = box.querySelector('#nverr');
          if (!name) { err.textContent = 'Enter the name.'; return; }
          if (tax && !/^(\d{10}|\d{13})$/.test(tax)) { err.textContent = 'Tax ID must be 10 or 13 digits, or leave it blank.'; return; }
          if (S.faVendorSet.has(name.toLowerCase())) { f.merchant.value = name; vh(); return; }
          const { error } = await sb.from('fa_new_vendors').insert({ name, business_type: box.querySelector('#nvtype').value, tax_id: tax || null, address: box.querySelector('#nvaddr').value.trim() || null, phone: box.querySelector('#nvphone').value.trim() || null, created_by: S.user.id, created_by_name: S.profile.full_name });
          if (error) { err.textContent = /duplicate|unique/i.test(error.message) ? 'Someone already added this supplier. Pick it from the list.' : error.message; return; }
          S.faVendors.push(name); S.faVendorSet.add(name.toLowerCase());
          const dl = back.querySelector('#favend'); if (dl) dl.insertAdjacentHTML('beforeend', `<option value="${esc(name)}">`);
          f.merchant.value = name; toast('Supplier added'); vh();
        };
      };
    };
    f.merchant.addEventListener('change', vh); f.merchant.addEventListener('input', () => { clearTimeout(f.__vt); f.__vt = setTimeout(vh, 300); });
    f.doc_type?.addEventListener('change', vh); setTimeout(vh, 0);
  }
  // Mileage: under Transportation, a tick box turns the line into own-car mileage (km x rate, map screenshot as receipt)
  {
    const isTr = () => /transport/i.test(cats.find((c) => c.id === f.category_id.value)?.name || '');
    const hideNames = ['item', 'amount', 'qty', 'payment_method', 'doc_type', 'vat_amount', 'wht_rate', 'merchant', 'currency', 'original_amount', 'accounting_code'];
    const mlCalc = () => {
      if (!f.mileage.checked) return;
      const km = Number(f.ml_km.value || 0);
      f.amount.value = (Math.round(km * MILE_RATE * 100) / 100).toFixed(2); f.qty.value = 1;
      f.payment_method.value = 'own_money'; f.doc_type.value = 'receipt_form'; f.currency.value = 'THB';
      f.vat_amount.value = ''; f.wht_rate.value = ''; f.merchant.value = '';
      f.item.value = `Mileage: ${f.ml_from.value.trim() || '?'} → ${f.ml_to.value.trim() || '?'}, ${km} km`;
      back.querySelector('#mlamt').textContent = `${money(Number(f.amount.value))} THB`;
    };
    const mlShow = () => {
      const tr = isTr(); back.querySelector('#mlrow').hidden = !tr;
      const was = f.__ml; if (!tr) f.mileage.checked = false;
      const on = f.mileage.checked; f.__ml = on;
      // Turning mileage off: undo what it filled in, so the line is a normal receipt again
      if (was && !on) { if (f.doc_type.value === 'receipt_form') f.doc_type.value = ''; if (MILE_RE.test(f.item.value)) f.item.value = ''; f.amount.value = ''; f.merchant.dispatchEvent(new Event('change')); }
      back.querySelectorAll('[data-ml]').forEach((el) => (el.hidden = !on));
      hideNames.forEach((n) => { const el = f[n]?.closest('.field'); if (el) el.hidden = on; });
      ['origf', 'fxrow'].forEach((id) => { const el = back.querySelector('#' + id); if (el && on) el.hidden = true; });
      ['ml_from', 'ml_to', 'ml_km'].forEach((n) => (f[n].required = on));
      const d = back.querySelector('#pvdrop b'); if (d) d.textContent = on ? 'Drop the Google Maps screenshot here' : 'Drop receipt files here';
      if (on) mlCalc();
    };
    const m = MILE_RE.exec(f.item.value || '');
    if (m) { f.mileage.checked = true; f.ml_from.value = m[1]; f.ml_to.value = m[2]; f.ml_km.value = m[3]; }
    f.category_id.addEventListener('change', mlShow); f.mileage.addEventListener('change', mlShow);
    ['ml_from', 'ml_to', 'ml_km'].forEach((n) => f[n].addEventListener('input', mlCalc));
    setTimeout(mlShow, 0);
  }
  // WHT: the amount paid is what the vendor received (after WHT), so WHT = paid x rate / (100 - rate). Editable.
  const whtCalc = () => { const r = Number(f.wht_rate?.value || 0); if (!f.wht_amount) return; if (!r) { f.wht_amount.value = ''; f.wht_amount.disabled = true; return; } f.wht_amount.disabled = false; if (f.wht_amount.dataset.manual) return; const a = Number(f.amount.value || 0); f.wht_amount.value = a ? (Math.round((a * r / (100 - r)) * 100) / 100).toFixed(2) : ''; };
  if (f.wht_rate) { f.wht_rate.addEventListener('change', () => { delete f.wht_amount.dataset.manual; whtCalc(); }); f.amount.addEventListener('input', whtCalc); f.wht_amount.addEventListener('input', () => { f.wht_amount.dataset.manual = '1'; }); if (f.wht_amount.value) f.wht_amount.dataset.manual = '1'; whtCalc(); }
  const close = () => back.remove();
  back.querySelectorAll('[data-x]').forEach((b) => b.onclick = close);
  back.onclick = (e) => { if (e.target === back) close(); };

  const all = () => [...receipts.map((r) => ({ kind: 'saved', r })), ...newFiles.map((file) => ({ kind: 'new', file, get rot() { return file._rot || 0; }, set rot(v) { file._rot = v; } }))];
  const zs = { z: 1, x: 0, y: 0 };
  // Fill the form from what was read
  // onlyEmpty: keep anything already typed (used when adding papers to an existing line)
  const fillFrom = (d, onlyEmpty = false) => {
    if (!d) return;
    const put = (el, val) => { if (val == null || val === '') return; if (onlyEmpty && el.value && !(el === f.invoice_date && el.value === today())) return; el.value = val; };
    put(f.invoice_date, d.invoice_date);
    if (d.vat_amount != null && f.vat_amount) put(f.vat_amount, d.vat_amount);
    put(f.category_id, d.category_id);
    put(f.item, joinItem(d.item, d.short_name || d.merchant));
    const cur = (d.currency || 'THB').toUpperCase();
    if (!onlyEmpty && [...f.currency.options].some((o) => o.value === cur)) f.currency.value = cur;
    if (d.total_amount != null) { if (f.currency.value === 'THB') put(f.amount, d.total_amount); else put(f.original_amount, d.total_amount); }
    if (d.receipt_time && !item) aiTime = d.receipt_time;
    if (d.merchant && !item) aiMerchant = d.merchant;
    if (cur !== 'THB' && !onlyEmpty) f.amount.dataset.auto = '1';
    syncCur(); autoFx();
  };
  let aiTime = null, aiMerchant = null, groupRun = 0;
  const toB64 = async (file) => {
    const x = await compress(file);
    if (x.size > 4 * 1024 * 1024) return null;
    const bytes = new Uint8Array(await x.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mime: x.type, data: btoa(bin) };
  };
  // Read every attached paper together: same purchase (receipt + slip + order page) or a different one?
  const analyze = async (cacheOnly = false) => {
    const list = all(); const box = back.querySelector('#grp');
    if (!list.length) { box.innerHTML = ''; return; }
    const ckey = 'bo_grp_' + list.map((x) => (x.kind === 'saved' ? x.r.id : '')).sort().join(',');
    const cacheable = list.every((x) => x.kind === 'saved');
    let cached = null; try { cached = cacheable ? JSON.parse(localStorage.getItem(ckey) || 'null') : null; } catch { /* ignore */ }
    const run_ = ++groupRun;
    box.innerHTML = '<div class="banner info" style="font-size:13px">Reading the attached papers</div>';
    const saved = list.filter((x) => x.kind === 'saved'), fresh = list.filter((x) => x.kind === 'new');
    const files = [];
    for (const x of fresh) { const b = await toB64(x.file); if (!b) { box.innerHTML = '<div class="banner warn" style="font-size:13px">A file is too large to read automatically. Please fill in the details.</div>'; return; } files.push(b); }
    const order = [...saved, ...fresh];
    let data, error;
    if (cached) data = cached;
    else ({ data, error } = await sb.functions.invoke('bo-read-receipt', { body: { mode: 'group', saved_ids: saved.map((x) => x.r.id), files } }));
    if (run_ !== groupRun || !back.isConnected) return;
    if (cacheable && !cached && data?.status === 'done') { try { localStorage.setItem(ckey, JSON.stringify(data)); } catch { /* ignore */ } }
    if (cacheOnly && ((data?.groups || []).length < 2 || localStorage.getItem(ckey + '_ok'))) { box.innerHTML = ''; return; }
    if (error || data?.status !== 'done') { box.innerHTML = '<div class="banner warn" style="font-size:13px">Could not read the papers. Please fill in the details.</div>'; return; }
    const groups = data.groups || [];
    const label = (x) => esc(x.kind === 'saved' ? (x.r.file_name || 'Receipt') : x.file.name);
    const main = groups.find((g) => g.docs.includes(0)) || groups[0];
    if (main) fillFrom(main, !!item);
    const kinds = main ? main.docs.map((d, k) => `${label(order[d])}: ${esc(main.kinds?.[k] || 'paper')}`).join(', ') : '';
    const others = groups.filter((g) => g !== main);
    // A photo with several separate receipts on it: read it the Add receipts way (1 line each, auto-cropped)
    const multi = [];
    for (const g of groups) (g.receipts_in_doc || []).forEach((n, k) => { if (Number(n) > 1 && g.docs[k] != null) multi.push({ x: order[g.docs[k]], n: Number(n) }); });
    if (!item && multi.length) {
      const total = multi.reduce((a, m) => a + m.n, 0);
      box.innerHTML = `<div class="banner warn" style="font-size:13px"><b>${multi.length > 1 ? `${multi.length} photos show` : 'This photo shows'} ${total} separate receipts.</b>
        <div style="margin:6px 0 8px">Each receipt should be its own line. The photo will be cut into 1 image per receipt.</div>
        <div class="row" style="gap:8px"><button type="button" class="btn small primary" id="mkmulti">Read as ${total} lines</button><button type="button" class="btn small ghost" id="keepone">Keep as 1 line</button></div></div>`;
      box.querySelector('#keepone').onclick = () => { box.innerHTML = '<div class="banner info" style="font-size:13px">Keeping it as 1 line. Please check the details.</div>'; };
      box.querySelector('#mkmulti').onclick = async (e) => {
        const b = e.target; b.disabled = true; b.textContent = 'Reading';
        const notes = [];
        for (const m of multi) {
          try {
            if (m.x.kind === 'new') {
              const i = newFiles.indexOf(m.x.file); if (i >= 0) newFiles.splice(i, 1);
              const res = await snapAndRead(m.x.file, report, 'desktop'); notes.push(res.html || esc(res.text));
            } else {
              const i = receipts.indexOf(m.x.r); if (i >= 0) receipts.splice(i, 1);
              await sb.from('receipts').update({ report_id: report.id }).eq('id', m.x.r.id);
              const res = await readReceipt(m.x.r.id);
              if (res.status === 'done' && (res.count || 1) > 1) { try { await autoSplit(m.x.r.storage_path, res.results || []); } catch { /* keep full photo */ } }
              notes.push(`Read ${res.count || 1} receipts from the photo.`);
            }
          } catch (err) { notes.push(esc(friendly(err))); }
        }
        await refreshCounts();
        if (!all().length) { close(); onDone && onDone(); toast('Done. Add the purpose on each new line.'); return; }
        idx = 0; drawPreview();
        box.innerHTML = `<div class="banner info" style="font-size:13px">${notes.join('<br>')}<br>Add the purpose on each new line in the form.</div>`;
        onDone && onDone();
      };
      return;
    }
    if (!item && groups.length > 1) {
      // Step through the purchases 1 at a time: big photo on the left, its details in the form
      const saveBtn = back.querySelector('#save');
      const readForm = () => { const d = Object.fromEntries(new FormData(f)); return { invoice_date: d.invoice_date, category_id: d.category_id, item: d.item.trim(), purpose: (d.purpose || '').trim(), amount: d.amount, qty: d.qty, payment_method: d.payment_method, doc_type: d.doc_type, merchant: (d.merchant || '').trim(), vat_amount: d.vat_amount, wht_rate: d.wht_rate, wht_amount: d.wht_amount, accounting_code: (d.accounting_code || '').trim(), currency: d.currency, original_amount: d.original_amount }; };
      const loadForm = (g) => {
        if (g.v) { for (const [k, val] of Object.entries(g.v)) if (f[k]) f[k].value = val ?? ''; syncCur(); return; }
        const keepPurpose = g === main && step < 0 ? f.purpose.value : '';
        for (const k of ['item', 'amount', 'invoice_date', 'category_id', 'accounting_code', 'original_amount']) f[k].value = '';
        f.qty.value = 1; f.purpose.value = keepPurpose;
        fillFrom(g);
      };
      let step = -1;
      const show = (i) => {
        if (step >= 0) groups[step].v = readForm();
        step = i; const g = groups[i];
        loadForm(g);
        const first = order[g.docs[0]];
        const pi = all().findIndex((x) => (x.kind === 'saved' ? x.r === first.r : x.file === first.file));
        if (pi >= 0) { idx = pi; zs.z = 1; zs.x = 0; zs.y = 0; drawPreview(); }
        const last = i === groups.length - 1;
        box.innerHTML = `<div class="banner warn" style="font-size:13px">
          <div class="spread"><b>${groups.length} different purchases · checking ${i + 1} of ${groups.length}</b><span class="faint">${g.docs.map((d, k) => esc(g.kinds?.[k] || 'paper')).join(' + ')}</span></div>
          ${!g.invoice_date || g.total_amount == null || !g.category_id ? `<div style="margin-top:6px;color:var(--bad)"><b>Missing on the paper:</b> ${[!g.invoice_date && 'date', g.total_amount == null && 'amount', !g.category_id && 'category'].filter(Boolean).join(', ')}. Please fill ${!g.invoice_date && g.total_amount == null ? 'them' : 'it'} in.</div>` : ''}
          <div style="margin:6px 0 8px">Check the photo on the left and the details below, add the purpose${last ? ', then create the lines' : ', then go to the next'}.${g.docs.length > 1 ? ' Use the dots under the photo to see each paper of this purchase.' : ''}</div>
          <div class="row" style="gap:8px">${i > 0 ? '<button type="button" class="btn small" id="stepback">Back</button>' : ''}
            ${last ? `<button type="button" class="btn small primary" id="mklines">Create ${groups.length} lines</button>` : '<button type="button" class="btn small primary" id="stepnext">Next purchase</button>'}
            <button type="button" class="btn small ghost" id="keepall">Keep all on this line</button></div></div>`;
        const nx = box.querySelector('#stepnext'), bk = box.querySelector('#stepback'), mk = box.querySelector('#mklines');
        // Every purchase must be complete before moving on, so none is silently left behind
        const ok = () => { if (f.reportValidity()) return true; toast('Fill in the missing details for this purchase first', true); return false; };
        if (nx) nx.onclick = () => { if (ok()) show(i + 1); };
        if (bk) bk.onclick = () => show(i - 1);
        if (mk) mk.onclick = () => { if (!ok()) return; groups[step].v = readForm(); makeLines(groups, order); };
        box.querySelector('#keepall').onclick = () => {
          saveBtn.hidden = false; fillFrom(main); step = -1;
          box.innerHTML = '<div class="banner info" style="font-size:13px">Keeping all papers on this line. Please check the details.</div>';
        };
        box.scrollIntoView({ block: 'nearest' });
      };
      saveBtn.hidden = true;
      show(0);
      return;
    }
    box.innerHTML = `<div class="banner ${others.length ? 'warn' : 'info'}" style="font-size:13px">
      ${main ? `<div><b>${main.docs.length > 1 ? 'Same purchase' : 'Read'}:</b> ${kinds}. ${item ? 'Empty fields filled in.' : 'Details filled in.'} Please check.</div>` : ''}
      ${others.map((g, gi) => `<div style="margin-top:8px"><b>Different purchase:</b> ${g.docs.map((d) => label(order[d])).join(', ')} (${esc(g.short_name || g.merchant || 'unknown')}${g.total_amount != null ? ', ' + esc(g.currency || 'THB') + ' ' + money(g.total_amount) : ''}${g.invoice_date ? ', ' + dateLabel(g.invoice_date) : ''}).
        <span class="row" style="display:inline-flex;gap:6px;margin-left:4px"><button type="button" class="btn small" data-split="${gi}">Make it a separate line</button><button type="button" class="btn small ghost" data-keep="${gi}">Keep here</button></span></div>`).join('')}
    </div>`;
    box.querySelectorAll('[data-keep]').forEach((b) => b.onclick = () => { b.closest('div').remove(); if (cacheable) try { localStorage.setItem(ckey + '_ok', '1'); } catch { /* ignore */ } });
    box.querySelectorAll('[data-split]').forEach((b) => b.onclick = async () => {
      const g = others[Number(b.dataset.split)];
      const items_ = g.docs.map((d) => order[d]);
      b.disabled = true; b.textContent = 'Moving';
      for (const x of items_) {
        if (x.kind === 'new') {
          const i = newFiles.indexOf(x.file); if (i >= 0) newFiles.splice(i, 1);
          try { const m = await run(() => snapAndRead(x.file, report, 'desktop')); toast(m.text || 'Added as a separate line'); } catch { /* shown */ }
        } else {
          const i = receipts.indexOf(x.r); if (i >= 0) receipts.splice(i, 1);
          await sb.from('receipts').update({ item_id: null, report_id: report.id }).eq('id', x.r.id);
          if (item) await sb.from('receipts').update({ item_id: null }).eq('id', x.r.id);
          await readReceipt(x.r.id);
        }
      }
      idx = 0; drawPreview(); analyze(); onDone && refreshCounts();
    });
  };
  // Draw the image rotated onto a canvas (full resolution)
  async function rotatedCanvas(url, rot) {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const side = rot === 90 || rot === 270;
    const c = document.createElement('canvas');
    c.width = side ? bmp.height : bmp.width; c.height = side ? bmp.width : bmp.height;
    const g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2); g.rotate((rot * Math.PI) / 180);
    g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return c;
  }
  async function startCrop(cur, url, rot) {
    const pv = back.querySelector('#pv');
    pv.innerHTML = '<div class="none">Loading</div>';
    let c;
    try { c = await rotatedCanvas(url, rot); } catch { toast('Could not open the photo for cropping', true); return drawPreview(); }
    pv.innerHTML = `<div class="crop-stage"><canvas id="cc"></canvas><div class="crop-box" id="cb" hidden></div></div>
      <div class="pv-tools"><span class="pv-hint">Drag a box around 1 receipt</span><button type="button" id="cok" disabled>Apply crop and read</button><button type="button" id="cx">Cancel</button></div>`;
    const cc = pv.querySelector('#cc');
    const maxW = pv.clientWidth - 24, maxH = Math.max(320, pv.clientHeight - 70);
    const k = Math.min(maxW / c.width, maxH / c.height, 1);
    cc.width = Math.round(c.width * k); cc.height = Math.round(c.height * k);
    cc.getContext('2d').drawImage(c, 0, 0, cc.width, cc.height);
    const box = pv.querySelector('#cb'); let sel = null, start = null;
    const pos = (e) => { const r = cc.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: Math.max(0, Math.min(r.width, t.clientX - r.left)), y: Math.max(0, Math.min(r.height, t.clientY - r.top)) }; };
    const draw = () => { if (!sel) return; box.hidden = false; Object.assign(box.style, { left: cc.offsetLeft + sel.x + 'px', top: cc.offsetTop + sel.y + 'px', width: sel.w + 'px', height: sel.h + 'px' }); };
    const down = (e) => { e.preventDefault(); start = pos(e); sel = { x: start.x, y: start.y, w: 0, h: 0 }; draw(); };
    const move = (e) => { if (!start) return; e.preventDefault(); const p2 = pos(e); sel = { x: Math.min(start.x, p2.x), y: Math.min(start.y, p2.y), w: Math.abs(p2.x - start.x), h: Math.abs(p2.y - start.y) }; draw(); };
    const up = () => { start = null; pv.querySelector('#cok').disabled = !(sel && sel.w > 20 && sel.h > 20); };
    cc.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    cc.addEventListener('touchstart', down, { passive: false }); cc.addEventListener('touchmove', move, { passive: false }); cc.addEventListener('touchend', up);
    const cleanup = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    pv.querySelector('#cx').onclick = () => { cleanup(); drawPreview(); };
    pv.querySelector('#cok').onclick = async () => {
      cleanup();
      const sx = Math.round(sel.x / k), sy = Math.round(sel.y / k), sw = Math.round(sel.w / k), sh = Math.round(sel.h / k);
      const out = document.createElement('canvas'); out.width = sw; out.height = sh;
      out.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
      const name = 'cropped.jpg';
      if (cur.kind === 'saved') {
        pv.innerHTML = '<div class="none">Saving crop and reading</div>';
        try {
          const path = `${S.user.id}/${crypto.randomUUID()}.jpg`;
          must(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' }));
          // Only this receipt gets the cropped image; other lines keep the full photo
          must(await sb.from('receipts').update({ storage_path: path, mime_type: 'image/jpeg', rotation: 0, file_hash: null, file_name: name }).eq('id', cur.r.id));
          Object.assign(cur.r, { storage_path: path, mime_type: 'image/jpeg', rotation: 0, file_name: name });
          const { data } = await sb.functions.invoke('bo-read-receipt', { body: { receipt_id: cur.r.id, preview: true } });
          if (data?.status === 'done') { cur.r.ai_data = data.data; fillFrom(data.data); toast('Cropped and read. Please check the details.'); }
          else toast('Cropped. It could not be read, please fill in the details.', true);
        } catch (e) { toast(friendly(e), true); }
      } else {
        const i = newFiles.indexOf(cur.file);
        if (i >= 0) newFiles[i] = new File([blob], name, { type: 'image/jpeg' });
        toast('Cropped. It will be read after you save.');
      }
      zs.z = 1; zs.x = 0; zs.y = 0;
      drawPreview();
    };
  }
  async function drawPreview() {
    const list = all();
    const pv = back.querySelector('#pv');
    if (!list.length) {
      pv.innerHTML = `<div class="pv-drop" id="pvdrop"><b>Drop receipt files here</b><span>or</span>
        <div class="row" style="justify-content:center"><button type="button" class="btn" id="pvpick">Choose files</button><button type="button" class="btn" id="pvup">Choose from uploaded</button></div>
        <small>Receipt, payment slip, order page. Several files for the same purchase are fine.</small></div>`;
      pv.querySelector('#pvpick').onclick = () => df.click();
      pv.querySelector('#pvup').onclick = pickUploaded;
    }
    else {
      idx = Math.min(idx, list.length - 1);
      const cur = list[idx];
      let url, mime;
      if (cur.kind === 'saved') { url = await signedUrl(cur.r.storage_path); mime = cur.r.mime_type; }
      else { url = URL.createObjectURL(cur.file); mime = cur.file.type; }
      const isImg = mime?.startsWith('image/') && !/hei[cf]/.test(mime);
      const rot = cur.kind === 'saved' ? (cur.r.rotation || 0) : (cur.rot || 0);
      const tf = () => `translate(${zs.x}px, ${zs.y}px) scale(${zs.z}) rotate(${rot}deg)`;
      pv.innerHTML = (isImg
        ? `<div class="zoom-stage" id="zst"><img id="pimg" class="${rotCls(rot)}" src="${esc(url)}" alt="Receipt" draggable="false" style="transform:${tf()}"></div>
           <div class="pv-tools">
             <button type="button" id="zo" title="Zoom out">−</button><button type="button" id="zi" title="Zoom in">+</button><button type="button" id="zf" title="Fit">Fit</button>
             <button type="button" id="rotb" title="Rotate 90 degrees">Rotate ↻</button>
             <button type="button" id="crb" title="Crop to 1 receipt">Crop</button>
             ${cur.kind === 'saved' ? '<button type="button" id="rdb" title="Read this receipt again">Read again</button>' : ''}
           </div>`
        : `<iframe src="${esc(url)}" title="Receipt"></iframe>`)
        + (list.length > 1 ? `<div class="preview-nav">${list.map((_, n) => `<button type="button" data-i="${n}">${n === idx ? '●' : n + 1}</button>`).join('')}</div>` : '');
      pv.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { idx = Number(b.dataset.i); zs.z = 1; zs.x = 0; zs.y = 0; drawPreview(); });
      if (!isImg) return;
      const img = pv.querySelector('#pimg'), st = pv.querySelector('#zst');
      const apply = () => { img.style.transform = tf(); st.classList.toggle('zoomed', zs.z > 1); };
      const zoom = (factor) => { zs.z = Math.min(6, Math.max(1, zs.z * factor)); if (zs.z === 1) { zs.x = 0; zs.y = 0; } apply(); };
      pv.querySelector('#zi').onclick = () => zoom(1.4);
      pv.querySelector('#zo').onclick = () => zoom(1 / 1.4);
      pv.querySelector('#zf').onclick = () => { zs.z = 1; zs.x = 0; zs.y = 0; apply(); };
      st.onwheel = (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
      let drag = null;
      st.onmousedown = (e) => { if (zs.z > 1) drag = { x: e.clientX - zs.x, y: e.clientY - zs.y }; };
      st.onmousemove = (e) => { if (drag) { zs.x = e.clientX - drag.x; zs.y = e.clientY - drag.y; apply(); } };
      st.onmouseup = st.onmouseleave = () => { drag = null; };
      st.ondblclick = () => zoom(zs.z > 1 ? 0 : 2);
      pv.querySelector('#rotb').onclick = async () => {
        const next = (rot + 90) % 360;
        if (cur.kind === 'saved') {
          cur.r.rotation = next;
          const { error } = await sb.from('receipts').update({ rotation: next }).eq('storage_path', cur.r.storage_path).eq('staff_id', S.user.id);
          if (error) toast(friendly(error), true);
        } else cur.rot = next;
        drawPreview();
      };
      pv.querySelector('#crb').onclick = () => startCrop(cur, url, rot);
      const rdb = pv.querySelector('#rdb');
      if (rdb) rdb.onclick = async () => {
        rdb.disabled = true; rdb.textContent = 'Reading';
        const { data } = await sb.functions.invoke('bo-read-receipt', { body: { receipt_id: cur.r.id, preview: true } });
        if (data?.status === 'done') {
          cur.r.ai_data = data.data; fillFrom(data.data);
          toast(data.found > 1 ? `Read again. This photo has ${data.found} receipts, so the first one was used. Crop to 1 receipt for best results.` : 'Read again. Please check the details.');
        } else toast('Could not read it. Try cropping to 1 receipt.', true);
        rdb.disabled = false; rdb.textContent = 'Read again';
      };
    }
    back.querySelector('#addmore').hidden = !list.length;
    back.querySelector('#rlist').closest('.field').querySelector('label').hidden = !list.length;
    back.querySelector('#rlist').innerHTML = list.map((x, n) => `<span class="pill" style="text-transform:none">${esc(x.kind === 'saved' ? (x.r.file_name || 'Receipt') : x.file.name)} <a href="#" data-rm="${n}" title="Remove">×</a></span>`).join(' ');
    back.querySelectorAll('[data-rm]').forEach((a) => a.onclick = (e) => {
      e.preventDefault(); const n = Number(a.dataset.rm);
      if (n < receipts.length) receipts.splice(n, 1); else newFiles.splice(n - receipts.length, 1);
      drawPreview();
    });
  }
  const origf = back.querySelector('#origf');
  const syncCur = () => { origf.style.display = f.currency.value === 'THB' ? 'none' : ''; back.querySelector('#fxrow').hidden = f.currency.value === 'THB'; };
  // Foreign receipts: THB = amount on receipt x reference rate of the invoice date (staff can overwrite)
  const autoFx = async () => {
    syncCur();
    const cur = f.currency.value, orig = Number(f.original_amount.value), date = f.invoice_date.value, note = back.querySelector('#fxnote');
    if (cur === 'THB') return;
    if (!orig || !date) { note.textContent = 'Enter the date and the amount on the receipt to work out the THB.'; return; }
    const rate = await fxRate(cur, date);
    if (!rate) { note.textContent = `No exchange rate found for ${cur} on ${dateLabel(date)}. Enter the THB you paid.`; return; }
    if (!f.amount.value || f.amount.dataset.auto === '1') { f.amount.value = (Math.round(orig * rate * 100) / 100).toFixed(2); f.amount.dataset.auto = '1'; }
    note.textContent = `1 ${cur} = ${rate.toFixed(4)} THB on ${dateLabel(date)} (mid-market rate, like the Xe app). ${cur} ${money(orig)} = THB ${money(orig * rate)}. If you know the THB you actually paid, type it in instead.`;
  };
  f.amount.addEventListener('input', () => { f.amount.dataset.auto = '0'; });
  ['currency', 'original_amount', 'invoice_date'].forEach((k) => f[k].addEventListener('change', autoFx));
  f.original_amount.addEventListener('input', autoFx);
  f.currency.onchange = autoFx; syncCur(); if (f.currency.value !== 'THB') { if (!item) f.amount.dataset.auto = '1'; autoFx(); }
  // Choose photos already in the system that are not on any line yet (e.g. in Needs attention)
  async function pickUploaded() {
    const rows = must(await sb.from('receipts').select('*').eq('staff_id', S.user.id).is('item_id', null).or(`report_id.eq.${report.id},report_id.is.null`).order('created_at', { ascending: false }).limit(60))
      .filter((r) => !receipts.some((x) => x.id === r.id));
    const pk = document.createElement('div'); pk.className = 'modal-back'; pk.style.zIndex = 60;
    pk.innerHTML = `<div class="modal" style="max-width:760px"><div class="modal-head"><h2>Choose from uploaded</h2><button class="btn ghost" data-px>Close</button></div>
      <div class="modal-body" style="padding:16px">${rows.length ? `<p class="muted" style="margin:0 0 10px">Photos you uploaded that are not on any line yet. Tap to select.</p>
        <div class="recent pick-grid">${(await Promise.all(rows.map(async (r) => `<div class="tile" data-pid="${r.id}">${await thumbHtml(r)}<div class="pick-cap">${esc((r.ai_data && (r.ai_data.short_name || r.ai_data.merchant)) || 'Receipt')}${r.ai_data?.total_amount != null ? ' · ' + money(r.ai_data.total_amount) : ''}</div></div>`))).join('')}</div>` : '<div class="empty">No unused photos. Everything you uploaded is already on a line.</div>'}</div>
      <div class="modal-foot"><span class="faint" id="pkn"></span><div class="row"><button class="btn ghost" data-px>Cancel</button><button class="btn primary" id="pkok" disabled>Attach</button></div></div></div>`;
    document.body.appendChild(pk);
    const shut = () => pk.remove();
    pk.querySelectorAll('[data-px]').forEach((b) => b.onclick = shut);
    pk.onclick = (e) => { if (e.target === pk) shut(); };
    const ok = pk.querySelector('#pkok');
    pk.querySelectorAll('[data-pid]').forEach((t) => t.onclick = (e) => {
      e.stopPropagation(); t.classList.toggle('picked');
      const k = pk.querySelectorAll('.picked').length; ok.disabled = !k; pk.querySelector('#pkn').textContent = k ? `${k} selected` : '';
    });
    ok.onclick = () => {
      const ids = [...pk.querySelectorAll('.picked')].map((t) => t.dataset.pid);
      receipts.push(...rows.filter((r) => ids.includes(r.id)));
      shut(); idx = Math.max(0, all().length - 1); drawPreview(); analyze();
    };
  }
  // 1 line per purchase. The purchase shown in the form keeps what was typed (e.g. the purpose).
  async function makeLines(groups, order) {
    const btn = back.querySelector('#mklines'); if (btn) { btn.disabled = true; btn.textContent = 'Creating lines'; }
    const misc = S.categories.find((c) => /misc/i.test(c.name))?.id;
    let made = 0, held = 0;
    for (const g of groups) {
      const papers = g.docs.map((n) => order[n]);
      const v = g.v || {};
      const amount = v.amount ? Number(v.amount) : (g.currency || 'THB') === 'THB' ? Number(g.total_amount) : NaN;
      const date = v.invoice_date || g.invoice_date;
      const cat = v.category_id || g.category_id || null;
      g.purpose = v.purpose || '';
      try {
        if (!Number.isFinite(amount) || amount <= 0 || !date || !cat) {
          // Not enough to make a line: leave the papers in Needs attention
          for (const x of papers) if (x.kind === 'new') await uploadReceipt(x.file, { reportId: report.id });
          held++; continue;
        }
        const row = must(await sb.from('expense_items').insert({
          report_id: report.id, invoice_date: date, receipt_time: g.receipt_time || null, merchant: g.merchant || null,
          item: v.item || joinItem(g.item, g.short_name || g.merchant) || 'Receipt',
          category_id: (cat && catFor(report).some((c) => c.id === cat)) ? cat : misc, purpose: g.purpose || '', qty: v.qty ? Number(v.qty) : 1, amount,
          currency: v.currency || 'THB', original_amount: v.currency && v.currency !== 'THB' && v.original_amount ? Number(v.original_amount) : null,
          exchange_rate: v.currency && v.currency !== 'THB' && v.original_amount ? Math.round((amount / Number(v.original_amount)) * 1e6) / 1e6 : null,
          payment_method: v.payment_method || 'own_money', accounting_code: v.accounting_code || null,
          needs_review: !g.purpose,
        }).select().single());
        for (const x of papers) {
          if (x.kind === 'new') { const r = await uploadReceipt(x.file, { itemId: row.id, reportId: report.id }); if (x.file._rot) await sb.from('receipts').update({ rotation: x.file._rot }).eq('id', r.id); }
          else must(await sb.from('receipts').update({ item_id: row.id, report_id: report.id }).eq('id', x.r.id));
        }
        made++;
      } catch (e) { toast(friendly(e), true); }
    }
    const missing = groups.filter((g) => !g.purpose).length;
    toast(`${made} line${made === 1 ? '' : 's'} created${held ? `, ${held} held in Needs attention` : ''}.${missing ? ' Some still need a purpose.' : ''}`);
    close(); onDone && onDone();
  }
  // A file uploaded before is never uploaded twice. Unused copy: reuse it. On another line: say which.
  const moveable = [];
  const addFiles = async (files) => {
    const notes = [];
    for (const file of [...files]) {
      let hash = null; try { hash = await fileHash(file); } catch { /* ignore */ }
      const { data: ex } = hash ? await sb.from('receipts').select('*').eq('staff_id', S.user.id).eq('file_hash', hash).maybeSingle() : { data: null };
      if (!ex) { file._hash = hash; newFiles.push(file); continue; }
      if (receipts.some((r) => r.id === ex.id)) { notes.push(`${esc(file.name)} is already attached here.`); continue; }
      if (!ex.item_id) { receipts.push(ex); notes.push(`${esc(file.name)} was uploaded before and not used yet, so that copy is attached.`); continue; }
      if (item && ex.item_id === item.id) { notes.push(`${esc(file.name)} is already attached here.`); continue; }
      const { data: other } = await sb.from('expense_items').select('item, amount, invoice_date').eq('id', ex.item_id).maybeSingle();
      const { count: left } = await sb.from('receipts').select('id', { count: 'exact', head: true }).eq('item_id', ex.item_id);
      moveable.push(ex);
      notes.push(`<b>${esc(file.name)} is already on another line</b>${other ? `: ${esc(other.item)}, ${money(other.amount)}, ${dateLabel(other.invoice_date)}` : ''}. A photo can only be on 1 line.
        ${left > 1 ? `<button type="button" class="btn small" data-move="${moveable.length - 1}" style="margin-left:6px">Move it here</button>` : '<span class="faint">It is the only paper on that line, so it cannot be moved.</span>'}`);
    }
    idx = Math.max(0, all().length - 1); drawPreview();
    const box = back.querySelector('#dupnote');
    box.innerHTML = notes.length ? `<div class="banner warn" style="font-size:13px">${notes.join('<br>')}</div>` : '';
    box.querySelectorAll('[data-move]').forEach((b) => b.onclick = () => {
      const ex = moveable[Number(b.dataset.move)];
      if (!receipts.some((r) => r.id === ex.id)) receipts.push(ex);
      b.replaceWith(Object.assign(document.createElement('span'), { className: 'faint', textContent: 'Will move to this line when you save.' }));
      idx = all().length - 1; drawPreview(); analyze();
    });
    analyze();
  };
  const drop = back.querySelector('#drop'), df = back.querySelector('#df');
  drop.onclick = (e) => { e.preventDefault(); df.click(); };
  df.onchange = () => { addFiles(df.files); df.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  const pvEl = back.querySelector('#pv');
  pvEl.ondragover = (e) => { e.preventDefault(); pvEl.classList.add('over'); };
  pvEl.ondragleave = (e) => { if (!pvEl.contains(e.relatedTarget)) pvEl.classList.remove('over'); };
  pvEl.ondrop = (e) => { e.preventDefault(); pvEl.classList.remove('over'); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); };
  back.querySelector('#upick').onclick = (e) => { e.preventDefault(); pickUploaded(); };
  drawPreview();
  // Opening a line that already has several papers: check they are all the same purchase
  if (item && receipts.length > 1) analyze(true);
  // Opened from Needs attention: same check as a new upload (e.g. 1 screenshot with 4 trips)
  if (!item && receipts.length) analyze();

  // Delete from inside the window: a line with its photos, or a receipt opened from Needs attention
  const edel = back.querySelector('#edel');
  if (edel) edel.onclick = async () => {
    if (!confirmInline(edel, 'Click again to delete')) return;
    const rids = item ? (item.receipts || []).map((r) => r.id) : [...receiptIds];
    try {
      await run(async () => {
        if (item) must(await sb.from('expense_items').delete().eq('id', item.id));
        if (rids.length) must(await sb.from('receipts').delete().in('id', rids));
      });
    } catch { return; }
    close();
    const after = async () => { await refreshCounts(); onDone && onDone(); };
    toastUndo(item ? 'Line deleted.' : (rids.length > 1 ? `${rids.length} receipts deleted.` : 'Receipt deleted.'), [...(item ? [item.id] : []), ...rids], after);
    after();
  };

  back.querySelector('#save').onclick = async () => {
    const err = back.querySelector('#eerr'); err.textContent = '';
    if (!f.reportValidity()) return;
    if (!all().length) { err.textContent = 'Attach at least 1 receipt.'; return; }
    const d = Object.fromEntries(new FormData(f));
    const row = {
      report_id: report.id, invoice_date: d.invoice_date, item: d.item.trim(), category_id: d.category_id,
      purpose: d.purpose.trim(), amount: Number(d.amount), needs_review: false,
      ...(item?.duplicate_of ? { duplicate_ok: d.duplicate_ok === 'on' } : {}),
      ...(!item && ai ? { merchant: ai.merchant || null, receipt_time: ai.receipt_time || null, duplicate_ok: ai.held_reason === 'duplicate' } : {}),
      ...(!item && !ai && (aiTime || aiMerchant) ? { merchant: aiMerchant, receipt_time: aiTime } : {}), qty: Number(d.qty), payment_method: d.payment_method,
      accounting_code: d.accounting_code.trim() || null, currency: d.currency,
      doc_type: d.doc_type || null, ...(d.merchant != null ? { merchant: d.merchant.trim() || null } : {}),
      vat_amount: d.vat_amount === '' || d.vat_amount == null ? null : Number(d.vat_amount),
      wht_rate: d.wht_rate ? Number(d.wht_rate) : null, wht_amount: d.wht_rate && d.wht_amount !== '' && d.wht_amount != null ? Number(d.wht_amount) : null,
      original_amount: d.currency === 'THB' ? null : (d.original_amount ? Number(d.original_amount) : null),
      exchange_rate: d.currency !== 'THB' && d.original_amount && Number(d.amount) ? Math.round((Number(d.amount) / Number(d.original_amount)) * 1e6) / 1e6 : null,
    };
    const btn = back.querySelector('#save'); btn.disabled = true; btn.textContent = 'Saving';
    let created = null;
    try {
      await run(async () => {
        const saved = item
          ? must(await sb.from('expense_items').update(row).eq('id', item.id).select().single())
          : (created = must(await sb.from('expense_items').insert(row).select().single()));
        const keep = receipts.map((r) => r.id);
        if (item) {
          const dropped = (item.receipts || []).filter((r) => !keep.includes(r.id)).map((r) => r.id);
          if (dropped.length) must(await sb.from('receipts').update({ item_id: null }).in('id', dropped));
        }
        if (keep.length) must(await sb.from('receipts').update({ item_id: saved.id }).in('id', keep));
        for (const file of newFiles) {
          const r = await uploadReceipt(file, { itemId: saved.id });
          if (file._rot) await sb.from('receipts').update({ rotation: file._rot }).eq('id', r.id);
        }
      }, 'Saved');
      close(); onDone && onDone();
    } catch {
      // Don't leave a half-saved line with no receipt behind
      if (created) { await sb.from('receipts').update({ item_id: null }).eq('item_id', created.id); await sb.from('expense_items').delete().eq('id', created.id); }
      btn.disabled = false; btn.textContent = 'Save';
    }
  };
}

/* ---------- home ---------- */
async function pageHome() {
  if (isAdmin()) return pageHomeAdmin();
  const { forms } = await currentForm();
  const card = (href, title, sub, extra = '') => `<a class="card card-pad home-card" href="${href}"><h2>${title}</h2><p class="muted" style="margin:6px 0 0">${sub}</p>${extra}</a>`;
  shell(`<div class="page-head"><div><h1>Hello, ${esc(S.profile.full_name || S.profile.staff_no)}</h1><p>What do you want to do?</p></div></div>
  <div class="home-grid">
    ${card('#/forms', 'Expenses', forms.length ? `${forms.length} open form${forms.length > 1 ? 's' : ''}: ${forms.map((f) => esc(monthLabel(f.period_month.slice(0, 7)) + (f.form_type === 'project' ? ' (' + (f.project || 'project') + ')' : ''))).join(', ')}` : 'No open form. Start one for the month you need.',
      `${S.reviewCount ? `<div style="margin-top:10px"><span class="pill new">${S.reviewCount} line${S.reviewCount > 1 ? 's' : ''} need a purpose</span></div>` : ''}${S.inboxCount ? `<div style="margin-top:6px"><span class="pill submitted">${S.inboxCount} receipt${S.inboxCount > 1 ? 's' : ''} need attention</span></div>` : ''}`)}
    ${card('#/approvals', 'Approvals', S.pendingCount ? `${S.pendingCount} form${S.pendingCount > 1 ? 's' : ''} for you to check` : 'Nothing waiting for you')}
    ${STAGE >= 2 ? card('#/ot', 'Timesheet', 'Your hours and OT for this period (26th to 25th)') : ''}
  </div>`);
}

// Admins: only what is waiting for them
async function pageHomeAdmin() {
  const { forms } = await currentForm();
  const [chk, appr, sub, ots, otsAll] = await Promise.all([
    sb.from('expense_reports').select('id, staff_id, checked_by', { count: 'exact' }).eq('status', 'checked'),
    sb.from('expense_reports').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    sb.from('expense_reports').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
    sb.from('ot_forms').select('id', { count: 'exact', head: true }).eq('status', 'checked'),
    sb.from('ot_forms').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
  ]);
  const hasHR = ((await sb.from('profiles').select('id').eq('is_hr', true).eq('active', true)).data || []).length > 0;
  const finalN = (chk.data || []).filter((r) => r.staff_id !== S.user.id && r.checked_by !== S.user.id).length;
  const tsN = (ots.count || 0) + (hasHR ? 0 : otsAll.count || 0);
  const tile = (href, n, title, sub) => `<a class="card card-pad home-card" href="${href}"><div style="font-size:34px;font-weight:600;line-height:1;${n ? '' : 'color:var(--ink-3)'}">${n}</div><h2 style="margin-top:8px">${title}</h2><p class="muted" style="margin:4px 0 0">${sub}</p></a>`;
  shell(`<div class="page-head"><div><h1>Hello, ${esc(S.profile.full_name || S.profile.staff_no)}</h1><p>${finalN + tsN + (appr.count || 0) + (S.pendingCount || 0) ? 'Here is what is waiting.' : 'Nothing is waiting for you.'}</p></div></div>
  <div class="home-grid">
    <a class="card card-pad home-card" href="#/forms"><h2>My expenses</h2><p class="muted" style="margin:6px 0 0">${forms.length ? `${forms.length} open form${forms.length > 1 ? 's' : ''}: ${forms.map((f) => esc(monthLabel(f.period_month.slice(0, 7)) + (f.form_type === 'project' ? ' (' + (f.project || 'project') + ')' : ''))).join(', ')}` : 'No open form. Start one for the month you need.'}</p></a>
    ${S.pendingCount ? tile('#/approvals?s=todo&k=exp', S.pendingCount, 'For you to check', 'forms where you were picked (step 1)') : ''}
    ${tile('#/approvals?s=checked&k=exp', finalN, 'Expense forms', 'need your final approval')}
    ${STAGE >= 2 ? tile('#/approvals?s=todo&k=ts', tsN, 'Timesheets', 'need your final approval') : ''}
    ${tile('#/approvals?s=approved&k=exp', appr.count || 0, 'Approved forms', 'waiting to be paid')}
    ${tile('#/approvals?s=submitted&k=exp', sub.count || 0, 'Being checked', 'by the checker each sender picked (step 1)')}
  </div>`);
}

/* ---------- expense forms ---------- */
async function pageHistory() {
  const rows = must(await sb.from('expense_report_totals').select('*').eq('staff_id', S.user.id).order('period_month', { ascending: false }));
  const reps = must(await sb.from('expense_reports').select('id,status,form_type,project,project_id').eq('staff_id', S.user.id));
  const rep = Object.fromEntries(reps.map((r) => [r.id, r]));
  const pids = [...new Set(reps.map((r) => r.project_id).filter(Boolean))];
  const projs = pids.length ? Object.fromEntries(((await sb.from('projects').select('id,name,code,active').in('id', pids)).data || []).map((x) => [x.id, x])) : {};
  const bal = (r) => { const b = Number(r.balance) || 0; return `${money(b)}${b < 0 ? '<div class="faint" style="font-size:11px">owed to you</div>' : b > 0 ? '<div class="faint" style="font-size:11px">to return to company</div>' : ''}`; };
  const tr = (r) => { const st = rep[r.report_id]?.status; return `<tr class="click" data-href="${['draft', 'rejected'].includes(st) ? '#/expenses?id=' + r.report_id : '#/report/' + r.report_id}"><td>${monthLabel(r.period_month.slice(0, 7))}</td><td class="mono">${esc(r.ref_no)}</td><td>${pill(st)}</td><td class="num">${money(r.total_spent)}</td><td class="num">${bal(r)}</td></tr>`; };
  const cols = '<colgroup><col style="width:22%"><col style="width:24%"><col style="width:20%"><col style="width:16%"><col style="width:18%"></colgroup>';
  const head = cols + '<thead><tr><th>Month</th><th>Reference</th><th>Status</th><th class="num">Spent</th><th class="num">Balance</th></tr></thead>';
  const personal = rows.filter((r) => rep[r.report_id]?.form_type !== 'project');
  const groups = {};
  rows.filter((r) => rep[r.report_id]?.form_type === 'project').forEach((r) => {
    const f = rep[r.report_id], pj = projs[f.project_id], key = f.project_id || 'n:' + (f.project || '');
    (groups[key] ||= { name: pj?.name || f.project || 'Project', code: pj?.code || '', closed: pj ? pj.active === false : false, rows: [] }).rows.push(r);
  });
  const gl = Object.values(groups).sort((x, y) => (x.closed - y.closed) || x.name.localeCompare(y.name));
  const sec = (title, body) => `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>${title}</h2></div>${body}</div>`;
  shell(`<div class="page-head"><div><h1>Expense forms</h1><p>Petty Cash and project forms. Open one to add receipts.</p></div><button class="btn primary" id="newform">New expense form</button></div>
  ${rows.length ? `${sec('Petty Cash', personal.length ? `<div class="table-wrap"><table style="table-layout:fixed">${head}<tbody>${personal.map(tr).join('')}</tbody></table></div>` : '<div class="empty">No Petty Cash forms yet.</div>')}
  ${sec('Projects', gl.length ? `<div class="table-wrap"><table style="table-layout:fixed">${head}<tbody>${gl.map((g) => `<tr${g.closed ? ' style="opacity:0.6"' : ''}><td colspan="5" style="padding-top:16px;border-bottom:0"><b style="font-weight:600">${esc(g.name)}</b> <span class="faint">· ${g.code ? esc(g.code) : 'no code yet'}${g.closed ? ' · closed' : ''}</span></td></tr>${g.rows.map(tr).join('')}`).join('')}</tbody></table></div>` : '<div class="empty">No project forms yet.</div>')}`
  : '<div class="card"><div class="empty">No expense forms yet. Click <b>New expense form</b> to start.</div></div>'}`);
  bindRowLinks();
  document.getElementById('newform').onclick = async () => { const f = await newFormDialog(); if (f) location.hash = '#/expenses?id=' + f.id; };
}

/* ---------- my reports (old) ---------- */
async function pageHistoryOld() {
  const rows = must(await sb.from('expense_report_totals').select('*').eq('staff_id', S.user.id).order('period_month', { ascending: false }));
  const reps = must(await sb.from('expense_reports').select('id,status').eq('staff_id', S.user.id));
  const st = Object.fromEntries(reps.map((r) => [r.id, r.status]));
  shell(`<div class="page-head"><div><h1>My reports</h1><p>All your monthly expense reports.</p></div></div>
  <div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Reference</th><th>Status</th><th class="num">Spent</th><th class="num">Balance</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-href="#/report/${r.report_id}"><td>${monthLabel(r.period_month.slice(0, 7))}</td><td class="mono">${esc(r.ref_no)}</td><td>${pill(st[r.report_id])}</td><td class="num">${money(r.total_spent)}</td><td class="num">${money(r.balance)}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">No reports yet.</div>'}</div>`);
  bindRowLinks();
}
function bindRowLinks() { main().querySelectorAll('[data-href]').forEach((tr) => tr.onclick = () => { location.hash = tr.dataset.href; }); }

/* ---------- report detail (staff read-only, approver actions) ---------- */
async function pageReport(id) {
  const report = must(await sb.from('expense_reports').select('*').eq('id', id).single());
  const mine = report.staff_id === S.user.id;
  // Your own form that can still be edited opens on the editing page
  if (mine && ['draft', 'rejected'].includes(report.status)) { location.replace('#/expenses?id=' + report.id); return; }
  await loadOverLimit();
  const canDecide = canActOn(report);
  // Approvers review the whole form as it prints; this page is the "Lines" view
  if (canDecide && !params().lines) { location.replace('#/print/' + report.id); return; }
  const { items, totals } = await loadReportBundle(report);
  const staff = must(await sb.from('profiles').select('full_name, thai_name, staff_no').eq('id', report.staff_id).single());
  const approver = report.approved_by_name ? { full_name: report.approved_by_name } : null;
  const x = await reviewExtras(report, items);
  let bank = null;
  if (isAdmin() || isMgr()) bank = (await sb.from('staff_bank_details').select('*').eq('staff_id', report.staff_id).maybeSingle()).data;
  const slip = report.paid_slip_path ? await signedUrl(report.paid_slip_path) : null;

  shell(`
  <div class="page-head"><div><h1>${esc(staff.full_name)} · ${monthLabel(report.period_month.slice(0, 7))} · ${esc(formKind(report))}</h1>
    <p>${esc(staff.staff_no || '')}${staff.thai_name ? ' · ' + esc(staff.thai_name) : ''}</p></div>
    <div class="row"><span class="seg"><a href="#/print/${report.id}">Form</a><a class="on" href="#/report/${report.id}?lines=1">Lines</a></span><a class="btn" href="${isApprover() && !mine ? '#/approvals' : '#/forms'}">Back</a></div></div>
  <div class="stack">
    ${report.status === 'rejected' ? `<div class="banner bad"><b>Returned:</b> ${esc(report.rejection_reason)}</div>` : ''}
    ${mine && report.status === 'submitted' ? seenBanner(x.events) : ''}
    ${statsHtml(report, totals)}
    ${isApprover() && report.status === 'submitted' ? sinceReturnedHtml(items, staff.full_name) : ''}
    ${isApprover() && x.changed.size ? `<div class="banner info"><b>${x.changed.size} line${x.changed.size > 1 ? 's' : ''} changed</b> since the form was returned on ${dateLabel(report.last_returned_at)}. Marked "Changed" below.</div>` : ''}
    ${isApprover() && x.flags.length ? `<div class="card card-pad"><h2 style="margin-bottom:8px">Worth a look</h2><ul class="flaglist">${x.flags.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><div class="card-head"><h2>Expenses</h2></div>${await itemsTable(items, { editable: false, showActions: false, marks: isApprover() ? x.marks : null })}</div>
    <div class="two-col" style="grid-template-columns:1fr 1fr">
      <div class="card"><div class="card-head"><h2>By category</h2></div>${categorySummary(items)}</div>
      <div class="card card-pad stack">
        <h2>History</h2>
        ${timelineHtml(x.events)}
        ${report.remarks ? `<div class="muted" style="font-size:13px">Remarks: ${esc(report.remarks)}</div>` : ''}
        ${report.status === 'paid' ? `<div style="font-size:13px"><b>Paid</b> ${dateLabel(report.paid_at)}${report.paid_ref ? ' · ' + esc(report.paid_ref) : ''}${slip ? ` · <a href="#" data-view="${esc(report.paid_slip_path)}" data-mime="image/jpeg">View transfer slip</a>` : ''}</div>` : ''}
        ${bank ? `<div style="font-size:13px"><b>Pay to</b><br>${esc(bank.bank_name)} · ${esc(bank.account_no)}<br>${esc(bank.account_name)}</div>` : ((isAdmin() || isMgr()) ? '<div class="faint" style="font-size:13px">No bank details on file.</div>' : '')}
      </div>
    </div>
    ${isApprover() ? `<div class="card card-pad stack"><h2>Approver notes</h2><textarea class="input" id="anote" rows="2" placeholder="Only approvers and admins see this. e.g. Checked the Wi-Fi purchase with Mary by phone.">${esc(x.note?.note || '')}</textarea><span class="faint" style="font-size:12px" id="anotes">${x.note?.updated_by_name ? `Last edited by ${esc(x.note.updated_by_name)}, ${dateLabel(x.note.updated_at)}` : 'Saved when you click outside the box.'}</span></div>` : ''}
    ${canDecide ? `<div class="card card-pad spread"><span class="muted">Approve or return this form in Form view, where you see every receipt.</span><a class="btn primary" href="#/print/${report.id}">Open Form view</a></div>` : ''}
    ${report.checked_at ? `<div class="faint" style="font-size:13px">Step 1: ${esc(report.checked_by_name || '')}${report.checked_by ? ` · ${esc(dateLabel(report.checked_at))}` : ''}</div>` : ''}
    
    ${canPay(report) && report.status === 'approved' ? `<div class="card card-pad spread"><span class="muted">${Number(totals.balance) < 0 ? `Company owes ${thb(-totals.balance)}. Mark paid once transferred.` : `Nothing to reimburse. ${thb(totals.balance)} ${report.form_type === 'project' ? 'to be returned to the company' : 'carries to the next personal form'}.`}</span><button class="btn primary" id="paid">Mark as paid</button></div>` : ''}
    ${isAdmin() && report.status !== 'draft' ? `<div class="row"><button class="btn ghost small" id="reopen">Reopen as draft</button></div>` : ''}
  </div>`);
  wireLines();
  wireDecision(report, items, totals, async () => { await refreshCounts(); pageReport(id); });
}
// Approve, Return, Mark as paid, Reopen, approver notes: shared by the Form and Lines views
function wireDecision(report, items, totals, reload) {
  const id = report.id;
  const set = async (patch, msg) => { try { await run(async () => must(await sb.from('expense_reports').update(patch).eq('id', id)), msg); } catch { return; } reload(); };
  const ok = document.getElementById('ok');
  if (ok) ok.onclick = async (e) => { if (!(await ensureSignature('approve'))) return; confirmInline(e.target, 'Click again to approve') && set({ status: report.status === 'checked' ? 'approved' : 'checked' }, report.status === 'checked' ? 'Final approval given' : 'Checked, sent to admin for final approval'); };
  const fa = document.getElementById('faent');
  if (fa) fa.onclick = () => set({ fa_entered_at: report.fa_entered_at ? null : new Date().toISOString() }, report.fa_entered_at ? 'Unmarked' : 'Marked entered in FlowAccount');
  const no = document.getElementById('no');
  if (no) no.onclick = async () => { if (await returnDialog(report, items)) reload(); };
  const paid = document.getElementById('paid');
  if (paid) paid.onclick = async () => { if (await paidDialog(report, totals)) reload(); };
  const reopen = document.getElementById('reopen');
  if (reopen) reopen.onclick = (e) => confirmInline(e.target) && set({ status: 'draft' }, 'Reopened');
  const an = document.getElementById('anote');
  if (an) an.onchange = async () => {
    try { await run(async () => must(await sb.from('report_notes').upsert({ report_id: id, note: an.value.trim(), updated_by_name: S.profile.full_name, updated_at: new Date().toISOString() })), 'Note saved'); } catch { /* shown */ }
    const st = document.getElementById('anotes'); if (st) st.textContent = `Last edited by ${S.profile.full_name}, ${dateLabel(today())}`;
  };
}
// Flags, changed lines, history and approver notes for a form
async function reviewExtras(report, items) {
  const since = report.last_returned_at;
  const changed = new Set(since ? items.filter((i) => i.updated_at > since || i.created_at > since).map((i) => i.id) : []);
  const [events, note, prev] = await Promise.all([
    sb.from('report_events').select('*').eq('report_id', report.id).order('at').then((r) => r.data || []),
    isApprover() ? sb.from('report_notes').select('*').eq('report_id', report.id).maybeSingle().then((r) => r.data) : null,
    isApprover() ? sb.from('expense_report_totals').select('total_spent, period_month').eq('staff_id', report.staff_id).eq('form_type', report.form_type || 'personal').lt('period_month', report.period_month).order('period_month', { ascending: false }).limit(1).then((r) => (r.data || [])[0]) : null,
  ]);
  const flags = [], marks = {};
  const mark = (i, t) => { (marks[i.id] = marks[i.id] || { tags: [] }).tags.push(t); };
  // Spending flags removed (decided 4 Nov 2026): approvers check every line themselves. Only "Changed", currency and return notes stay.
  items.forEach((i) => {
    if (i.currency && i.currency !== 'THB') mark(i, i.currency);
    if (changed.has(i.id)) mark(i, 'Changed');
    if (i.return_note) (marks[i.id] = marks[i.id] || { tags: [] }).note = i.return_note;
  });
  return { flags, marks, changed, events, note };
}
function timelineHtml(events) {
  if (!events.length) return '<div class="faint" style="font-size:13px">Not submitted yet.</div>';
  return `<ol class="tline">${events.map((e) => `<li><b>${esc(e.action)}</b> <span class="faint">${dateLabel(e.at)}${e.by_name ? ' · ' + esc(e.by_name) : ''}</span>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</li>`).join('')}</ol>`;
}
// Return: an overall reason, plus a note on each line that needs fixing
function returnDialog(report, items) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-label="Return to staff">
      <div class="modal-head"><h2>Return to staff</h2><button class="btn ghost" data-x>Close</button></div>
      <div class="modal-body"><div class="card-pad stack">
        <div class="field"><label>Reason</label><textarea class="input" id="rr" rows="2" placeholder="e.g. Please add clearer purposes on the marked lines">${esc(report.rejection_reason || '')}</textarea></div>
        <div class="field"><label>Lines to fix <span class="faint">(tick a line and say what to change)</span></label>
          <div class="rlines">${items.map((i, n) => `<div class="rline"><label><input type="checkbox" data-id="${i.id}"> <span>${n + 1}. ${esc(dateLabel(i.invoice_date))} · ${esc(i.item)} · THB ${money(i.amount)}</span></label><input class="input" data-note="${i.id}" placeholder="What should be changed?" hidden></div>`).join('')}</div></div>
        <div class="error" id="rerr"></div>
      </div></div>
      <div class="modal-foot"><span></span><div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn danger" id="rok">Send back</button></div></div></div>`;
    document.body.appendChild(back);
    const close = (v) => { back.remove(); resolve(v); };
    back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => close(false)));
    back.querySelectorAll('.rline input[type=checkbox]').forEach((cb) => (cb.onchange = () => { const t = back.querySelector(`[data-note="${cb.dataset.id}"]`); t.hidden = !cb.checked; if (cb.checked) t.focus(); }));
    back.querySelector('#rok').onclick = async () => {
      const reason = back.querySelector('#rr').value.trim();
      const notes = [...back.querySelectorAll('.rline input[type=checkbox]:checked')].map((cb) => ({ id: cb.dataset.id, note: back.querySelector(`[data-note="${cb.dataset.id}"]`).value.trim() }));
      const err = back.querySelector('#rerr');
      if (!reason && !notes.length) { err.textContent = 'Write a reason or tick the lines to fix.'; return; }
      if (notes.some((x) => !x.note)) { err.textContent = 'Add a note on each ticked line.'; return; }
      try { await run(async () => must(await sb.rpc('return_form', { p_report: report.id, p_reason: reason || `${notes.length} line${notes.length > 1 ? 's need' : ' needs'} changes`, p_notes: notes })), 'Returned to staff'); } catch { return; }
      close(true);
    };
  });
}
// Mark as paid, with the transfer slip and a reference
function paidDialog(report, totals) {
  return new Promise((resolve) => {
    const owe = Number(totals.balance) < 0 ? -Number(totals.balance) : 0;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal narrow" role="dialog" aria-label="Mark as paid">
      <div class="modal-head"><h2>Mark as paid</h2><button class="btn ghost" data-x>Close</button></div>
      <div class="modal-body"><div class="card-pad stack">
        <p class="muted" style="margin:0">${owe ? `Transfer THB ${money(owe)} to the staff member, then record it here.` : 'Nothing to reimburse. Mark it closed.'}</p>
        ${owe ? `<div class="field"><label>Transfer slip <span class="faint">(photo or PDF)</span></label><input type="file" id="ps" accept="image/*,application/pdf"></div>` : ''}
        <div class="field"><label>Reference <span class="faint">(optional)</span></label><input class="input" id="pr" placeholder="e.g. KBank transfer 2 Nov"></div>
        <div class="error" id="perr"></div>
      </div></div>
      <div class="modal-foot"><span></span><div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="pok">${owe ? 'Mark as paid' : 'Close form'}</button></div></div></div>`;
    document.body.appendChild(back);
    const close = (v) => { back.remove(); resolve(v); };
    back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => close(false)));
    back.querySelector('#pok').onclick = async () => {
      const b = back.querySelector('#pok'); b.disabled = true;
      try {
        await run(async () => {
          let path = null;
          const f = back.querySelector('#ps')?.files?.[0];
          if (f) {
            const x = await compress(f);
            path = `${S.user.id}/slip-${crypto.randomUUID()}.${(x.name.split('.').pop() || 'jpg').toLowerCase()}`;
            must(await sb.storage.from(BUCKET).upload(path, x, { contentType: x.type || 'application/octet-stream' }));
          }
          must(await sb.from('expense_reports').update({ status: 'paid', received_at: today(), paid_slip_path: path, paid_ref: back.querySelector('#pr').value.trim() || null }).eq('id', report.id));
        }, 'Marked as paid');
      } catch { b.disabled = false; return; }
      close(true);
    };
  });
}

/* ---------- print form (IGA standard expense form) ---------- */
const dmy = (d) => { if (!d) return ''; const x = new Date(`${String(d).slice(0, 10)}T00:00:00`); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`; };
const thbp = (n) => `THB${money(n)}`;
async function pagePrint(id) {
  const report = must(await sb.from('expense_reports').select('*').eq('id', id).single());
  const { items, totals } = await loadReportBundle(report);
  const staff = must(await sb.from('profiles').select('full_name, thai_name, staff_no').eq('id', report.staff_id).single());
  const approver = report.approved_by_name ? { full_name: report.approved_by_name } : (report.approved_by ? (await sb.from('profiles').select('full_name').eq('id', report.approved_by).maybeSingle()).data : null);
  const bank = (await sb.from('staff_bank_details').select('*').eq('staff_id', report.staff_id).maybeSingle()).data;
  const monthTitle = `CASH EXPENSES ${new Date(report.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}${report.form_type === 'project' ? ' · Project: ' + (report.project || '') : ''}`;
  const applicant = staff.full_name || staff.staff_no;
  const head = () => `
    <div class="pf-head"><img src="/images/bcm-logo.png" alt="Bloom Chiangmai"><div class="pf-title"><b>Bloom Chiangmai</b><span>${esc(monthTitle)}</span></div><div></div></div>
    <div class="pf-meta"><b>Date:</b><span class="v">${dmy(report.report_date)}</span><span></span>
      <b>Applicant:</b><span class="v">${esc(applicant)}</span><span class="ref">Ref. ${esc(report.ref_no)}</span></div>`;
  const signBlock = () => `
    <table class="pf-sign">
      <tr><td style="width:24%">Signed by applicant:</td><td style="width:34%" class="pf-sigcell">${report.applicant_signature ? `<img src="${esc(report.applicant_signature)}" alt="">` : ''}</td><td style="width:16%">Approved by:</td><td class="v pf-sigcell">${report.approver_signature ? `<img src="${esc(report.approver_signature)}" alt="">` : ''}<span>${esc(approver?.full_name || '')}</span>${['submitted', 'checked'].includes(report.status) ? '<span class="pf-screen faint">Signs at final approval</span>' : ''}${report.checked_by ? `<div class="pf-check">Checked by ${esc(report.checked_by_name || '')}${report.form_type === 'project' ? ' (PIC)' : ''}${report.checked_signature ? `<img src="${esc(report.checked_signature)}" alt="">` : ''}</div>` : ''}</td></tr>
      <tr><td>Date:</td><td class="v">${dmy(report.submitted_at)}</td><td>Date:</td><td class="v">${dmy(report.approved_at)}</td></tr>
      <tr class="gap"><td colspan="4"></td></tr>
      <tr><td>Reimbursement receiving Date:</td><td class="v">${dmy(report.received_at)}</td><td>Supervisor Signature:</td><td></td></tr>
      <tr><td>Received by Applicant:</td><td></td><td>Date:</td><td></td></tr>
    </table>`;

  // Page 1: Total expense
  const byCat = {};
  items.forEach((i) => { byCat[i.category_id] = (byCat[i.category_id] || 0) + Number(i.amount); });
  const catRows = S.categories.filter((c) => byCat[c.id]);
  const advance = Number(report.opening_advance) + Number(report.advance_topup);
  const spent = Number(totals.total_spent);
  const balance = advance - spent;
  const sumRows = catRows.map((c, n) => `<tr><td class="c">${n + 1}</td><td class="c">${esc(c.code || '')}</td><td class="c">${esc(c.name)}</td><td class="c">${money(byCat[c.id])}</td></tr>`);
  while (sumRows.length < 7) sumRows.push('<tr><td></td><td></td><td></td><td></td></tr>');
  const page1 = `<section class="pf-page">${head()}
    <table class="pf-t">
      <thead><tr><th style="width:9%">No.</th><th style="width:22%">Category Code</th><th>Category</th><th style="width:24%">Amount (THB)</th></tr></thead>
      <tbody>${sumRows.join('')}
        <tr class="tot"><td>Remarks:</td><td colspan="2" style="font-family:inherit">${esc(report.remarks || '')}</td><td class="big">${money(spent)}</td></tr>
        <tr class="lab"><td colspan="3">Cash Advance${Number(report.opening_advance) ? ` (carried forward ${money(report.opening_advance)} + new ${money(report.advance_topup)})` : ''}:</td><td class="v">${money(advance)}</td></tr>
        <tr class="lab"><td colspan="3">${balance < 0 ? 'Reimbursement Amount' : (report.form_type === 'project' ? 'Balance to return to company' : 'Balance carried to next month')}:</td><td class="v">${money(Math.abs(balance))}</td></tr>
      </tbody>
    </table>
    ${signBlock()}
    ${bank ? `<div class="pf-bank"><b>Bank Details;</b><br>${esc(bank.bank_name)}<br>Account No. ${esc(bank.account_no)}<br>${esc(bank.account_name)}</div>` : ''}
    <div class="pf-note">Generated by the Bloom Chiangmai back office · ${esc(staff.staff_no || '')} · Status: ${esc(STATUS_TEXT[report.status])}</div>
  </section>`;

  // 1 sheet per category, like the category tabs; more than 10 lines continues on the next page
  const PER = 8;
  const catPages = catRows.flatMap((c) => {
    const lines = items.filter((i) => i.category_id === c.id);
    const chunks = [];
    for (let k = 0; k < Math.max(lines.length, 1); k += PER) chunks.push(lines.slice(k, k + PER));
    return chunks.map((chunk, p) => {
      const last = p === chunks.length - 1;
      const rows = chunk.map((i, n) => `<tr><td class="c">${p * PER + n + 1}</td><td class="c">${dmy(i.invoice_date)}</td><td>${esc(i.item)}</td><td class="c">${esc(i.accounting_code || c.code || '')}</td><td class="c">${esc(c.name)}</td><td>${esc(i.purpose)}${fxNote(i) ? ` (${fxNote(i)})` : ''}</td><td class="c">${Number(i.qty)}</td><td class="r">${money(i.amount)}</td></tr>`);
      while (rows.length < 8) rows.push('<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>');
      const sub = chunk.reduce((s2, i) => s2 + Number(i.amount), 0);
      const pageNote = chunks.length > 1 ? `<div class="pf-note" style="text-align:right">${esc(c.name)} · page ${p + 1} of ${chunks.length}</div>` : '';
      return `<section class="pf-page land">${head()}
      <table class="pf-t${chunk.length > 8 ? ' dense' : ''}">
        <thead><tr><th style="width:5%">No.</th><th style="width:10%">Invoice Date</th><th style="width:19%">Item</th><th style="width:11%">Accounting code</th><th style="width:12%">Category</th><th>Usage / Purpose (Please fill in clearly)</th><th style="width:5%">Qty</th><th style="width:12%">Amount (THB)</th></tr></thead>
        <tbody>${rows.join('')}
          ${last
            ? `<tr class="tot"><td colspan="6">Remarks:</td><td style="font-family:inherit;font-weight:700;text-align:center">Grand Total:</td><td class="r big">${money(byCat[c.id])}</td></tr>`
            : `<tr class="tot"><td colspan="6">Continued on next page</td><td style="font-family:inherit;font-weight:700;text-align:center">Page total:</td><td class="r">${money(sub)}</td></tr>`}
        </tbody>
      </table>
      ${last ? signBlock() : ''}${pageNote}
    </section>`;
    });
  });

  // Receipts, grouped by category (numbered to match the category sheets). Receipts per page can be set per category.
  const byPath = new Map();
  catRows.forEach((c) => items.filter((i) => i.category_id === c.id).forEach((i, n) => (i.receipts || []).forEach((r) => {
    const label = `${c.name} No. ${n + 1} · ${dmy(i.invoice_date)} · ${i.item} · ${thbp(i.amount)}`;
    if (byPath.has(r.storage_path)) byPath.get(r.storage_path).labels.push(label);
    else byPath.set(r.storage_path, { r, labels: [label], cat: c });
  })));
  const fig = async ({ r, labels }) => {
    const url = await signedUrl(r.storage_path);
    const isImg = r.mime_type?.startsWith('image/') && !/hei[cf]/.test(r.mime_type);
    return `<figure><figcaption>${esc(labels.join('  |  '))}</figcaption><div class="img">${isImg && url ? `<img class="${rotCls(r.rotation || 0)}" src="${esc(url)}" alt="Receipt" style="transform:rotate(${r.rotation || 0}deg)">` : `<div>PDF receipt: ${esc(r.file_name || '')}<br><span style="font-size:9pt;color:#666">Print the PDF separately.</span></div>`}</div></figure>`;
  };
  const rcGroups = [];
  for (const c of catRows) {
    const list = [...byPath.values()].filter((x) => x.cat.id === c.id);
    if (list.length) rcGroups.push({ c, figs: await Promise.all(list.map(fig)) });
  }
  const figs = rcGroups.flatMap((g) => g.figs);
  const loadPer = (key, d) => { try { return Number(localStorage.getItem(key)) || d; } catch { return d; } };
  const savePer = (key, n) => { try { localStorage.setItem(key, String(n)); } catch { /* ignore */ } };
  let per = loadPer('bo_rc_per', 2);
  const catPer = Object.fromEntries(rcGroups.map((g) => [g.c.id, loadPer('bo_rc_per_' + g.c.id, 0)]));
  const opts = (n, withDefault) => `${withDefault ? `<option value="0" ${!n ? 'selected' : ''}>Same as all</option>` : ''}${[1, 2, 4, 6].map((k) => `<option value="${k}" ${k === n ? 'selected' : ''}>${k} per page</option>`).join('')}`;
  const rcPagesFor = () => rcGroups.flatMap((g) => {
    const n = catPer[g.c.id] || per, out = [];
    for (let k = 0; k < g.figs.length; k += n) {
      const cells = g.figs.slice(k, k + n); while (cells.length < n) cells.push('<div></div>');
      const head = k === 0 ? `<div class="pf-rchead"><b>Receipts: ${esc(g.c.name)}</b><select class="input rc-cat" data-cat="${g.c.id}">${opts(catPer[g.c.id], true)}</select></div>` : '';
      out.push(`<section class="pf-page">${head}<div class="pf-rc n${n}${head ? ' with-head' : ''}">${cells.join('')}</div></section>`);
    }
    return out;
  });
  const rcPages = rcPagesFor();
  // Approvers review the form here: Form / Lines switch, flags, Return and Approve stay in the bar
  const mineF = report.staff_id === S.user.id;
  const reviewing = isReviewer() && !mineF && !['draft', 'rejected'].includes(report.status);
  await loadOverLimit();
  const canDecide = reviewing && canActOn(report);
  if (canDecide) sb.rpc('mark_seen', { p_report: report.id }).then(pollPending);
  const x = reviewing ? await reviewExtras(report, items) : null;
  const ownDraft = mineF && ['draft', 'rejected'].includes(report.status);
  app.innerHTML = `
    <div class="pf-bar">${reviewing
      ? `<div class="row"><a class="btn" href="#/approvals">Back</a><span><b>${esc(applicant)}</b> <span class="muted">· ${esc(monthLabel(report.period_month.slice(0, 7)))} · ${esc(formKind(report))} · Spent THB ${money(spent)} · Advance THB ${money(advance)}</span></span>${pill(report.status)}<span class="seg"><a class="on" href="#/print/${report.id}">Form</a><a href="#/report/${report.id}?lines=1">Lines</a></span></div>
        <div class="row">${x.flags.length || x.changed.size ? `<button class="btn small ghost" id="fl">${x.changed.size ? `${x.changed.size} changed · ` : ''}${x.flags.length} to look at</button>` : ''}${figs.length ? `<select class="input" id="rcper" style="width:auto;padding:4px 8px" title="Receipts per page">${opts(per, false)}</select>` : ''}<button class="btn" id="pp">Print</button>${canDecide ? `<button class="btn danger" id="no">Return</button><button class="btn primary" id="ok">${report.status === 'checked' ? 'Final approve' : 'Checked (step 1)'}</button>` : ''}</div>`
      : `<div class="row"><a class="btn" href="${ownDraft ? '#/expenses?id=' + report.id : '#/report/' + report.id + '?lines=1'}">Back</a><span class="muted">${esc(report.ref_no)} · ${esc(applicant)} · ${1 + catPages.length + rcPages.length} pages</span></div>
        <div class="row">${['draft', 'rejected'].includes(report.status) ? '<span class="pill">Draft: not yet approved</span>' : ''}${figs.length ? `<label class="muted" style="display:flex;gap:6px;align-items:center">Receipts <select class="input" id="rcper" style="width:auto;padding:4px 8px">${opts(per, false)}</select></label>` : ''}<button class="btn primary" id="pp">Print form</button></div>`}</div>
    ${x && (x.flags.length || x.changed.size) ? `<div class="pf-flags" id="flp" hidden>${x.changed.size ? `<div><b>${x.changed.size} line${x.changed.size > 1 ? 's' : ''} changed</b> since returned on ${dateLabel(report.last_returned_at)}: ${items.filter((i) => x.changed.has(i.id)).map((i) => esc(i.item)).join(', ')}</div>` : ''}${x.flags.length ? `<ul class="flaglist">${x.flags.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${reviewing && report.status === 'submitted' ? sinceReturnedHtml(items, applicant) : ''}
    <div class="pf-wrap">${page1}${catPages.join('')}<div id="rcpages">${rcPages.join('')}</div></div>`;
  const flb = document.getElementById('fl'); if (flb) flb.onclick = () => { const pnl = document.getElementById('flp'); pnl.hidden = !pnl.hidden; };
  if (reviewing) wireDecision(report, items, totals, () => pagePrint(id));
  const redraw = () => {
    const pages = rcPagesFor();
    document.getElementById('rcpages').innerHTML = pages.join('');
    app.querySelector('.pf-bar .muted').textContent = `${report.ref_no} · ${applicant} · ${1 + catPages.length + pages.length} pages`;
    app.querySelectorAll('.rc-cat').forEach((el) => el.onchange = () => { catPer[el.dataset.cat] = Number(el.value); savePer('bo_rc_per_' + el.dataset.cat, el.value); redraw(); });
  };
  const sel = document.getElementById('rcper');
  if (sel) sel.onchange = () => { per = Number(sel.value); savePer('bo_rc_per', per); redraw(); };
  redraw();
  document.getElementById('pp').onclick = async () => {
    await Promise.all([...app.querySelectorAll('img')].map((im) => im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })));
    window.print();
  };
}

/* ---------- approvals ---------- */
// Admin: who can do what (tick boxes) and the project list with each project's PIC(s)
async function pageAccess() {
  const [people, projects, pics] = await Promise.all([
    sb.from('profiles').select('id, full_name, staff_no, role, active, is_accountant, is_data_entry, is_hr').order('staff_no').then(must),
    sb.from('projects').select('*').order('active', { ascending: false }).order('name').then(must),
    sb.from('project_pics').select('*').then(must),
  ]);
  const act = people.filter((x) => x.active);
  const tick = (x, k, on, dis = false, tip = '') => `<td class="ac"><input type="checkbox" data-p="${x.id}" data-k="${k}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''} title="${esc(tip)}"></td>`;
  shell(`<div class="page-head"><div><h1>Projects</h1><p>Projects for project expense forms. The PIC is told when a project form is sent, and can see it.</p></div></div>
  <div class="banner info" style="margin-bottom:14px">Who can use the back office, and who does data entry or accounting, is set in the staff system: <a href="/staff-permissions.html#roles">Admin › Roles and access</a>.</div>
  <div class="card"><div class="card-head"><h2>Projects</h2><div class="row"><input class="input" id="npname" placeholder="New project name" style="width:220px"><button class="btn" id="npadd">Add project</button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Project</th><th>Code <span class="faint" style="font-weight:400">for FlowAccount</span></th><th>PIC (checks project forms first)</th><th>Status</th></tr></thead><tbody>
  ${projects.map((pr) => `<tr class="${pr.active ? '' : 'faint'}"><td><b>${esc(pr.name)}</b>${pr.created_by_name ? `<div class="faint" style="font-size:11px">added by ${esc(pr.created_by_name)}</div>` : ''}</td><td><input class="input mono" data-pcode="${pr.id}" ${isAdmin() ? '' : 'disabled'} value="${esc(pr.code || '')}" placeholder="e.g. BCMOPEN26" style="width:130px;text-transform:uppercase"></td><td><div class="picbox">${act.map((x) => `<label class="picchip${pics.some((q) => q.project_id === pr.id && q.staff_id === x.id) ? ' on' : ''}"><input type="checkbox" data-pic="${pr.id}" data-s="${x.id}" ${pics.some((q) => q.project_id === pr.id && q.staff_id === x.id) ? 'checked' : ''}>${esc(x.full_name || x.staff_no)}</label>`).join('')}</div></td>
    <td>${isAdmin() ? '' : `<span class="faint">${pr.active ? 'Active' : 'Closed'}</span>`}<button ${isAdmin() ? '' : 'hidden'} class="btn small ghost" data-pact="${pr.id}" data-on="${pr.active ? 1 : 0}">${pr.active ? 'Active · close' : 'Closed · reopen'}</button></td></tr>`).join('') || '<tr><td colspan="4" class="faint">No projects yet.</td></tr>'}
  </tbody></table></div>
  <div class="faint" style="font-size:12px;padding:0 16px 14px">Every form goes: the checker the sender picked → Admin (final approval) → Admin pays → Data entry enters it in FlowAccount. Nobody checks or approves their own form. With no checker picked, a form goes straight to an admin.</div></div>`);
  document.getElementById('hlrow')?.scrollIntoView({ block: 'center' });
  main().querySelectorAll('input[data-k]').forEach((c) => (c.onchange = async () => {
    const k = c.dataset.k, x = people.find((y) => y.id === c.dataset.p);
    const patch = k === 'approver' ? { role: c.checked ? 'approver' : 'staff' } : k === 'admin' ? { role: c.checked ? 'admin' : 'staff' } : { [k]: c.checked };
    try { await run(async () => must(await sb.from('profiles').update(patch).eq('id', x.id)), 'Saved'); } catch { c.checked = !c.checked; return; }
    if (k === 'admin' || k === 'approver') pageAccess();
  }));
  main().querySelectorAll('input[data-pic]').forEach((c) => (c.onchange = async () => {
    const row = { project_id: c.dataset.pic, staff_id: c.dataset.s };
    try { await run(async () => must(c.checked ? await sb.from('project_pics').insert(row) : await sb.from('project_pics').delete().eq('project_id', row.project_id).eq('staff_id', row.staff_id)), c.checked ? 'PIC added' : 'PIC removed'); } catch { c.checked = !c.checked; return; }
    c.closest('label').classList.toggle('on', c.checked);
    if (row.staff_id === S.user.id) S.myPics = c.checked ? [...(S.myPics || []), row.project_id] : (S.myPics || []).filter((y) => y !== row.project_id);
  }));
  main().querySelectorAll('[data-pcode]').forEach((inp) => (inp.onchange = async () => { const v = inp.value.trim().toUpperCase().replace(/\s+/g, '') || null; try { await run(async () => must(await sb.from('projects').update({ code: v }).eq('id', inp.dataset.pcode)), 'Code saved'); } catch { return; } inp.value = v || ''; }));
  main().querySelectorAll('[data-pact]').forEach((b) => (b.onclick = async () => { try { await run(async () => must(await sb.from('projects').update({ active: b.dataset.on !== '1' }).eq('id', b.dataset.pact)), 'Saved'); } catch { return; } pageAccess(); }));
  document.getElementById('npadd').onclick = async () => {
    const n = document.getElementById('npname').value.trim(); if (!n) return toast('Type a project name', true);
    try { await run(async () => must(await sb.from('projects').insert({ name: n })), 'Project added'); } catch { return; } pageAccess();
  };
}
// Data entry: one line at a time, laid out in FlowAccount's order, with copy buttons and the receipt
async function pageFA(id) {
  const report = must(await sb.from('expense_reports').select('*').eq('id', id).single());
  const items = must(await sb.from('expense_items').select('*, receipts(*)').eq('report_id', id).order('invoice_date').order('created_at'));
  const staff = (await sb.from('profiles').select('full_name').eq('id', report.staff_id).single()).data || {};
  const proj = report.project_id ? (await sb.from('projects').select('name, code').eq('id', report.project_id).single()).data : null;
  if (!items.length) { shell('<div class="empty">This form has no lines.</div>'); return; }
  let k = Math.max(0, items.findIndex((i) => !i.fa_done)); if (k < 0) k = 0;
  const who = staff.full_name || '';
  const details = (i) => i.payment_method === 'kbiz' ? '' : [who, report.ref_no, i.payment_method === 'own_money' ? 'personal cash' : i.payment_method === 'company_card' ? 'company card' : ''].filter(Boolean).join(' · ');
  const supplier = (i) => i.doc_type === 'receipt_form' ? 'ใบรับรองแทนใบเสร็จ' : i.doc_type === 'cash_bill' && !i.merchant ? 'บิลเงินสด' : (i.merchant || '');
  const category = (i) => { const c = S.categories.find((x) => x.id === i.category_id) || {}; if (report.form_type !== 'project') return { v: c.name || '', note: 'personal form: code to confirm with the accountant' }; const code = i.payment_method === 'kbiz' ? c.fa_code_bank : c.fa_code; return { v: code || c.name || '', note: code ? '' : 'no FlowAccount code set for this category' }; };
  const draw = async () => {
    const i = items[k], done = items.filter((x) => x.fa_done).length;
    const rc = (i.receipts || [])[0];
    const url = rc ? await signedUrl(rc.storage_path) : '';
    const cat = category(i);
    const rows = [
      ['Supplier', supplier(i), !supplier(i) ? 'missing' : ''],
      ['Date', i.invoice_date ? new Date(`${i.invoice_date}T00:00:00`).toLocaleDateString('en-GB') : '', ''],
      ['Project', proj ? (proj.code || proj.name) : '', proj ? (proj.code ? '' : 'no project code set yet (Access & projects)') : 'personal form, leave empty'],
      ['Details', details(i), i.payment_method === 'kbiz' ? 'KBIZ: leave empty' : ''],
      ['Description', [i.item, i.purpose].filter(Boolean).join(', '), ''],
      ['Category', cat.v, cat.note],
      ['Amount', money(i.amount), i.wht_rate ? 'paid to the vendor, after WHT' : ''],
      ['VAT', i.vat_amount ? money(i.vat_amount) : '', i.vat_amount ? '' : 'none'],
      ['WHT', i.wht_rate ? `${Number(i.wht_rate)}% · ${money(i.wht_amount)}` : '', i.wht_rate ? `bill total before WHT: ${money(Number(i.amount) + Number(i.wht_amount || 0))}` : 'none'],
      ['Paid by', PAY[i.payment_method] || '', ''],
      ['Document', DOCT[i.doc_type] || '', i.doc_type ? '' : 'not set'],
    ];
    shell(`<a class="faint" href="#/report/${id}" style="text-decoration:none;font-size:13px">‹ Back to the form</a>
    <div class="page-head"><div><h1>FlowAccount · ${esc(report.ref_no)}</h1><p>${esc(who)} · ${esc(formKind(report))} · ${done} of ${items.length} lines entered</p></div></div>
    <div class="fa-wrap"><div class="fa-photo">${url ? (rc.mime_type === 'application/pdf' ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open PDF</a>` : `<img src="${esc(url)}" alt="Receipt" style="transform:rotate(${rc.rotation || 0}deg)">`) : '<span class="faint">No receipt</span>'}</div>
    <div class="card fa-card"><div class="fa-head"><b>Line ${k + 1} of ${items.length}</b>${i.fa_done ? '<span class="pill paid">Entered</span>' : ''}</div>
      ${rows.map(([l, v, n]) => `<div class="fa-row"><span class="fa-l">${l}</span><span class="fa-v">${v ? esc(v) : '<span class="faint">-</span>'}${n ? `<div class="fa-n">${esc(n)}</div>` : ''}</span>${v && l !== 'Paid by' && l !== 'Document' ? `<button class="btn ghost small fa-copy" data-v="${esc(v)}" title="Copy">Copy</button>` : '<span></span>'}</div>`).join('')}
      <div class="fa-foot"><button class="btn" id="faprev" ${k === 0 ? 'disabled' : ''}>‹ Back</button>${i.fa_done ? '<button class="btn ghost" id="faundo">Not entered</button>' : ''}<button class="btn primary" id="fanext">${i.fa_done ? 'Next ›' : 'Entered, next ›'}</button></div></div></div>`);
    main().querySelectorAll('.fa-copy').forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.v); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); } catch { toast('Could not copy', true); } }));
    document.getElementById('faprev').onclick = () => { k = Math.max(0, k - 1); draw(); };
    const u = document.getElementById('faundo');
    if (u) u.onclick = async () => { try { must(await sb.rpc('mark_fa_line', { p_item: i.id, p_done: false })); } catch (e) { return toast(e.message, true); } i.fa_done = false; draw(); };
    document.getElementById('fanext').onclick = async () => {
      if (!i.fa_done) { try { must(await sb.rpc('mark_fa_line', { p_item: i.id, p_done: true })); } catch (e) { return toast(e.message, true); } i.fa_done = true; }
      if (items.every((x) => x.fa_done)) { toast('All lines entered. Form marked as entered in FlowAccount.'); location.hash = `#/report/${id}`; return; }
      const nx = items.findIndex((x, j) => j > k && !x.fa_done); k = nx >= 0 ? nx : items.findIndex((x) => !x.fa_done); draw();
    };
  };
  draw();
}
async function pageApprovals() {
  await loadOverLimit();
  const p = params();
  const status = p.s || 'todo';
  const key = p.m || '';
  const tsOK = STAGE >= 2 && (isAdmin() || isHR());
  // No tab chosen: open the one with work waiting for this person
  let kind = 'exp';
  if (tsOK && p.k) kind = p.k;
  else if (tsOK) {
    const st = [isHR() ? 'submitted' : '', isAdmin() ? 'checked' : ''].filter(Boolean);
    const [{ data: ts }, { data: ex }] = await Promise.all([sb.from('ot_forms').select('id, staff_id').in('status', st), sb.from('expense_reports').select('id, staff_id, status, form_type, project_id, fa_entered_at').in('status', ['submitted', 'checked', 'approved', 'paid'])]);
    const tsN = (ts || []).filter((x) => x.staff_id !== S.user.id).length, exN = (ex || []).filter(myTodo).length;
    kind = tsN && !exN ? 'ts' : !tsN && !exN && isHR() && !(isApprover() || isPic() || isAccountant() || isDataEntry()) ? 'ts' : 'exp';
  }
  const kq = tsOK ? `&k=${kind}` : '';
  let tsStatus = status;
  if (tsOK && status === 'todo') {
    const hrs = ((await sb.from('profiles').select('id').eq('is_hr', true).eq('active', true)).data || []).length;
    tsStatus = isHR() && !isAdmin() ? 'submitted' : isAdmin() && !isHR() ? (hrs ? 'checked' : ['submitted', 'checked']) : ['submitted', 'checked'];
  }
  let q = sb.from('expense_reports').select('*').order('period_month', { ascending: false }).order('submitted_at', { ascending: true });
  if (status === 'todo') q = q.in('status', ['submitted', 'checked', 'approved', 'paid']);
  else if (status !== 'all') q = q.eq('status', status);
  if (key) q = q.eq('period_month', monthStart(key));
  const reports = must(await q).filter((r) => status !== 'todo' || myTodo(r));
  const ids = reports.map((r) => r.id);
  const totals = ids.length ? must(await sb.from('expense_report_totals').select('*').in('report_id', ids)) : [];
  const staff = must(await sb.from('profiles').select('id, full_name, staff_no'));
  const T = Object.fromEntries(totals.map((t) => [t.report_id, t]));
  const P = Object.fromEntries(staff.map((s) => [s.id, s]));
  const NEW = await unseenIds(reports.filter((r) => r.status === 'submitted' && (r.staff_id !== S.user.id || isAdmin())));
  const tabs = ['todo', 'submitted', 'checked', 'approved', 'rejected', 'paid', 'all'];
  const TABL = (t) => (t === 'all' ? 'All' : t === 'todo' ? 'For me' : t === 'checked' ? 'Waiting final' : t === 'rejected' ? 'Returned' : STATUS_TEXT[t]);
  // Months that actually have forms, newest first
  const allMonths = [...new Set(((await sb.from('expense_reports').select('period_month')).data || []).map((r) => r.period_month.slice(0, 7)))].sort().reverse();
  shell(`
  <div class="page-head"><div><h1>Approvals</h1><p>${esc(todoHint())}</p></div>
    <div class="row"><select class="input" id="m" style="width:auto"><option value="">All months</option>${allMonths.map((k) => `<option value="${k}" ${k === key ? 'selected' : ''}>${monthLabel(k)}</option>`).join('')}</select></div></div>
  ${tsOK ? `<div class="seg" style="margin-bottom:12px"><a href="#/approvals?s=${status}${key ? '&m=' + key : ''}&k=exp" class="${kind === 'exp' ? 'on' : ''}">Expenses</a><a href="#/approvals?s=${status}${key ? '&m=' + key : ''}&k=ts" class="${kind === 'ts' ? 'on' : ''}">Timesheets</a></div>` : ''}
  <div class="row" style="margin-bottom:12px">${['todo', 'all'].map((t) => `<a class="btn small ${t === status ? 'primary' : ''}" href="#/approvals?s=${t}${key ? '&m=' + key : ''}${kq}">${TABL(t)}</a>`).join('')}<select class="input" id="amore" style="width:auto;height:32px;font-size:13px"><option value="">More…</option>${tabs.filter((t) => !['todo', 'all'].includes(t)).map((t) => `<option value="${t}" ${t === status ? 'selected' : ''}>${TABL(t)}</option>`).join('')}</select></div>
  ${kind === 'ts' ? await otApprovalsHtml(tsStatus) : ''}
  <div class="card"${kind === 'ts' ? ' hidden' : ''}>${reports.length ? `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Month</th><th>Reference</th><th>Status</th><th>Submitted</th><th class="num">Spent</th><th class="num">Balance</th></tr></thead><tbody>
    ${reports.map((r) => `<tr class="click" data-href="#/report/${r.id}"><td>${NEW.has(r.id) ? '<span class="newdot" title="New, not opened yet"></span>' : ''}${esc(P[r.staff_id]?.full_name)}<div class="faint mono">${esc(P[r.staff_id]?.staff_no || '')}</div></td><td>${monthLabel(r.period_month.slice(0, 7))}<div class="faint" style="font-size:12px">${esc(formKind(r))}</div></td><td class="mono">${esc(r.ref_no)}</td><td>${pill(r.status)}</td><td>${dateLabel(r.submitted_at)}</td><td class="num">${money(T[r.id]?.total_spent)}</td><td class="num">${money(T[r.id]?.balance)}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">Nothing here.</div>'}</div>
  `);
  document.getElementById('m').onchange = (e) => { location.hash = `#/approvals?s=${status}${e.target.value ? '&m=' + e.target.value : ''}${kq}`; };
  document.getElementById('amore').onchange = (e) => { if (e.target.value) location.hash = `#/approvals?s=${e.target.value}${key ? '&m=' + key : ''}${kq}`; };
  bindRowLinks();
}

/* ---------- recently deleted ---------- */
async function pageTrash() {
  // Same as Needs attention: show the chosen form's deleted items (plus items that belonged to no form)
  const { forms, form: cur } = await currentForm();
  const pick = params().f || cur?.id || 'all';
  const allRows = must(await sb.from('trash').select('*').eq('staff_id', S.user.id).order('deleted_at', { ascending: false }).limit(300));
  const rows = pick === 'all' ? allRows : allRows.filter((t) => !t.data?.report_id || t.data.report_id === pick);
  const F = Object.fromEntries(forms.map((f) => [f.id, f]));
  const formSel = forms.length > 1 ? `<label class="muted" style="display:flex;gap:6px;align-items:center;margin-top:8px">Form <select class="input" id="trform" style="width:auto;padding:5px 8px">${forms.map((f) => `<option value="${f.id}" ${f.id === pick ? 'selected' : ''}>${esc(formLabel(f))}</option>`).join('')}<option value="all" ${pick === 'all' ? 'selected' : ''}>All forms</option></select></label>` : '';
  const list = await Promise.all(rows.map(async (t) => {
    const d = t.data || {};
    const thumb = t.kind === 'receipt' ? await thumbHtml(d) : '<div class="thumb">LINE</div>';
    const what = t.kind === 'receipt'
      ? `Receipt${d.ai_data?.short_name || d.ai_data?.merchant ? ' · ' + esc(d.ai_data.short_name || d.ai_data.merchant) : ''}${d.ai_data?.total_amount ? ' · ' + esc(d.ai_data.currency || 'THB') + ' ' + money(d.ai_data.total_amount) : ''}`
      : `Expense line · ${esc(d.item || '')} · THB ${money(d.amount)} · ${dateLabel(d.invoice_date)}`;
    const left = Math.max(0, 30 - Math.floor((Date.now() - new Date(t.deleted_at)) / 86400000));
    return `<tr><td style="width:56px">${thumb}</td><td>${what}<div class="faint" style="font-size:12px">${pick === 'all' && F[d.report_id] ? esc(formLabel(F[d.report_id])) + ' · ' : ''}Deleted ${dateLabel(t.deleted_at)} · removed for good in ${left} day${left === 1 ? '' : 's'}</div></td><td class="num"><button class="btn small" data-restore="${t.row_id}">Restore</button></td></tr>`;
  }));
  shell(`<div class="page-head"><div><h1>Recently deleted</h1><p>Deleted receipts and lines are kept for 30 days. Restore anything deleted by mistake.</p>${formSel}</div></div>
    <div class="card">${rows.length ? `<div class="table-wrap"><table><tbody>${list.join('')}</tbody></table></div>` : '<div class="empty">Nothing deleted in the last 30 days.</div>'}</div>
    <p class="faint" style="font-size:12px">Lines can only be restored into a form that is still a draft or returned.</p>`);
  const trf = document.getElementById('trform');
  if (trf) trf.onchange = () => { if (trf.value !== 'all') chooseForm(trf.value); location.hash = '#/trash?f=' + trf.value; };
  main().querySelectorAll('[data-restore]').forEach((b) => b.onclick = async () => {
    const { error } = await sb.rpc('restore_deleted', { p_row_ids: [b.dataset.restore] });
    if (error) return toast(friendly(error), true);
    toast('Restored'); await refreshCounts(); pageTrash();
  });
}

/* ---------- account ---------- */
async function pageAccount() {
  const bank = (await sb.from('staff_bank_details').select('*').eq('staff_id', S.user.id).maybeSingle()).data || {};
  shell(`
  <div class="page-head"><div><h1>My account</h1><p>${esc(S.profile.full_name)} · ${esc(S.profile.staff_no || '')} · ${isAdmin() ? 'Back office: Full' : 'Back office: Edit'}${S.profile.is_data_entry ? ' · Data entry' : ''}${S.profile.is_accountant ? ' · Accountant' : ''}</p></div></div>
  <div class="two-col" style="grid-template-columns:1fr 1fr">
    <div class="card"><div class="card-head"><h2>Bank details for reimbursement</h2></div><form class="card-pad stack" id="bf">
      <div class="field"><label>Bank</label><input class="input" name="bank_name" value="${esc(bank.bank_name)}" placeholder="e.g. Kasikorn Bank" required></div>
      <div class="field"><label>Account number</label><input class="input mono" name="account_no" value="${esc(bank.account_no)}" required></div>
      <div class="field"><label>Account name</label><input class="input" name="account_name" value="${esc(bank.account_name)}" placeholder="As shown in the bank book" required></div>
      <div class="faint" style="font-size:12px">Only you and the office admin can see this.</div>
      <div><button class="btn primary">Save bank details</button></div></form></div>
    <div class="card"><div class="card-head"><h2>Password</h2></div><div class="card-pad"><p class="muted" style="margin:0">Your password is the one for the staff system. Change it there, or ask an admin (Staff › Directory › your profile › Password).</p></div></div>
    <div class="card"><div class="card-head"><h2>Signature</h2><button class="btn small" id="sigdraw">${S.profile.signature ? 'Draw again' : 'Add signature'}</button></div><div class="card-pad">${S.profile.signature ? `<img class="sigimg" src="${esc(S.profile.signature)}" alt="Your signature">` : '<span class="faint">No signature yet. You need one to submit or approve a form.</span>'}<div class="faint" style="font-size:12px;margin-top:6px">Printed on forms you submit or approve.</div></div></div>
    <div style="margin-top:8px;grid-column:1/-1;max-width:420px"><div class="faint" style="font-size:12px;margin-bottom:6px">Signed in as ${esc(S.profile.full_name || S.profile.staff_no)}</div><button class="btn" id="so2" style="width:100%">Sign out</button></div>
  </div>`);
  document.getElementById('so2').onclick = signOut;
  document.getElementById('sigdraw').onclick = async () => { if (await signatureDialog()) pageAccount(); };
  const bf = document.getElementById('bf');
  bf.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(bf));
    await run(async () => must(await sb.from('staff_bank_details').upsert({ staff_id: S.user.id, bank_name: d.bank_name.trim(), account_no: d.account_no.trim(), account_name: d.account_name.trim() })), 'Bank details saved');
  };
}

/* ---------- admin: staff ---------- */
async function adminCall(body, retry = true) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  // An old sign-in that no longer exists on the server (signed out on another device): refresh once and try again
  if (error && retry && error.context?.status === 401) {
    const { error: re } = await sb.auth.refreshSession();
    if (!re) return adminCall(body, false);
    throw new Error('Your sign-in has expired. Please sign out and sign in again.');
  }
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function pageStaff() {
  const staff = must(await sb.from('profiles').select('*').order('staff_no', { nullsFirst: false }));
  const [projs, pics] = await Promise.all([sb.from('projects').select('id, name').then(must), sb.from('project_pics').select('*').then(must)]);
  const access = (x) => {
    const t = [x.role === 'admin' ? 'Admin' : '', x.role === 'approver' ? 'Office approver' : '', x.is_accountant ? 'Accountant' : '', x.is_data_entry ? 'Data entry' : '', x.is_hr ? 'HR' : ''].filter(Boolean);
    const pn = projs.filter((pr) => pics.some((q) => q.project_id === pr.id && q.staff_id === x.id)).map((pr) => pr.name);
    if (pn.length) t.push('PIC: ' + pn.join(', '));
    return `${(t.length ? t : ['Staff']).map((y) => `<span class="atag">${esc(y)}</span>`).join('')}<div><a href="#/admin/access?p=${x.id}" style="font-size:12px">Set access</a></div>`;
  };
  const nextNo = (pre) => { const n = staff.map((s) => new RegExp(`^${pre}(\\d{3})$`).exec(s.staff_no || '')).filter(Boolean).map((m) => Number(m[1])); return `${pre}${String((n.length ? Math.max(...n) : 0) + 1).padStart(3, '0')}`; };
  const next = nextNo('IGASTF');
  shell(`
  <div class="page-head"><div><h1>Staff</h1><p>Logins and details. Staff sign in with their staff number and password. Access is set on Settings › Projects &amp; access.</p></div></div>
  <div class="stack">
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Staff no.</th><th>Name</th><th>Thai name</th><th>Contact email</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>
      ${staff.map((s) => `<tr data-id="${s.id}">
        <td class="mono">${esc(s.staff_no || '-')}</td>
        <td><input class="input" data-f="full_name" value="${esc(s.full_name)}"></td>
        <td><input class="input" data-f="thai_name" value="${esc(s.thai_name)}"></td>
        <td><input class="input" data-f="contact_email" type="email" value="${esc(s.contact_email)}" placeholder="optional"></td>
        <td>${access(s)}</td>
        <td>${s.active ? '<span class="pill paid">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
        <td class="num"><button class="btn small ghost" data-pin>Reset password</button>${s.id !== S.user.id ? `<button class="btn small ghost ${s.active ? 'danger' : ''}" data-active="${s.active ? 0 : 1}">${s.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>
      </tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><div class="card-head"><h2>Add staff</h2></div><form class="card-pad" id="nf"><div class="grid-form">
      <div class="field"><label>Staff number</label><input class="input mono" name="staff_no" value="${next}" required pattern="[A-Za-z]{6}[0-9]{3}"><span class="hint">IGASTF for staff, other 3 letters for other groups, e.g. IGAFRL001</span></div>
      <div class="field"><label>Role</label><select class="input" name="role"><option>staff</option><option>approver</option><option>admin</option></select></div>
      <div class="field"><label>Full name</label><input class="input" name="full_name" required></div>
      <div class="field"><label>Thai name (optional)</label><input class="input" name="thai_name"></div>
      <div class="field"><label>Contact email (optional)</label><input class="input" name="contact_email" type="email"></div>
      <div class="field"><label>Starting password</label><input class="input" name="pin" required minlength="8" autocomplete="off"><span class="hint">At least 8 characters. Give it to the person privately. They must change it on first sign-in.</span></div>
    </div><div style="margin-top:14px"><button class="btn primary">Create login</button></div></form></div>
  </div>`);
  const nf = document.getElementById('nf');
  // Suggest the next number for the role, unless someone typed their own
  nf.role.onchange = () => { const sug = [nextNo('IGASTF'), nextNo('IGAADM')]; if (!nf.staff_no.value.trim() || sug.includes(nf.staff_no.value.trim().toUpperCase())) nf.staff_no.value = nextNo(nf.role.value === 'admin' ? 'IGAADM' : 'IGASTF'); };
  nf.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(nf));
    await run(() => adminCall({ action: 'create', ...d, staff_no: normStaffNo(d.staff_no) }), `Login created for ${d.full_name}`);
    pageStaff();
  };
  main().querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelectorAll('[data-f]').forEach((el) => el.onchange = async () => {
      try { await run(() => adminCall({ action: 'update', id, [el.dataset.f]: el.value }), 'Saved'); } catch { pageStaff(); }
    });
    tr.querySelector('[data-pin]').onclick = async (e) => {
      const td = e.target.closest('td');
      td.innerHTML = `<div class="row" style="justify-content:flex-end"><input class="input pin" style="width:170px" placeholder="New password" autocomplete="off"><button class="btn small primary">Set</button><button class="btn small ghost">Cancel</button></div>`;
      const [inp, ok, cancel] = td.querySelectorAll('input,button');
      cancel.onclick = () => pageStaff();
      ok.onclick = async () => { await run(() => adminCall({ action: 'reset_pin', id, pin: inp.value }), 'Password reset. They must change it at next sign-in.'); pageStaff(); };
      inp.focus();
    };
    const act = tr.querySelector('[data-active]');
    if (act) act.onclick = async () => {
      if (!confirmInline(act)) return;
      await run(() => adminCall({ action: 'update', id, active: act.dataset.active === '1' }), 'Updated');
      pageStaff();
    };
  });
}

/* ---------- admin: cash advances ---------- */
async function pageCashSettings() {
  const staff = must(await sb.from('profiles').select('id, full_name, staff_no, role, active, gets_advance').eq('active', true).order('staff_no'));
  shell(`<div class="page-head"><div><h1>Who gets cash advances</h1><p>Only people set to Yes see the Cash advance box on their expense forms. Admins always do. Everyone else pays with their own money and is paid back.</p></div></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Staff</th><th>Gets cash advances</th></tr></thead><tbody>
  ${staff.map((p) => `<tr><td>${esc(p.full_name)}<div class="faint mono">${esc(p.staff_no || '')}</div></td><td>${p.role === 'admin' ? '<span class="faint">Always (admin)</span>' : seg('data-gadv', p.id, p.gets_advance)}</td></tr>`).join('')}
  </tbody></table></div></div>
  <p class="faint" style="font-size:12px">A form that already has an advance keeps it if you switch someone to No.</p>`);
  main().querySelectorAll('[data-gadv]').forEach((el) => (el.onclick = async () => {
    if (el.classList.contains('on')) return;
    const on = el.dataset.v === '1';
    try { await run(async () => must(await sb.from('profiles').update({ gets_advance: on }).eq('id', el.dataset.gadv)), on ? 'Gets cash advances now' : 'No cash advances'); } catch { /* shown */ }
    pageCashSettings();
  }));
}
async function pageAdvances() {
  // Totals per staff member across all forms. Staff enter their own advance on each form; admins can correct it here.
  const open = params().s || '';
  const [staff, reports, totals] = await Promise.all([
    sb.from('profiles').select('id, full_name, staff_no, active').order('staff_no').then(must),
    sb.from('expense_reports').select('*').order('period_month', { ascending: false }).then(must),
    sb.from('expense_report_totals').select('*').then(must),
  ]);
  const T = Object.fromEntries(totals.map((t) => [t.report_id, t]));
  const per = staff.map((p) => {
    const rs = reports.filter((r) => r.staff_id === p.id);
    const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
    const adv = sum((r) => Number(r.advance_topup || 0));
    const spent = sum((r) => Number(T[r.id]?.total_spent || 0));
    const lastPersonal = rs.find((r) => r.form_type !== 'project');
    const holds = lastPersonal ? Math.max(0, Number(T[lastPersonal.id]?.balance || 0)) : 0;
    const toReturn = sum((r) => (r.form_type === 'project' && r.status !== 'paid' ? Math.max(0, Number(T[r.id]?.balance || 0)) : 0));
    const owed = sum((r) => (['submitted', 'approved'].includes(r.status) ? Math.max(0, -Number(T[r.id]?.balance || 0)) : 0));
    return { p, rs, adv, spent, holds, toReturn, owed };
  }).filter((x) => x.adv > 0 || x.rs.some((r) => Number(r.opening_advance || 0) > 0));
  const others = staff.filter((p) => p.active).length - per.filter((x) => x.p.active).length;
  const G = per.reduce((a, x) => ({ adv: a.adv + x.adv, holds: a.holds + x.holds, toReturn: a.toReturn + x.toReturn, owed: a.owed + x.owed }), { adv: 0, holds: 0, toReturn: 0, owed: 0 });
  shell(`
  <div class="page-head"><div><h1>Cash advances</h1><p>Only people who have an advance. Click a person to see their forms and correct an advance. Who can get one: Settings › Cash advances.</p></div></div>
  <div class="stats" style="margin-bottom:16px">
    <div class="stat"><label>Advances given</label><div>${money(G.adv)}</div><small>all forms</small></div>
    <div class="stat"><label>Staff still hold</label><div>${money(G.holds)}</div><small>personal, carried forward</small></div>
    <div class="stat"><label>To return</label><div>${money(G.toReturn)}</div><small>project leftovers</small></div>
    <div class="stat"><label>Company owes</label><div>${money(G.owed)}</div><small>submitted or approved, not paid</small></div>
  </div>
  ${!per.length ? `<div class="card" style="text-align:center;padding:34px 20px"><h2 style="margin:0 0 6px">No cash advances yet</h2><p class="faint" style="margin:0">They appear here when someone set to Yes in Settings › Cash advances enters one on a form.</p></div>` : `<div class="card"><div class="table-wrap"><table><thead><tr><th>Staff</th><th class="num">Forms</th><th class="num">Advances</th><th class="num">Spent</th><th class="num">Holds now</th><th class="num">To return</th><th class="num">Company owes</th></tr></thead><tbody>
    ${per.map((x) => `<tr class="click" data-s="${x.p.id}"><td>${esc(x.p.full_name)}<div class="faint mono">${esc(x.p.staff_no || '')}</div></td><td class="num">${x.rs.length}</td><td class="num">${money(x.adv)}</td><td class="num">${money(x.spent)}</td><td class="num">${money(x.holds)}</td><td class="num">${money(x.toReturn)}</td><td class="num">${x.owed ? `<b>${money(x.owed)}</b>` : money(0)}</td></tr>
      ${open === x.p.id ? `<tr><td colspan="7" style="background:var(--paper)"><table class="subt"><thead><tr><th>Form</th><th>Status</th><th class="num">Carried forward</th><th class="num">Advance</th><th class="num">Spent</th><th class="num">Balance</th></tr></thead><tbody>
        ${x.rs.map((r) => `<tr><td><a href="#/report/${r.id}?lines=1" class="mono">${esc(r.ref_no)}</a><div class="faint" style="font-size:12px">${esc(monthLabel(r.period_month.slice(0, 7)) + ' · ' + formKind(r))}</div></td><td>${pill(r.status)}</td><td class="num">${money(r.opening_advance)}</td><td class="num"><input class="input num" style="width:120px;display:inline-block" type="number" step="0.01" min="0" data-adv="${r.id}" value="${Number(r.advance_topup)}"></td><td class="num">${money(T[r.id]?.total_spent)}</td><td class="num">${money(T[r.id]?.balance)}</td></tr>`).join('') || '<tr><td colspan="6" class="faint">No forms yet.</td></tr>'}
      </tbody></table></td></tr>` : ''}`).join('')}
  </tbody></table></div>${others > 0 ? `<div class="faint" style="padding:10px 16px;border-top:1px solid var(--line);font-size:13px">${others} other staff ${others === 1 ? 'has' : 'have'} no cash advance.</div>` : ''}</div>`}
  <p class="faint" style="font-size:12px">Click a person to see their forms. Holds now: positive balance on their latest personal form. Company owes: forms with more spent than advanced, not yet paid.</p>`);
  main().querySelectorAll('tr[data-s]').forEach((tr) => (tr.onclick = () => { location.hash = '#/admin/advances' + (open === tr.dataset.s ? '' : '?s=' + tr.dataset.s); }));
  main().querySelectorAll('[data-adv]').forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
    el.onchange = async () => {
      try { await run(async () => must(await sb.from('expense_reports').update({ advance_topup: Math.max(0, Number(el.value || 0)) }).eq('id', el.dataset.adv)), 'Advance saved'); } catch { return; }
      pageAdvances();
    };
  });
}

/* ---------- admin: categories ---------- */
async function pageCategories() {
  const cats = must(await sb.from('expense_categories').select('*').order('sort_order'));
  const tk = (c, f) => `<td class="c-tick"><input type="checkbox" data-tk="${f}" ${c[f] ? 'checked' : ''}></td>`;
  shell(`
  <div class="page-head"><div><h1>Categories</h1><p>Tick where each category is offered. Turn off instead of deleting, to keep old reports intact.</p></div></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Order</th><th>Name</th><th>Status</th><th class="c-tick" style="border-left:1px solid var(--line)">Petty Cash</th><th class="c-tick">Project</th><th class="c-tick">Accounting</th></tr></thead><tbody>
    ${cats.map((c) => `<tr data-id="${c.id}"><td style="width:90px"><input class="input" type="number" data-f="sort_order" value="${c.sort_order}"></td><td><input class="input" data-f="name" value="${esc(c.name)}"></td>
      <td style="width:70px"><button class="btn small ${c.active ? '' : 'ghost'}" data-toggle>${c.active ? 'On' : 'Off'}</button></td>${tk(c, 'on_petty').replace('class="c-tick"', 'class="c-tick" style="border-left:1px solid var(--line)"')}${tk(c, 'on_project')}${tk(c, 'on_acct')}</tr>`).join('')}
  </tbody></table></div>
  <form class="card-pad row" id="cf" style="border-top:1px solid var(--line)"><input class="input" name="name" placeholder="New category" required style="max-width:320px"><button class="btn">Add</button></form></div>
  <p class="faint" style="font-size:12px">Accounting = Card payments and Bank transfers. FlowAccount account codes for each category are on Settings › FlowAccount.</p>`);
  const reload = async () => { S.categories = must(await sb.from('expense_categories').select('*').order('sort_order')); pageCategories(); };
  main().querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.querySelectorAll('[data-f]').forEach((el) => el.onchange = async () => {
      const v = el.dataset.f === 'sort_order' ? Number(el.value) : (el.value.trim() || null);
      await run(async () => must(await sb.from('expense_categories').update({ [el.dataset.f]: v }).eq('id', tr.dataset.id)), 'Saved');
      reload();
    });
    tr.querySelectorAll('[data-tk]').forEach((el) => el.onchange = async () => {
      try { await run(async () => must(await sb.from('expense_categories').update({ [el.dataset.tk]: el.checked }).eq('id', tr.dataset.id)), 'Saved'); } catch { el.checked = !el.checked; return; }
      S.categories = must(await sb.from('expense_categories').select('*').order('sort_order'));
    });
    tr.querySelector('[data-toggle]').onclick = async () => {
      const on = tr.querySelector('[data-toggle]').textContent === 'On';
      await run(async () => must(await sb.from('expense_categories').update({ active: !on }).eq('id', tr.dataset.id)), 'Saved');
      reload();
    };
  });
  const cf = document.getElementById('cf');
  cf.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(cf));
    await run(async () => must(await sb.from('expense_categories').insert({ name: d.name.trim(), sort_order: cats.length + 1, on_petty: true, on_project: true, on_acct: true })), 'Category added. Untick where it does not apply.');
    reload();
  };
}

/* ---------- start ---------- */
// Group login: arriving from the INGROUP ASIA back office with a one-time pass signs the person in here
async function hubArrive() {
  const m = (location.hash || '').match(/[?&]hub=([a-f0-9]{64})/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.hash.replace(/[?&]hub=[a-f0-9]{64}/, '').replace(/\?$/, ''));
  try {
    // Never leave the page on Loading: give up after 8 seconds and show the normal sign-in
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(SUPABASE_URL + '/functions/v1/id-sign-in', { signal: ctl.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'hub', pass: m[1] }) });
    const out = await r.json(); clearTimeout(tm);
    if (r.ok && out.access_token) await sb.auth.setSession({ access_token: out.access_token, refresh_token: out.refresh_token });
  } catch { /* they sign in as usual */ }
}
async function start() {
  await hubArrive();
  await loadMe(); route(); setTimeout(pollPending, 800);
  let later = false; try { later = !!sessionStorage.getItem('bo_sig_later'); } catch { /* ignore */ }
  if (S.profile && !S.profile.signature && !later && !S.user.user_metadata?.must_change_pin) setTimeout(() => signatureDialog({ first: true }), 600);
}
let recovering = /type=recovery/.test(location.hash);
sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') { S.user = null; } if (evt === 'PASSWORD_RECOVERY') recovering = true; });
if (recovering) { setTimeout(async () => { const { data } = await sb.auth.getSession(); history.replaceState(null, '', location.pathname); if (data.session) { S.user = data.session.user; renderChangePin(true).bind(); } else renderLogin('That reset link has expired or was already used. Ask for a new one.'); }, 600); } else start();

/* ---------- phone version: Snap, To check, Forms, Approvals ---------- */
// Lines that still need something from the staff member: a purpose, a check after reading, or a possible duplicate
const needsCheck = (i) => i.needs_review || !String(i.purpose || '').trim() || (i.duplicate_of && !i.duplicate_ok);
async function phoneCheckItems() {
  const forms = await openForms();
  if (!forms.length) return { forms, items: [] };
  const items = must(await sb.from('expense_items').select('*, receipts(*)').in('report_id', forms.map((f) => f.id)).order('invoice_date'));
  // Lines the approver noted on a returned form, until the staff member saves them again
  const noted = (i) => { const f = forms.find((x) => x.id === i.report_id); return i.return_note && f?.status === 'rejected' && (!f.last_returned_at || i.updated_at <= f.last_returned_at); };
  if (!S.faVendors) await loadFAVendors();
  const noSup = (i) => (S.faVendors || []).length && needsSupplier(i);
  return { forms, items: items.filter((i) => needsCheck(i) || noted(i) || noSup(i)) };
}
async function phoneCount() {
  try { S.checkCount = (await phoneCheckItems()).items.length; } catch { S.checkCount = 0; }
  try {
    const { count } = await sb.from('receipts').select('id', { count: 'exact', head: true }).eq('staff_id', S.user.id).is('item_id', null);
    S.heldCount = count || 0;
  } catch { S.heldCount = 0; }
}
const heldNote = () => (S.heldCount ? `<p class="pnote">${S.heldCount} photo${S.heldCount > 1 ? 's' : ''} could not become a line (unclear or possible duplicate). Sort ${S.heldCount > 1 ? 'them' : 'it'} in Needs attention on a computer.</p>` : '');
function phoneTabs() {
  const r = (location.hash || '#/capture').split('?')[0];
  const T = (href, icon, label, n) => `<a href="${href}" class="${r.startsWith(href) ? 'on' : ''}"><span class="pt-ic">${icon}</span>${label}${n ? `<span class="pt-n">${n}</span>` : ''}</a>`;
  const cam = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const chk = '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
  const doc = '<svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h4"/></svg>';
  const apr = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
  return `<nav class="ptabs">${T('#/capture', cam, 'Snap')}${T('#/check', chk, 'To check', S.checkCount)}${T('#/forms', doc, 'Forms')}${isReviewer() ? T('#/approvals', apr, 'Waiting') : ''}</nav>`;
}
const desktopNote = '<p class="pnote">Batch delete, printing and grouping papers are on the computer version.</p>';
async function recentPurposes() {
  const { data } = await sb.from('expense_items').select('purpose, expense_reports!inner(staff_id)').eq('expense_reports.staff_id', S.user.id).not('purpose', 'is', null).order('updated_at', { ascending: false }).limit(60);
  const out = [];
  (data || []).forEach((d) => { const p = String(d.purpose || '').trim(); if (p && p.length >= 4 && p.length <= 60 && !out.includes(p) && out.length < 4) out.push(p); });
  return out;
}
const chipsHtml = (list) => (list.length ? `<div class="pchips">${list.map((p) => `<button type="button" class="pchip" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : '');
const wireChips = (root, input) => root.querySelectorAll('.pchip').forEach((c) => (c.onclick = () => { input.value = c.dataset.p; input.dispatchEvent(new Event('input')); }));

// I. Snap: pick the form, take the photo, fix it (rotate, crop, retake), add the purpose, send
async function phoneSnap(flash = '') {
  const { forms, form: report } = await currentForm();
  if (!report) {
    shell(`<div class="pstack"><h1>Snap a receipt</h1><p class="muted">You have no open expense form. Start one for this month, then your receipts go straight into it.</p><button class="btn primary pbig" id="start">Start a form</button></div>`);
    document.getElementById('start').onclick = async () => { const f = await newFormDialog(); if (f) { chooseForm(f.id); phoneSnap(); } };
    return;
  }
  shell(`<div class="pstack">
    ${forms.length > 1 ? `<div class="field"><label>Adding to</label><select class="input" id="formsel">${forms.map((f) => `<option value="${f.id}" ${f.id === report.id ? 'selected' : ''}>${esc(monthLabel(f.period_month.slice(0, 7)) + ' · ' + formKind(f))}</option>`).join('')}</select></div>` : `<div class="faint" style="font-size:13px">Adding to <b style="color:var(--ink)">${esc(monthLabel(report.period_month.slice(0, 7)) + ' · ' + formKind(report))}</b></div>`}
    <label class="psnap"><input type="file" class="pick" accept="image/*" capture="environment" hidden><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Take photo</span></label>
    <label class="btn pbig"><input type="file" class="pick" accept="image/*,application/pdf" hidden>Choose from gallery</label>
    <div id="result">${flash}</div>
    <div id="qbox"></div>
    ${heldNote()}
    <a href="#" class="faint" id="nf" style="font-size:12px;text-align:center;margin-top:8px">Receipt for another month or project? Start a form</a>
  </div>`);
  const fs = document.getElementById('formsel');
  if (fs) fs.onchange = (e) => { chooseForm(e.target.value); phoneSnap(); };
  document.getElementById('nf').onclick = async (e) => { e.preventDefault(); const f = await newFormDialog(); if (f) chooseForm(f.id); phoneSnap(); };
  main().querySelectorAll('.pick').forEach((inp) => (inp.onchange = (e) => { const f = e.target.files[0]; if (f) phoneReview(f, report); }));
  renderQueue();
}
// Reading queue: photos are uploaded and read one after another in the background while staff keep snapping
const SNAPQ = { jobs: [], running: false };
// Who paid: staff choose on Snap (phone). Only "Me" is repaid.
const WHO = [['cash_advance', 'Petty cash', 'From the cash the company gave me.'], ['company_card', 'Company card', 'Paid with the company Visa. Not repaid to me.'], ['own_money', 'Me', 'Paid with my own money. Repaid to me.']];
function whoHtml(sel = 'cash_advance') {
  if (!WHO.some((w) => w[0] === sel)) return '';
  return `<div class="field"><label>Who paid?</label><input type="hidden" name="payment_method" id="who" value="${sel}"><div class="pwho">${WHO.map(([k, l]) => `<button type="button" class="pwb${k === sel ? ' on' : ''}" data-who="${k}">${l}</button>`).join('')}</div><span class="hint" id="whoh">${WHO.find((w) => w[0] === sel)[2]}</span></div>`;
}
function wireWho(root) {
  const inp = root.querySelector('#who'); if (!inp) return;
  root.querySelectorAll('[data-who]').forEach((b) => (b.onclick = () => {
    inp.value = b.dataset.who;
    root.querySelectorAll('[data-who]').forEach((x) => x.classList.toggle('on', x === b));
    root.querySelector('#whoh').textContent = WHO.find((w) => w[0] === b.dataset.who)[2];
  }));
}
function enqueueSnap(file, report, purpose, paidBy = 'own_money') {
  SNAPQ.jobs.push({ id: crypto.randomUUID(), file, report, purpose, paidBy, status: 'waiting', thumb: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
  runSnapQueue();
}
async function runSnapQueue() {
  if (SNAPQ.running) return;
  SNAPQ.running = true;
  let j;
  while ((j = SNAPQ.jobs.find((x) => x.status === 'waiting'))) {
    j.status = 'reading'; renderQueue();
    try {
      const msg = await snapAndRead(j.file, j.report, 'phone');
      if (j.purpose && msg.itemIds?.length) await sb.from('expense_items').update({ purpose: j.purpose }).in('id', msg.itemIds).or('purpose.is.null,purpose.eq.');
      if (j.paidBy && j.paidBy !== 'cash_advance' && msg.itemIds?.length) await sb.from('expense_items').update({ payment_method: j.paidBy }).in('id', msg.itemIds);
      j.status = 'done'; j.msg = msg.text || (msg.html || '').replace(/<[^>]+>/g, ' ');
    } catch (e) { j.status = 'failed'; j.msg = friendly(e); }
    try { await refreshCounts(); } catch { /* ignore */ }
    const tab = document.querySelector('.ptabs a[href="#/check"]');
    if (tab) { let n = tab.querySelector('.pt-n'); if (S.checkCount) { if (!n) { n = document.createElement('span'); n.className = 'pt-n'; tab.appendChild(n); } n.textContent = S.checkCount; } else n?.remove(); }
    renderQueue();
  }
  SNAPQ.running = false;
}
function renderQueue() {
  const box = document.getElementById('qbox'); if (!box) return;
  const list = SNAPQ.jobs.slice(-6).reverse();
  if (!list.length) { box.innerHTML = ''; return; }
  const left = SNAPQ.jobs.filter((x) => x.status === 'waiting' || x.status === 'reading').length;
  box.innerHTML = `<div class="plabel">${left ? `Reading ${left} photo${left > 1 ? 's' : ''}. Keep this page open.` : 'This session'}</div>
    <div class="pq">${list.map((j) => `<div class="pqrow ${j.status}">${j.thumb ? `<img src="${j.thumb}" alt="">` : '<span class="pqf">PDF</span>'}<span>${j.status === 'waiting' ? 'Waiting' : j.status === 'reading' ? 'Reading' : esc(j.msg || '')}</span>${j.status === 'failed' ? `<button class="btn small" data-retry="${j.id}">Try again</button>` : ''}</div>`).join('')}</div>`;
  box.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = () => { const j = SNAPQ.jobs.find((x) => x.id === b.dataset.retry); if (j) { j.status = 'waiting'; runSnapQueue(); } }));
}
window.addEventListener('beforeunload', (e) => { if (SNAPQ.jobs.some((x) => x.status === 'waiting' || x.status === 'reading')) { e.preventDefault(); e.returnValue = ''; } });
async function phoneReview(file, report) {
  const isImg = file.type.startsWith('image/') && !/hei[cf]/.test(file.type);
  let rot = 0, crop = null, bmp = null;
  if (isImg) { try { bmp = await createImageBitmap(file); } catch { bmp = null; } }
  const purposes = await recentPurposes();
  shell(`<div class="pstack">
    <div class="prev" id="prev">${bmp ? '<canvas id="pc"></canvas><div class="crop-box" id="cb" hidden></div>' : `<div class="pfile">${esc(file.name)}</div>`}</div>
    ${bmp ? '<div class="ptools" id="tools"><button type="button" class="btn" id="rot">Rotate</button><button type="button" class="btn" id="crp">Crop</button><button type="button" class="btn" id="re">Retake</button></div>' : ''}
    <div class="field"><label>What was it for? <span class="faint">(optional)</span></label><input class="input" id="pp" placeholder="e.g. China shoot, location scout">${chipsHtml(purposes)}</div>
    ${whoHtml('cash_advance')}
    <button class="btn primary pbig" id="use">Use photo</button>
    <a href="#/capture" class="pnote" id="cancel" style="text-align:center">Cancel</a>
  </div>`);
  const pp = document.getElementById('pp'); wireChips(main(), pp); wireWho(main());
  document.getElementById('cancel').onclick = (e) => { e.preventDefault(); phoneSnap(); };
  // Draw the photo turned by rot, with the crop (in drawn-photo fractions) shown as a box
  const full = () => {
    const side = rot % 180 !== 0, c = document.createElement('canvas');
    c.width = side ? bmp.height : bmp.width; c.height = side ? bmp.width : bmp.height;
    const g = c.getContext('2d'); g.translate(c.width / 2, c.height / 2); g.rotate((rot * Math.PI) / 180); g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return c;
  };
  let cropping = false, start = null, sel = null, zoomReset = () => {};
  const draw = () => {
    if (!bmp) return;
    const src = full(), pc = document.getElementById('pc'), box = document.getElementById('cb'), wrap = document.getElementById('prev');
    const k = Math.min((wrap.clientWidth - 2) / src.width, (window.innerHeight * 0.5) / src.height);
    let s = src;
    if (crop && !cropping) { s = document.createElement('canvas'); s.width = crop.w * src.width; s.height = crop.h * src.height; s.getContext('2d').drawImage(src, crop.x * src.width, crop.y * src.height, s.width, s.height, 0, 0, s.width, s.height); }
    const kk = Math.min((wrap.clientWidth - 2) / s.width, (window.innerHeight * 0.5) / s.height);
    const sc = crop && !cropping ? kk : k, dpr = Math.min(3, window.devicePixelRatio || 1);
    const cw = Math.round(s.width * sc), ch = Math.round(s.height * sc);
    pc.style.width = cw + 'px'; pc.style.height = ch + 'px';
    pc.width = Math.min(s.width, Math.round(cw * dpr)); pc.height = Math.min(s.height, Math.round(ch * dpr));
    const g2 = pc.getContext('2d'); g2.imageSmoothingQuality = 'high'; g2.drawImage(s, 0, 0, pc.width, pc.height);
    box.hidden = true; zoomReset();
  };
  const out = async () => {
    if (!bmp || (!rot && !crop)) return file;
    const src = full(); let c = src;
    if (crop) { c = document.createElement('canvas'); c.width = Math.round(crop.w * src.width); c.height = Math.round(crop.h * src.height); c.getContext('2d').drawImage(src, crop.x * src.width, crop.y * src.height, c.width, c.height, 0, 0, c.width, c.height); }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '-edited.jpg', { type: 'image/jpeg' });
  };
  if (bmp) {
    zoomReset = pinchZoom(document.getElementById('prev'), () => !cropping);
    draw();
    document.getElementById('rot').onclick = () => { rot = (rot + 90) % 360; crop = null; draw(); };
    document.getElementById('re').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.capture = 'environment'; i.onchange = () => i.files[0] && phoneReview(i.files[0], report); i.click(); };
    const pc = document.getElementById('pc'), box = document.getElementById('cb'), crp = document.getElementById('crp');
    const pos = (e) => { const r = pc.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return { x: Math.max(0, Math.min(r.width, t.clientX - r.left)), y: Math.max(0, Math.min(r.height, t.clientY - r.top)) }; };
    const show = () => { box.hidden = false; Object.assign(box.style, { left: pc.offsetLeft + sel.x + 'px', top: pc.offsetTop + sel.y + 'px', width: sel.w + 'px', height: sel.h + 'px' }); };
    const down = (e) => { if (!cropping) return; e.preventDefault(); start = pos(e); sel = { x: start.x, y: start.y, w: 0, h: 0 }; show(); };
    const move = (e) => { if (!cropping || !start) return; e.preventDefault(); const p = pos(e); sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; show(); };
    const up = () => { start = null; };
    pc.addEventListener('touchstart', down, { passive: false }); pc.addEventListener('touchmove', move, { passive: false }); pc.addEventListener('touchend', up);
    pc.addEventListener('mousedown', down); pc.addEventListener('mousemove', move); pc.addEventListener('mouseup', up);
    crp.onclick = () => {
      if (!cropping) { cropping = true; crop = null; sel = null; draw(); crp.textContent = 'Done'; crp.classList.add('primary'); toast('Drag a box around the receipt'); return; }
      cropping = false; crp.textContent = 'Crop'; crp.classList.remove('primary');
      if (sel && sel.w > 20 && sel.h > 20) crop = { x: sel.x / pc.clientWidth, y: sel.y / pc.clientHeight, w: sel.w / pc.clientWidth, h: sel.h / pc.clientHeight };
      draw();
    };
  }
  // Hand the photo to the reading queue and go straight back to the camera
  document.getElementById('use').onclick = async () => {
    const b = document.getElementById('use'); b.disabled = true;
    enqueueSnap(await out(), report, pp.value.trim(), document.getElementById('who')?.value || 'cash_advance');
    phoneSnap();
  };
}

// II. To check: one line at a time, photo on top, purpose and category below
async function phoneCheck(pos = 0) {
  const { forms, items } = await phoneCheckItems();
  S.checkCount = items.length;
  if (!items.length) {
    shell(`<div class="pstack"><h1>To check</h1><div class="pdone"><b>All done</b><span class="muted">Every line has a purpose.</span></div>${heldNote()}<a class="btn pbig" href="#/capture">Snap another receipt</a></div>`);
    return;
  }
  pos = Math.min(pos, items.length - 1);
  const i = items[pos], r = (i.receipts || [])[0], form = forms.find((f) => f.id === i.report_id);
  const url = r ? await signedUrl(r.storage_path) : null;
  const img = r && url && r.mime_type?.startsWith('image/') ? `<img src="${esc(url)}" alt="Receipt" style="transform:rotate(${r.rotation || 0}deg)">` : `<div class="pfile">${r ? 'PDF' : 'No receipt'}</div>`;
  const purposes = await recentPurposes();
  const cats = catFor(form, i.category_id);
  const dup = i.duplicate_of && !i.duplicate_ok;
  shell(`<div class="pstack">
    <div class="spread"><h1>To check</h1><span class="faint">${pos + 1} of ${items.length}</span></div>
    <div class="prev">${img}</div>
    <div class="pmeta"><b>${esc(i.item || 'Expense')}</b><span>${esc(dateLabel(i.invoice_date))} · THB ${money(i.amount)}${i.currency && i.currency !== 'THB' ? ` · ${esc(i.currency)} ${money(i.original_amount)}` : ''}</span><span class="faint">${esc(form ? monthLabel(form.period_month.slice(0, 7)) + ' · ' + formKind(form) : '')}</span></div>
    ${i.return_note ? `<div class="banner bad" style="font-size:13px"><b>Approver:</b> ${esc(i.return_note)}</div>` : ''}
    ${dup ? '<label class="banner bad pdup"><input type="checkbox" id="dupok"> Possible duplicate. Tick if this is a separate expense.</label>' : ''}
    <form id="cf" class="stack" style="gap:12px">
      <div class="field"><label>What was it for?</label><textarea class="input" name="purpose" rows="2" required placeholder="Which project or client?">${esc(i.purpose || '')}</textarea>${chipsHtml(purposes)}</div>
      <div class="field"><label>Category</label><select class="input" name="category_id" required>${cats.map((c) => `<option value="${c.id}" ${c.id === i.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      ${whoHtml(i.payment_method || 'own_money')}
      ${(S.faVendors || []).length && needsSupplier(i) ? `<div class="field"><label>Supplier <span class="faint">(pick from the list)</span></label><input class="input" name="merchant" list="pfav" autocomplete="off" value="${esc(i.merchant || '')}" placeholder="Type the shop name"><datalist id="pfav">${S.faVendors.map((x) => `<option value="${esc(x)}">`).join('')}</datalist><div id="pnew"></div></div>` : ''}
      <a href="#" class="pnote" id="more" style="margin:0">Edit details</a>
      <div id="det" class="stack" style="gap:12px" hidden>
        <div class="field"><label>Item</label><input class="input" name="item" value="${esc(i.item || '')}" required></div>
        <div class="row" style="gap:10px;flex-wrap:nowrap"><div class="field" style="flex:1"><label>Date</label><input class="input" type="date" name="invoice_date" value="${esc(i.invoice_date || '')}" required></div>
        <div class="field" style="flex:1"><label>Amount (THB)</label><input class="input" type="number" step="0.01" min="0" name="amount" value="${esc(i.amount)}" required></div></div>
      </div>
      <div class="error" id="cerr"></div>
      <button class="btn primary pbig" type="submit">${items.length > 1 ? 'Save and next' : 'Save'}</button>
      ${items.length > 1 ? '<a href="#" class="pnote" id="skip" style="text-align:center;margin:0">Skip for now</a>' : ''}
    </form>
    ${heldNote()}
  </div>`);
  pinchZoom(main().querySelector('.prev'));
  const f = document.getElementById('cf'); wireChips(main(), f.purpose); wireWho(main());
  document.getElementById('more').onclick = (e) => { e.preventDefault(); document.getElementById('det').hidden = false; e.target.remove(); };
  const sk = document.getElementById('skip'); if (sk) sk.onclick = (e) => { e.preventDefault(); phoneCheck((pos + 1) % items.length); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('cerr'); err.textContent = '';
    const dupBox = document.getElementById('dupok');
    if (dupBox && !dupBox.checked) { err.textContent = 'Tick the duplicate box if this is a separate expense, or delete it on the computer.'; return; }
    const patch = { purpose: f.purpose.value.trim(), category_id: f.category_id.value, item: f.item.value.trim(), invoice_date: f.invoice_date.value, amount: Number(f.amount.value), needs_review: false };
    if (document.getElementById('who')) patch.payment_method = document.getElementById('who').value;
    if (f.merchant) {
      const m = f.merchant.value.trim();
      if (m && !S.faVendorSet.has(m.toLowerCase())) {
        // Not in the list: add it as a new supplier in one tap
        const box = document.getElementById('pnew');
        if (!box.dataset.ask) { box.dataset.ask = '1'; box.innerHTML = `<div class="pnote" style="margin:6px 0 0">"${esc(m)}" is not in the list. Tap Save again to add it as a new supplier.</div>`; return; }
        const { error } = await sb.from('fa_new_vendors').insert({ name: m, business_type: /(co\.?,?\s*ltd|company|limited|inc|บริษัท|จำกัด)/i.test(m) ? 'Corporation' : 'Individual', created_by: S.user.id, created_by_name: S.profile.full_name });
        if (error && !/duplicate|unique/i.test(error.message)) { err.textContent = error.message; return; }
        S.faVendors.push(m); S.faVendorSet.add(m.toLowerCase());
      }
      if (m) patch.merchant = m;
    }
    if (dupBox) patch.duplicate_ok = true;
    try { await run(async () => must(await sb.from('expense_items').update(patch).eq('id', i.id)), 'Saved'); } catch { return; }
    await refreshCounts(); phoneCheck(pos);
  };
}

// III. Forms: totals and Submit. Submit only once every line has a purpose.
async function phoneForms() {
  const forms = await openForms();
  const ids = forms.map((f) => f.id);
  const [totals, items, past] = await Promise.all([
    ids.length ? sb.from('expense_report_totals').select('*').in('report_id', ids).then(must) : [],
    ids.length ? sb.from('expense_items').select('id, report_id, purpose, needs_review, duplicate_of, duplicate_ok, receipts(id)').in('report_id', ids).then(must) : [],
    sb.from('expense_report_totals').select('*').eq('staff_id', S.user.id).order('period_month', { ascending: false }).limit(12).then(must),
  ]);
  const T = Object.fromEntries(totals.map((t) => [t.report_id, t]));
  const done = past.filter((t) => !ids.includes(t.report_id)).slice(0, 4);
  const stat = await Promise.all(done.map(async (t) => {
    const st = (await sb.from('expense_reports').select('status').eq('id', t.report_id).single()).data?.status;
    let seen = '';
    if (st === 'submitted') { const ev = (await sb.from('report_events').select('*').eq('report_id', t.report_id).order('at')).data || []; seen = /Being reviewed/.test(seenBanner(ev)) ? 'Being reviewed' : 'Waiting for review'; }
    return { t, s: st, seen };
  }));
  const card = (f) => {
    const t = T[f.id] || {}, mine = items.filter((x) => x.report_id === f.id), todo = mine.filter(needsCheck).length, bal = Number(t.balance || 0);
    const noRc = mine.filter((x) => !(x.receipts || []).length).length;
    return `<div class="pform">
      <div class="spread"><b>${esc(monthLabel(f.period_month.slice(0, 7)))} · ${esc(formKind(f))}</b>${pill(f.status)}</div>
      <div class="faint mono">${esc(f.ref_no)}</div>
      ${f.status === 'rejected' && f.rejection_reason ? `<div class="banner bad" style="font-size:13px">Returned: ${esc(f.rejection_reason)}</div>` : ''}
      ${canAdv(f) ? `<div class="field" style="gap:4px"><label style="font-size:12px">Cash advance received</label><input class="input num" type="number" step="0.01" min="0" inputmode="decimal" data-padv="${f.id}" value="${Number(f.advance_topup) || ''}" placeholder="0.00" style="text-align:left"></div>` : ''}
      <div class="pnums"><div><span>Lines</span><b>${mine.length}</b></div><div><span>Spent</span><b>${money(t.total_spent)}</b></div><div><span>${bal < 0 ? 'Owed to you' : f.form_type === 'project' ? 'To return' : 'Balance'}</span><b>${money(Math.abs(bal))}</b></div></div>
      ${!mine.length ? '<span class="faint">No lines yet.</span>' : noRc ? `<div class="banner bad" style="font-size:13px">${noRc} line${noRc > 1 ? 's have' : ' has'} no receipt photo. Add ${noRc > 1 ? 'them' : 'it'} on a computer.</div>` : todo ? `<a class="btn pbig" href="#/check">${todo} line${todo > 1 ? 's need' : ' needs'} a purpose</a>` : `<div data-pchk="${f.id}">${checkerPicker(f)}</div>${chkChosen(f) ? `<button class="btn primary pbig" data-sub="${f.id}">${f.checker_id ? 'Send to ' + esc(firstName(f.checker_name)) : 'Send to admin'}</button>` : ''}`}
    </div>`;
  };
  shell(`<div class="pstack">
    <h1>Forms</h1>
    ${forms.length ? forms.map(card).join('') : '<p class="muted">No open forms. Snap a receipt to start one.</p>'}
    ${stat.length ? `<div class="plabel">Sent</div>${stat.map(({ t, s, seen }) => `<div class="prow"><span>${esc(monthLabel(String(t.period_month).slice(0, 7)))} · ${esc(t.form_type === 'project' ? 'Project: ' + (t.project || '') : 'Personal')}<br><span class="faint">${money(t.total_spent)} THB${seen ? ' · ' + seen : ''}</span></span>${pill(s)}</div>`).join('')}` : ''}
    

  </div>`);
  main().querySelectorAll('[data-padv]').forEach((el) => (el.onchange = async () => {
    try { await run(async () => must(await sb.from('expense_reports').update({ advance_topup: Math.max(0, Number(el.value || 0)) }).eq('id', el.dataset.padv)), 'Cash advance saved'); } catch { return; }
    phoneForms();
  }));
  main().querySelectorAll('[data-pchk]').forEach((el) => { const f = forms.find((x) => x.id === el.dataset.pchk); if (f) wireChecker(el, f, phoneForms); });
  main().querySelectorAll('[data-sub]').forEach((b) => (b.onclick = async () => {
    const fid = b.dataset.sub;
    if (!(await ensureSignature('submit'))) return;
    const loose = must(await sb.from('receipts').select('id').eq('staff_id', S.user.id).eq('report_id', fid).is('item_id', null));
    if (loose.length && !b.dataset.ok) {
      b.insertAdjacentHTML('beforebegin', `<div class="banner warn" style="font-size:13px">${loose.length} receipt${loose.length > 1 ? "s aren't" : " isn't"} on any line and won't be included. ${loose.length > 1 ? 'They stay' : 'It stays'} in Needs attention for a later form.</div>`);
      b.dataset.ok = '1'; b.textContent = 'Submit anyway'; return;
    }
    if (!confirmInline(b, 'Tap again to submit')) return;
    try {
      await run(async () => {
        if (loose.length) must(await sb.from('receipts').update({ report_id: null }).in('id', loose.map((r) => r.id)));
        must(await sb.from('expense_reports').update({ status: 'submitted' }).eq('id', fid));
      }, 'Submitted for approval');
    } catch { return; }
    await refreshCounts(); phoneForms();
  }));
}

// IV. Waiting: a reminder of forms to approve, read only. Approving is done on a computer.
async function phoneApprovals() {
  const id = params().id;
  if (id) return phoneApprove(id);
  if (params().ot) return phoneOTApprove(params().ot);
  const [waiting, recent] = await Promise.all([
    sb.from('expense_reports').select('*').in('status', ['submitted', 'checked']).order('submitted_at').then(must),
    sb.from('expense_reports').select('*').in('status', ['approved', 'rejected', 'paid']).order('updated_at', { ascending: false }).limit(5).then(must),
  ]);
  const list = waiting.filter(canActOn);
  const ots = isAdmin() || isHR() ? must(await sb.from('ot_forms').select('id, staff_id, period_end, status').in('status', isAdmin() ? ['checked', 'submitted'] : ['submitted']).order('submitted_at')).filter((f) => f.staff_id !== S.user.id) : [];
  const otc = ots.length ? must(await sb.from('ot_entries').select('form_id, counted').in('form_id', ots.map((f) => f.id))) : [];
  const ids = [...list, ...recent].map((r) => r.id);
  const [totals, staff, lines] = await Promise.all([
    ids.length ? sb.from('expense_report_totals').select('*').in('report_id', ids).then(must) : [],
    sb.from('profiles').select('id, full_name').then(must),
    list.length ? sb.from('expense_items').select('report_id').in('report_id', list.map((r) => r.id)).then(must) : [],
  ]);
  const T = Object.fromEntries(totals.map((t) => [t.report_id, t])), P = Object.fromEntries(staff.map((x) => [x.id, x]));
  const row = (r, right) => `<a class="prow" href="#/approvals?id=${r.id}"><span><b>${esc(P[r.staff_id]?.full_name || '')}</b><br><span class="faint">${esc(monthLabel(r.period_month.slice(0, 7)) + ' · ' + formKind(r))}${right ? '' : ` · ${lines.filter((l) => l.report_id === r.id).length} lines`}</span></span>${right || `<span class="num">${money(T[r.id]?.total_spent)}<br><span class="faint">THB</span></span>`}</a>`;
  shell(`<div class="pstack"><h1>Waiting</h1>
    ${list.length ? `<div class="plabel">Expenses</div>${list.map((r) => row(r)).join('')}` : ''}
    ${ots.length ? `<div class="plabel">Timesheets</div>${ots.map((f) => `<a class="prow" href="#/approvals?ot=${f.id}"><span><b>${esc(P[f.staff_id]?.full_name || '')}</b><br><span class="faint">Timesheet · ${esc(otPeriod(f.period_end).label)}</span></span><span class="num">${Math.round(otc.filter((e) => e.form_id === f.id).reduce((a, e) => a + Number(e.counted), 0) * 100) / 100} h<br><span class="faint">OT</span></span></a>`).join('')}` : ''}
    ${!list.length && !ots.length ? '<div class="pdone"><b>Nothing waiting</b><span class="muted">Submitted forms and timesheets show up here.</span></div>' : ''}
    ${recent.length ? `<div class="plabel">Recent</div>${recent.map((r) => row(r, pill(r.status))).join('')}` : ''}
    </div>`);
}
async function phoneApprove(id) {
  const report = must(await sb.from('expense_reports').select('*').eq('id', id).single());
  const [items, staff, t] = await Promise.all([
    sb.from('expense_items').select('*, receipts(*)').eq('report_id', id).order('invoice_date').then(must),
    sb.from('profiles').select('full_name').eq('id', report.staff_id).single().then(must),
    sb.from('expense_report_totals').select('*').eq('report_id', id).single().then(must),
  ]);
  if (report.status === 'submitted') sb.rpc('mark_seen', { p_report: id }).then(pollPending);
  const x = await reviewExtras(report, items);
  const byCat = {};
  items.forEach((i) => { byCat[i.category_id] = (byCat[i.category_id] || 0) + Number(i.amount); });
  const top = [...items].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 3);
  const thumbs = await Promise.all(items.map(async (i) => { const r = (i.receipts || [])[0]; return r && r.mime_type?.startsWith('image/') ? await signedUrl(r.storage_path) : null; }));
  shell(`<div class="pstack">
    <a href="#/approvals" class="pnote" style="margin:0">‹ Waiting</a>
    <div class="spread"><div><h1>${esc(staff.full_name)}</h1><span class="muted">${esc(monthLabel(report.period_month.slice(0, 7)) + ' · ' + formKind(report))}</span></div>${pill(report.status)}</div>
    <div class="pform"><div class="pnums"><div><span>Lines</span><b>${items.length}</b></div><div><span>Total</span><b>${money(t.total_spent)}</b></div><div><span>Submitted</span><b>${report.submitted_at ? dateLabel(report.submitted_at).replace(/ \d{4}$/, '') : '-'}</b></div></div></div>
    <div class="plabel">By category</div>
    <div class="pform" style="gap:4px">${S.categories.filter((c) => byCat[c.id]).map((c) => `<div class="spread"><span>${esc(c.name)}</span><span class="num">${money(byCat[c.id])}</span></div>`).join('')}</div>
    <div class="plabel">Biggest</div>
    <div class="pform" style="gap:4px">${top.map((i) => `<div class="spread"><span>${esc(i.item)}</span><span class="num">${money(i.amount)}</span></div>`).join('')}</div>
    ${report.status === 'submitted' ? sinceReturnedHtml(items, staff.full_name) : ''}
    ${x.flags.length || x.changed.size ? `<div class="plabel">Worth a look</div><div class="banner warn" style="font-size:13px">${x.changed.size ? `${x.changed.size} line${x.changed.size > 1 ? 's' : ''} changed since returned.<br>` : ''}${x.flags.map((f) => esc(f.text)).join('<br>')}</div>` : ''}
    <button class="btn pbig" id="all">See all ${items.length} lines</button>
    <div id="lines" class="stack" style="gap:6px" hidden>${items.map((i, k) => `<div class="prow" style="justify-content:flex-start">${thumbs[k] ? `<img class="pthumb" src="${esc(thumbs[k])}" alt="" data-view="${esc(i.receipts[0].storage_path)}" data-mime="${esc(i.receipts[0].mime_type)}" data-rot="${i.receipts[0].rotation || 0}" style="transform:rotate(${i.receipts[0].rotation || 0}deg)">` : '<span class="pthumb"></span>'}<span style="flex:1;min-width:0">${esc(i.item)} · <span class="faint">${esc(dateLabel(i.invoice_date).replace(/ \d{4}$/, ''))}</span><br><span class="faint">${esc(i.purpose || 'No purpose')}</span></span><span class="num">${money(i.amount)}</span></div>`).join('')}</div>
    ${canActOn(report) ? phoneDecideBar() : '<p class="pnote" style="text-align:center">Read only.</p>'}
  </div>`);
  document.getElementById('all').onclick = (e) => { document.getElementById('lines').hidden = false; e.target.remove(); };
  wirePhoneDecide(staff.full_name,
    async () => must(await sb.from('expense_reports').update({ status: report.status === 'checked' ? 'approved' : 'checked' }).eq('id', id)),
    async (reason) => must(await sb.rpc('return_form', { p_report: id, p_reason: reason, p_notes: [] })));
}
// Split for payroll: OT on workdays, hours at x2 on days off / holidays, days kept as saved days off
function otSplit(entries, offd = {}) {
  let ot = 0, x2 = 0; const saved = new Set();
  entries.forEach((e) => { if (e.leave_type || !Number(e.hours)) return; if (e.day_type === 'workday' || offd[e.work_date] === 'swap') ot += Number(e.counted); else if (offd[e.work_date] === 'save') saved.add(e.work_date); else x2 += Number(e.counted); });
  const R = (n) => Math.round(n * 100) / 100;
  return { ot: R(ot), x2: R(x2), saved: saved.size, text: `Workday OT ${R(ot)} h · Day-off work ${R(x2)} h at x2 · ${saved.size} saved day${saved.size === 1 ? '' : 's'} off` };
}
// The 26th-25th period a date falls in (otPeriod takes the period's end date)
function periodOf(d) { const t = new Date(`${d}T00:00:00`); return otPeriod(iso(new Date(t.getFullYear(), t.getMonth() + (t.getDate() > 25 ? 1 : 0), 25))); }
function swapMax(d) { const t = new Date(`${d}T00:00:00`); t.setMonth(t.getMonth() + 2); return iso(t); }
function phoneDecideBar() {
  return `<div class="pdec"><button class="btn pbig" id="pno">Return</button><button class="btn primary pbig" id="pok">Approve</button></div><div class="pnote" style="text-align:center">Notes on single lines and Mark as paid are on the computer.</div>`;
}
function wirePhoneDecide(name, approve, giveBack) {
  const ok = document.getElementById('pok'), no = document.getElementById('pno');
  if (!ok) return;
  const done = async (msg) => { toast(msg); await pollPending(); location.hash = '#/approvals'; };
  ok.onclick = async () => {
    if (!(await ensureSignature('approve'))) return;
    if (ok.dataset.sure !== '1') { ok.dataset.sure = '1'; ok.textContent = 'Tap again to approve'; return; }
    ok.disabled = true;
    try { await approve(); } catch (e) { ok.disabled = false; return toast(e.message || 'Could not approve', true); }
    done('Approved');
  };
  no.onclick = () => {
    const sh = document.createElement('div'); sh.className = 'psheet-bg';
    sh.innerHTML = `<div class="psheet"><h3>Return to ${esc(name)}</h3><label class="faint" style="font-size:13px">Reason (they will see this)</label><textarea class="input" id="prs" rows="4" placeholder="e.g. Add a note for the OT on 26 Oct"></textarea><div class="pdec"><button class="btn pbig" id="prc">Cancel</button><button class="btn danger pbig" id="prr">Return</button></div></div>`;
    document.body.appendChild(sh);
    const t = sh.querySelector('#prs'); setTimeout(() => t.focus(), 50);
    sh.querySelector('#prc').onclick = () => sh.remove();
    sh.onclick = (e) => { if (e.target === sh) sh.remove(); };
    sh.querySelector('#prr').onclick = async (e) => {
      const why = t.value.trim(); if (!why) { toast('Write a reason first', true); return t.focus(); }
      e.target.disabled = true;
      try { await giveBack(why); } catch (err) { e.target.disabled = false; return toast(err.message || 'Could not return', true); }
      sh.remove(); done('Returned');
    };
  };
}
async function phoneOTApprove(id) {
  const form = must(await sb.from('ot_forms').select('*').eq('id', id).single());
  const [entries, staff] = await Promise.all([
    sb.from('ot_entries').select('*').eq('form_id', id).order('work_date').order('start_time').then(must),
    sb.from('profiles').select('full_name').eq('id', form.staff_id).single().then(must),
  ]);
  const offd = Object.fromEntries(((await sb.from('ot_offday').select('day, choice').eq('staff_id', form.staff_id)).data || []).map((o) => [o.day, o.choice]));
  const sp = otSplit(entries, offd);
  const otherHR = ((await sb.from('profiles').select('id').eq('is_hr', true).eq('active', true).neq('id', form.staff_id)).data || []).length > 0;
  const hrStep = isHR() && form.staff_id !== S.user.id && form.status === 'submitted';
  const can = hrStep || (isAdmin() && (form.status === 'checked' || (form.status === 'submitted' && !otherHR)));
  if (can && (!form.seen_at || form.seen_at < form.submitted_at)) sb.from('ot_forms').update({ seen_at: new Date().toISOString() }).eq('id', id).then(pollPending);
  const per = otPeriod(form.period_end);
  const ot = Math.round(entries.reduce((a, e) => a + Number(e.counted), 0) * 100) / 100;
  const lv = {}; entries.filter((e) => e.leave_type).forEach((e) => { lv[e.leave_type] = (lv[e.leave_type] || 0) + 1; });
  const short = { annual: 'AL', sick: 'Sick', personal: 'Pers', replacement: 'Repl', other: 'Other' };
  const lvTxt = Object.entries(lv).map(([k, n]) => `${short[k] || k} ${n}`).join(' · ') || 'None';
  const rows = entries.map((e) => `<div class="prow" style="display:block"><div class="spread"><span>${esc(dateLabel(e.work_date).replace(/ \d{4}$/, ''))}</span><span>${e.leave_type ? `<span class="ltag">${esc(LEAVE[e.leave_type] || e.leave_type)}</span>` : `${hhmm(e.start_time)}-${hhmm(e.end_time)}${e.day_type !== 'workday' ? (offd[e.work_date] === 'swap' ? ` · <b>swap</b>${Number(e.counted) ? ` · OT ${Number(e.counted)} h` : ''}` : offd[e.work_date] === 'save' ? ' · <b>saved day</b>' : offd[e.work_date] === 'pay' ? ` · <b>${Number(e.counted)} h x2</b>` : ' · <b>no choice</b>') : Number(e.counted) ? ` · <b>OT ${Number(e.counted)} h</b>` : ''}`}</span></div>${e.reason ? `<div class="faint" style="font-size:12px">${esc(e.reason)}</div>` : ''}</div>`).join('');
  shell(`<div class="pstack"><a class="faint" href="#/approvals" style="text-decoration:none">‹ Waiting</a>
    <h1 style="margin-bottom:0">${esc(staff.full_name)} · Timesheet</h1><div class="faint">${esc(per.label)} · ${pill(form.status)}</div>
    ${form.status === 'rejected' ? `<div class="banner bad">Returned: ${esc(form.rejection_reason || '')}</div>` : ''}
    <div class="pform"><div class="pnums"><div><span>OT</span><b>${sp.ot} h</b></div><div><span>Day off x2</span><b>${sp.x2} h</b></div><div><span>Saved</span><b>${sp.saved}</b></div><div><span>Leave</span><b style="font-size:14px">${esc(lvTxt)}</b></div><div><span>Submitted</span><b>${form.submitted_at ? dateLabel(form.submitted_at).replace(/ \d{4}$/, '') : '-'}</b></div></div></div>
    <div class="plabel">Days that differ from normal</div>
    ${rows || '<div class="faint">All normal days.</div>'}
    ${can ? phoneDecideBar() : '<p class="pnote" style="text-align:center">Read only.</p>'}
  </div>`);
  wirePhoneDecide(staff.full_name,
    async () => must(await sb.from('ot_forms').update({ status: hrStep ? 'checked' : 'approved' }).eq('id', id)),
    async (reason) => must(await sb.from('ot_forms').update({ status: 'rejected', rejection_reason: reason }).eq('id', id)));
}
// Phone, admins: just the people and a password reset (everything else is on the computer)
async function phoneStaff() {
  const staff = must(await sb.from('profiles').select('id, full_name, staff_no, active').eq('active', true).order('staff_no'));
  shell(`<div class="pstack"><h1>Staff</h1><p class="pnote" style="margin:0">Reset a password here. Adding people and access are on the computer.</p>
    ${staff.map((x) => `<div class="prow" style="display:block" data-id="${x.id}"><div class="spread"><span><b>${esc(x.full_name)}</b> <span class="faint mono" style="font-size:12px">${esc(x.staff_no || '')}</span></span><button class="btn small" data-rp>Reset password</button></div><div data-box></div></div>`).join('')}</div>`);
  main().querySelectorAll('[data-rp]').forEach((b) => (b.onclick = () => {
    const row = b.closest('[data-id]'), box = row.querySelector('[data-box]');
    box.innerHTML = `<div class="row" style="margin-top:8px;flex-wrap:nowrap"><input class="input" placeholder="New password (8+)" autocomplete="off" style="flex:1"><button class="btn primary small">Set</button></div><div class="pnote" style="margin:4px 0 0">Give it to them privately. They change it at next sign-in.</div>`;
    const [inp, ok] = box.querySelectorAll('input,button'); inp.focus();
    ok.onclick = async () => { if (inp.value.length < 8) return toast('At least 8 characters', true); try { await run(() => adminCall({ action: 'reset_pin', id: row.dataset.id, pin: inp.value }), 'Password reset'); } catch { return; } box.innerHTML = ''; };
  }));
}
async function phoneRoute(path) {
  if (path === '/') { location.replace('#/capture'); return; }
  if (path === '/capture') return phoneSnap();
  if (path === '/check') return phoneCheck();
  if (path === '/expenses' && params().line) { location.replace('#/check'); return; }
  if (['/forms', '/expenses', '/history', '/inbox', '/trash', '/home'].includes(path) || path.startsWith('/report/')) {
    if (path.startsWith('/report/') && isApprover()) { location.replace('#/approvals?id=' + path.split('/')[2]); return; }
    if (path !== '/forms') { location.replace('#/forms'); return; }
    return phoneForms();
  }
  if (path === '/approvals' && isReviewer()) return phoneApprovals();
  if (path === '/admin/staff') { location.replace('#/home'); return; }
  if (path.startsWith('/ot/review/') && (isAdmin() || isHR())) { location.replace('#/approvals?ot=' + path.split('/')[3]); return; }
  return false;
}

// Pinch with 2 fingers to zoom a photo, drag with 1 finger to move it, double tap to reset.
// enabled(): return false to hand touches to something else (crop).
function pinchZoom(box, enabled = () => true) {
  if (!box) return () => {};
  const el = () => box.querySelector('canvas, img');
  let z = 1, x = 0, y = 0, d0 = 0, z0 = 1, p0 = null, mid0 = null, lastTap = 0;
  const apply = () => {
    const t = el(); if (!t) return;
    t.style.transformOrigin = 'center center';
    const rot = t.dataset.rot0 ?? (t.dataset.rot0 = t.style.transform || '');
    t.style.transform = `translate(${x}px, ${y}px) scale(${z}) ${rot}`;
    box.classList.toggle('zoomed', z > 1.01);
  };
  const reset = () => { z = 1; x = 0; y = 0; apply(); };
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  box.style.touchAction = 'pan-y';
  box.addEventListener('touchstart', (e) => {
    if (!enabled()) return;
    if (e.touches.length === 2) { d0 = dist(e.touches[0], e.touches[1]); z0 = z; mid0 = { x, y }; e.preventDefault(); }
    else if (e.touches.length === 1) {
      const now = Date.now(); if (now - lastTap < 280) { reset(); lastTap = 0; return; } lastTap = now;
      p0 = { cx: e.touches[0].clientX, cy: e.touches[0].clientY, x, y };
    }
  }, { passive: false });
  box.addEventListener('touchmove', (e) => {
    if (!enabled()) return;
    if (e.touches.length === 2 && d0) { e.preventDefault(); z = Math.max(1, Math.min(5, z0 * dist(e.touches[0], e.touches[1]) / d0)); if (z === 1) { x = 0; y = 0; } else { x = mid0.x; y = mid0.y; } apply(); }
    else if (e.touches.length === 1 && p0 && z > 1) { e.preventDefault(); x = p0.x + e.touches[0].clientX - p0.cx; y = p0.y + e.touches[0].clientY - p0.cy; apply(); }
  }, { passive: false });
  box.addEventListener('touchend', (e) => { if (e.touches.length < 2) d0 = 0; if (!e.touches.length) p0 = null; });
  return () => { const t = el(); z = 1; x = 0; y = 0; if (t) { t.style.transform = ''; delete t.dataset.rot0; } box.classList.remove('zoomed'); };
}

// Signature: drawn once with finger or mouse, saved on the profile, copied onto each form at submit / approve
function signatureDialog({ first = false, reason = '' } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal narrow sigmodal" role="dialog" aria-label="Your signature">
      <div class="modal-head"><h2>Your signature</h2><button class="btn ghost" data-x>${first ? 'Later' : 'Close'}</button></div>
      <div class="modal-body"><div class="card-pad stack sigbody">
        <p class="muted" style="margin:0">${reason || (first ? 'Sign once here. It is printed on the forms you submit or approve.' : 'Sign in the box with your finger or mouse.')}</p>
        <canvas class="sigpad" id="sp"></canvas>
        <div class="spread"><a href="#" class="linkbtn" id="spclr">Clear</a><span class="faint" style="font-size:12px">Sign above the line</span></div>
        <div class="error" id="sperr"></div>
      </div></div>
      <div class="modal-foot"><span></span><div class="row"><button class="btn ghost" data-x>${first ? 'Later' : 'Cancel'}</button><button class="btn primary" id="spok">Save signature</button></div></div></div>`;
    document.body.appendChild(back);
    const c = back.querySelector('#sp');
    // Drawing size follows the box on screen (tall on phones, wide on computers)
    const W = Math.round(c.clientWidth * 2) || 900, H = Math.round(c.clientHeight * 2) || 300; c.width = W; c.height = H;
    const g = c.getContext('2d');
    const guide = () => { g.clearRect(0, 0, W, H); g.strokeStyle = '#d3cfc4'; g.lineWidth = 2; g.beginPath(); g.moveTo(W * 0.06, H * 0.78); g.lineTo(W * 0.94, H * 0.78); g.stroke(); };
    guide();
    let drawing = false, last = null, inked = false;
    const pt = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }; };
    c.addEventListener('pointerdown', (e) => { e.preventDefault(); c.setPointerCapture(e.pointerId); drawing = true; last = pt(e); });
    c.addEventListener('pointermove', (e) => {
      if (!drawing) return; e.preventDefault();
      const p = pt(e); g.strokeStyle = '#1b1b19'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke(); last = p; inked = true;
    });
    const stop = () => { drawing = false; };
    c.addEventListener('pointerup', stop); c.addEventListener('pointercancel', stop);
    back.querySelector('#spclr').onclick = (e) => { e.preventDefault(); inked = false; guide(); };
    const close = (v) => { back.remove(); resolve(v); };
    back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => { if (first) { try { sessionStorage.setItem('bo_sig_later', '1'); } catch { /* ignore */ } } close(null); }));
    back.querySelector('#spok').onclick = async () => {
      if (!inked) { back.querySelector('#sperr').textContent = 'Sign in the box first.'; return; }
      // Export the ink only (no guide line), on a transparent background
      const out = document.createElement('canvas'); out.width = W; out.height = H;
      const o = out.getContext('2d'); o.drawImage(c, 0, 0);
      const d = o.getImageData(0, 0, W, H);
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let i = 0; i < d.data.length; i += 4) {
        if (d.data[i] > 150) { d.data[i + 3] = 0; continue; }
        const px = (i / 4) % W, py = Math.floor(i / 4 / W);
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      o.putImageData(d, 0, 0);
      // Trim the empty space around the ink so it prints as large as possible; keep it under 900px wide
      const pad = 10; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
      const tw = x1 - x0 + 1, th = y1 - y0 + 1, k = Math.min(1, 900 / tw);
      const t = document.createElement('canvas'); t.width = Math.round(tw * k); t.height = Math.round(th * k);
      t.getContext('2d').drawImage(out, x0, y0, tw, th, 0, 0, t.width, t.height);
      const url = t.toDataURL('image/png');
      try { await run(async () => must(await sb.from('profiles').update({ signature: url }).eq('id', S.user.id)), 'Signature saved'); } catch { return; }
      S.profile.signature = url; close(url);
    };
  });
}
async function ensureSignature(what) {
  if (S.profile?.signature) return true;
  return !!(await signatureDialog({ reason: what === 'approve' ? 'Add your signature to approve. It is printed in "Approved by" on the form.' : 'Add your signature to submit. It is printed in "Signed by applicant" on the form.' }));
}
// Approvals dot: check every minute, when the app comes back to the front, and on every page change
// Submitted forms this approver has not opened since they were (re)submitted
async function unseenIds(waiting) {
  if (!waiting.length) return new Set();
  const { data: ev } = await sb.from('report_events').select('report_id, action, by_id, at').in('report_id', waiting.map((r) => r.id)).in('action', ['Submitted', 'Resubmitted', 'Seen']);
  return new Set(waiting.filter((r) => {
    const mine = (ev || []).filter((e) => e.report_id === r.id);
    const lastSub = mine.filter((e) => e.action !== 'Seen').reduce((a, e) => (e.at > a ? e.at : a), r.submitted_at || '');
    return !mine.some((e) => e.action === 'Seen' && e.by_id === S.user.id && e.at >= lastSub);
  }).map((r) => r.id));
}
async function pollPending() {
  if (!S.user || document.hidden) return;
  pollMessages();
  if (!isReviewer()) return;
  await loadOverLimit();
  const { data: subs } = await sb.from('expense_reports').select('id, staff_id, submitted_at, status, form_type, project_id, fa_entered_at').in('status', ['submitted', 'checked', 'approved', 'paid']);
  const waiting = (subs || []).filter(myTodo);
  const { data: ots } = isAdmin() || isHR() ? await sb.from('ot_forms').select('id, staff_id, submitted_at, seen_at').eq('status', isAdmin() && !isHR() ? 'checked' : 'submitted').neq('staff_id', S.user.id) : { data: [] };
  const otWait = (ots || []).filter((r) => r.staff_id !== S.user.id || isAdmin());
  const otNew = otWait.filter((r) => !r.seen_at || r.seen_at < r.submitted_at).length;
  const unseen = (await unseenIds(waiting)).size + otNew;
  S.pendingCount = waiting.length + otWait.length; S.pendingUnseen = unseen;
  applyApprovalBadge();
}
// Red number = forms you have not opened yet. Grey dot = all seen, still waiting for a decision.
function applyApprovalBadge() {
  document.querySelectorAll('a[href="#/approvals"]:not(.home-card):not(.me-row)').forEach((a) => {
    const cls = a.closest('.ptabs') ? 'pt-n' : 'count';
    a.querySelectorAll('.count, .pt-n').forEach((n) => n.remove());
    if (!S.pendingCount) return;
    const n = document.createElement('span');
    n.className = cls + (S.pendingUnseen ? '' : ' dot');
    n.textContent = S.pendingUnseen ? S.pendingUnseen : '';
    n.title = S.pendingUnseen ? `${S.pendingUnseen} new` : `${S.pendingCount} waiting, all seen`;
    a.appendChild(n);
  });
}
setInterval(pollPending, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollPending(); });
window.addEventListener('hashchange', () => setTimeout(pollPending, 300));

// Staff see whether an approver has opened their submitted form
function seenBanner(events) {
  const lastSub = [...events].reverse().find((e) => e.action === 'Submitted' || e.action === 'Resubmitted');
  const seen = [...events].reverse().find((e) => e.action === 'Seen' && (!lastSub || e.at >= lastSub.at));
  return seen ? `<div class="banner info"><b>Being reviewed.</b> Seen by ${esc(seen.by_name || 'the checker')} on ${dateLabel(seen.at)}.</div>`
    : '<div class="banner info"><b>Waiting for review.</b> Nobody has opened it yet.</div>';
}

/* ---------- overtime (OT) ---------- */
const OT_DAY = { workday: 'Workday', day_off: 'Day off', holiday: 'Holiday' };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// OT periods run from the 26th of one month to the 25th of the next
function otPeriod(endIso) {
  let end;
  if (endIso) end = new Date(`${endIso}T00:00:00`);
  else { const t = new Date(); end = new Date(t.getFullYear(), t.getMonth() + (t.getDate() > 25 ? 1 : 0), 25); }
  const start = new Date(end.getFullYear(), end.getMonth() - 1, 26);
  const shift = (n) => iso(new Date(end.getFullYear(), end.getMonth() + n, 25));
  return { start: iso(start), end: iso(end), prev: shift(-1), next: shift(1), label: end.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), range: `${start.getDate()} ${start.toLocaleDateString('en-GB', { month: 'short' })} to ${end.getDate()} ${end.toLocaleDateString('en-GB', { month: 'short' })}` };
}
const hhmm = (t) => String(t || '').slice(0, 5);
// Same rules as the database, for the live preview while typing
function otPreview(date, start, end, set, holidays) {
  if (!date || !start || !end) return null;
  const d = new Date(`${date}T00:00:00`), dow = d.getDay();
  let type = 'workday';
  if (holidays.includes(date)) type = 'holiday';
  else if (dow === 0) type = 'day_off';
  else if (dow === 6 && (set.week_pattern === 'mon_fri' || (set.week_pattern === 'alt_sat' && set.sat_off_anchor && Math.round(Math.abs(d - new Date(`${set.sat_off_anchor}T00:00:00`)) / 864e5) % 14 === 0))) type = 'day_off';
  const m = (t) => { const [a, b] = t.split(':').map(Number); return a + b / 60; };
  let h = m(end) - m(start); if (h <= 0) h += 24;
  const normal = m(hhmm(set.end_time)) - m(hhmm(set.start_time));
  const counted = type === 'workday' ? Math.max(0, h - normal) : Math.max(0, h - (h > 5 ? Number(set.lunch_hours) : 0)) * Number(type === 'holiday' ? set.holiday_mult : set.dayoff_mult);
  return { type, hours: Math.round(h * 100) / 100, counted: Math.round(counted * 100) / 100 };
}
async function otSetup(staffId) {
  const [set, hol] = await Promise.all([
    sb.from('ot_settings').select('*').eq('staff_id', staffId).maybeSingle().then((r) => r.data),
    sb.from('holidays').select('day, name').then((r) => { HOLNAME = Object.fromEntries((r.data || []).map((x) => [x.day, x.name || 'Holiday'])); return (r.data || []).map((x) => x.day); }),
  ]);
  const ov = (await sb.from('ot_day_type').select('day, treat_as').eq('staff_id', staffId)).data || [];
  const od = (await sb.from('ot_offday').select('day, choice, save_until, swap_date').eq('staff_id', staffId)).data || [];
  const st = set || { start_time: '08:00', end_time: '16:30', lunch_hours: 1, week_pattern: 'mon_fri', sat_off_anchor: null, dayoff_mult: 1, holiday_mult: 1, pay_type: 'full_time' }; // BCM default
  st.__sid = staffId; st.ovr = Object.fromEntries(ov.map((x) => [x.day, x.treat_as])); st.offd = Object.fromEntries(od.map((x) => [x.day, x.choice])); st.swapd = Object.fromEntries(od.filter((x) => x.swap_date).map((x) => [x.day, x.swap_date]));
  return { set: st, hol };
}
const otSetLine = (set) => set.pay_type === 'freelance' ? 'Freelance: no regular hours. Click the days you worked and enter your times.' : `${set.pay_type === 'part_time' ? 'Part-time · ' : ''}Normal hours ${hhmm(set.start_time)}-${hhmm(set.end_time)} · ${set.week_pattern === 'alt_sat' ? 'long/short week (alternate Saturdays off)' : set.week_pattern === 'mon_fri' ? 'Monday to Friday' : set.week_pattern === 'one_sat' ? 'Monday to Saturday, 1 Saturday off a month (pick it in the calendar)' : 'Monday to Saturday'} · on days off and holidays all hours count as OT (minus lunch on long days)${set.pay_type === 'freelance' ? ' · freelance' : ''}`;
function otTable(entries, { editable = false } = {}) {
  if (!entries.length) return '<div class="empty">No OT logged for this period yet.</div>';
  const by = { workday: 0, day_off: 0, holiday: 0 }; let counted = 0;
  entries.forEach((e) => { by[e.day_type] = (by[e.day_type] || 0) + Number(e.hours); counted += Number(e.counted); });
  return `${editable ? '<div class="selbar" id="otbar" hidden><span id="otcount"></span><button class="btn small ghost danger" id="otdelsel">Delete selected</button></div>' : ''}<div class="table-wrap"><table class="lines"><thead><tr>${editable ? '<th class="selcol"><input type="checkbox" id="otall" aria-label="Select all"></th>' : ''}<th style="width:90px">Date</th><th style="width:110px">Time</th><th>Reason</th><th style="width:90px">Day</th><th class="num" style="width:70px">Hours</th><th class="num" style="width:80px">Counted</th></tr></thead><tbody>
    ${entries.map((e) => `<tr ${editable ? `data-ot="${e.id}" class="click"` : ''}>${editable ? `<td class="selcol"><input type="checkbox" class="otsel" data-id="${e.id}" aria-label="Select"></td>` : ''}<td class="nowrap">${shortDate(e.work_date)} <span class="faint">${new Date(`${e.work_date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })}</span></td><td class="nowrap">${e.leave_type ? `<span class="ltag">${LEAVE[e.leave_type]}</span>` : `${hhmm(e.start_time)}-${hhmm(e.end_time)}`}</td><td><div class="c2">${esc(e.reason) || '<span class="error">Add a reason</span>'}</div>${e.return_note ? `<div class="rnote">Approver: ${esc(e.return_note)}</div>` : ''}</td><td><span class="ltag ${e.day_type === 'workday' ? 'chg' : ''}">${OT_DAY[e.day_type] || ''}</span></td><td class="num">${Number(e.hours)}</td><td class="num">${Number(e.counted)}</td></tr>`).join('')}
  </tbody><tfoot><tr>${editable ? '<td></td>' : ''}<td colspan="4">Hours: workday ${by.workday} · day off ${by.day_off} · holiday ${by.holiday}</td><td class="num">${Object.values(by).reduce((a, b) => a + b, 0)}</td><td class="num">${Math.round(counted * 100) / 100}</td></tr></tfoot></table></div>`;
}
const OT_ICON = {
  draft: ['<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>', 'pi-draft'],
  submitted: ['<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>', 'pi-wait'],
  approved: ['<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>', 'pi-ok'],
  rejected: ['<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-2"/></svg>', 'pi-bad'],
};
OT_ICON.paid = OT_ICON.approved;
// Preview a sheet on screen (like the expense form), then print it on its own
function printSheet(html, landscape = false, title = 'Preview') {
  document.getElementById('pvwrap')?.remove();
  const w = document.createElement('div'); w.id = 'pvwrap';
  w.innerHTML = `<div class="pv-bar"><button class="btn" id="pvback">‹ Back</button><b>${esc(title)}</b><button class="btn primary" id="pvprint">Print</button></div><div class="psheet${landscape ? ' land' : ''}">${html}</div>`;
  document.body.appendChild(w); document.body.classList.add('printing-sheet');
  const close = () => { w.remove(); document.body.classList.remove('printing-sheet'); document.removeEventListener('keydown', esc1); };
  const esc1 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc1);
  w.querySelector('#pvback').onclick = close;
  w.querySelector('#pvprint').onclick = () => window.print();
}
function timesheetPrintHtml({ name, staffNo, per, set, hol, entries, form }) {
  const days = periodWeeks(per).flat().filter((d) => d >= per.start && d <= per.end);
  const sp = otSplit(entries, set.offd || {});
  let tH = 0, tOT = 0, worked = 0, swaps = 0; const lv = {};
  const rows = days.map((d) => {
    const x = dayInfo(d, entries, set, hol), dt = new Date(`${d}T00:00:00`);
    const off = x.type !== 'workday';
    const ch = set.offd?.[d];
    const typ = x.lv ? LEAVE[x.lv.leave_type] : x.type === 'holiday' ? (HOLNAME[d] || 'Holiday') : off ? (x.note.startsWith('Swap for') ? 'Swap off' : 'Day off') : 'Workday';
    if (x.lv) lv[x.lv.leave_type] = (lv[x.lv.leave_type] || 0) + 1;
    if (x.hours) { tH += x.hours; worked++; }
    if (x.ot && !(off && ch === 'save')) tOT += x.ot;
    if (ch === 'swap' && x.hours) swaps++;
    const how = !x.lv && off && x.hours ? (ch === 'pay' ? 'Paid x2' : ch === 'save' ? 'Saved day' : ch === 'swap' ? `Swap for ${dateLabel(set.swapd[d]).replace(/ \d{4}$/, '')}` : 'No choice') : '';
    return `<tr class="${off || x.lv ? 'off' : ''}"><td>${dt.toLocaleDateString('en-GB', { weekday: 'short' })}</td><td>${dt.getDate()} ${dt.toLocaleDateString('en-GB', { month: 'short' })}</td><td>${esc(typ)}${how ? ` · ${esc(how)}` : ''}</td><td>${x.ranges.length && x.hours ? x.ranges.map(([a, b]) => `${mm(a)}-${mm(b)}`).join(', ') : ''}</td><td class="n">${x.hours || ''}</td><td class="n">${x.ot && !(off && ch === 'save') ? x.ot : ''}</td><td>${esc(x.note && !x.note.startsWith('Swap for') ? x.note : '')}</td></tr>`;
  }).join('');
  const sig = (src) => src ? `<img src="${esc(src)}" alt="">` : '';
  return `<div class="ps-head"><div><b>Bloom Chiangmai</b><div>Timesheet · ${esc(per.label)} (${esc(per.range)})</div></div><div style="text-align:right"><b>${esc(name)}</b><div>${esc(staffNo || '')}</div></div></div>
    <div class="ps-sub">${esc(otSetLine(set))}${form ? ` · Status: ${esc(STATUS_TEXT[form.status] || form.status)}` : ''}</div>
    <table class="ps-t"><thead><tr><th>Day</th><th>Date</th><th>Type</th><th>Times</th><th class="n">Hours</th><th class="n">OT</th><th>Note</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td colspan="4"><b>Total</b></td><td class="n"><b>${Math.round(tH * 100) / 100}</b></td><td class="n"><b>${Math.round(tOT * 100) / 100}</b></td><td></td></tr></tfoot></table>
    <table class="ps-sum"><tr>
      <td><span>Days worked</span><b>${worked}</b></td>
      <td><span>Hours worked</span><b>${Math.round(tH * 100) / 100} h</b></td>
      <td><span>Workday OT</span><b>${sp.ot} h</b></td>
      <td><span>Day-off work (x2)</span><b>${sp.x2} h</b></td>
      <td><span>Saved days off</span><b>${sp.saved}</b></td>
      <td><span>Swaps</span><b>${swaps}</b></td>
      <td><span>Leave</span><b>${Object.entries(lv).map(([k, n]) => `${({ annual: 'AL', sick: 'Sick', personal: 'Pers', replacement: 'Repl', saved: 'Saved' })[k] || k} ${n}`).join(' · ') || 'None'}</b></td>
    </tr></table>
    <div class="ps-tot"><b>For payroll:</b> ${esc(sp.text)}</div>
    <table class="ps-sign"><tr><td>Staff signature<div class="ps-sig">${sig(form?.applicant_signature)}</div>${esc(name)}</td><td>Approved by<div class="ps-sig">${sig(form?.approver_signature)}</div>${['approved', 'paid'].includes(form?.status) ? `${esc(form.approved_by_name || '')} · ${esc(dateLabel(form.approved_at))}` : ''}</td></tr></table>`;
}
// Admins don't keep a timesheet: they start from a list of staff and open one person's timesheet
async function pageOTStaff() {
  const per = otPeriod(params().p);
  const [people, forms, bals, sv] = await Promise.all([
    sb.from('profiles').select('id, full_name, staff_no, role, active').eq('active', true).eq('no_timesheet', false).order('staff_no').then(must),
    sb.from('ot_forms').select('id, staff_id, status').eq('period_end', per.end).then(must),
    sb.from('time_off_balance').select('*').then(must),
    sb.from('saved_days_balance').select('*').then(must),
  ]);
  const ents = forms.length ? must(await sb.from('ot_entries').select('form_id, counted').in('form_id', forms.map((f) => f.id))) : [];
  const R = (n) => Math.round(n * 100) / 100;
  shell(`<div class="page-head"><div><h1>Staff timesheets · ${esc(per.label)}</h1><p>Choose a person to open their timesheet.</p></div>
    <div class="row"><a class="btn small" href="#/ot?p=${per.prev}">‹</a><a class="btn small" href="#/ot?p=${per.next}">›</a></div></div>
  <div class="stafftiles">${people.map((x) => {
    const f = forms.find((y) => y.staff_id === x.id), st = f ? (OT_ICON[f.status] || OT_ICON.draft) : null;
    const b = bals.find((y) => y.staff_id === x.id), sd = sv.find((y) => y.staff_id === x.id);
    const ot = f ? R(ents.filter((e) => e.form_id === f.id).reduce((a, e) => a + Number(e.counted), 0)) : 0;
    return `<a class="stile" href="#/ot?p=${per.end}&u=${x.id}"><span class="avatar big">${esc(x.full_name.trim()[0] || '?')}</span><b>${esc(x.full_name)}</b><div class="faint" style="font-size:11px">${esc(x.staff_no || '')}</div><div class="stile-st">${st ? `<span class="${st[1]}">${st[0]}</span>${esc(STATUS_TEXT[f.status] || f.status)}` : '<span class="faint">Not started</span>'}</div><div class="stile-n"><span>OT<b>${ot} h</b></span><span>Time off<b>${b ? R(Number(b.earned) - Number(b.used)) : 0} h</b></span><span>Saved<b>${sd ? Number(sd.days_left) : 0}</b></span></div></a>`;
  }).join('') || '<div class="empty">No staff yet.</div>'}</div>`);
}
async function pageOT() {
  if ((isAdmin() || (isHR() && params().all)) && !params().u) return pageOTStaff();
  if (!keepsTS() && !params().u && !isHR()) { shell(`<div class="page-head"><div><h1>Timesheet</h1><p>You do not keep a timesheet at BCM. An admin can change this in Settings › Timesheet.</p></div></div>`); return; }
  const per = otPeriod(params().p);
  // Approvers and admins can look at anyone's OT (read only); everyone else sees their own
  const uid = (isAdmin() || isHR() || isAccountant()) && params().u ? params().u : S.user.id;
  const self = uid === S.user.id;
  // Admins are not in the OT loop: the picker and team list show staff and approvers (plus "Me")
  const people = isAdmin() || isHR() || isAccountant() ? must(await sb.from('profiles').select('id, full_name, staff_no, active, role, no_timesheet').eq('active', true).order('staff_no')).filter((x) => !x.no_timesheet) : [];
  const who = people.find((x) => x.id === uid);
  let form = (await sb.from('ot_forms').select('*').eq('staff_id', uid).eq('period_end', per.end).maybeSingle()).data;
  const entries = form ? must(await sb.from('ot_entries').select('*').eq('form_id', form.id).order('work_date').order('start_time')) : [];
  const { set, hol } = await otSetup(uid);
  const bal = (await sb.from('time_off_balance').select('*').eq('staff_id', uid).maybeSingle()).data || { earned: 0, used: 0, day_hours: 8 };
  const left = Math.round((Number(bal.earned) - Number(bal.used)) * 100) / 100;
  const sv = (await sb.from('saved_days_balance').select('*').eq('staff_id', uid).maybeSingle()).data || { days_left: 0, next_expiry: null };
  window.__savedLeft = Number(sv.days_left) || 0;
  // Only the staff member changes their own days. Admin and HR can ask about a day instead.
  const editable = self && (!form || ['draft', 'rejected'].includes(form.status));
  const uq = self ? '' : `&u=${uid}`;
  // All OT periods for this person, so earlier ones are one click away
  const mine = must(await sb.from('ot_forms').select('id, period_end, status, take_as, time_off_hours, expiry_action').eq('staff_id', uid).order('period_end', { ascending: false }));
  const sums = mine.length ? must(await sb.from('ot_entries').select('form_id, counted').in('form_id', mine.map((f) => f.id))) : [];
  const others = mine.filter((f) => f.period_end !== per.end);
  const total = entries.reduce((a, e) => a + Number(e.counted), 0);
  // Team view for approvers: everyone's counted hours and status for this period
  let team = '';
  if (isApprover() && self) {
    // This period, plus the latest period each person logged OT in (so older OT is not hidden behind "Nothing logged")
    const all = must(await sb.from('ot_forms').select('id, staff_id, status, period_end').order('period_end', { ascending: false }));
    const te = all.length ? must(await sb.from('ot_entries').select('form_id, counted').in('form_id', all.map((f) => f.id))) : [];
    const bals = must(await sb.from('time_off_balance').select('*'));
    const balOf = (id) => { const b = bals.find((y) => y.staff_id === id); return b ? Math.round((Number(b.earned) - Number(b.used)) * 100) / 100 : 0; };
    const cnt = (f) => (f ? Math.round(te.filter((e) => e.form_id === f.id).reduce((a, e) => a + Number(e.counted), 0) * 100) / 100 : 0);
    team = `<div class="card"><div class="card-head"><h2>Team</h2></div><div class="table-wrap"><table><thead><tr><th>Staff</th><th>This period</th><th class="num">Counted</th><th class="num">Time-off balance</th></tr></thead><tbody>${people.filter((x) => x.role !== 'admin').map((x) => {
      const f = all.find((y) => y.staff_id === x.id && y.period_end === per.end);
      return `<tr class="click" data-href="#/ot?p=${per.end}&u=${x.id}"><td>${esc(x.full_name)}</td><td>${f ? pill(f.status) : '<span class="faint">Nothing logged</span>'}</td><td class="num">${cnt(f)} h</td><td class="num${balOf(x.id) < 0 ? ' error' : ''}">${balOf(x.id)} h</td></tr>`; }).join('')}</tbody></table></div></div>`;
  }
  // Approvers: OT older than 3 months that nobody has decided on yet (pay out, or keep longer)
  let decide = '';
  if (isApprover() && self) {
    const cut = iso(new Date(new Date().getFullYear(), new Date().getMonth() - 3, new Date().getDate()));
    const old = must(await sb.from('ot_forms').select('id, staff_id, period_end, status, expiry_action, extended_until').in('status', ['approved', 'paid']).is('expiry_action', null).lt('period_end', cut));
    const ext = must(await sb.from('ot_forms').select('id, staff_id, period_end, status, expiry_action, extended_until').eq('expiry_action', 'extended').lt('extended_until', today()));
    const todo = [...old, ...ext];
    if (todo.length) {
      const hrs = must(await sb.from('ot_entries').select('form_id, counted').in('form_id', todo.map((f) => f.id)));
      const sumF = (id) => Math.round(hrs.filter((e) => e.form_id === id).reduce((a, e) => a + Number(e.counted), 0) * 100) / 100;
      const rows = todo.filter((f) => sumF(f.id) > 0);
      if (rows.length) decide = `<div class="card"><div class="card-head"><h2>OT past 3 months · to decide</h2><span class="faint" style="font-size:12px">Agree with the staff member, then choose</span></div><div class="table-wrap"><table><tbody>${rows.map((f) => `<tr><td>${esc(people.find((x) => x.id === f.staff_id)?.full_name || '')}</td><td>${esc(otPeriod(f.period_end).label)}</td><td class="num">${sumF(f.id)} h</td><td style="text-align:right"><button class="btn small" data-xpay="${f.id}">Pay out</button> <button class="btn small" data-xkeep="${f.id}">Keep 3 more months</button></td></tr>`).join('')}</tbody></table></div></div>`;
    }
  }
  // Approvers: saved days off that run out within 30 days
  let savedSoon = '';
  if (isApprover() && self) {
    const soon = iso(new Date(Date.now() + 30 * 86400000));
    const rows = must(await sb.from('ot_offday').select('staff_id, day, save_until').eq('choice', 'save').lte('save_until', soon).gte('save_until', iso(new Date())).order('save_until'));
    const names = Object.fromEntries(people.map((x) => [x.id, x.full_name]));
    if (rows.length) savedSoon = `<div class="card"><div class="card-head"><h2>Saved days off running out</h2><span class="faint" style="font-size:12px">Agree with the staff member, then choose</span></div><div class="table-wrap"><table><tbody>${rows.map((o) => `<tr><td>${esc(names[o.staff_id] || '')}</td><td>Worked ${esc(dateLabel(o.day))}</td><td class="faint">runs out ${esc(dateLabel(o.save_until))}</td><td class="num"><button class="btn small" data-sext="${o.staff_id}|${o.day}|${o.save_until}">Extend 3 months</button> <button class="btn small" data-spay="${o.staff_id}|${o.day}">Pay x2 instead</button></td></tr>`).join('')}</tbody></table></div></div>`;
  }
  shell(`${isAdmin() && !self ? `<a class="faint" href="#/ot?p=${per.end}" style="text-decoration:none;font-size:13px">‹ All staff</a>` : ''}<div class="page-head"><div>${self ? `<h1>Timesheet · ${esc(per.label)}</h1>` : `<div class="row" style="gap:10px;align-items:center"><span class="avatar">${esc((who?.full_name || '?').trim()[0] || '?')}</span><h1 style="margin:0">${esc(who?.full_name || '')} · Timesheet · ${esc(per.label)}</h1></div>`}<p>${self ? '' : `${esc(who?.staff_no || '')} · `}${esc(otSetLine(set))}</p></div>
    <div class="row">${people.length ? `<select class="input" id="otwho" style="width:auto">${people.map((x) => `<option value="${x.id}" ${x.id === uid ? 'selected' : ''}>${x.id === S.user.id ? 'Me' : esc(x.full_name)}</option>`).join('')}</select>` : ''}<a class="btn small" href="#/ot?p=${per.prev}${uq}" aria-label="Previous period">‹</a><a class="btn small" href="#/ot?p=${per.next}${uq}" aria-label="Next period">›</a><button class="btn small" id="otprint">Preview</button>${!self && form ? `<a class="btn" href="#/ot/review/${form.id}">Open for review</a>` : ''}</div></div>
  <div class="stack">
    <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="stat"><label>Replacement days available</label><div>${Math.floor((Number(sv.days_left) + Math.max(0, left) / (Number(bal.day_hours) || 8)) * 10) / 10} days</div><small>${Number(sv.days_left)} saved day${Number(sv.days_left) === 1 ? '' : 's'}${sv.next_expiry && Number(sv.days_left) > 0 ? ` (next runs out ${esc(dateLabel(sv.next_expiry))})` : ''} + ${left} h OT</small></div><div class="stat"><label>OT balance</label><div>${left} h</div><small>${Number(bal.day_hours) ? `about ${Math.round((left / Number(bal.day_hours)) * 10) / 10} days` : ''}</small></div><div class="stat"><label>Earned</label><div>${Math.round(Number(bal.earned) * 100) / 100} h</div><small>approved OT, last 3 months</small></div><div class="stat"><label>Used</label><div>${Math.round(Number(bal.used) * 100) / 100} h</div><small>replacement days paid from OT (${Number(bal.day_hours)} h each)</small></div></div>
    ${left < 0 ? `<div class="banner bad"><b>Time-off balance is below zero.</b> More replacement days off are planned than OT hours saved.</div>` : ''}
    ${!self ? `<div class="banner info">You are viewing someone else's timesheet (read only). Only they can change their days. Tap a day to ask them about it. Check, approve or return it from Approvals.</div>` : ''}
    ${decide}
    ${savedSoon}
    ${self && (!form || form.status === 'draft') && iso(new Date()) >= iso(new Date(new Date(`${per.end}T00:00:00`).getTime() - 86400000)) && iso(new Date()) <= per.end ? `<div class="banner warn"><b>Due ${esc(dateLabel(per.end))}.</b> Not submitted yet. Check your days, then submit below.</div>` : ''}
    ${form?.status === 'rejected' ? `<div class="banner bad"><b>Returned:</b> ${esc(form.rejection_reason)}<br>Fix it and submit again.</div>` : ''}
    ${form && form.status !== 'draft' && form.status !== 'rejected' ? `<div class="banner info">${pill(form.status)} ${form.status === 'submitted' ? (form.seen_at && form.seen_at >= form.submitted_at ? 'Being reviewed.' : 'Waiting for review.') : form.status === 'approved' ? `Approved by ${esc(form.approved_by_name || '')} on ${dateLabel(form.approved_at)}.` : `Paid on ${dateLabel(form.paid_at)}.`}</div>` : ''}
    ${calHtml(per, entries, set, hol, { editable })}
    ${editable && entries.length ? `<div class="row" style="justify-content:flex-end"><button class="btn primary" id="otsub">Submit for approval</button></div>` : ''}
    ${!editable && form ? `<div class="muted" style="font-size:13px">${otSplitText(form, total)}</div>` : ''}
    ${others.length ? `<div class="card"><div class="card-head"><h2>Other periods</h2><span class="ptkey">${[['draft', 'draft'], ['submitted', 'waiting'], ['approved', 'approved'], ['rejected', 'returned']].map(([k, w]) => `<span class="${OT_ICON[k][1]}">${OT_ICON[k][0]}</span>${w}`).join('')}</span></div><div class="ptiles">${others.map((f) => { const st = OT_ICON[f.status] || OT_ICON.draft; const h = Math.round(sums.filter((x) => x.form_id === f.id).reduce((a, x) => a + Number(x.counted), 0) * 100) / 100; return `<a class="ptile" href="#/ot?p=${f.period_end}${uq}" title="${esc(otPeriod(f.period_end).range)} · ${esc(STATUS_TEXT[f.status] || f.status)}${f.expiry_action === 'paid' ? ' · paid out' : f.expiry_action === 'extended' ? ' · kept longer' : ''}"><span class="pt-ic ${st[1]}">${st[0]}</span><b>${esc(otPeriod(f.period_end).label)}</b><span class="faint">OT ${h} h</span></a>`; }).join('')}</div></div>` : ''}
    ${team}
    <p class="faint" style="font-size:12px">Log the times you actually worked that day. On a workday, OT is the time beyond your normal hours. On a day off or holiday, all hours count (minus 1 h lunch for long days).</p>
  </div>`);
  bindRowLinks();
  main().querySelectorAll('[data-xpay]').forEach((b) => (b.onclick = async () => { if (!confirmInline(b, 'Confirm pay out')) return; try { await run(async () => must(await sb.from('ot_forms').update({ expiry_action: 'paid' }).eq('id', b.dataset.xpay)), 'Marked to pay out'); } catch { return; } pageOT(); }));
  main().querySelectorAll('[data-xkeep]').forEach((b) => (b.onclick = async () => { const t = new Date(); t.setMonth(t.getMonth() + 3); try { await run(async () => must(await sb.from('ot_forms').update({ expiry_action: 'extended', extended_until: iso(t) }).eq('id', b.dataset.xkeep)), 'Kept for 3 more months'); } catch { return; } pageOT(); }));
  main().querySelectorAll('[data-sext]').forEach((b) => (b.onclick = async () => { const [sid, d, u] = b.dataset.sext.split('|'); const t = new Date(`${u}T00:00:00`); t.setMonth(t.getMonth() + 3); try { await run(async () => must(await sb.from('ot_offday').update({ save_until: iso(t) }).eq('staff_id', sid).eq('day', d)), 'Extended 3 months'); } catch { return; } pageOT(); }));
  main().querySelectorAll('[data-spay]').forEach((b) => (b.onclick = async () => { if (!confirmInline(b, 'Confirm pay x2')) return; const [sid, d] = b.dataset.spay.split('|'); try { await run(async () => must(await sb.from('ot_offday').update({ choice: 'pay' }).eq('staff_id', sid).eq('day', d)), 'Changed to paid x2'); } catch { return; } pageOT(); }));
  document.getElementById('otprint').onclick = () => printSheet(timesheetPrintHtml({ name: self ? S.profile.full_name : who?.full_name || '', staffNo: self ? S.profile.staff_no : who?.staff_no, per, set, hol, entries, form }), false, 'Timesheet preview');
  const ws = document.getElementById('otwho'); if (ws) ws.onchange = () => { location.hash = `#/ot?p=${per.end}${ws.value === S.user.id ? '' : '&u=' + ws.value}`; };
  const reload = () => pageOT();
  const ensureForm = async () => {
    if (form) return form;
    form = must(await sb.from('ot_forms').insert({ staff_id: uid, period_start: per.start, period_end: per.end }).select().single());
    return form;
  };
  const open = (e) => otEntryDialog({ entry: e, per, set, hol, onSave: async (v) => {
    const f = await ensureForm();
    if (e) must(await sb.from('ot_entries').update(v).eq('id', e.id)); else must(await sb.from('ot_entries').insert({ ...v, form_id: f.id }));
  }, onDone: reload });
  window.__tobLeft = left; window.__tobDay = Number(bal.day_hours) || 8;
  const lock = !self ? `Only ${who?.full_name || 'they'} can change their days.` : !form ? '' : form.status === 'submitted' ? 'This timesheet is submitted and waiting for approval. Ask your approver to return it if you need to make changes.' : ['approved', 'paid'].includes(form.status) ? 'This timesheet is approved. An admin can reopen it as a draft if something is wrong.' : '';
  wireCal({ entries, set, hol, editable, ensureForm, reload, lock, askFor: !self && (isAdmin() || isHR()) ? uid : null, askName: who?.full_name || '' });
  if (params().d) { const c = main().querySelector(`.cal-c[data-day="${params().d}"]`); if (c) c.classList.add('cal-flash'); }
  main().querySelectorAll('tr[data-ot]').forEach((tr) => (tr.onclick = (ev) => {
    if (ev.target.closest('.otsel')) return;
    if (ev.target.closest('.selcol')) { const cb = tr.querySelector('.otsel'); cb.checked = !cb.checked; syncSel(); return; }
    open(entries.find((x) => x.id === tr.dataset.ot));
  }));
  // Tick several entries and delete them together
  const boxes = [...main().querySelectorAll('.otsel')], bar = document.getElementById('otbar'), all = document.getElementById('otall');
  const syncSel = () => {
    const n = boxes.filter((b) => b.checked).length;
    if (bar) { bar.hidden = !n; document.getElementById('otcount').textContent = `${n} selected`; }
    if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
  };
  boxes.forEach((b) => (b.onchange = syncSel));
  if (all) all.onchange = () => { boxes.forEach((b) => (b.checked = all.checked)); syncSel(); };
  const ds = document.getElementById('otdelsel');
  if (ds) ds.onclick = async () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.id);
    if (!ids.length || !confirmInline(ds, `Delete ${ids.length}?`)) return;
    try { await run(async () => must(await sb.from('ot_entries').delete().in('id', ids)), `${ids.length} deleted`); } catch { return; }
    reload();
  };
  const tk = document.getElementById('ottoff');
  if (tk) tk.onchange = async () => {
    const v = Math.min(total, Math.max(0, Number(tk.value) || 0)); tk.value = v;
    document.getElementById('otpay').textContent = Math.round((total - v) * 100) / 100;
    await run(async () => must(await sb.from('ot_forms').update({ time_off_hours: v, take_as: v >= total && total > 0 ? 'time_off' : 'pay' }).eq('id', form.id)), 'Saved');
  };
  const sub = document.getElementById('otsub');
  if (sub) sub.onclick = async () => {
    if (!(await ensureSignature('submit'))) return;
    if (!confirmInline(sub, 'Click again to submit')) return;
    try { await run(async () => must(await sb.from('ot_forms').update({ status: 'submitted' }).eq('id', form.id)), 'Submitted for approval'); } catch { return; }
    reload();
  };
}
function otEntryDialog({ entry, per, set, hol, onSave, onDone }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal narrow" role="dialog" aria-label="OT entry">
    <div class="modal-head"><h2>${entry ? 'Edit OT' : 'Add OT'}</h2><button class="btn ghost" data-x>Close</button></div>
    <div class="modal-body"><form class="card-pad stack" id="otf">
      <div class="field"><label>Date</label><input class="input" type="date" name="work_date" min="${per.start}" max="${per.end}" value="${esc(entry?.work_date || (today() >= per.start && today() <= per.end ? today() : per.start))}" required></div>
      <div class="row" style="gap:10px;flex-wrap:nowrap"><div class="field" style="flex:1"><label>Start</label><input class="input" type="time" name="start_time" value="${hhmm(entry?.start_time) || hhmm(set.start_time)}" required></div>
        <div class="field" style="flex:1"><label>End</label><input class="input" type="time" name="end_time" value="${hhmm(entry?.end_time)}" required></div></div>
      <div class="field"><label>Reason</label><input class="input" name="reason" value="${esc(entry?.reason || '')}" placeholder="e.g. Night shoot for Symatics" required></div>
      <div class="banner info" id="otpv" style="font-size:13px">Enter the date and times.</div>
      <div class="error" id="oterr"></div>
    </form></div>
    <div class="modal-foot"><span>${entry ? '<button class="btn ghost danger" id="otdel1">Delete</button>' : ''}</span><div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="otok">Save</button></div></div></div>`;
  document.body.appendChild(back);
  const f = back.querySelector('#otf');
  const d1 = back.querySelector('#otdel1');
  if (d1) d1.onclick = async () => {
    if (!confirmInline(d1, 'Click again to delete')) return;
    try { await run(async () => must(await sb.from('ot_entries').delete().eq('id', entry.id)), 'Deleted'); } catch { return; }
    back.remove(); onDone();
  };
  const close = () => back.remove();
  back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  const pv = () => {
    const r = otPreview(f.work_date.value, f.start_time.value, f.end_time.value, set, hol);
    back.querySelector('#otpv').innerHTML = r ? `<b>${OT_DAY[r.type]}</b>${f.end_time.value <= f.start_time.value ? ' · ends after midnight' : ''} · ${r.hours} h worked · <b>${r.counted} h counted</b>${r.type === 'workday' && !r.counted ? ' (within normal hours)' : ''}` : 'Enter the date and times.';
  };
  ['work_date', 'start_time', 'end_time'].forEach((n) => (f[n].oninput = pv)); pv();
  back.querySelector('#otok').onclick = async () => {
    if (!f.reportValidity()) return;
    const v = { work_date: f.work_date.value, start_time: f.start_time.value, end_time: f.end_time.value, reason: f.reason.value.trim() };
    try { await run(async () => onSave(v), 'Saved'); } catch { return; }
    close(); onDone();
  };
}
// Approver: review an OT form
async function pageOTReview(id) {
  const form = must(await sb.from('ot_forms').select('*').eq('id', id).single());
  const [entries, staff, { set, hol }] = await Promise.all([
    sb.from('ot_entries').select('*').eq('form_id', id).order('work_date').order('start_time').then(must),
    sb.from('profiles').select('full_name, staff_no').eq('id', form.staff_id).single().then(must),
    otSetup(form.staff_id),
  ]);
  const mine = form.staff_id === S.user.id;
  const otherHR = ((await sb.from('profiles').select('id').eq('is_hr', true).eq('active', true).neq('id', form.staff_id)).data || []).length > 0;
  const hrStep = isHR() && !mine && form.status === 'submitted';
  const admStep = isAdmin() && (form.status === 'checked' || (form.status === 'submitted' && !otherHR));
  const canDecide = hrStep || admStep;
  if (canDecide && (!form.seen_at || form.seen_at < form.submitted_at)) sb.from('ot_forms').update({ seen_at: new Date().toISOString() }).eq('id', id).then(pollPending);
  const total = entries.reduce((a, e) => a + Number(e.counted), 0);
  setTimeout(() => wireCal({ entries, set, hol, editable: false }), 0);
  shell(`<div class="page-head"><div><h1>${esc(staff.full_name)} · Timesheet</h1><p>${esc(otPeriod(form.period_end).label)} · ${esc(otSetLine(set))}</p></div>
    <div class="row">${pill(form.status)}<a class="btn" href="#/approvals">Back</a></div></div>
  <div class="stack">
    ${form.status === 'rejected' ? `<div class="banner bad"><b>Returned:</b> ${esc(form.rejection_reason)}</div>` : ''}
    <div class="banner info" style="font-size:13px"><b>For payroll:</b> ${esc(otSplit(entries, set.offd).text)}</div>
    ${calHtml(otPeriod(form.period_end), entries, set, hol, { editable: false })}
    <div class="muted" style="font-size:13px">Submitted ${dateLabel(form.submitted_at) || '-'}${form.checked_at ? ` · Checked ${dateLabel(form.checked_at)} by ${esc(form.checked_by_name || '')}` : ''}${form.approved_at ? ` · ${form.status === 'rejected' ? 'Returned' : 'Approved'} ${dateLabel(form.approved_at)} by ${esc(form.approved_by_name || '')}` : ''}${form.paid_at ? ` · Paid ${dateLabel(form.paid_at)}` : ''}</div>
    ${canDecide ? `<div class="card card-pad stack"><div class="field"><label>Reason (needed to return)</label><textarea class="input" id="otr" rows="2" placeholder="e.g. 1 Nov: please confirm the end time"></textarea></div><div class="row"><button class="btn danger" id="otno">Return</button><button class="btn primary" id="otok2">Approve</button></div></div>` : ''}
    ${(isAdmin() || isAccountant()) && form.status === 'approved' ? `<div class="card card-pad spread"><span class="muted">${Number(form.time_off_hours) < total ? 'Mark as paid once the paid hours are in payroll.' : 'All taken as time off. Mark as closed once recorded.'}</span><button class="btn primary" id="otpaid">${form.take_as === 'pay' ? 'Mark as paid' : 'Close'}</button></div>` : ''}
    ${isAdmin() && form.status !== 'draft' ? '<div class="row"><button class="btn ghost small" id="otreopen">Reopen as draft</button></div>' : ''}
  </div>`);
  const set2 = async (patch, msg) => { try { await run(async () => must(await sb.from('ot_forms').update(patch).eq('id', id)), msg); } catch { return; } await pollPending(); pageOTReview(id); };
  const ok = document.getElementById('otok2'); if (ok) { if (hrStep) ok.textContent = 'Checked, send to admin'; ok.onclick = async (e) => { if (!(await ensureSignature('approve'))) return; confirmInline(e.target, hrStep ? 'Click again to send to admin' : 'Click again to approve') && (hrStep ? set2({ status: 'checked' }, 'Sent to admin') : (async () => { const allOff = Number(form.time_off_hours || 0) >= total; try { await run(async () => { must(await sb.from('ot_forms').update({ status: 'approved' }).eq('id', id)); if (allOff) must(await sb.from('ot_forms').update({ status: 'paid' }).eq('id', id)); }, allOff ? 'Approved and closed (all taken as time off)' : 'Approved'); } catch { return; } await pollPending(); pageOTReview(id); })()); }; }
  const no = document.getElementById('otno'); if (no) no.onclick = (e) => { const r = document.getElementById('otr').value.trim(); if (!r) return toast('Write a reason first', true); confirmInline(e.target, 'Click again to return') && set2({ status: 'rejected', rejection_reason: r }, 'Returned'); };
  const pd = document.getElementById('otpaid'); if (pd) pd.onclick = (e) => confirmInline(e.target) && set2({ status: 'paid' }, 'Done');
  const ro = document.getElementById('otreopen'); if (ro) ro.onclick = (e) => confirmInline(e.target) && set2({ status: 'draft' }, 'Reopened');
}
// Thai public holidays: year tabs, 12 month calendars with the names under each, new official days to decide
function holHtml(hols, sugg, meta, y) {
  const years = [...new Set([new Date().getFullYear(), ...hols.map((h) => +h.day.slice(0, 4)), ...sugg.map((s) => +s.day.slice(0, 4))])].filter((x) => x >= new Date().getFullYear() - 1).sort();
  const H = {}; hols.filter((h) => h.day.startsWith(y + '-')).forEach((h) => (H[h.day] = { name: h.name || 'Holiday' }));
  const Q = sugg.filter((s) => s.status === 'ask' && s.day.startsWith(y + '-') && !H[s.day]);
  Q.forEach((s) => (H[s.day] = { name: s.name, ask: true }));
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  let grid = '';
  for (let m = 0; m < 12; m++) {
    const lead = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    let c = 'MTWTFSS'.split('').map((w) => `<div class="w">${w}</div>`).join('') + '<div></div>'.repeat(lead), names = '';
    for (let d = 1; d <= days; d++) {
      const k = `${y}-${p2(m + 1)}-${p2(d)}`, dow = new Date(y, m, d).getDay(), we = dow === 0 || dow === 6, h = H[k];
      c += `<div class="d ${we ? 'we' : ''} ${h ? (h.ask ? 'ask' : 'hol' + (we ? ' wk' : '')) : ''}" ${h ? `title="${esc(h.name)}"` : ''}>${d}</div>`;
      if (h) names += `<div class="n ${we ? 'wk' : ''} ${h.ask ? 'q' : ''}" ${h.ask ? '' : `data-hed="${k}"`}><b>${d}</b><span class="wd">${WD[dow]}</span><span>${esc(h.name)}${h.ask ? ' · new?' : ''}</span></div>`;
    }
    c += '<div></div>'.repeat(42 - lead - days);
    grid += `<div class="hm"><div class="mh">${MN[m]}</div><div class="hcal">${c}</div><div class="nl">${names || '<div class="none">None</div>'}</div></div>`;
  }
  const n = Object.values(H).filter((h) => !h.ask).length;
  return `<div class="card card-pad" id="holcard"><div class="spread" style="align-items:flex-start;gap:8px;flex-wrap:wrap"><div style="margin-right:auto"><h2 style="margin:0">Thai public holidays ${y}</h2><div class="faint" style="font-size:13px">${n} days off${Q.length ? ` · ${Q.length} new day${Q.length > 1 ? 's' : ''} to decide` : ''}</div></div>
    <div class="row" style="gap:6px">${years.map((x) => `<button class="btn small ${x === y ? '' : 'ghost'}" data-hy="${x}">${x}</button>`).join('')}<button class="btn small" id="hadd">+ Add day</button></div></div>
    ${Q.map((s) => `<div class="hol-q"><span style="flex:1"><b>New: ${esc(new Date(`${s.day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}, ${esc(s.name)}.</b> Not given before. Give it as a day off?</span><button class="btn small" data-hyes="${s.day}" data-hnm="${esc(s.name)}">Yes</button><button class="btn small ghost" data-hno="${s.day}" data-hnm="${esc(s.name)}">No</button></div>`).join('')}
    <div class="hol-lg"><span><i style="background:#e1f5ee"></i>Holiday</span><span><i style="background:#faeeda"></i>On a weekend</span><span><i style="outline:1.5px dashed #534ab7"></i>New, waiting for Yes or No</span><span class="faint">Click a name to rename or remove it</span></div>
    <div class="hgrid">${grid}</div>
    <div class="faint" style="font-size:12px;margin-top:10px">${meta?.note === 'nokey' ? 'Automatic updates are off until the Bank of Thailand key is added (Supabase secret BOT_API_KEY). Add days by hand meanwhile.' : `Updated by itself from the Bank of Thailand once a month.${meta?.checked_at ? ` Last checked ${esc(dateLabel(meta.checked_at))}.` : ''}`}</div></div>`;
}
function bindHol(hols, rerun) {
  main().querySelectorAll('[data-hy]').forEach((b) => (b.onclick = () => { pageOTSettings.hy = +b.dataset.hy; rerun(); }));
  const edit = (day) => {
    const h = hols.find((x) => x.day === day); const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal" style="max-width:420px"><div class="modal-head"><h2>${day ? esc(dateLabel(day)) : 'Add a day'}</h2><button class="btn ghost" data-x>Close</button></div>
      <div class="stack" style="padding:16px">${day ? '' : '<div class="field"><label>Date</label><input class="input" type="date" id="hdd"></div>'}<div class="field"><label>Name</label><input class="input" id="hnn" value="${esc(h?.name || '')}" placeholder="e.g. Songkran"></div></div>
      <div class="modal-foot"><span>${day ? '<button class="btn ghost danger" id="hrm">Remove</button>' : ''}</span><button class="btn primary" id="hsv">Save</button></div></div>`;
    document.body.appendChild(back); const close = () => back.remove(); back.querySelector('[data-x]').onclick = close;
    back.querySelector('#hsv').onclick = async () => { const d = day || back.querySelector('#hdd').value; if (!d) return toast('Pick a date', true);
      try { await run(async () => must(await sb.from('holidays').upsert({ day: d, name: back.querySelector('#hnn').value.trim() || null })), 'Saved'); } catch { return; } close(); rerun(); };
    const rm = back.querySelector('#hrm'); if (rm) rm.onclick = async (e) => { if (!confirmInline(e.target, 'Remove this day?')) return; try { await run(async () => must(await sb.from('holidays').delete().eq('day', day)), 'Removed'); } catch { return; } close(); rerun(); };
  };
  document.getElementById('hadd').onclick = () => edit(null);
  main().querySelectorAll('[data-hed]').forEach((el) => (el.onclick = () => edit(el.dataset.hed)));
  main().querySelectorAll('[data-hyes]').forEach((b) => (b.onclick = async () => { try { await run(async () => { must(await sb.from('holidays').upsert({ day: b.dataset.hyes, name: b.dataset.hnm })); must(await sb.from('holiday_suggestions').update({ status: 'given' }).eq('day', b.dataset.hyes).eq('name', b.dataset.hnm)); }, 'Added as a day off'); } catch { return; } rerun(); }));
  main().querySelectorAll('[data-hno]').forEach((b) => (b.onclick = async () => { try { await run(async () => must(await sb.from('holiday_suggestions').update({ status: 'declined' }).eq('day', b.dataset.hno).eq('name', b.dataset.hnm)), 'Not given. It will not be asked again.'); } catch { return; } rerun(); }));
}
// Admin: OT settings per person and the holiday calendar
async function pageOTSettings() {
  const [staff, sets, hols, hsug, hmeta] = await Promise.all([
    sb.from('profiles').select('id, full_name, staff_no, active, role, no_timesheet').order('no_timesheet').order('staff_no').then(must),
    sb.from('ot_settings').select('*').then(must),
    sb.from('holidays').select('*').order('day').then(must),
    sb.from('holiday_suggestions').select('*').then((r) => r.data || []),
    sb.from('holiday_meta').select('*').eq('id', 1).maybeSingle().then((r) => r.data),
  ]);
  const S2 = Object.fromEntries(sets.map((x) => [x.staff_id, x]));
  // HR (not admin) changing someone else: saved as a request until that person agrees
  const viaReq = isHR() && !isAdmin();
  const reqs = viaReq || isAdmin() ? ((await sb.from('hr_requests').select('*').eq('status', 'pending')).data || []) : [];
  const RQ = Object.fromEntries(reqs.map((x) => [x.staff_id, x]));
  const LBL = { pay_type: { full_time: 'Full-time', part_time: 'Part-time', freelance: 'Freelance' }, week_pattern: { alt_sat: 'Long/short week', mon_fri: 'Mon to Fri', mon_sat: 'Mon to Sat' } };
  const chg = (c) => Object.entries(c).map(([k, v]) => (LBL[k]?.[v] || (k === 'start_time' ? 'start ' : k === 'end_time' ? 'end ' : k === 'sat_off_anchor' ? 'Saturday off ' : '') + String(v).slice(0, 10))).join(', ');
  const tsSel = (p) => `<td>${seg('data-nots', p.id, !p.no_timesheet, 'Yes', 'No', !isAdmin())}</td>`;
  const row = (p) => { if (p.no_timesheet) return `<tr data-off="${p.id}" class="faint"><td>${esc(p.full_name)}<div class="faint mono">${esc(p.staff_no)}</div></td>${tsSel(p)}<td colspan="3" class="faint">No timesheet (consultant, or paid elsewhere). Not on the roster, payroll or reminders. Expense forms still work.</td></tr>`;
    const x = { ...(S2[p.id] || {}), ...(RQ[p.id]?.changes || {}) }; const rq = RQ[p.id]; return `<tr data-sid="${p.id}"><td>${esc(p.full_name)}<div class="faint mono">${esc(p.staff_no)}</div>${rq ? `<div class="hr-wait">Waiting for ${esc(p.full_name)} to agree: ${esc(chg(rq.changes))} <a href="#" data-rqx="${rq.id}">cancel</a></div>` : ''}</td>${tsSel(p)}
    <td><select class="input" data-k="pay_type">${[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['freelance', 'Freelance']].map(([v, l]) => `<option value="${v}" ${(x.pay_type || 'full_time') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><div class="row" style="gap:6px;flex-wrap:nowrap"><input class="input" type="time" data-k="start_time" value="${hhmm(x.start_time) || '08:00'}" style="width:118px"><span>to</span><input class="input" type="time" data-k="end_time" value="${hhmm(x.end_time) || '16:30'}" style="width:118px"></div></td>
    <td><select class="input" data-k="week_pattern"><option value="alt_sat" ${(x.week_pattern || 'mon_fri') === 'alt_sat' ? 'selected' : ''}>Long/short week</option><option value="mon_fri" ${(x.week_pattern || 'mon_fri') === 'mon_fri' ? 'selected' : ''}>Mon to Fri</option><option value="mon_sat" ${x.week_pattern === 'mon_sat' ? 'selected' : ''}>Mon to Sat</option><option value="one_sat" ${x.week_pattern === 'one_sat' ? 'selected' : ''}>Mon to Sat, 1 Saturday off a month</option></select><div class="faint" style="font-size:11px">A Saturday off: <input class="input" type="date" data-k="sat_off_anchor" value="${esc(x.sat_off_anchor || '2026-10-03')}" style="width:140px;padding:2px 6px"></div></td>

</tr>`; };
  shell(`<div class="page-head"><div><h1>Timesheet settings</h1><p>Normal hours and work week per person, and the company holiday calendar. ${viaReq ? 'Changes to other people wait until they agree; your own save straight away.' : 'Changes save as you go and the person gets a message.'}</p></div></div>
  <div class="stack">
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Staff</th><th>Timesheet</th><th>Type</th><th>Normal hours (lunch included)</th><th>Work week</th></tr></thead><tbody>${staff.filter((p) => p.active).map(row).join('')}</tbody></table></div></div>
    ${holHtml(hols, hsug, hmeta, pageOTSettings.hy || new Date().getFullYear())}
  </div>`);
  main().querySelectorAll('[data-nots]').forEach((el) => (el.onclick = async () => {
    if (el.classList.contains('on')) return;
    const off = el.dataset.v === '0';
    try { await run(async () => must(await sb.from('profiles').update({ no_timesheet: off }).eq('id', el.dataset.nots)), off ? 'Set to no timesheet' : 'Keeps a timesheet now'); } catch { /* shown */ }
    pageOTSettings();
  }));
  main().querySelectorAll('tr[data-sid] [data-k]').forEach((el) => (el.onchange = async () => {
    const sid = el.closest('tr').dataset.sid; let v = el.value;
    if (['dayoff_mult', 'holiday_mult', 'freelance_rate'].includes(el.dataset.k)) v = v === '' ? null : Number(v);
    if (viaReq && sid !== S.user.id) {
      try { await run(async () => must(await sb.rpc('hr_propose', { p_staff: sid, p_changes: { [el.dataset.k]: v } })), 'Sent for agreement'); } catch { /* shown */ }
      return pageOTSettings();
    }
    try { await run(async () => must(await sb.from('ot_settings').upsert({ staff_id: sid, [el.dataset.k]: v, updated_at: new Date().toISOString() })), 'Saved'); } catch { /* shown */ }
  }));
  main().querySelectorAll('[data-rqx]').forEach((a) => (a.onclick = async (e) => { e.preventDefault(); try { await run(async () => must(await sb.rpc('hr_cancel', { p_id: Number(a.dataset.rqx) })), 'Cancelled'); } catch { return; } pageOTSettings(); }));
  bindHol(hols, pageOTSettings);
  // Once a month, fetch the official list from the Bank of Thailand in the background
  if (!pageOTSettings.synced && (!hmeta?.checked_at || Date.now() - new Date(hmeta.checked_at) > 25 * 86400000)) { pageOTSettings.synced = true; sb.functions.invoke('bo-sync-holidays', { body: {} }).then(({ data }) => { if (data?.changed && location.hash.startsWith('#/admin/ot')) pageOTSettings(); }); }
}

async function otApprovalsHtml(status) {
  let q = sb.from('ot_forms').select('*').order('period_end', { ascending: false });
  if (Array.isArray(status)) q = q.in('status', status); else if (status !== 'all') q = q.eq('status', status);
  const forms = must(await q);
  if (!forms.length) return '<div class="card" style="margin-top:16px"><div class="empty">No timesheets here.</div></div>';
  const [staff, ents] = await Promise.all([
    sb.from('profiles').select('id, full_name, staff_no').then(must),
    sb.from('ot_entries').select('form_id, hours, counted').in('form_id', forms.map((f) => f.id)).then(must),
  ]);
  const P = Object.fromEntries(staff.map((x) => [x.id, x]));
  const sum = (id, k) => ents.filter((e) => e.form_id === id).reduce((a, e) => a + Number(e[k]), 0);
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Timesheets</h2></div><div class="table-wrap"><table><thead><tr><th>Staff</th><th>Period</th><th>Status</th><th>Submitted</th><th>Taken as</th><th class="num">OT counted</th></tr></thead><tbody>
    ${forms.map((f) => `<tr class="click" data-href="#/ot/review/${f.id}"><td>${f.status === 'submitted' && (!f.seen_at || f.seen_at < f.submitted_at) ? '<span class="newdot"></span>' : ''}${esc(P[f.staff_id]?.full_name || '')}<div class="faint mono">${esc(P[f.staff_id]?.staff_no || '')}</div></td><td>${esc(otPeriod(f.period_end).label)}</td><td>${pill(f.status)}</td><td>${dateLabel(f.submitted_at)}</td><td>${f.expiry_action === 'paid' ? 'Paid out' : f.expiry_action === 'extended' ? 'Kept longer' : ''}</td><td class="num">${Math.round(sum(f.id, 'counted') * 100) / 100} h</td></tr>`).join('')}
  </tbody></table></div></div>`;
}

/* ---------- timesheet week view ---------- */
const LEAVE = { annual: 'Annual leave', sick: 'Sick', personal: 'Personal', replacement: 'Replacement day off' };
const tmin = (t) => { if (!t) return null; const [a, b] = t.split(':').map(Number); return a * 60 + b; };
function baseTypeOf(date, set, hol) { return (otPreview(date, '09:00', '10:00', set, hol) || {}).type || 'workday'; }
function dayTypeOf(date, set, hol) { return set.ovr?.[date] || baseTypeOf(date, set, hol); }
// Hours and OT for a whole day, from its time ranges (same rules as the database)
function dayCalc(ranges, type, set) {
  if (set.pay_type === 'freelance') { const hf = ranges.reduce((a, [x, y]) => { if (x == null || y == null) return a; let d = (y - x) / 60; if (d <= 0) d += 24; return a + d; }, 0); return { hours: Math.round((hf - (hf > 5 ? Number(set.lunch_hours) || 0 : 0)) * 100) / 100, ot: 0 }; }
  const h = ranges.reduce((a, [x, y]) => { if (x == null || y == null) return a; let d = (y - x) / 60; if (d <= 0) d += 24; return a + d; }, 0);
  if (!h) return { hours: 0, ot: 0 };
  const normal = (tmin(hhmm(set.end_time)) - tmin(hhmm(set.start_time))) / 60;
  const ot = type === 'workday' ? Math.max(0, h - normal) : Math.max(0, h - (h > 5 ? Number(set.lunch_hours) : 0)) * Number(type === 'holiday' ? set.holiday_mult : set.dayoff_mult);
  // hours shown = time actually worked: minus lunch on days over 5 h
  const worked = h - (h > 5 ? Number(set.lunch_hours) || 0 : 0);
  return { hours: Math.round(worked * 100) / 100, ot: Math.round(ot * 100) / 100 };
}
function periodWeeks(per) {
  const start = new Date(`${per.start}T00:00:00`), end = new Date(`${per.end}T00:00:00`);
  const mon = new Date(start); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const weeks = [];
  for (let d = new Date(mon); d <= end; d.setDate(d.getDate() + 7)) {
    const days = [];
    for (let k = 0; k < 7; k++) { const x = new Date(d); x.setDate(x.getDate() + k); if (x >= start && x <= end) days.push(iso(x)); }
    weeks.push(days);
  }
  return weeks;
}
function weekGridHtml(per, entries, set, hol, total) {
  const weeks = periodWeeks(per);
  let w = Number(params().w);
  if (!Number.isInteger(w) || w < 0 || w >= weeks.length) { const t = today(); w = Math.max(0, weeks.findIndex((x) => x.includes(t))); }
  const ns = hhmm(set.start_time), ne = hhmm(set.end_time);
  const rows = weeks[w].map((date) => {
    const type = dayTypeOf(date, set, hol);
    const es = entries.filter((e) => e.work_date === date).sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    const lv = es.find((e) => e.leave_type);
    const tr = es.filter((e) => !e.leave_type && e.start_time);
    const has = tr.length > 0, off = type !== 'workday';
    const a = has ? tr[0] : null, b = tr[1] || null;
    const note = (lv || tr[0])?.reason || '';
    const label = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const typeCell = off ? `<span class="ltag">${OT_DAY[type]}</span>` : `<select class="input wk-type"><option value="">Workday</option>${Object.entries(LEAVE).map(([k, v]) => `<option value="${k}" ${lv?.leave_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    const showTimes = !lv && (!off || has);
    return `<tr class="wk-row${off ? ' wk-off' : ''}" data-date="${date}" data-type="${type}" data-ns="${ns}" data-ne="${ne}">
      <td class="nowrap">${label}</td><td>${typeCell}</td>
      <td class="wk-t" ${showTimes ? '' : 'hidden'}><input class="input wk-in" type="time" value="${a ? hhmm(a.start_time) : off ? '' : ns}"></td>
      <td class="wk-t" ${showTimes ? '' : 'hidden'}><input class="input wk-out" type="time" value="${a ? hhmm(a.end_time) : off ? '' : ne}"></td>
      ${showTimes ? '' : `<td colspan="2" class="wk-add">${off && !lv ? '<a href="#" class="linkbtn wk-addl">+ add</a>' : ''}</td>`}
      <td><input class="input wk-note" value="${esc(note)}" placeholder="${off ? '' : 'Note'}"></td>
      <td class="num wk-h">-</td><td class="num wk-ot">-</td>
      <td class="wk-sp">${lv ? '' : `<label class="faint" title="Two time ranges on this day"><input type="checkbox" class="wk-split" ${b ? 'checked' : ''} ${showTimes ? '' : 'hidden'}></label>`}</td></tr>
    <tr class="wk-sub" data-for="${date}" ${b ? '' : 'hidden'}><td></td><td class="faint" style="font-size:12px">2nd time</td><td><input class="input wk-in2" type="time" value="${b ? hhmm(b.start_time) : ''}"></td><td><input class="input wk-out2" type="time" value="${b ? hhmm(b.end_time) : ''}"></td><td colspan="4" class="faint" style="font-size:12px">Not for overnight shifts. Use one time ending after midnight.</td></tr>`;
  }).join('');
  return `<div class="card"><div class="card-head"><h2>Week ${w + 1} of ${weeks.length}</h2><div class="row"><span class="muted">Period OT counted: <b>${Math.round(total * 100) / 100} h</b></span><a class="btn small" ${w > 0 ? `href="#/ot?p=${per.end}&w=${w - 1}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>‹ Week</a><a class="btn small" ${w < weeks.length - 1 ? `href="#/ot?p=${per.end}&w=${w + 1}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>Week ›</a><button class="btn primary" id="wksave">Save week</button></div></div>
    <div class="table-wrap"><table class="lines wk"><thead><tr><th style="width:110px">Day</th><th style="width:170px">Type</th><th style="width:120px">In</th><th style="width:120px">Out</th><th>Note</th><th class="num" style="width:60px">Hours</th><th class="num" style="width:50px">OT</th><th style="width:44px">Split</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td colspan="5">Week total</td><td class="num" id="wkh">-</td><td class="num" id="wkot">-</td><td></td></tr></tfoot></table></div>
    <p class="faint" style="font-size:12px;padding:0 16px 12px">Days are filled with your normal hours. Change only what was different, then Save week. A week you don't touch counts as normal hours.</p></div>`;
}
function wireWeekGrid({ per, entries, set, hol, ensureForm, reload }) {
  const tbody = main().querySelector('table.wk tbody'); if (!tbody) return;
  const rowsOf = () => [...tbody.querySelectorAll('tr.wk-row')];
  const subOf = (r) => tbody.querySelector(`tr.wk-sub[data-for="${r.dataset.date}"]`);
  const read = (r) => {
    const lv = r.querySelector('.wk-type')?.value || '';
    const sub = subOf(r);
    const timesShown = !r.querySelector('.wk-t').hidden;
    const ranges = [];
    if (!lv && timesShown) {
      const a = tmin(r.querySelector('.wk-in').value), b = tmin(r.querySelector('.wk-out').value);
      if (a != null && b != null) ranges.push([a, b]);
      if (r.querySelector('.wk-split')?.checked && !sub.hidden) { const c = tmin(sub.querySelector('.wk-in2').value), d = tmin(sub.querySelector('.wk-out2').value); if (c != null && d != null) ranges.push([c, d]); }
    }
    return { lv, ranges, note: r.querySelector('.wk-note').value.trim() };
  };
  const recalc = () => {
    let th = 0, to = 0;
    rowsOf().forEach((r) => {
      const v = read(r), c = dayCalc(v.ranges, r.dataset.type, set);
      r.querySelector('.wk-h').textContent = v.lv ? '-' : c.hours || '-';
      r.querySelector('.wk-ot').textContent = v.lv ? '-' : c.ot || (c.hours ? 0 : '-');
      th += c.hours; to += c.ot;
      // blue = different from a normal day
      const def = r.dataset.type === 'workday' ? !v.lv && v.ranges.length === 1 && v.ranges[0][0] === tmin(r.dataset.ns) && v.ranges[0][1] === tmin(r.dataset.ne) && !v.note : !v.ranges.length && !v.note;
      r.classList.toggle('wk-chg', !def);
    });
    document.getElementById('wkh').textContent = Math.round(th * 100) / 100;
    document.getElementById('wkot').textContent = Math.round(to * 100) / 100;
  };
  rowsOf().forEach((r) => {
    r.querySelectorAll('input, select').forEach((el) => (el.oninput = el.onchange = () => {
      if (el.classList.contains('wk-type')) {
        const lv = !!el.value; r.querySelectorAll('.wk-t').forEach((t) => (t.hidden = lv)); const sp = r.querySelector('.wk-split'); if (sp) sp.hidden = lv;
        if (lv) { subOf(r).hidden = true; if (sp) sp.checked = false; }
      }
      if (el.classList.contains('wk-split')) subOf(r).hidden = !el.checked;
      recalc();
    }));
    const addl = r.querySelector('.wk-addl');
    if (addl) addl.onclick = (e) => {
      e.preventDefault(); r.querySelector('.wk-add').remove();
      r.querySelectorAll('.wk-t').forEach((t) => (t.hidden = false)); const sp = r.querySelector('.wk-split'); if (sp) sp.hidden = false;
      r.querySelector('.wk-in').value = hhmm(set.start_time); r.querySelector('.wk-in').focus(); recalc();
    };
  });
  tbody.querySelectorAll('tr.wk-sub input').forEach((el) => (el.oninput = recalc));
  recalc();
  document.getElementById('wksave').onclick = async () => {
    const b = document.getElementById('wksave');
    const plan = rowsOf().map((r) => {
      const v = read(r), date = r.dataset.date, type = r.dataset.type;
      let want = [];
      if (v.lv) want = [{ work_date: date, leave_type: v.lv, reason: v.note }];
      else if (v.ranges.length) {
        const normalDay = type === 'workday' && v.ranges.length === 1 && v.ranges[0][0] === tmin(r.dataset.ns) && v.ranges[0][1] === tmin(r.dataset.ne) && !v.note;
        if (!normalDay) want = v.ranges.map(([x, y], k) => ({ work_date: date, start_time: `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`, end_time: `${String(Math.floor(y / 60)).padStart(2, '0')}:${String(y % 60).padStart(2, '0')}`, reason: k === 0 ? v.note : v.note }));
      }
      const c = dayCalc(v.ranges, type, set);
      return { date, want, needNote: !v.lv && c.ot > 0 && !v.note, row: r };
    });
    const newRep = plan.filter((x) => x.want.some((e) => e.leave_type === 'replacement')).length - entries.filter((e) => e.leave_type === 'replacement' && plan.some((x) => x.date === e.work_date)).length;
    if (newRep > 0 && window.__tobLeft != null && window.__tobLeft - newRep * window.__tobDay < 0 && !b.dataset.ok) { b.dataset.ok = '1'; toast(`Not enough time off saved (${window.__tobLeft} h left). Click Save week again to save anyway.`, true); return; }
    const miss = plan.find((x) => x.needNote);
    if (miss) { miss.row.querySelector('.wk-note').focus(); toast('Add a note on each day with OT', true); return; }
    b.disabled = true;
    try {
      await run(async () => {
        const f = await ensureForm();
        const dates = plan.map((x) => x.date);
        must(await sb.from('ot_entries').delete().eq('form_id', f.id).in('work_date', dates));
        const rows = plan.flatMap((x) => x.want.map((e) => ({ ...e, form_id: f.id })));
        if (rows.length) must(await sb.from('ot_entries').insert(rows));
      }, 'Week saved');
    } catch { b.disabled = false; return; }
    reload();
  };
}

const otSplitText = (form) => (form.expiry_action === 'paid' ? 'paid out' : form.expiry_action === 'extended' ? `kept until ${dateLabel(form.extended_until)}` : 'goes to time-off balance once approved, for 3 months');

/* ---------- timesheet calendar ---------- */
let HOLNAME = {};
const mm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// What a day looks like: saved entries, or the person's normal day
function dayInfo(date, entries, set, hol) {
  const type = dayTypeOf(date, set, hol);
  const es = entries.filter((e) => e.work_date === date).sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  const lv = es.find((e) => e.leave_type);
  const tr = es.filter((e) => !e.leave_type && e.start_time);
  let ranges = tr.map((e) => [tmin(hhmm(e.start_time)), tmin(hhmm(e.end_time))]);
  const isDefault = !es.length;
  const free = set.pay_type === 'freelance';
  if (isDefault && type === 'workday' && !free) ranges = [[tmin(hhmm(set.start_time)), tmin(hhmm(set.end_time))]];
  const c = lv ? { hours: 0, ot: 0 } : dayCalc(ranges, set.offd?.[date] === 'swap' ? 'workday' : type, set);
  if (free) c.ot = 0;
  return { date, type, lv, ranges, note: (lv || tr[0] || es[0])?.reason || '', isDefault, ...c };
}
// Timesheet: select several workdays and give them the same times in one go
function selectDays({ per, entries, set, hol, ensureForm, reload }) {
  const head = main().querySelector('.cal')?.closest('.card')?.querySelector('.card-head'); if (!head) return;
  const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = 'Select days'; btn.style.marginLeft = '10px'; { const hint = head.querySelector('span.faint'); if (hint) { const g = document.createElement('div'); g.style.cssText = 'display:flex;align-items:center;margin-left:auto'; hint.replaceWith(g); g.append(hint, btn); } else head.appendChild(btn); }
  const days = periodWeeks(per).flat();
  const touched = (d) => entries.some((e) => e.work_date === d) || !!set.ovr?.[d];
  const okDay = (d) => { const x = dayInfo(d, entries, set, hol); return x.type === 'workday' && !x.lv && !touched(d); };
  let on = false; const pick = new Set();
  const cal = main().querySelector('.cal');
  const bar = document.createElement('div'); bar.className = 'sd-bar'; bar.hidden = true;
  bar.innerHTML = `<b id="sdn">0 days</b><span class="faint">In</span><input class="input" type="time" id="sdi" value="${hhmm(set.start_time)}"><span class="faint">Out</span><input class="input" type="time" id="sdo" value="${hhmm(set.end_time)}">
    <input class="input" id="sdr" placeholder="Reason (needed for OT)" style="width:200px" hidden><span class="faint" id="sdc"></span><button class="btn primary small" id="sda" style="margin-left:auto">Apply</button>`;
  cal.after(bar);
  const tip = document.createElement('div'); tip.className = 'sd-tip'; tip.hidden = true;
  tip.innerHTML = '<b>Tap the days to fill</b><button class="btn small" id="sdall">All workdays</button><span class="faint">Days you already changed are skipped. Leave and days off: open the day as usual.</span><button class="btn small" id="sddone" style="margin-left:auto">Done</button>';
  cal.before(tip);
  const calc = () => {
    const a = tmin(bar.querySelector('#sdi').value || '00:00'), b = tmin(bar.querySelector('#sdo').value || '00:00');
    const c = b > a ? dayCalc([[a, b]], 'workday', set) : { hours: 0, ot: 0 };
    bar.querySelector('#sdn').textContent = `${pick.size} day${pick.size === 1 ? '' : 's'}`;
    bar.querySelector('#sdc').textContent = b > a ? `${c.hours} h each${c.ot ? ` · ${Math.round(c.ot * pick.size * 100) / 100} h OT` : ' · no OT'}` : 'Out must be after In';
    bar.querySelector('#sdr').hidden = !c.ot;
    return { a, b, c };
  };
  const paint = () => { cal.querySelectorAll('.cal-c[data-day]').forEach((c) => { c.classList.toggle('sd-on', pick.has(c.dataset.day)); c.classList.toggle('sd-no', on && !okDay(c.dataset.day)); }); calc(); };
  const setMode = (v) => { on = v; pick.clear(); bar.hidden = tip.hidden = !v; btn.hidden = v; cal.classList.toggle('sd-mode', v); paint(); };
  btn.onclick = () => setMode(true);
  tip.querySelector('#sddone').onclick = () => setMode(false);
  tip.querySelector('#sdall').onclick = () => { days.filter(okDay).forEach((d) => pick.add(d)); paint(); };
  // in select mode a tap picks the day instead of opening it
  cal.addEventListener('click', (e) => {
    if (!on) return; const c = e.target.closest('.cal-c[data-day]'); if (!c) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const d = c.dataset.day; if (!okDay(d)) { toast('Already changed by hand, or not a workday. Open it to change.', true); return; }
    pick.has(d) ? pick.delete(d) : pick.add(d); paint();
  }, true);
  bar.querySelectorAll('input').forEach((i) => (i.oninput = calc));
  bar.querySelector('#sda').onclick = async () => {
    if (!pick.size) { toast('Tap at least 1 day', true); return; }
    const { a, b, c } = calc(); if (b <= a) { toast('Out must be after In', true); return; }
    const reason = bar.querySelector('#sdr').value.trim();
    if (c.ot && !reason) { toast('Add a reason: these days have OT', true); bar.querySelector('#sdr').focus(); return; }
    const normal = mm(a) === hhmm(set.start_time) && mm(b) === hhmm(set.end_time) && !reason;
    try { await run(async () => {
      const fm = await ensureForm();
      const ds = [...pick];
      must(await sb.from('ot_entries').delete().eq('form_id', fm.id).in('work_date', ds));
      if (!normal) must(await sb.from('ot_entries').insert(ds.map((d) => ({ form_id: fm.id, work_date: d, start_time: mm(a), end_time: b >= 1440 ? '24:00' : mm(b), reason: reason || null }))));
    }, `${pick.size} day${pick.size === 1 ? '' : 's'} filled`); } catch { return; }
    reload();
  };
}
function calHtml(per, entries, set, hol, { editable }) {
  if (isPhone()) return phoneCalHtml(per, entries, set, hol, { editable });
  const weeks = periodWeeks(per);
  let th = 0, tot = 0, lvd = 0;
  const grid = weeks.map((days) => {
    const mon = new Date(`${days[0]}T00:00:00`); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    let wh = 0, wo = 0;
    const cells = [];
    for (let k = 0; k < 7; k++) {
      const d = new Date(mon); d.setDate(d.getDate() + k); const date = iso(d);
      if (!days.includes(date)) { cells.push(`<div class="cal-c cal-out"><span class="cal-d">${d.getDate()}</span></div>`); continue; }
      const x = dayInfo(date, entries, set, hol);
      wh += x.hours; wo += x.ot; if (x.lv) lvd++;
      const off = (x.type !== 'workday' || !!x.lv) && set.pay_type !== 'freelance';
      // a scheduled workday taken off (leave or "other"): grey like a day off, plus its type
      const takenOff = set.ovr?.[date] === 'day_off' && baseTypeOf(date, set, hol) === 'workday';
      cells.push(`<button type="button" class="cal-c${off ? ' cal-off' : ''}" data-day="${date}">
        <span class="cal-d">${d.getDate()}${d.getDate() === 1 || date === days[0] && days === weeks[0] ? ` <span class="cal-m">${d.toLocaleDateString('en-GB', { month: 'short' })}</span>` : ''} <span class="cal-wd">${d.toLocaleDateString('en-GB', { weekday: 'short' })}</span></span>
        <span class="cal-b">${set.ovr?.[date] ? '' : x.type === 'holiday' ? `<span class="cal-hol">${esc(HOLNAME[date] || 'Holiday')}</span>` : ''}
        ${x.lv ? `<span class="cal-lv" title="${LEAVE[x.lv.leave_type]}">${{ replacement: 'Replacement', annual: 'Annual leave' }[x.lv.leave_type] || LEAVE[x.lv.leave_type]}</span>` : takenOff && !x.hours ? `<span class="cal-lv">${x.note.startsWith('Swap for') ? 'Swap off' : 'Day off'}</span>` : x.hours ? `<span>${x.hours} h${x.ranges.length > 1 ? ' · split' : ''}</span>` : `<span class="faint">${off ? 'off' : '-'}</span>`}
        ${x.hours && off && !x.lv && set.offd?.[x.date] === 'swap' ? `<span class="cal-ot">Swap ↔ ${esc(dateLabel(set.swapd[x.date]).replace(/ \d{4}$/, ''))}</span>${x.ot ? `<span class="cal-ot">OT ${x.ot}</span>` : ''}` : x.hours && off && !x.lv && set.offd?.[x.date] === 'save' ? '<span class="cal-ot">Saved day</span>' : x.ot ? `<span class="cal-ot">${off && !x.lv && set.offd?.[x.date] === 'pay' ? `${x.ot} h x2` : off && !x.lv ? `${x.ot} h · choose` : `OT ${x.ot}`}</span>` : ''}</span></button>`);
    }
    th += wh; tot += wo;
    return `${cells.join('')}<div class="cal-wk">${Math.round(wh * 100) / 100} h${wo ? `<br><b>OT ${Math.round(wo * 100) / 100}</b>` : ''}</div>`;
  }).join('');
  return `<div class="card"><div class="card-head"><h2>${Math.round(th * 100) / 100} h worked · ${Math.round(tot * 100) / 100} h OT${lvd ? ` · ${lvd} day${lvd > 1 ? 's' : ''} leave` : ''}</h2><span class="faint" style="font-size:12px">${editable ? 'Click a day to change it' : 'Click a day for details'}</span></div>
    <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span class="cal-h">${d}</span>`).join('')}<span class="cal-h">Week</span>${grid}</div>
</div>`;
}
function wireCal({ entries, set, hol, editable, ensureForm, reload, lock = '', askFor = null, askName = '' }) {
  if (isPhone() && document.getElementById('tcal')) {
    const open = (d) => dayDialog({ x: dayInfo(d, entries, set, hol), set, hol, editable, ensureForm, reload, lock, askFor, askName, ents: entries });
    const show = (d) => {
      main().querySelectorAll('#tcal [data-cd]').forEach((b) => b.classList.toggle('rc-sel', b.dataset.cd === d));
      const x = dayInfo(d, entries, set, hol);
      const off = x.type !== 'workday' && !x.hours;
      const what = x.lv ? LEAVE[x.lv.leave_type] : off ? (x.type === 'holiday' ? (HOLNAME[d] || 'Holiday') : 'Day off') : `${x.ranges.map((r) => `${mm(r[0])} to ${mm(r[1])}`).join(', ')} · ${x.hours} h${x.ot ? ` + OT ${x.ot}` : ''}`;
      document.getElementById('tcaldet').innerHTML = `<div class="rc-row"><span><span class="rc-nm">${esc(dateLabel(d))}</span><span class="faint rc-tx">${esc(what)}${x.note ? ' · ' + esc(x.note) : ''}</span></span><button class="btn small" id="tcalgo">${editable ? 'Change' : askFor ? 'Ask' : 'Details'}</button></div>`;
      document.getElementById('tcalgo').onclick = () => open(d);
    };
    main().querySelectorAll('#tcal [data-cd]').forEach((b) => (b.onclick = () => show(b.dataset.cd)));
    const want = params().d, all = [...main().querySelectorAll('#tcal [data-cd]')].map((b) => b.dataset.cd);
    show(all.includes(want) ? want : all.includes(iso(new Date())) ? iso(new Date()) : all[0]);
    return;
  }
  main().querySelectorAll('.cal-c[data-day]').forEach((b) => (b.onclick = () => dayDialog({ x: dayInfo(b.dataset.day, entries, set, hol), set, hol, editable, ensureForm, reload, lock, askFor, askName, ents: entries })));
}
function phoneCalHtml(per, entries, set, hol, { editable }) {
  const days = periodWeeks(per).flat();
  const today = iso(new Date());
  const lead = (new Date(`${days[0]}T00:00:00`).getDay() + 6) % 7;
  const free = set.pay_type === 'freelance';
  const short = { annual: 'AL', sick: 'Sick', personal: 'Pers', replacement: 'Repl', saved: 'Saved', other: 'Other' };
  const cells = Array(lead).fill('<div></div>').concat(days.map((d) => {
    const x = dayInfo(d, entries, set, hol), n = new Date(`${d}T00:00:00`);
    const off = (x.type !== 'workday' || !!x.lv) && !free;
    let tag = '';
    if (x.lv) tag = `<span class="rc-t rc-leave">${short[x.lv.leave_type] || 'Leave'}</span>`;
    else if (x.hours && x.type !== 'workday') tag = `<span class="rc-t rc-dw">Day-off work</span>`;
    else if (x.ot) tag = `<span class="rc-t rc-on">OT ${x.ot}</span>`;
    else if (x.type === 'holiday') tag = `<span class="rc-t rc-hol">Holiday</span>`;
    else if (free && x.hours) tag = `<span class="rc-t">${x.hours} h</span>`;
    return `<button type="button" class="rc-d${off && !x.hours ? ' rc-we' : ''}${d === today ? ' rc-today' : ''}" data-cd="${d}"><span class="rc-top"><b>${n.getDate()}</b></span>${tag}</button>`;
  }));
  return `<div class="card card-pad" id="tcal"><div class="rc-lg"><span class="rc-t rc-on">OT</span><span class="rc-t rc-leave">Leave</span><span class="rc-t rc-dw">Day-off work</span><span class="faint">${editable ? 'Tap a day, then Change' : 'Tap a day for details'}</span></div>
    <div class="rc-g rc-wk">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
    <div class="rc-g">${cells.join('')}</div><div class="rc-det" id="tcaldet"></div></div>`;
}
// Read-only day: only what matters (what the day was, hours, OT, note), plus Ask for admin and HR
function dayView({ x, set, hol = [], lock = '', askFor = null, askName = '' }) {
  const title = new Date(`${x.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const off = !x.hours;
  const kind = x.lv ? LEAVE[x.lv.leave_type] || 'Leave' : off ? (x.type === 'holiday' ? (HOLNAME[x.date] || 'Holiday') : 'Day off')
    : x.type !== 'workday' ? `Worked on a ${x.type === 'holiday' ? 'holiday' : 'day off'}${set.offd?.[x.date] === 'pay' ? ' · paid x2' : set.offd?.[x.date] === 'save' ? ' · kept as a day off' : set.offd?.[x.date] === 'swap' ? ' · swapped' : ''}` : 'Workday';
  const times = x.ranges.map((r) => `${mm(r[0])} to ${mm(r[1])}`).join(', ');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal narrow" role="dialog" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost" data-x>Close</button></div>
    <div class="modal-body"><div class="card-pad stack">
      <div class="dv"><span>${esc(kind)}</span>${x.hours ? `<b>${x.hours} h${x.ot ? ` · OT ${x.ot}` : ''}</b>` : ''}</div>
      ${x.hours && times ? `<div class="faint" style="font-size:13px;margin-top:-6px">${esc(times)}${x.isDefault ? ' (normal hours)' : ''}</div>` : ''}
      ${x.note ? `<div style="font-size:14px"><span class="faint">Note:</span> ${esc(x.note)}</div>` : ''}
      ${askFor ? `<div class="field" style="margin-top:6px"><label>Ask ${esc(askName)} about this day</label><textarea class="input" id="ddask" rows="3" placeholder="e.g. Was this a shoot day? Please add the OT."></textarea>
        <button type="button" class="btn primary" id="ddasks" style="width:100%;margin-top:8px">Send question</button>
        <span class="hint">Only ${esc(askName)} can change their days. They get your question in Messages and can reply.</span></div>` : lock ? `<div class="faint" style="font-size:13px">${esc(lock)}</div>` : ''}
      <div class="error" id="dderr"></div>
    </div></div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const ab = back.querySelector('#ddasks');
  if (ab) ab.onclick = async () => {
    const t = back.querySelector('#ddask').value.trim();
    if (!t) { back.querySelector('#dderr').textContent = 'Write a question first.'; return; }
    ab.disabled = true;
    const { error } = await sb.rpc('ask_about_day', { p_staff: askFor, p_day: x.date, p_text: t });
    if (error) { ab.disabled = false; back.querySelector('#dderr').textContent = error.message; return; }
    close(); toast(`Question sent to ${askName}`);
  };
}
function dayDialog({ x, set, editable, ensureForm, reload, hol = [], lock = '', askFor = null, askName = '', ents = [] }) {
  if (!editable) return dayView({ x, set, hol, lock, askFor, askName });
  const base = baseTypeOf(x.date, set, hol);
  const baseLabel = base === 'holiday' ? (HOLNAME[x.date] || 'Holiday') : OT_DAY[base];
  let etype = x.type;
  let off = etype !== 'workday';
  const ns = hhmm(set.start_time), ne = hhmm(set.end_time);
  const r1 = x.ranges[0], r2 = x.ranges[1];
  const title = new Date(`${x.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const back = document.createElement('div');
  back.className = 'modal-back';
  const dis = editable ? '' : 'disabled';
  // Same hours on other days: workdays of this period, not changed by hand
  const cpOk = set.pay_type !== 'freelance' && base === 'workday';
  const cpDays = cpOk ? periodWeeks(periodOf(x.date)).flat() : [];
  const cpCan = (d) => d !== x.date && baseTypeOf(d, set, hol) === 'workday' && !set.ovr?.[d] && !set.offd?.[d] && !ents.some((e) => e.work_date === d && (e.leave_type || /^Swap for/.test(e.reason || '')));
  const cpPick = new Set();
  const cpHtml = cpOk ? (() => {
    const m0 = new Date(`${cpDays[0]}T00:00:00`); const lead = (m0.getDay() + 6) % 7;
    const cells = cpDays.map((d) => { const n = new Date(`${d}T00:00:00`).getDate(); const c = d === x.date ? 'cp-me' : cpCan(d) ? '' : baseTypeOf(d, set, hol) === 'workday' ? 'cp-hand' : 'cp-off'; return `<button type="button" class="cp-d ${c}" data-cp="${d}" ${c ? 'tabindex="-1"' : ''}>${n}</button>`; });
    return `<div id="ddcp" class="cp"><div class="row" style="justify-content:space-between;align-items:center"><label style="margin:0">Same hours on other days <span class="faint">(optional)</span></label><button type="button" class="btn small" id="cpall">All workdays</button></div>
      <div class="cp-g">${'MTWTFSS'.split('').map((w) => `<span class="cp-h">${w}</span>`).join('')}${'<span></span>'.repeat(lead)}${cells.join('')}</div>
      <span class="faint" style="font-size:12px">Dashed: leave or a swapped day, skipped. Days with other hours get these hours.</span></div>`;
  })() : '';
  back.innerHTML = `<div class="modal narrow" role="dialog" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost" data-x>Close</button></div>
    <div class="modal-body"><form class="card-pad stack" id="dd">
      ${!editable ? `<div class="banner warn" style="font-size:13px"><b>Can't change this day.</b> ${esc(lock || 'This timesheet is locked.')}</div>` : ''}
      <div class="field"><label>This day is</label><select class="input" name="kind" ${dis}>${base === 'workday'
        ? `<option value="work" ${!set.ovr?.[x.date] && !x.lv ? 'selected' : ''}>Workday</option><option value="off" ${set.ovr?.[x.date] === 'day_off' || x.lv ? 'selected' : ''}>Day off</option>`
        : `<option value="off" selected>${esc(base === 'holiday' ? baseLabel : 'Day off')}</option>`}</select>
        <input type="hidden" name="treat" value="${set.ovr?.[x.date] || ''}"><input type="hidden" name="lv" value="${x.lv?.leave_type || ''}"></div>
      ${base === 'workday' ? `<div class="field" id="ddkind2"><label>Type of day off</label><select class="input" name="offtype" ${dis}><option value="" ${!x.lv && set.ovr?.[x.date] !== 'day_off' ? 'selected' : ''}>Choose the type</option>${Object.entries(LEAVE).map(([k, v]) => `<option value="${k}" ${x.lv?.leave_type === k ? 'selected' : ''}>${v}</option>`).join('')}<option value="other" ${set.ovr?.[x.date] === 'day_off' ? 'selected' : ''}>Other (swapped day, etc.)</option></select></div>
      <div class="field" id="ddrange" hidden><label>Until <span class="faint">(for several days in a row)</span></label><input class="input" type="date" name="until" min="${x.date}" value="${x.date}" ${dis}><span class="hint" id="ddrangeh"></span></div>` : ''}

      <div class="faint" id="ddoffh" style="font-size:12px">Not a workday on your schedule. If you worked, tap In: it fills your normal hours to adjust. Then choose Paid x2, Keep as a day off, or Swap.</div>
      <div id="ddt" class="stack" style="gap:10px">
        <div class="row" style="gap:10px;flex-wrap:nowrap"><div class="field" style="flex:1"><label>In</label><input class="input" type="time" name="in1" value="${r1 ? mm(r1[0]) : ''}" ${dis}></div><div class="field" style="flex:1"><label>Out</label><input class="input" type="time" name="out1" value="${r1 ? mm(r1[1]) : ''}" ${dis}></div></div>
        <label class="row" style="gap:6px;font-size:13px"><input type="checkbox" name="split" ${r2 ? 'checked' : ''} ${dis}> Split: a second time range on this day</label>
        <div id="dd2" class="stack" style="gap:6px" ${r2 ? '' : 'hidden'}><div class="row" style="gap:10px;flex-wrap:nowrap"><div class="field" style="flex:1"><label>2nd in</label><input class="input" type="time" name="in2" value="${r2 ? mm(r2[0]) : ''}" ${dis}></div><div class="field" style="flex:1"><label>2nd out</label><input class="input" type="time" name="out2" value="${r2 ? mm(r2[1]) : ''}" ${dis}></div></div><span class="faint" style="font-size:12px">Not for overnight shifts. Use one time ending after midnight.</span></div>
      </div>
      <div class="field" id="ddch" hidden><label>How do you want this day?</label>
        <label class="ddopt"><input type="radio" name="och" value="pay" ${set.offd?.[x.date] === 'pay' ? 'checked' : ''} ${dis}><span><b>Paid x2</b><br><span class="faint" id="ddchp">Hours paid at x2</span></span></label>
        <label class="ddopt"><input type="radio" name="och" value="save" ${set.offd?.[x.date] === 'save' ? 'checked' : ''} ${dis}><span><b>Keep as a day off for later</b><br><span class="faint">+1 replacement day, use within 3 months</span></span></label>
        <label class="ddopt"><input type="radio" name="och" value="swap" ${set.offd?.[x.date] === 'swap' ? 'checked' : ''} ${dis}><span style="flex:1"><b>Swap for another day</b><br><span class="faint">Worked as a normal day; take this day off instead (within 2 months):</span><input class="input" type="date" name="swapd" value="${set.swapd?.[x.date] || ''}" min="${periodOf(x.date).start}" max="${swapMax(x.date)}" style="margin-top:4px" ${dis}></span></label></div>
      <div class="field"><label>Note <span class="faint" id="ddneed"></span></label><input class="input" name="note" value="${esc(x.note)}" placeholder="e.g. Night shoot for Symatics" ${dis}></div>
      ${cpHtml}
      <div class="banner info" id="ddpv" style="font-size:13px"></div>
      <div class="error" id="dderr"></div>
    </form></div>
    <div class="modal-foot"><span>${editable && !x.isDefault ? '<button class="btn ghost" id="ddreset">Reset to normal</button>' : ''}</span><div class="row"><button class="btn ghost" data-x>${editable ? 'Cancel' : 'Close'}</button>${editable ? '<button class="btn primary" id="ddok">Save</button>' : ''}</div></div></div>`;
  document.body.appendChild(back);
  const f = back.querySelector('#dd');
  const ab = back.querySelector('#ddasks');
  if (ab) ab.onclick = async () => {
    const t = back.querySelector('#ddask').value.trim();
    if (!t) { back.querySelector('#dderr').textContent = 'Write a question first.'; return; }
    const { error } = await sb.rpc('ask_about_day', { p_staff: askFor, p_day: x.date, p_text: t });
    if (error) { back.querySelector('#dderr').textContent = error.message; return; }
    back.remove(); toast(`Question sent to ${askName}`);
  };
  const close = () => back.remove();
  back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  const read = () => {
    const lv = etype === 'workday' ? (f.lv?.value || '') : '';
    const ranges = [];
    if (!lv) {
      const a = tmin(f.in1.value), b = tmin(f.out1.value); if (a != null && b != null) ranges.push([a, b]);
      if (f.split.checked) { const c = tmin(f.in2.value), d = tmin(f.out2.value); if (c != null && d != null) ranges.push([c, d]); }
    }
    return { lv, ranges, note: f.note.value.trim() };
  };
  const pv = () => {
    const k = f.kind.value, k2 = f.offtype?.value || 'other';
    const k2box = back.querySelector('#ddkind2'); if (k2box) k2box.hidden = k !== 'off';
    const rg = back.querySelector('#ddrange');
    if (rg) {
      rg.hidden = !(k === 'off' && LEAVE[f.offtype?.value]);
      const ds = leaveDays(x.date, f.until.value, set, hol);
      back.querySelector('#ddrangeh').textContent = f.until.value > x.date ? `${ds.length} workday${ds.length === 1 ? '' : 's'} (days off and holidays are skipped)` : '';
    }
    if (k === 'work') { f.treat.value = base === 'workday' ? '' : 'workday'; f.lv.value = ''; }
    else if (base !== 'workday') { f.treat.value = ''; f.lv.value = ''; }
    else if (k2 === 'other') { f.treat.value = 'day_off'; f.lv.value = ''; }
    else { f.treat.value = ''; f.lv.value = k2; }
    const nt = f.treat.value || base;
    if (nt !== etype) {
      etype = nt; off = etype !== 'workday';
      if (!off && !f.in1.value && !f.out1.value) { f.in1.value = ns; f.out1.value = ne; }
      if (off && f.in1.value === ns && f.out1.value === ne && !f.split.checked) { f.in1.value = ''; f.out1.value = ''; }
    }
    const freeD = set.pay_type === 'freelance';
    back.querySelector('#ddoffh').hidden = !off || freeD;
    back.querySelector('select[name=kind]').closest('.field').hidden = freeD;
    back.querySelector('#ddt').hidden = !!f.lv.value;
    const v = read();
    back.querySelector('#ddt').hidden = !!v.lv;
    back.querySelector('#dd2').hidden = !f.split.checked;
    const c = dayCalc(v.ranges, f.querySelector('input[name=och]:checked')?.value === 'swap' ? 'workday' : etype, set);
    const showCh = off && !freeD && !v.lv && v.ranges.length > 0;
    back.querySelector('#ddch').hidden = !showCh;
    const och = f.querySelector('input[name=och]:checked')?.value || '';
    if (showCh) back.querySelector('#ddchp').textContent = `${c.ot} h paid at x2`;
    const ex = etype === 'day_off' && base !== 'day_off' ? extraDayOff(x.date, set, hol) : { extra: false };
    const offWork = base === 'workday' && !v.lv && etype === 'day_off';
    f.note.placeholder = v.lv ? 'Optional' : etype === 'day_off' ? 'e.g. Swapped with Saturday 7 Nov' : 'e.g. Night shoot for Symatics';
    back.querySelector('#ddneed').textContent = c.ot && !v.lv ? '(needed, this day has OT)' : offWork ? '(needed: why this day is off)' : ex.extra ? `(needed: ${ex.text})` : '';
    const cpBox = back.querySelector('#ddcp'); const cpLive = !!cpBox && !v.lv && etype === 'workday' && v.ranges.length > 0;
    if (cpBox) cpBox.hidden = !cpLive;
    const cpN = cpLive ? cpPick.size : 0; const okb = back.querySelector('#ddok'); if (okb) okb.textContent = cpN ? `Save ${cpN + 1} days` : 'Save';
    back.querySelector('#ddpv').innerHTML = (cpN ? `Saves <b>${cpN + 1} days</b> · ` : '') + (v.lv ? `<b>${LEAVE[v.lv]}</b>${v.lv === 'replacement' ? ` · uses ${(window.__savedLeft || 0) >= 1 ? '1 saved day' : `${window.__tobDay || 8} h of OT`}` : ''}` : v.ranges.length ? (showCh && och === 'swap' ? `${c.hours} h worked · <b>swapped${f.swapd.value ? ` for ${esc(dateLabel(f.swapd.value))}` : ''}</b>, normal day (OT only after ${hhmm(set.end_time)})` : showCh && och === 'save' ? `${c.hours} h worked on a ${etype === 'holiday' ? 'holiday' : 'day off'} · <b>kept as 1 saved day off</b>` : showCh && och === 'pay' ? `${c.hours} h worked · <b>${c.ot} h at x2</b> (${etype === 'holiday' ? 'holiday' : 'day off'}, minus lunch)` : `${c.hours} h worked · <b>${c.ot} h</b>${off ? ` on a ${etype === 'holiday' ? 'holiday' : 'day off'}: choose Paid x2 or Keep as a day off` : ' OT'}`) : off ? 'Not worked' : 'No times entered');
  };
  back.querySelectorAll('.cp-d[data-cp]').forEach((b) => (b.onclick = () => { const d = b.dataset.cp; if (!cpCan(d)) return; cpPick.has(d) ? cpPick.delete(d) : cpPick.add(d); b.classList.toggle('cp-on', cpPick.has(d)); pv(); }));
  const cpa = back.querySelector('#cpall'); if (cpa) cpa.onclick = () => { cpDays.filter(cpCan).forEach((d) => cpPick.add(d)); back.querySelectorAll('.cp-d[data-cp]').forEach((b) => b.classList.toggle('cp-on', cpPick.has(b.dataset.cp))); pv(); };
  f.querySelectorAll('input, select').forEach((el) => (el.oninput = el.onchange = pv)); pv();
  // Picking a swap date selects the Swap option
  ['input', 'change', 'focus'].forEach((ev) => f.swapd.addEventListener(ev, () => { if (!editable) return; const sw = f.querySelector('input[name=och][value=swap]'); if (!sw.checked) { sw.checked = true; pv(); } }));
  // On a day off the times start empty (so nothing is logged by accident); tapping In or Out fills normal hours to adjust
  ['in1', 'out1'].forEach((n) => f[n].addEventListener('focus', () => { if (editable && !f.in1.value && !f.out1.value) { f.in1.value = ns; f.out1.value = ne; pv(); } }));
  if (!editable) return;
  const saveRows = async (rows, treat = '') => {
    const fm = await ensureForm();
    if (treat) must(await sb.from('ot_day_type').upsert({ staff_id: set.__sid, day: x.date, treat_as: treat }));
    else if (set.ovr?.[x.date]) must(await sb.from('ot_day_type').delete().eq('staff_id', set.__sid).eq('day', x.date));
    must(await sb.from('ot_entries').delete().eq('form_id', fm.id).eq('work_date', x.date));
    if (rows.length) must(await sb.from('ot_entries').insert(rows.map((r) => ({ ...r, form_id: fm.id, work_date: x.date }))));
    const ch = rows.some((r) => r.start_time) && (treat || base) !== 'workday' ? (f.querySelector('input[name=och]:checked')?.value || '') : '';
    const oldSwap = set.swapd?.[x.date] || '';
    const newSwap = ch === 'swap' ? f.swapd.value : '';
    // the swap day can be in a later period: use (or start) that period's timesheet
    const formFor = async (d) => {
      const pe = periodOf(d);
      if (pe.end === (fm.period_end || periodOf(x.date).end)) return fm;
      let g = (await sb.from('ot_forms').select('*').eq('staff_id', set.__sid).eq('period_end', pe.end).maybeSingle()).data;
      if (!g) g = must(await sb.from('ot_forms').insert({ staff_id: set.__sid, period_start: pe.start, period_end: pe.end }).select().single());
      if (!['draft', 'rejected'].includes(g.status)) throw new Error(`The timesheet for ${pe.label} is already submitted. Pick another day.`);
      return g;
    };
    if (oldSwap && oldSwap !== newSwap) {
      const og = await formFor(oldSwap);
      must(await sb.from('ot_day_type').delete().eq('staff_id', set.__sid).eq('day', oldSwap).eq('treat_as', 'day_off'));
      must(await sb.from('ot_entries').delete().eq('form_id', og.id).eq('work_date', oldSwap).like('reason', 'Swap for %'));
    }
    const ng = newSwap && newSwap !== oldSwap ? await formFor(newSwap) : null;
    if (ch) must(await sb.from('ot_offday').upsert({ staff_id: set.__sid, day: x.date, choice: ch, swap_date: newSwap || null }));
    else if (set.offd?.[x.date]) must(await sb.from('ot_offday').delete().eq('staff_id', set.__sid).eq('day', x.date));
    if (newSwap && newSwap !== oldSwap) {
      must(await sb.from('ot_day_type').upsert({ staff_id: set.__sid, day: newSwap, treat_as: 'day_off' }));
      must(await sb.from('ot_entries').delete().eq('form_id', ng.id).eq('work_date', newSwap));
      must(await sb.from('ot_entries').insert({ form_id: ng.id, work_date: newSwap, reason: `Swap for ${dateLabel(x.date)}` }));
    }
  };
  const rs = back.querySelector('#ddreset');
  if (rs) rs.onclick = async () => { try { await run(() => saveRows([]), 'Reset to normal'); } catch { return; } close(); reload(); };
  back.querySelector('#ddok').onclick = async () => {
    const v = read(), err = back.querySelector('#dderr'); err.textContent = '';
    const c = dayCalc(v.ranges, f.querySelector('input[name=och]:checked')?.value === 'swap' && etype !== 'workday' ? 'workday' : etype, set);
    const och2 = f.querySelector('input[name=och]:checked')?.value || '';
    const needCh = off && set.pay_type !== 'freelance' && !v.lv && v.ranges.length > 0;
    if (needCh && !och2) { err.textContent = 'Choose Paid x2, Keep as a day off, or Swap.'; return; }
    if (needCh && och2 === 'swap') {
      const sd = f.swapd.value, pr = periodOf(x.date);
      if (!sd) { err.textContent = 'Pick the day you will take off instead.'; f.swapd.focus(); return; }
      if (sd === x.date || sd < pr.start || sd > swapMax(x.date)) { err.textContent = `Pick a day between ${dateLabel(pr.start)} and ${dateLabel(swapMax(x.date))}.`; return; }
      if (dayTypeOf(sd, set, hol) !== 'workday' && set.swapd?.[x.date] !== sd) { err.textContent = 'That day is already off. Pick a workday.'; return; }
    }
    if (!v.lv && c.ot && !v.note) { err.textContent = 'Add a note: this day has OT.'; f.note.focus(); return; }
    const ex2 = etype === 'day_off' && base !== 'day_off' ? extraDayOff(x.date, set, hol) : { extra: false };
    if (ex2.extra && !v.note) { err.textContent = `Add a reason: ${ex2.text}.`; f.note.focus(); return; }
    if (base === 'workday' && f.kind.value === 'off' && !f.offtype.value) { err.textContent = 'Choose the type of day off.'; f.offtype.focus(); return; }
    if (base === 'workday' && !v.lv && etype === 'day_off' && !v.note) { err.textContent = 'Add a reason for this day off.'; f.note.focus(); return; }
    let rows = [];
    if (v.lv) rows = [{ leave_type: v.lv, reason: v.note }];
    else if (v.ranges.length) {
      const normal = !off && v.ranges.length === 1 && mm(v.ranges[0][0]) === ns && mm(v.ranges[0][1]) === ne && !v.note;
      if (!normal) rows = v.ranges.map(([a, b]) => ({ start_time: mm(a), end_time: b >= 1440 ? '24:00' : mm(b), reason: v.note }));
    } else if (v.note) rows = [{ reason: v.note }]; // a day off with a reason, no hours
    if (v.lv === 'replacement' && !x.lv && (window.__savedLeft || 0) < 1 && window.__tobLeft != null && window.__tobLeft < window.__tobDay && !back.dataset.ok) { back.dataset.ok = '1'; err.textContent = `Only ${window.__tobLeft} h of time off saved. Click Save again to save anyway.`; return; }
    if (v.lv && f.until && f.until.value > x.date) {
      const ds = leaveDays(x.date, f.until.value, set, hol);
      if (v.lv === 'replacement' && window.__tobLeft != null && window.__tobLeft < ds.length * window.__tobDay && !back.dataset.ok2) { back.dataset.ok2 = '1'; err.textContent = `${ds.length} days need ${ds.length * window.__tobDay} h of time off, only ${window.__tobLeft} h saved. Click Save again to save anyway.`; return; }
      try { await run(() => saveLeaveRange(ds, v.lv, v.note, set), `${ds.length} days saved`); } catch { return; }
      close(); reload(); return;
    }
    const cpGo = !v.lv && etype === 'workday' && v.ranges.length > 0 && cpPick.size > 0;
    try { await run(async () => {
      await saveRows(rows, f.treat.value);
      if (cpGo) {
        const fm = await ensureForm(); const ds = [...cpPick];
        must(await sb.from('ot_entries').delete().eq('form_id', fm.id).in('work_date', ds));
        if (rows.length) must(await sb.from('ot_entries').insert(ds.flatMap((d) => rows.map((r) => ({ ...r, form_id: fm.id, work_date: d })))));
      }
    }, cpGo ? `${cpPick.size + 1} days saved` : 'Saved'); } catch { return; }
    close(); reload();
  };
}

// Extra day off = a weekday switched off, or a Saturday off beyond the month's allowance. These need a reason.
function extraDayOff(date, set, hol) {
  const d = new Date(`${date}T00:00:00`);
  if (d.getDay() !== 6) return { extra: true, text: 'a workday switched to a day off' };
  if (set.week_pattern === 'mon_fri') return { extra: false };
  const y = d.getFullYear(), m = d.getMonth(), sats = [];
  for (let k = 1; k <= 31; k++) { const x = new Date(y, m, k); if (x.getMonth() !== m) break; if (x.getDay() === 6) sats.push(iso(x)); }
  const allow = set.week_pattern === 'one_sat' ? 1 : set.week_pattern === 'mon_sat' ? 0 : sats.filter((x) => baseTypeOf(x, set, hol) === 'day_off').length;
  const offNow = sats.filter((x) => x !== date && dayTypeOf(x, set, hol) === 'day_off').length + 1;
  return offNow > allow ? { extra: true, text: `Saturday off number ${offNow} this month (allowed ${allow})` } : { extra: false };
}

// Workdays between two dates (inclusive); days off and holidays are skipped
function leaveDays(from, to, set, hol) {
  const out = []; if (!from || !to || to < from) return [from];
  for (let d = new Date(`${from}T00:00:00`); iso(d) <= to; d.setDate(d.getDate() + 1)) { const x = iso(d); if (baseTypeOf(x, set, hol) === 'workday' && set.ovr?.[x] !== 'day_off' || x === from) out.push(x); if (out.length > 60) break; }
  return out;
}
// Save leave on several days, in whichever timesheet period each day falls (periods are created when needed)
async function saveLeaveRange(days, lv, note, set) {
  const forms = {};
  for (const d of days) {
    const per = otPeriod(d.slice(8) > '25' ? iso(new Date(+d.slice(0, 4), +d.slice(5, 7), 25)) : `${d.slice(0, 8)}25`);
    if (!forms[per.end]) {
      let f = (await sb.from('ot_forms').select('*').eq('staff_id', set.__sid).eq('period_end', per.end).maybeSingle()).data;
      if (!f) f = must(await sb.from('ot_forms').insert({ staff_id: set.__sid, period_start: per.start, period_end: per.end }).select().single());
      if (!['draft', 'rejected'].includes(f.status)) throw new Error(`The timesheet for ${per.label} is already submitted. Leave on those days cannot be added here.`);
      forms[per.end] = f;
    }
    const fm = forms[per.end];
    if (set.ovr?.[d]) must(await sb.from('ot_day_type').delete().eq('staff_id', set.__sid).eq('day', d));
    must(await sb.from('ot_entries').delete().eq('form_id', fm.id).eq('work_date', d));
    must(await sb.from('ot_entries').insert({ form_id: fm.id, work_date: d, leave_type: lv, reason: note }));
  }
}

/* ---------- team roster (approvers and admins) ---------- */
async function pollMessages() {
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  S.msgCount = count || 0;
  document.querySelectorAll('a[href="#/messages"]:not(.home-card)').forEach((a) => { a.querySelectorAll('.count').forEach((n) => n.remove()); if (S.msgCount) { const n = document.createElement('span'); n.className = 'count'; n.textContent = S.msgCount; a.appendChild(n); } });
}
// Company card: upload the monthly statement, match each charge to a staff receipt, chase the rest
// Accounting line form: labelled fields, two columns
const fld = (label, html, wide) => `<label class="ln-f${wide ? ' wide' : ''}"><span>${label}</span>${html}</label>`;
const catOpts = (sel) => { const cs = S.categories.filter((x) => x.id === sel || (x.active && x.on_acct)); const op = (x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`;
  const co = (x) => !x.on_petty;
  return `<optgroup label="Everyday">${cs.filter((x) => !co(x)).map(op).join('')}</optgroup><optgroup label="Company only">${cs.filter(co).map(op).join('')}</optgroup>`; };
const lnForm = (o) => `<div class="ln-g">${fld('Supplier (from FlowAccount)', `<input class="input" list="${o.list}" data-f="merchant" placeholder="Pick a supplier" value="${esc(o.merchant || '')}">`)}
  ${fld('Category', `<select class="input" data-f="category_id"><option value="">Choose…</option>${catOpts(o.category_id)}</select>`)}
  ${fld('What was it for?', `<input class="input" data-f="purpose" placeholder="e.g. Props for the Symatics shoot" value="${esc(o.purpose || '')}">`, true)}
  <div class="ln-f wide ln-tax"><label><span>VAT (THB)</span><input class="input" type="number" step="0.01" min="0" data-f="vat_amount" placeholder="0.00" value="${Number(o.vat_amount) || ''}"></label>
  ${o.wht ? `<label><span>Withholding tax</span><select class="input" data-f="wht_rate">${[['', 'None'], ['1', '1%'], ['2', '2%'], ['3', '3%'], ['5', '5%']].map(([k, l]) => `<option value="${k}" ${(Number(o.wht_rate) || '') == k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label class="ln-top"><input type="checkbox" data-f="wht_on_top" ${o.wht_on_top ? 'checked' : ''}> Company pays the tax on top</label>` : ''}</div></div>`;
// FlowAccount accounts for company bills and card lines (not the staff expense categories)
const accLabel = (code) => (code ? (S.faAcc || []).find((a) => a.code === code)?.label || code : '');
const accCode = (v) => { const c = String(v || '').split(' / ')[0].trim(); return (S.faAcc || []).some((a) => a.code === c) ? c : null; };
const accOf = (x) => x.account_code || String(S.categories.find((c) => c.id === x.category_id)?.fa_code_bank || '').trim().split(/\s+/)[0] || null;
async function loadAcc() { if (!S.faAcc) S.faAcc = must(await sb.from('fa_accounts').select('code, label').like('code', '5%').order('code')); }
const accList = () => `<datalist id="faacc">${(S.faAcc || []).map((a) => `<option value="${esc(a.label)}">`).join('')}</datalist>`;
// Letter references: BILL2611A ... Z, AA. Sort by length first so AA comes after Z
const refLetter = (r) => String(r || '').replace(/^[A-Z]+\d{4}/, '');
const refSort = (a, b) => String(a || '~').length - String(b || '~').length || String(a || '~').localeCompare(String(b || '~'));
const PER = 15;
const pager = (n, pg, base) => { const pages = Math.ceil(n / PER); if (pages <= 1) return ''; const go = (k) => `${base}${base.includes('?') ? '&' : '?'}p=${k}`;
  return `<div class="ln-pg">${pg > 1 ? `<a class="btn small" href="${go(pg - 1)}">‹</a>` : '<span class="btn small" style="opacity:.35">‹</span>'}<span>${(pg - 1) * PER + 1} to ${Math.min(n, pg * PER)} of ${n}</span>${pg < pages ? `<a class="btn small" href="${go(pg + 1)}">›</a>` : '<span class="btn small" style="opacity:.35">›</span>'}</div>`; };
const pageOf = (arr, pg) => arr.slice((pg - 1) * PER, pg * PER);
const lnPill = (t, k) => `<span class="ln-p ${k}">${t}</span>`;
// Two people on the same line: save only if nobody changed it since this page loaded
const REV = {};
const keepRev = (rows) => { (rows || []).forEach((r) => { if (r && r.id && r.rev != null) REV[r.id] = r.rev; }); return rows; };
async function lineUpd(table, id, patch, reload) {
  let q = sb.from(table).update(patch).eq('id', id);
  if (REV[id] != null) q = q.eq('rev', REV[id]);
  const rows = must(await q.select('id, rev'));
  if (!rows.length) { setTimeout(reload, 0); throw new Error('Someone else changed this line just now. The page has been refreshed, check it and try again.'); }
  REV[id] = rows[0].rev;
}
// Match a shop or payee name to the FlowAccount supplier list (exact, else the only one sharing the first 2 words)
const vNorm = (v) => String(v || '').toLowerCase().replace(/\b(co|ltd|company|limited|part|mr|mrs|ms|miss|inc|www|com)\b\.?/g, ' ').replace(/(บริษัท|จำกัด|ห้างหุ้นส่วน|นางสาว|นาย|นาง)/g, ' ').replace(/[^a-z0-9\u0e00-\u0e7f ]/g, ' ').replace(/\s+/g, ' ').trim();
const guessVendor = (party) => { const p = vNorm(party); if (!p) return ''; const L = S.faVendors || [];
  const ex = L.filter((l) => vNorm(l) === p); if (ex.length === 1) return ex[0];
  const w = p.split(' ').slice(0, 2).join(' '), w1 = p.split(' ')[0];
  let hit = L.filter((l) => { const m = vNorm(l); return m && (m.startsWith(w) || p.startsWith(m.split(' ').slice(0, 2).join(' '))); });
  if (!hit.length && w1.length >= 4) hit = L.filter((l) => vNorm(l).split(' ')[0] === w1);
  return hit.length === 1 ? hit[0] : ''; };
// New supplier box, filled from the file: goes into the new suppliers file for FlowAccount
const newSupplier = (d) => new Promise((res) => {
  const t = /(co\.?,?\s*ltd|company|limited|inc\.?|corp|part|บริษัท|ห้างหุ้นส่วน|หจก|จำกัด)/i.test(d.name || '') ? 'Corporation' : 'Individual';
  const back = document.createElement('div'); back.className = 'modal-back';
  back.innerHTML = `<div class="modal narrow"><div class="modal-head"><h2>New supplier</h2><button class="btn ghost" data-x>Cancel</button></div><div class="modal-body"><div class="card-pad stack">
    <div class="faint" style="font-size:12px">Filled from the file. Check, then add. It goes to FlowAccount with this month's new suppliers file.</div>
    <div class="field"><label>Business name</label><input class="input" id="nvn" value="${esc(d.name || '')}"></div>
    <div class="field"><label>Type</label><select class="input" id="nvt"><option value="Corporation" ${t === 'Corporation' ? 'selected' : ''}>Company</option><option value="Individual" ${t === 'Individual' ? 'selected' : ''}>Person</option></select></div>
    <div class="field"><label>Tax ID</label><input class="input mono" id="nvi" value="${esc(d.tax_id || '')}" placeholder="10 or 13 digits"></div>
    <div class="field"><label>Address</label><textarea class="input" id="nva" rows="2">${esc(d.address || '')}</textarea></div>
    <div class="field"><label>Phone number</label><input class="input mono" id="nvp" value="${esc(d.phone || '')}"></div>
    <div class="error" id="nve"></div><button class="btn primary" id="nvk">Add supplier</button></div></div></div>`;
  document.body.appendChild(back);
  back.querySelector('[data-x]').onclick = () => { back.remove(); res(null); };
  back.querySelector('#nvk').onclick = async () => {
    const q = (k) => back.querySelector(k).value.trim(), name = q('#nvn'), tax = q('#nvi').replace(/\D/g, ''), err = back.querySelector('#nve');
    if (!name) { err.textContent = 'Enter the name.'; return; }
    if (tax && !/^(\d{10}|\d{13})$/.test(tax)) { err.textContent = 'Tax ID must be 10 or 13 digits, or leave it blank.'; return; }
    if (!S.faVendorSet.has(name.toLowerCase())) {
      const { error } = await sb.from('fa_new_vendors').insert({ name, business_type: q('#nvt'), tax_id: tax || null, address: q('#nva') || null, phone: q('#nvp') || null, created_by: S.user.id, created_by_name: S.profile.full_name });
      if (error && !/duplicate|unique/i.test(error.message)) { err.textContent = error.message; return; }
      S.faVendors.push(name); S.faVendorSet.add(name.toLowerCase());
    }
    back.remove(); res(name);
  };
});
// Month pages: one card per month, newest first; click a month to open it
async function pageMonths(kind) {
  const isCard = kind === 'card', base = isCard ? '#/card' : '#/bills';
  const cur = monthKey(new Date(new Date().getFullYear(), new Date().getMonth() - (isCard ? 1 : 0), 1));
  const M = {};
  const add = (mk) => (M[mk] = M[mk] || { n: 0, done: 0, t: 0, fa: 0, has: false, reading: false });
  add(cur);
  if (isCard) {
    const sts = must(await sb.from('card_statements').select('id, period_month, status'));
    const ch = sts.length ? must(await sb.from('card_charges').select('statement_id, amount, item_id, doc_path, no_doc, merchant, account_code, category_id, fa_done').in('statement_id', sts.map((x) => x.id))) : [];
    for (const st of sts) { const m = add(st.period_month.slice(0, 7)); m.has = true; if (st.status === 'reading') m.reading = true;
      for (const c of ch.filter((y) => y.statement_id === st.id)) { m.n++; m.t += Number(c.amount) || 0; if (c.item_id || ((c.doc_path || c.no_doc) && c.merchant && (c.account_code || c.category_id))) m.done++; if (c.fa_done || c.item_id) m.fa++; } }
  } else {
    const ps = must(await sb.from('kbiz_payments').select('period_month, merchant, category_id, account_code, no_doc, fa_done, kbiz_docs(kind, status, amount)').eq('admin_only', false));
    for (const p of ps) { const m = add(p.period_month.slice(0, 7)); m.has = true; const d = (k) => (p.kbiz_docs || []).find((x) => x.kind === k && x.status === 'ready');
      m.n++; m.t += Number((d('bill') || d('slip'))?.amount) || 0; if ((d('bill') || p.no_doc) && d('slip') && p.merchant && (p.category_id || p.account_code)) m.done++; if (p.fa_done) m.fa++; }
  }
  const keys = Object.keys(M).sort().reverse();
  const card = (mk) => { const m = M[mk]; const left = m.n - m.done;
    const status = m.reading ? lnPill('Reading…', '') : !m.has ? lnPill(isCard ? 'No statement yet' : 'Nothing uploaded yet', '') : left ? lnPill(`${left} to ${isCard ? 'find' : 'finish'}`, 'warn') : lnPill('Done', 'ok');
    return `<div class="card mo-card${m.has ? ' click' : ''}" ${m.has ? `data-href="${base}?m=${mk}"` : ''}><div class="card-pad">
      <div class="mo-top"><span class="mo-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg></span><b>${esc(monthLabel(mk))}</b>${status}</div>
      ${m.has ? `<div class="faint" style="font-size:13px;margin-top:6px">${m.n} line${m.n === 1 ? '' : 's'} · THB ${money(m.t)}${m.n && m.fa === m.n ? ' · in FlowAccount' : m.fa ? ` · ${m.fa} in FlowAccount` : ''}</div><div class="cc-bar" style="margin:8px 0 0"><div style="width:${m.n ? Math.round((m.done / m.n) * 100) : 0}%"></div></div>` : `<div style="margin-top:10px"><a class="btn small primary" href="${base}?m=${mk}">${isCard ? 'Upload statement' : 'Upload bills and slips'}</a></div>`}
    </div></div>`; };
  shell(`<div class="page-head"><div><h1>${isCard ? 'Card payments' : 'Bank transfers'}</h1><p>${isCard ? 'Company card, one statement a month. Pick a month.' : 'Bills and K BIZ slips for transfers. Pick a month.'}</p></div>
    <div class="row"><a class="btn primary" href="${base}?m=${cur}">${isCard ? 'Upload statement' : 'Upload bills and slips'}</a></div></div>
    <div class="mo-grid">${keys.map(card).join('')}</div>`);
  bindRowLinks();
}
// No invoice: pick a reason (Other lets you write one)
const NOINV = ['Supplier does not issue receipts', 'Receipt lost', 'Online service, invoice not available', 'Bank fee or interest', 'Foreign shop, no Thai tax invoice'];
const askNoInv = () => new Promise((res) => {
  const back = document.createElement('div'); back.className = 'modal-back';
  back.innerHTML = `<div class="modal narrow"><div class="modal-head"><h2>No invoice for this line</h2><button class="btn ghost" data-x>Cancel</button></div><div class="modal-body"><div class="card-pad stack">
    <div class="field"><label>Why is there no invoice?</label><select class="input" id="nis"><option value="">Choose a reason…</option>${NOINV.map((r) => `<option>${r}</option>`).join('')}<option value="other">Other</option></select></div>
    <div class="field" id="nio" hidden><label>Reason</label><input class="input" id="nir" maxlength="120"></div>
    <span class="hint">The line then only needs a supplier and category. The PPP print shows "No invoice" with this reason.</span>
    <div class="error" id="nie"></div><button class="btn primary" id="nik">Save</button></div></div></div>`;
  document.body.appendChild(back);
  const sel = back.querySelector('#nis');
  sel.onchange = () => { back.querySelector('#nio').hidden = sel.value !== 'other'; if (sel.value === 'other') back.querySelector('#nir').focus(); };
  back.querySelector('[data-x]').onclick = () => { back.remove(); res(null); };
  back.querySelector('#nik').onclick = () => { const v = sel.value === 'other' ? back.querySelector('#nir').value.trim() : sel.value; if (!v) { back.querySelector('#nie').textContent = sel.value === 'other' ? 'Write the reason first.' : 'Choose a reason first.'; return; } back.remove(); res(v); };
});
// Subscriptions: same shop on the statement every month
const subKey = (d) => String(d || '').toUpperCase().split('*')[0].replace(/[^A-Z]+/g, ' ').trim();
async function subsReview(st, charges, subs) {
  const prevSt = must(await sb.from('card_statements').select('id, period_month').lt('period_month', st.period_month).eq('status', 'ready').order('period_month', { ascending: false }).limit(1))[0];
  const prev = prevSt ? must(await sb.from('card_charges').select('description, amount').eq('statement_id', prevSt.id)) : [];
  const sum = (arr, k) => arr.filter((c) => subKey(c.description) === k).reduce((a, c) => a + Number(c.amount || 0), 0);
  const cnt = (arr, k) => arr.filter((c) => subKey(c.description) === k).length;
  const mine = subs.filter((x) => cnt(charges, x.match_key));
  const total = mine.reduce((a, x) => a + sum(charges, x.match_key), 0);
  const isNew = [...new Set(charges.map((c) => subKey(c.description)))].filter((k) => !subs.some((x) => x.match_key === k) && prev.some((c) => subKey(c.description) === k)).map((k) => charges.find((c) => subKey(c.description) === k).description);
  const more = mine.filter((x) => prev.length && cnt(charges, x.match_key) > Math.max(1, cnt(prev, x.match_key))).map((x) => x.name);
  const up = mine.filter((x) => { const a = sum(charges, x.match_key), b = sum(prev, x.match_key); return b && cnt(charges, x.match_key) === cnt(prev, x.match_key) && a > b * 1.05; }).map((x) => `${x.name} ${money(sum(prev, x.match_key))} to ${money(sum(charges, x.match_key))}`);
  if (!mine.length && !isNew.length) return;
  const body = [`Subscriptions on the ${monthLabel(st.period_month.slice(0, 7))} card statement: ${mine.length}, THB ${money(total)}.`, isNew.length ? `Also charged last month, not set as a subscription: ${isNew.join(', ')}.` : '', more.length ? `Charged more times than last month: ${more.join(', ')}.` : '', up.length ? `Went up: ${up.join(', ')}.` : '', 'Still needed? Review'].filter(Boolean).join(' ');
  await sb.rpc('notify_subs_review', { p_statement: st.id, p_body: body });
}
// Subscriptions: set up once (added by themselves), then the page only asks when something changed
const SUB_CANCEL = [
  [/SPOTIFY/i, 'https://www.spotify.com/account/subscription/'],
  [/APPLE\.COM|ITUNES/i, 'https://apps.apple.com/account/subscriptions'],
  [/APPLE MUSIC|GOOGLE ?PLAY|YOUTUBE/i, 'https://play.google.com/store/account/subscriptions'],
  [/GOOGLE/i, 'https://admin.google.com/ac/billing/subscriptions'],
  [/OPENAI|CHATGPT/i, 'https://chatgpt.com/#settings/Subscription'],
  [/NETLIFY/i, 'https://app.netlify.com/teams'],
  [/HEYGEN/i, 'https://app.heygen.com/settings'],
  [/ADOBE/i, 'https://account.adobe.com/plans'],
  [/CANVA/i, 'https://www.canva.com/settings/billing-and-teams'],
  [/DROPBOX/i, 'https://www.dropbox.com/account/plan'],
  [/MICROSOFT|MSFT/i, 'https://account.microsoft.com/services'],
  [/ZOOM/i, 'https://zoom.us/billing'],
  [/NETFLIX/i, 'https://www.netflix.com/cancelplan'],
  [/ANTHROPIC|CLAUDE/i, 'https://claude.ai/settings/billing'],
];
const subNice = (d) => String(d || '').replace(/\*.*$/, '').replace(/\s+\d[\d\s-]*$/, '').replace(/\.COM.*$/i, '').replace(/\s+(INC|LLC|LTD|TECHNOLOGY)\.?\b.*$/i, '').trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
async function pageSubs() {
  let all = must(await sb.from('subscriptions').select('*').order('name'));
  const sts = must(await sb.from('card_statements').select('id, period_month').eq('status', 'ready').order('period_month', { ascending: false }).limit(2));
  const [cur, prv] = await Promise.all(sts.map((x) => sb.from('card_charges').select('description, place, amount, currency, foreign_amount, trans_date, doc_path, no_doc').eq('statement_id', x.id).then(must)));
  const C = cur || [], PV = prv || [];
  const mk = sts[0]?.period_month.slice(0, 7);
  const of = (arr, k) => arr.filter((c) => subKey(c.description) === k);
  const subCat = (S.categories || []).find((k) => k.active && /subscription/i.test(k.name))?.id || null;
  // New subscriptions add themselves: charged 2 months in a row, or a clear subscription name
  const SUBRX = /SUBSCR|NETLIFY|SPOTIFY|OPENAI|CHATGPT|APPLE\.COM|GOOGLE|ADOBE|CANVA|HEYGEN|NOTION|ZOOM|DROPBOX|MICROSOFT|YOUTUBE|NETFLIX|ICLOUD|ANTHROPIC/i;
  const seen = new Set(all.map((x) => x.match_key));
  const fresh = [...new Set(C.map((c) => subKey(c.description)))].filter((k) => k && !seen.has(k) && (of(PV, k).length || of(C, k).some((c) => SUBRX.test(`${c.description} ${c.place || ''}`)))).map((k) => of(C, k)[0]);
  if (fresh.length && !pageSubs.adding) {
    pageSubs.adding = true;
    try {
      for (const c of fresh) {
        const txt = `${c.description} ${c.place || ''}`, url = (SUB_CANCEL.find(([re]) => re.test(txt)) || [])[1] || null;
        await sb.from('subscriptions').upsert({ match_key: subKey(c.description), name: subNice(c.description), merchant: guessVendor(c.description) || null, category_id: subCat, cancel_url: url, cancel_auto: true, active: true }, { onConflict: 'match_key' });
      }
      toast(`${fresh.length} new subscription${fresh.length === 1 ? '' : 's'} added. Use "Not a subscription" if one is wrong.`);
    } finally { pageSubs.adding = false; }
    all = must(await sb.from('subscriptions').select('*').order('name'));
  }
  const subs = all.filter((x) => x.active);
  for (const x of subs) if (x.cancel_url && !/^https?:\/\//i.test(x.cancel_url)) x.cancel_url = null;
  for (const x of subs) if (!x.cancel_url) { const c = of(C, x.match_key)[0] || of(PV, x.match_key)[0]; const u = (SUB_CANCEL.find(([re]) => re.test(`${c?.description || x.match_key} ${c?.place || ''}`)) || [])[1]; if (u) { x.cancel_url = u; x.cancel_auto = true; sb.from('subscriptions').update({ cancel_url: u, cancel_auto: true }).eq('id', x.id).then(() => {}); } }
  // Look up cancel pages for the ones not on the built-in list (once each)
  const noUrl = subs.filter((x) => !x.cancel_url && !(pageSubs.tried || (pageSubs.tried = new Set())).has(x.id));
  if (noUrl.length) { noUrl.forEach((x) => pageSubs.tried.add(x.id)); (async () => { let got = 0; for (const x of noUrl) { const c = of(C, x.match_key)[0] || of(PV, x.match_key)[0]; const { data } = await sb.functions.invoke('bo-find-cancel', { body: { shop: c?.description || x.name, place: c?.place || '' } }); if (data?.url) { got++; await sb.from('subscriptions').update({ cancel_url: data.url, cancel_auto: true }).eq('id', x.id); } } if (got && location.hash.startsWith('#/subs')) pageSubs(); })(); }
  const per = (x) => of(C, x.match_key).reduce((a, c) => a + Number(c.amount || 0), 0) || of(PV, x.match_key).reduce((a, c) => a + Number(c.amount || 0), 0);
  const total = subs.reduce((a, x) => a + per(x), 0);
  const issue = (x) => { const a = of(C, x.match_key), b = of(PV, x.match_key);
    if (x.ack_month === mk) return null;
    if (!a.length) return ['Not charged', 'OK', 'ack'];
    if (b.length && a.length > b.length) return [`Charged ${a.length}×`, 'OK', 'ack'];
    const sa = a.reduce((q, c) => q + Number(c.amount), 0), sb2 = b.reduce((q, c) => q + Number(c.amount), 0);
    if (sb2 && a.length === b.length && sa > sb2 * 1.05) return [`Price up, was ${money(sb2)}`, 'OK', 'ack'];
    if (!x.no_invoice && a.some((c) => !c.doc_path && !c.no_doc)) return ['Invoice missing', 'Upload', 'card'];
    return null; };
  const when = (c) => (c ? new Date(`${c.trans_date}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '-');
  const det = (x) => `<div class="nv-g" data-sb="${x.id}">
        <label><span>Name</span><input class="input" data-k="name" value="${esc(x.name)}"></label>
        <label><span>What it is for</span><input class="input" data-k="purpose" value="${esc(x.purpose || '')}" placeholder="Back office hosting"></label>
        <label><span>Used by</span><input class="input" data-k="used_by" value="${esc(x.used_by || '')}" placeholder="Team"></label>
        <label><span>Invoice</span><select class="input" data-k="no_invoice"><option value="0" ${x.no_invoice ? '' : 'selected'}>Upload each month</option><option value="1" ${x.no_invoice ? 'selected' : ''}>No invoice</option></select></label>
        <label><span>Cancel link${x.cancel_url && x.cancel_auto ? ' <em class="faint">(found for you)</em>' : ''}</span><input class="input" data-k="cancel_url" value="${esc(x.cancel_url || '')}" placeholder="${pageSubs.tried?.has(x.id) ? 'Not found, paste the link' : 'Looking it up…'}"></label>
      </div>
      <div class="nv-f"><span class="faint" style="font-size:12px;margin-right:auto">Shop on the statement: ${esc(x.match_key)}</span><button class="btn ghost small danger" data-stop="${x.id}">Not a subscription</button><button class="btn small primary" data-sbs="${x.id}">Save</button></div>`;
  const line = (x, right) => { const a = of(C, x.match_key), last = a[a.length - 1] || of(PV, x.match_key).slice(-1)[0];
    return `<details class="nv-row sb-row"><summary class="nv-s"><b>${esc(x.name)}</b><span class="faint">${[x.purpose, last?.currency && last.currency !== 'THB' && last.foreign_amount ? `${last.currency} ${money(last.foreign_amount)}` : '', when(last)].filter(Boolean).map(esc).join(' · ')}</span>
      <span class="num" style="margin-left:auto">${money(per(x))}</span>${right}${x.cancel_url ? `<a class="btn ghost small" href="${esc(x.cancel_url)}" target="_blank" rel="noopener" data-cx>Cancel subscription ›</a>` : ''}<span class="ln-chev">›</span></summary>${det(x)}</details>`; };
  const look = subs.filter(issue), good = subs.filter((x) => !issue(x));
  shell(`<div class="page-head"><div><h1>Subscriptions</h1><p>What the company card pays every month${mk ? ` · from the ${esc(monthLabel(mk))} statement` : ''}</p></div></div>
    <div class="mc-mets"><div><small>Every month</small><b>${money(total)}</b><small>THB, ${subs.length} subscription${subs.length === 1 ? '' : 's'}</small></div><div><small>Every year</small><b>${money(total * 12)}</b><small>THB at this month's rate</small></div></div>
    ${look.length ? `<div class="card" style="margin-bottom:12px"><div class="card-head"><h2>Needs a look</h2><span class="faint" style="font-size:12px">Only when something changed</span></div><div class="nv-list" style="border:0">${look.map((x) => { const i = issue(x); return line(x, `<span class="ln-p warn">${esc(i[0])}</span>${i[2] === 'ack' ? `<button class="btn small" data-ack="${x.id}">${i[1]}</button>` : `<a class="btn small" href="#/card?m=${mk}">${i[1]}</a>`}`); }).join('')}</div></div>` : ''}
    <div class="card"><div class="card-head"><h2>All good</h2><span class="faint" style="font-size:12px">Nothing to do</span></div><div class="nv-list" style="border:0">${good.map((x) => line(x, '<span class="ln-p ok">Done</span>')).join('') || '<div class="faint" style="padding:16px">Subscriptions add themselves when a card statement is read.</div>'}</div></div>
    <p class="faint" style="font-size:12px">New subscriptions on the card statement add themselves, with supplier, category and cancel link. Their charges fill themselves in on Card payments.</p>`);
  main().querySelectorAll('[data-ack]').forEach((b) => (b.onclick = async (e) => { e.preventDefault(); e.stopPropagation(); try { await run(async () => must(await sb.from('subscriptions').update({ ack_month: mk }).eq('id', b.dataset.ack)), 'OK'); } catch { return; } pageSubs(); }));
  main().querySelectorAll('.sb-row a.btn, [data-cx]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  main().querySelectorAll('[data-sbs]').forEach((b) => (b.onclick = async () => { const g = main().querySelector(`[data-sb="${b.dataset.sbs}"]`), v = (k) => g.querySelector(`[data-k="${k}"]`).value.trim();
    try { await run(async () => must(await sb.from('subscriptions').update({ name: v('name') || 'Subscription', purpose: v('purpose') || null, used_by: v('used_by') || null, no_invoice: v('no_invoice') === '1', cancel_url: v('cancel_url') || null, cancel_auto: false }).eq('id', b.dataset.sbs)), 'Saved'); } catch { return; } pageSubs(); }));
  main().querySelectorAll('[data-stop]').forEach((b) => (b.onclick = async (e) => { if (!confirmInline(e.target, 'Not a subscription? It will not be added again.')) return; try { await run(async () => must(await sb.from('subscriptions').update({ active: false, dismissed: true }).eq('id', b.dataset.stop)), 'Removed. It will not be suggested again.'); } catch { return; } pageSubs(); }));
}
// Delete with Undo: the row disappears now, the real delete runs after a few seconds unless Undo is pressed
function laterDelete(msg, doIt, undo) {
  const t = document.getElementById('toast'); let gone = false;
  t.className = ''; t.hidden = false;
  t.innerHTML = `${esc(msg)} <button class="btn small" id="undo" style="margin-left:10px;background:#fff;color:var(--ink)">Undo</button>`;
  clearTimeout(toastTimer); clearTimeout(undoTimer);
  const go = async () => { if (gone) return; gone = true; t.hidden = true; window.removeEventListener('beforeunload', go); try { await doIt(); } catch (e) { toast(friendly(e), true); } };
  undoTimer = setTimeout(go, 7000);
  window.addEventListener('beforeunload', go);
  document.getElementById('undo').onclick = () => { if (gone) return; gone = true; clearTimeout(undoTimer); window.removeEventListener('beforeunload', go); t.hidden = true; undo(); toast('Restored'); };
}
async function pageCard() {
  if (!params().m) return pageMonths('card');
  const months = must(await sb.from('card_statements').select('*').order('period_month', { ascending: false }));
  const want = params().m;
  const st = months.find((x) => x.period_month.slice(0, 7) === want) || null;
  const charges = keepRev(st ? must(await sb.from('card_charges').select('*').eq('statement_id', st.id).order('trans_date')) : []);
  const itemIds = charges.filter((c) => c.item_id).map((c) => c.item_id);
  const items = itemIds.length ? must(await sb.from('expense_items').select('id, item, merchant, amount, invoice_date, report_id, purpose').in('id', itemIds)) : [];
  const staff = must(await sb.from('profiles').select('id, full_name').eq('active', true).order('full_name'));
  const sugg = st && st.status === 'ready' ? ((await sb.rpc('card_suggestions', { p_statement: st.id })).data || []) : [];
  const unm = st && st.status === 'ready' ? ((await sb.rpc('card_unmatched', { p_statement: st.id })).data || []) : [];
  const name = (id) => staff.find((x) => x.id === id)?.full_name || '';
  if (!S.faVendors) await loadFAVendors();
  await loadAcc();
  const subs = must(await sb.from('subscriptions').select('*').eq('active', true));
  const nk = (n) => String(n || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  const nvSet = new Set(((await sb.from('fa_new_vendors').select('name')).data || []).map((x) => nk(x.name)));
  const knownSup = (m) => !!m && (S.faVendorSet.has(m.toLowerCase()) || nvSet.has(nk(m)));
  const subOf = (c) => subs.find((x) => x.match_key === subKey(c.description));
  // Known subscriptions fill themselves in (supplier, category, purpose; Done when no invoice is needed)
  const subCat = (S.categories || []).find((k) => k.active && /subscription/i.test(k.name))?.id || null;
  const subPatch = (c) => { const x = subOf(c); if (!x || c.item_id || c.fa_done) return null; const p = {};
    const mer = x.merchant || guessVendor(c.description) || guessVendor(x.name);
    if (!c.merchant && mer) p.merchant = mer;
    if (!c.category_id && (x.category_id || subCat)) p.category_id = x.category_id || subCat;
    if (!c.purpose && (x.purpose || x.name)) p.purpose = x.purpose || x.name;
    if (x.no_invoice && !c.doc_path && !c.no_doc) Object.assign(p, { no_doc: true, no_doc_reason: x.no_doc_reason || 'Online service, invoice not available' });
    return Object.keys(p).length ? p : null; };
  for (const x of subs) if (!x.category_id && subCat) { x.category_id = subCat; sb.from('subscriptions').update({ category_id: subCat }).eq('id', x.id).then(() => {}); }
  // Same shop on the statement again: copy supplier, category and purpose from the line already saved
  const sibPatch = (c) => { if (c.item_id || c.fa_done || (c.merchant && c.category_id)) return null; const k = subKey(c.description);
    const z = charges.find((q) => q.id !== c.id && q.merchant && q.category_id && subKey(q.description) === k); if (!z) return null;
    const p = {}; if (!c.merchant) p.merchant = z.merchant; if (!c.category_id) p.category_id = z.category_id; if (!c.purpose && z.purpose) p.purpose = z.purpose; return p; };
  const subPatch0 = subPatch;
  const fillP = (c) => subPatch0(c) || sibPatch(c);
  const fill = charges.filter((c) => fillP(c));
  if (fill.length && !pageCard.filling) {
    pageCard.filling = true;
    try { for (const c of fill) await sb.from('card_charges').update(fillP(c)).eq('id', c.id); } finally { pageCard.filling = false; }
    pageCard.filled = (pageCard.filled || 0) + 1; if (pageCard.filled < 3) return pageCard();
  }
  pageCard.filled = 0;
  if (st && st.status === 'ready' && !st.subs_notified_at && charges.length) subsReview(st, charges, subs);
  const needsDet = (c) => (c.doc_path || c.no_doc) && !c.item_id && (!c.merchant || !(c.account_code || c.category_id));
  const done = (c) => c.item_id || ((c.doc_path || c.no_doc) && !needsDet(c));
  const open = charges.filter((c) => !done(c)), ok = charges.filter(done);
  if (st && !pageCard.numbered && ok.some((c) => !c.item_id && !c.fa_ref)) { pageCard.numbered = true; await sb.rpc('assign_fa_refs', { p_month: st.period_month.slice(0, 7) + '-01' }); return pageCard(); }
  pageCard.numbered = false;
  const cpg = Math.min(Math.max(1, Number(params().p) || 1), Math.max(1, Math.ceil(open.length / PER)));
  const when = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const ago = (t) => { const d = Math.floor((Date.now() - new Date(t)) / 86400000); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`; };
  const sub = (c) => `${c.fa_ref ? `<b class="ln-ref">${esc(c.fa_ref)}</b> · ` : ''}${when(c.trans_date)}${c.currency && c.foreign_amount ? ` · ${esc(c.currency)} ${money(c.foreign_amount)}` : ''}${c.place ? ` · ${esc(c.place)}` : ''}`;
  const PB = { own_money: 'Me', cash_advance: 'Petty cash', kbiz: 'KBIZ' };
  const cats = S.categories.filter((x) => x.active);
  const shopName = (d) => String(d || '').replace(/\*.*$/, '').replace(/\s+\d[\d\s-]*$/, '').replace(/\.COM.*$/i, '').trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  const catByName = (re) => cats.find((k) => re.test(k.name))?.id || '';
  const guessCat = (c, mer) => { const last = charges.find((q) => q.id !== c.id && q.merchant && q.merchant === mer && q.category_id); if (last) return last.category_id;
    const d = `${c.description} ${c.place || ''}`.toUpperCase();
    if (/INTEREST|FEE|CHARGE/.test(d)) return catByName(/bank/i);
    if (/GRAB|BOLT|TAXI|AIR|AIRASIA|THAI ?AIR|TRAIN|BTS|MRT|PARKING|PTT|SHELL|ESSO|FUEL/.test(d)) return catByName(/transport/i);
    if (/CAFE|COFFEE|RESTAUR|FOOD|KITCHEN|BAR\b|7-ELEVEN|STARBUCKS|MK |PIZZA|BAKERY/.test(d)) return catByName(/food/i);
    if (/NETLIFY|GOOGLE|APPLE|SPOTIFY|OPENAI|ADOBE|CANVA|HEYGEN|MICROSOFT|ZOOM|DROPBOX|SUBSCR/.test(d)) return catByName(/subscr/i);
    if (/TRUE|AIS|DTAC|3BB|ELECTRIC|WATER|PEA\b|MEA\b/.test(d)) return catByName(/utilit/i);
    return catByName(/misc/i); };
  const sugg2 = (c) => { const mer = c.merchant || guessVendor(c.description) || shopName(c.description); return { mer, isNew: !!mer && !S.faVendorSet.has(mer.toLowerCase()), cat: c.category_id || guessCat(c, mer), guessed: !c.category_id || !c.merchant }; };
  const detForm = (c) => `<div class="cc-det" data-det="${c.id}"><div class="ln-chips">${c.no_doc ? `<span class="ln-c">${c.no_doc_reason ? 'No invoice: ' + esc(c.no_doc_reason) : 'Bank charge, no receipt needed'}</span>` : `<button type="button" class="ln-c ok" data-view="${esc(c.doc_path)}">✓ ${esc(c.doc_name || 'File')}</button>`}</div>
    ${(() => { const g = sugg2(c); return `${g.guessed ? `<div class="cc-sg">Filled in for you${g.isNew ? `: <b>${esc(g.mer)}</b> is a new supplier, its details are completed in Month close` : ''}. Check and press Save to confirm.</div>` : ''}<div style="text-align:right;margin:-2px 0 4px" data-ccnw="${c.id}" ${knownSup(g.mer) ? 'hidden' : ''}><button type="button" class="btn ghost small" data-ccnew="${c.id}">+ New supplier</button></div>${lnForm({ list: 'ccv', cats, merchant: g.mer, category_id: g.cat, purpose: c.purpose, vat_amount: c.vat_amount })}`; })()}
    <label class="ln-top" style="display:flex;gap:6px;align-items:center;font-size:13px;margin:8px 0 0"><input type="checkbox" data-f="is_sub" ${subOf(c) ? 'checked' : ''}> Monthly subscription (next months fill in by themselves)</label>
    <div class="ln-foot">${c.doc_path ? `<button class="btn ghost small ln-del" data-undo="${c.id}">Remove file</button>` : c.no_doc_reason ? `<button class="btn ghost small" data-inv="${c.id}">There is an invoice</button>` : '<span></span>'}<button class="btn primary small" data-save="${c.id}">Save</button></div></div>`;
  const row = (c) => { if (needsDet(c)) return `<div class="cc-r ln-row" data-cc="${c.id}" style="display:block"><button type="button" class="ln-sum" data-tog><span class="ln-d">${esc(when(c.trans_date))}</span><span class="ln-t"><b>${esc(c.merchant || c.description)}</b><small>${c.fa_ref ? `<b class="ln-ref">${esc(c.fa_ref)}</b> · ` : ''}${esc(c.purpose || c.description)}</small></span><span class="ln-fs"><span class="ln-ft ${c.doc_path || c.no_doc ? 'ok' : ''}">${c.no_doc ? (c.no_doc_reason ? 'No invoice' : 'Bank charge') : 'File'}</span></span><span class="cc-n">${money(c.amount)}</span><span>${lnPill('Needs details', 'warn')}</span><span class="ln-chev">›</span></button><div class="ln-body" hidden>${detForm(c)}</div></div>`;
    const g = sugg.find((x) => x.charge_id === c.id);
    return `<div class="cc-r" data-cc="${c.id}"><div class="cc-m"><b>${esc(c.description)}</b>${subOf(c) ? ' <a class="ln-p gr" href="#/subs" style="font-size:11px">Subscription</a>' : ''}<small>${sub(c)}</small>${c.note ? `<small class="cc-note">Note: ${esc(c.note)}</small>` : ''}${g ? `<div class="cc-sg">Possible match: ${esc(g.staff_name)}'s receipt ${esc(g.item_label || '')}, saved as ${esc(PB[g.paid_by] || g.paid_by)} <button class="btn small" data-sg="${c.id}" data-it="${g.item_id}">Switch to Company card and match</button></div>` : ''}</div>
    <div class="cc-a"><span class="cc-n">${money(c.amount)}</span><button class="btn ghost small" data-note="${c.id}">Note</button><label class="btn small">Upload invoice<input type="file" hidden multiple accept="image/*,application/pdf" data-add="${c.id}"></label><button class="btn ghost small" data-noinv="${c.id}">No invoice</button></div></div>`; };
  const okRow = (c) => { const it = items.find((x) => x.id === c.item_id); const how = it ? `Staff receipt: ${esc(it.merchant || it.item || '')}${it.purpose ? ' · ' + esc(it.purpose) : ''}` : `${esc(c.merchant || '')}${c.purpose ? ' · ' + esc(c.purpose) : ''} · file ${esc(c.doc_name || '')}${c.fa_done ? ' · in FlowAccount' : ''}`;
    return `<div class="cc-r cc-ok"><div class="cc-m"><b>${esc(c.description)}</b><small>${sub(c)} · ${how}</small></div><div class="cc-a"><span class="cc-n">${money(c.amount)}</span>${(c.doc_path || c.no_doc) && !c.item_id && !c.fa_done ? `<button class="btn ghost small" data-edit="${c.id}">Edit</button>` : ''}</div>${(c.doc_path || c.no_doc) && !c.item_id && !c.fa_done ? `<div class="ln-body" data-edb="${c.id}" hidden style="flex-basis:100%">${detForm(c)}</div>` : ''}</div>`; };
  const monthSel = `<a class="btn ghost" href="#/card">‹ All months</a>`;
  shell(`<div class="page-head"><div><h1>Card payments · ${esc(monthLabel(want))}</h1>
    <p>${st && st.status === 'ready' ? `${ok.length} of ${charges.length} done · ${open.length ? `<span class="error" style="display:inline">${open.length} to find</span>` : 'nothing to find'}` : 'Upload the monthly company card statement (PDF). Each charge is matched to a staff receipt marked Company card.'}</p></div>
    <div class="row">${st && st.status === 'ready' ? `<a class="btn" href="#/sheet/card?m=${st.period_month.slice(0, 7)}">Print for PPP</a>` : ''}${monthSel}${st && !charges.length ? '<button class="btn ghost" id="ccdel">Delete statement</button>' : ''}<label class="btn primary">${st ? 'Replace statement' : 'Upload statement'}<input type="file" hidden accept="application/pdf,image/*" id="ccup"></label></div></div>
    ${st && st.status === 'reading' ? '<div class="banner info">Reading the statement… this takes about a minute. The page refreshes when it is done.</div>' : ''}
    ${st && st.status === 'failed' ? `<div class="banner bad">Could not read this statement: ${esc(st.error || '')}. Try uploading it again.</div>` : ''}
    ${st && st.status === 'ready' && open.length ? `<label class="sb-drop" id="ccdrop"><input type="file" hidden multiple accept="image/*,application/pdf" id="ccmany"><b>Drop invoices here</b><span>Many at once. Each one is read and placed on its charge by amount, date and shop name, with the supplier and category filled in.</span></label><div id="ccprog"></div>` : ''}
    <datalist id="ccv">${(S.faVendors || []).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
    ${charges.length ? `<div class="cc-bar"><div style="width:${Math.round((ok.length / charges.length) * 100)}%"></div></div>
    <div class="card"><div class="card-pad" style="padding-top:4px">${pageOf(open, cpg).map(row).join('') || '<div class="faint" style="padding:12px 0">Every charge has its document.</div>'}${pager(open.length, cpg, '#/card' + (st ? '?m=' + st.period_month.slice(0, 7) : ''))}
      ${ok.length ? `<details class="cc-done"><summary>${ok.length} done</summary>${ok.map(okRow).join('')}</details>` : ''}</div></div>
    ${unm.length ? (() => { const m0 = st.period_month, mEnd = iso(new Date(new Date(`${m0}T00:00:00`).getFullYear(), new Date(`${m0}T00:00:00`).getMonth() + 1, 0)), late = iso(new Date(new Date(`${mEnd}T00:00:00`).getTime() - 4 * 86400000));
      return `<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>${unm.length} Company card receipt${unm.length > 1 ? 's' : ''} not on this statement</h2><div class="faint" style="font-size:12px">Staff chose Company card, but no charge matches. Most often it was paid with their own money by mistake.</div></div></div><div class="card-pad" style="padding-top:4px">
      ${unm.map((u) => `<div class="cc-r"><div class="cc-m"><b>${esc(u.staff_name)} · ${esc(u.item_label || '')}</b><small>${when(u.invoice_date)} · ${esc(u.report_ref || '')}${u.purpose ? ' · ' + esc(u.purpose) : ''}</small>${u.invoice_date < m0 ? '<div class="cc-tag bad">From an earlier month, still not on a statement</div>' : u.invoice_date >= late ? '<div class="cc-tag">End of month: may be on next month\'s statement</div>' : ''}</div>
        <div class="cc-a"><span class="cc-n">${money(u.amount)}</span><select class="input" data-mm="${u.item_id}" style="width:auto;font-size:12px;padding:3px 6px"><option value="">Match to a line</option>${open.map((c) => `<option value="${c.id}">${esc(c.description.slice(0, 28))} · ${money(c.amount)}</option>`).join('')}</select><button class="btn small" data-nc="${u.item_id}">Not the company card</button></div></div>`).join('')}
      </div></div>`; })() : ''}
    <p class="faint" style="font-size:12px">${st ? '<button class="btn ghost small" id="ccdel" style="float:right">Delete statement</button>' : ''}Drop a file on a line to attach it. Staff receipts with Who paid: Company card are matched by amount and date. Payments to the card are not listed.</p>` : ''}`);
  const del = document.getElementById('ccdel');
  if (del) del.onclick = () => {
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal narrow"><div class="modal-head"><h2>Delete this statement?</h2><button class="btn ghost" data-x>Cancel</button></div><div class="modal-body"><div class="card-pad stack">
      <p style="margin:0">${esc(monthLabel(st.period_month.slice(0, 7)))} · ${esc(st.file_name || 'statement')}. All ${charges.length} lines and any files attached to them on this page are removed. Staff receipts are not touched.</p>
      <button class="btn danger" id="ccdelok">Delete statement</button><div class="error" id="ccdelerr"></div></div></div></div>`;
    document.body.appendChild(back);
    back.querySelectorAll('[data-x]').forEach((x) => (x.onclick = () => back.remove()));
    back.querySelector('#ccdelok').onclick = () => {
      const paths = [st.file_path, ...charges.map((c) => c.doc_path).filter(Boolean)];
      back.remove(); main().innerHTML = '<div class="card card-pad faint" style="margin-top:20px">Statement deleted. Press Undo to bring it back.</div>';
      laterDelete('Statement deleted.', async () => { must(await sb.from('card_statements').delete().eq('id', st.id)); await sb.storage.from(BUCKET).remove(paths); if (location.hash.startsWith('#/card')) location.hash = '#/card'; }, () => pageCard());
    };
  };
  const ms = document.getElementById('ccm'); if (ms) ms.onchange = (e) => { location.hash = '#/card?m=' + e.target.value; };
  document.getElementById('ccup').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = '';
    const mk = await new Promise((res) => {
      const back = document.createElement('div'); back.className = 'modal-back';
      const def = want || monthKey(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));
      back.innerHTML = `<div class="modal narrow"><div class="modal-head"><h2>Which month is this statement for?</h2><button class="btn ghost" data-x>Cancel</button></div><div class="modal-body"><div class="card-pad stack"><div class="faint" style="font-size:13px">${esc(f.name)}</div><input class="input" type="month" id="ccmk" value="${def}"><button class="btn primary" id="ccgo">Read statement</button></div></div></div>`;
      document.body.appendChild(back);
      back.querySelector('[data-x]').onclick = () => { back.remove(); res(null); };
      back.querySelector('#ccgo').onclick = () => { const v = back.querySelector('#ccmk').value; back.remove(); res(/^\d{4}-\d{2}$/.test(v) ? v : null); };
    });
    if (!mk) return;
    try {
      await run(async () => {
        const path = `${S.user.id}/card/${mk}-${Date.now()}.${f.type === 'application/pdf' ? 'pdf' : 'jpg'}`;
        must(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/pdf' }));
        const old = months.find((x) => x.period_month.slice(0, 7) === mk);
        const row = old ? must(await sb.from('card_statements').update({ file_path: path, file_name: f.name, status: 'reading', error: null }).eq('id', old.id).select().single())
          : must(await sb.from('card_statements').insert({ period_month: mk + '-01', file_path: path, file_name: f.name }).select().single());
        location.hash = '#/card?m=' + mk; pageCard();
        const { error } = await sb.functions.invoke('bo-card-statement', { body: { statement_id: row.id } });
        if (error) throw error;
        await sb.rpc('match_card_charges', { p_statement: row.id });
      }, 'Statement read');
    } catch { /* shown */ }
    pageCard();
  };
  if (st && st.status === 'ready' && open.length) { sb.rpc('match_card_charges', { p_statement: st.id }).then(({ data }) => { if (data > 0) pageCard(); }); }
  const attach = async (id, f) => {
    try { await run(async () => {
      const path = `${S.user.id}/card/doc-${id}-${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_')}`;
      must(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream' }));
      await lineUpd('card_charges', id, { doc_path: path, doc_name: f.name }, pageCard);
    }, 'File attached'); } catch { return; }
    pageCard();
  };
  // Many invoices at once: read each, place it on its charge, fill supplier and category from last time
  const batchCard = async (fs) => {
    const prog = document.getElementById('ccprog'); const free = open.filter((c) => !c.doc_path && !c.no_doc); const placed = [], left = [];
    const allCh = must(await sb.from('card_charges').select('merchant, category_id').not('category_id', 'is', null).order('created_at', { ascending: false }));
    let n = 0;
    for (const f of fs) {
      n++; if (prog) prog.innerHTML = `<div class="banner info" style="margin:10px 0">Reading ${n} of ${fs.length}… keep this page open.</div>`;
      try {
        const path = `${S.user.id}/card/doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${f.name.replace(/[^\w.-]+/g, '_')}`;
        must(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream' }));
        const { data: x } = await sb.functions.invoke('bo-read-kbiz-doc', { body: { peek_path: path, mime: f.type || null } });
        const amt = Number(x?.amount) || 0, cur = String(x?.currency || 'THB').toUpperCase(), dt = x?.date ? new Date(`${x.date}T00:00:00`) : null;
        const sup = x?.supplier || guessVendor(x?.party) || '';
        const score = (c) => { let k = 0;
          if (amt && cur !== 'THB' && c.foreign_amount && Math.abs(Number(c.foreign_amount) - amt) <= 0.02) k += 3;
          else if (amt && (Math.abs(Number(c.amount) - amt) <= 5 || Math.abs(Number(c.amount) - amt) <= Number(c.amount) * 0.03)) k += 3;
          if (dt && Math.abs(new Date(`${c.trans_date}T00:00:00`) - dt) <= 4 * 86400000) k += 1;
          const w = vNorm(x?.party || '').split(' ')[0]; if (w && w.length >= 3 && vNorm(c.description).includes(w)) k += 2;
          return k; };
        const cand = free.filter((c) => !placed.some((pp) => pp.c.id === c.id)).map((c) => ({ c, k: score(c) })).filter((y) => y.k >= 3).sort((a, b) => b.k - a.k);
        if (cand.length && (cand.length === 1 || cand[0].k > cand[1].k)) {
          const c = cand[0].c, last = allCh.find((y) => sup && y.merchant === sup);
          await lineUpd('card_charges', c.id, { doc_path: path, doc_name: f.name, merchant: sup || null, category_id: last?.category_id || null, purpose: x?.item || null, vat_amount: Number(x?.vat_amount) || 0 }, () => {});
          placed.push({ c, f });
        } else left.push({ f, path, x });
      } catch { left.push({ f, path: null, x: null }); }
    }
    if (prog) prog.innerHTML = '';
    if (!left.length) { toast(`${placed.length} invoice${placed.length === 1 ? '' : 's'} placed`); return pageCard(); }
    const back = document.createElement('div'); back.className = 'modal-back';
    const opts = open.filter((c) => !c.doc_path && !c.no_doc && !placed.some((pp) => pp.c.id === c.id));
    back.innerHTML = `<div class="modal"><div class="modal-head"><h2>${left.length} file${left.length > 1 ? 's' : ''} not placed</h2><button class="btn ghost" data-x>Later</button></div><div class="modal-body"><div class="card-pad stack">
      <div class="faint" style="font-size:13px">${placed.length} placed by themselves. Choose the charge for each of these (for example Apple charges with no foreign amount).</div>
      ${left.map((y, k) => `<div class="cc-r"><div class="cc-m"><b>${esc(y.f.name)}</b><small>${y.x ? `${esc(y.x.party || '')} · ${esc(y.x.currency || '')} ${y.x.amount != null ? money(y.x.amount) : ''} · ${esc(y.x.date || '')}` : 'Could not be read'}</small></div>${y.path ? `<select class="input" data-pl="${k}" style="width:auto;font-size:12px"><option value="">Choose the charge</option>${opts.map((c) => `<option value="${c.id}">${esc(when(c.trans_date))} · ${esc(c.description.slice(0, 26))} · ${money(c.amount)}</option>`).join('')}</select>` : ''}</div>`).join('')}
      <button class="btn primary" id="plok">Place</button></div></div></div>`;
    document.body.appendChild(back);
    back.querySelector('[data-x]').onclick = () => { back.remove(); pageCard(); };
    back.querySelector('#plok').onclick = async () => {
      for (const sel of back.querySelectorAll('[data-pl]')) { if (!sel.value) continue; const y = left[Number(sel.dataset.pl)]; const sup = y.x?.supplier || guessVendor(y.x?.party) || null; const last = allCh.find((q) => sup && q.merchant === sup);
        try { await lineUpd('card_charges', sel.value, { doc_path: y.path, doc_name: y.f.name, merchant: sup, category_id: last?.category_id || null, purpose: y.x?.item || null, vat_amount: Number(y.x?.vat_amount) || 0 }, () => {}); } catch (e) { toast(friendly(e), true); } }
      back.remove(); pageCard();
    };
  };
  { const mi = document.getElementById('ccmany'), dz = document.getElementById('ccdrop');
    if (mi) mi.onchange = (e) => e.target.files.length && batchCard([...e.target.files]);
    if (dz) { dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('on'); }; dz.ondragleave = () => dz.classList.remove('on'); dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('on'); if (e.dataTransfer.files.length) batchCard([...e.dataTransfer.files]); }; } }
  main().querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
    const box = main().querySelector(`[data-det="${b.dataset.save}"]`), v = (f) => box.querySelector(`[data-f="${f}"]`).value.trim();
    const c0 = charges.find((x) => x.id === b.dataset.save), tick = box.querySelector('[data-f="is_sub"]')?.checked;
    if (tick && !subOf(c0)) await sb.from('subscriptions').upsert({ match_key: subKey(c0.description), name: v('merchant'), merchant: v('merchant'), category_id: v('category_id') || subCat, purpose: v('purpose') || null, no_invoice: !!c0.no_doc, no_doc_reason: c0.no_doc_reason || null, active: true }, { onConflict: 'match_key' });
    if (!tick && subOf(c0)) await sb.from('subscriptions').update({ active: false }).eq('id', subOf(c0).id);
    try { await run(async () => await lineUpd('card_charges', b.dataset.save, { merchant: v('merchant') || null, category_id: v('category_id') || null, account_code: null, purpose: v('purpose') || null, vat_amount: Number(v('vat_amount')) || 0 }, pageCard), tick ? 'Saved. Next months fill in by themselves.' : !v('merchant') || !v('category_id') ? 'Saved. Still needs supplier and category before it counts as done.' : 'Saved'); } catch { return; }
    pageCard();
  }));
  main().querySelectorAll('[data-ccnw]').forEach((w) => { const inp = main().querySelector(`[data-det="${w.dataset.ccnw}"] [data-f="merchant"]`); if (inp) inp.addEventListener('input', () => { w.hidden = knownSup(inp.value.trim()); }); });
  main().querySelectorAll('[data-ccnew]').forEach((b) => (b.onclick = async () => { const box = main().querySelector(`[data-det="${b.dataset.ccnew}"]`), inp = box.querySelector('[data-f="merchant"]');
    const nm = await newSupplier({ name: inp.value.trim() }); if (nm) { inp.value = nm; nvSet.add(nk(nm)); b.parentElement.hidden = true; toast('Supplier added. Press Save to keep it on this line.'); } }));
  main().querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const x = main().querySelector(`[data-edb="${b.dataset.edit}"]`); if (!x) return; x.hidden = !x.hidden; b.textContent = x.hidden ? 'Edit' : 'Close'; }));
  main().querySelectorAll('[data-nc]').forEach((b) => (b.onclick = async (e) => {
    if (!confirmInline(e.target, 'Switch to Me and repay?')) return;
    try { await run(async () => { const { error } = await sb.rpc('card_not_company', { p_item: b.dataset.nc }); if (error) throw error; }, 'Switched to Me. The staff member was told it will be repaid.'); } catch { return; }
    pageCard();
  }));
  main().querySelectorAll('[data-mm]').forEach((sel) => (sel.onchange = async () => {
    if (!sel.value) return;
    try { await run(async () => { const { error } = await sb.rpc('confirm_card_match', { p_charge: sel.value, p_item: sel.dataset.mm }); if (error) throw error; }, 'Matched'); } catch { return; }
    pageCard();
  }));
  main().querySelectorAll('[data-sg]').forEach((b) => (b.onclick = async () => {
    try { await run(async () => { const { error } = await sb.rpc('confirm_card_match', { p_charge: b.dataset.sg, p_item: b.dataset.it }); if (error) throw error; }, 'Matched. The staff member was told it is not repaid.'); } catch { return; }
    pageCard();
  }));
  main().querySelectorAll('[data-add]').forEach((i) => (i.onchange = (e) => { const fs = [...e.target.files]; if (!fs.length) return; if (fs.length === 1) attach(i.dataset.add, fs[0]); else batchCard(fs); }));
  main().querySelectorAll('.cc-r[data-cc]').forEach((r) => {
    r.ondragover = (e) => { e.preventDefault(); r.classList.add('cc-drop'); };
    r.ondragleave = () => r.classList.remove('cc-drop');
    r.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); r.classList.remove('cc-drop'); const fs = [...e.dataTransfer.files]; if (fs.length === 1) attach(r.dataset.cc, fs[0]); else if (fs.length) batchCard(fs); };
  });
  main().querySelectorAll('[data-undo]').forEach((b) => (b.onclick = async () => {
    const c = charges.find((x) => x.id === b.dataset.undo); const keep = { doc_path: c.doc_path, doc_name: c.doc_name, merchant: c.merchant, category_id: c.category_id, account_code: c.account_code, purpose: c.purpose, vat_amount: c.vat_amount };
    try { await run(async () => await lineUpd('card_charges', c.id, { doc_path: null, doc_name: null, merchant: null, category_id: null, account_code: null, purpose: null, vat_amount: 0 }, pageCard)); } catch { return; }
    pageCard();
    laterDelete('File removed.', async () => { await sb.storage.from(BUCKET).remove([keep.doc_path]); }, async () => { const { error } = await sb.from('card_charges').update(keep).eq('id', c.id); if (error) toast(friendly(error), true); pageCard(); });
  }));
  main().querySelectorAll('[data-noinv]').forEach((b) => (b.onclick = async () => { const r = await askNoInv(); if (!r) return; try { await run(async () => await lineUpd('card_charges', b.dataset.noinv, { no_doc: true, no_doc_reason: r }, pageCard), 'Marked: no invoice. Add the supplier and category.'); } catch { return; } pageCard(); }));
  main().querySelectorAll('[data-inv]').forEach((b) => (b.onclick = async () => { try { await run(async () => await lineUpd('card_charges', b.dataset.inv, { no_doc: false, no_doc_reason: null }, pageCard), 'Add the invoice file'); } catch { return; } pageCard(); }));
  main().querySelectorAll('[data-note]').forEach((b) => (b.onclick = () => {
    const c = charges.find((x) => x.id === b.dataset.note);
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal narrow"><div class="modal-head"><h2>Note</h2><button class="btn ghost" data-x>Cancel</button></div><div class="modal-body"><div class="card-pad stack">
      <div><b>${esc(c.description)}</b><div class="faint" style="font-size:13px">${when(c.trans_date)} · ${money(c.amount)} THB</div></div>
      <div class="field"><label>Note on this charge</label><input class="input" id="ntx" maxlength="200" placeholder="Asked in LINE ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, waiting" value="${esc(c.note || '')}"></div>
      <button class="btn primary" id="nts">Save</button></div></div></div>`;
    document.body.appendChild(back);
    back.querySelector('[data-x]').onclick = () => back.remove();
    back.querySelector('#nts').onclick = async () => { const t = back.querySelector('#ntx').value.trim(); back.remove();
      try { await run(async () => await lineUpd('card_charges', c.id, { note: t || null }, pageCard), t ? 'Note saved' : 'Note removed'); } catch { return; } pageCard(); };
    setTimeout(() => back.querySelector('#ntx').focus(), 0);
  }));
}
// Printed sheet for PPP: cover sheet with fixed numbers (same as FlowAccount), then the documents in the same order
let pdfLib = null;
async function pdfPages(url) {
  if (!pdfLib) {
    await new Promise((ok, no) => { const t = document.createElement('script'); t.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; t.onload = ok; t.onerror = no; document.head.appendChild(t); });
    pdfLib = window.pdfjsLib; const wt = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js')).text(); pdfLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wt], { type: 'text/javascript' }));
  }
  const pdf = await pdfLib.getDocument(url).promise; const out = [];
  for (let k = 1; k <= Math.min(pdf.numPages, 6); k++) {
    const pg = await pdf.getPage(k); const vp = pg.getViewport({ scale: 2 }); const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height; await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise; out.push(cv.toDataURL('image/jpeg', 0.85));
  }
  return out;
}
async function docPages(path, mime, foot) {
  const url = await signedUrl(path); if (!url) return [`<section class="pf-page"><p>Could not open ${esc(foot)}</p></section>`];
  let imgs = [];
  try { imgs = (mime || '').includes('pdf') || /\.pdf$/i.test(path) ? await pdfPages(url) : [url]; } catch { imgs = []; }
  if (!imgs.length) return [`<section class="pf-page"><p>${esc(foot)}: could not show this file. Print it separately.</p></section>`];
  return imgs.map((src, k) => `<section class="pf-page sh-docpg"><div class="sh-doc"><img src="${esc(src)}" alt=""></div><div class="sh-foot">${esc(foot)}${imgs.length > 1 ? ` · page ${k + 1} of ${imgs.length}` : ''}</div></section>`);
}
async function pageSheet(kind) {
  const mk = params().m || monthKey();
  await sb.rpc('assign_fa_refs', { p_month: mk + '-01' });
  const back = kind === 'bills' ? `#/bills?m=${mk}` : `#/card?m=${mk}`;
  const title = kind === 'bills' ? 'Bank transfers by KBIZ' : 'Card payments (company card)';
  const yymm = `${mk.slice(2, 4)}${mk.slice(5, 7)}`;
  const block = (msg) => { app.innerHTML = `<div class="pf-bar"><a class="btn" href="${back}">Back</a></div><div class="pstack" style="padding:40px;max-width:560px;margin:auto"><h1>Not ready to print</h1><p>${msg}</p><a class="btn primary" href="${back}">Go back and finish</a></div>`; };
  let rows = [], docs = [], tot = { a: 0, v: 0, w: 0, p: 0 };
  const r2 = (x) => Math.round(x * 100) / 100;
  if (kind === 'bills') {
    const all = must(await sb.from('kbiz_payments').select('*, kbiz_docs(*)').eq('admin_only', false)).filter((p) => p.period_month.slice(0, 7) === mk);
    if (!S.faVendors) await loadFAVendors();
    const dk = (p, k) => (p.kbiz_docs || []).some((x) => x.kind === k && x.status === 'ready');
    const open = all.filter((p) => !p.fa_ref || !(dk(p, 'bill') || p.no_doc) || !dk(p, 'slip') || !(p.account_code || p.category_id) || !p.merchant || !S.faVendorSet.has(p.merchant.toLowerCase()));
    if (!all.length) return block('No supplier bills for this month yet.');
    if (open.length) return block(`Still to finish: ${open.map((p) => esc(p.merchant || (p.kbiz_docs || []).find((x) => x.party)?.party || 'a line')).join(', ')}. Each line needs a bill, a slip, a supplier from the FlowAccount list and a category. The sheet prints only when every line is complete, so nothing goes to PPP half done.`);
    all.sort((a, b) => refSort(a.fa_ref, b.fa_ref));
    const sl0 = (p) => (p.kbiz_docs || []).find((x) => x.kind === 'slip' && x.status === 'ready')?.amount;
    for (const p of all) {
      const d = (k) => (p.kbiz_docs || []).find((x) => x.kind === k && x.status === 'ready');
      const b = d('bill') || { amount: sl0(p) }, sl = d('slip'); const amt = Number(b.amount) || 0, vat = Number(p.vat_amount) || 0, wr = Number(p.wht_rate) || 0, w = p.wht_on_top ? r2(amt / (1 - wr / 100) - amt) : r2((amt - vat) * wr / 100), pay = Number(sl.amount) || r2(amt - w);
      tot.a += amt; tot.v += vat; tot.w += w; tot.p += pay;
      rows.push(`<tr><td class="c">${esc(refLetter(p.fa_ref))}</td><td class="c">${dmy(sl.doc_date)}</td><td>${esc(p.merchant)}<div class="sh-sub">${esc(p.purpose || b.item || '')}${p.bill_paper ? ' · original attached' : ''}${p.no_doc ? ` · No invoice: ${esc(p.no_doc_reason || '')}` : ''}</div></td><td class="r">${money(amt)}</td><td class="r">${money(vat)}</td><td class="r">${wr ? `${wr}% ${money(w)}${p.wht_on_top ? ' on top' : ''}` : '-'}</td><td class="r">${money(pay)}</td><td class="c">☐</td></tr>`);
      if (!p.bill_paper && b.file_path) docs.push(...await docPages(b.file_path, b.mime, `${p.fa_ref} · bill · ${p.merchant}`));
      docs.push(...await docPages(sl.file_path, sl.mime, `${p.fa_ref} · K BIZ slip · ${p.merchant}`));
    }
  } else {
    const sts = must(await sb.from('card_statements').select('*').eq('status', 'ready')).filter((x) => x.period_month.slice(0, 7) === mk);
    if (!sts.length) return block('No company card statement for this month yet.');
    const ch = must(await sb.from('card_charges').select('*').in('statement_id', sts.map((x) => x.id)).order('trans_date'));
    const open = ch.filter((c) => !c.item_id && !(c.fa_ref && (c.doc_path || c.no_doc) && c.merchant && (c.account_code || c.category_id)));
    if (open.length) return block(`Still to finish: ${open.map((c) => esc(c.description)).join(', ')}. Each charge needs a staff receipt, or a file with supplier and category. The sheet prints only when every charge is explained.`);
    const itemIds = ch.filter((c) => c.item_id).map((c) => c.item_id);
    const its = itemIds.length ? must(await sb.from('expense_items').select('id, report_id, invoice_date, created_at, category_id').in('id', itemIds)) : [];
    const reps = its.length ? must(await sb.from('expense_reports').select('id, ref_no').in('id', [...new Set(its.map((i) => i.report_id))])) : [];
    for (const st of sts) docs.push(...await docPages(st.file_path, null, `CARD${yymm} · card statement`));
    for (const c of ch) {
      const it = its.find((i) => i.id === c.item_id); const rf = it ? reps.find((r) => r.id === it.report_id)?.ref_no : '';
      const vat = Number(c.vat_amount) || 0; tot.a += Number(c.amount); tot.v += vat;
      rows.push(`<tr><td class="c">${c.fa_ref ? esc(refLetter(c.fa_ref)) : '-'}</td><td class="c">${dmy(c.trans_date)}</td><td>${esc(c.merchant || c.description)}<div class="sh-sub">${it ? `staff receipt, see form ${esc(rf || '')}` : c.no_doc ? (c.no_doc_reason ? `${esc(c.purpose || c.description)} · No invoice: ${esc(c.no_doc_reason)}` : 'bank charge, no receipt') : esc(c.purpose || c.description)}</div></td><td class="r">${money(c.amount)}</td><td class="r">${c.item_id ? '' : money(vat)}</td><td class="c">☐</td></tr>`);
      if (c.fa_ref && c.doc_path) docs.push(...await docPages(c.doc_path, c.doc_name && /\.pdf$/i.test(c.doc_name) ? 'application/pdf' : null, `${c.fa_ref} · ${c.merchant || c.description}`));
    }
  }
  const head = kind === 'bills'
    ? '<tr><th style="width:11mm">No.</th><th style="width:21mm">Paid</th><th>Supplier · for</th><th style="width:25mm">Bill</th><th style="width:20mm">VAT</th><th style="width:25mm">WHT</th><th style="width:25mm">Paid</th><th style="width:9mm">✓</th></tr>'
    : '<tr><th style="width:11mm">No.</th><th style="width:21mm">Date</th><th>Charge · how it is covered</th><th style="width:26mm">Amount</th><th style="width:20mm">VAT</th><th style="width:9mm">✓</th></tr>';
  const totRow = kind === 'bills'
    ? `<tr class="tot"><td colspan="3">Total · ${rows.length} lines</td><td class="r">${money(tot.a)}</td><td class="r">${money(tot.v)}</td><td class="r">${money(tot.w)}</td><td class="r">${money(tot.p)}</td><td></td></tr>`
    : `<tr class="tot"><td colspan="3">Total · ${rows.length} charges</td><td class="r">${money(tot.a)}</td><td class="r">${money(tot.v)}</td><td></td></tr>`;
  const cover = `<section class="pf-page"><div class="pf-head"><img src="/images/bcm-logo.png" alt="Bloom Chiangmai"><div class="pf-title"><b>Bloom Chiangmai</b><span>${esc(title.toUpperCase())} ${esc(monthLabel(mk).toUpperCase())}</span></div><div class="pf-meta" style="display:block;text-align:right"><span class="ref">${kind === 'bills' ? 'BILL' : 'CARD'}${yymm}</span></div></div>
    <table class="pf-t sh-t">${head}${rows.join('')}${totRow}</table>
    <p class="pf-note">No. = the letter after ${kind === 'bills' ? 'BILL' : 'CARD'}${yymm} in FlowAccount's Reference and at the start of the description. Behind this sheet, in the same order: ${kind === 'bills' ? 'for each line the bill (or the paper original), then the K BIZ slip' : 'the card statement, then the file for each numbered line. Staff receipts are in the staff form named on the line'}. Every page is footed with its number.</p>
    <table class="pf-sign"><tr><td style="width:25%">Prepared by (data entry):</td><td style="width:25%"></td><td style="width:25%">Checked by (PPP):</td><td></td></tr><tr><td>Date:</td><td></td><td>Date:</td><td></td></tr></table></section>`;
  app.innerHTML = `<div class="pf-bar"><div class="row"><a class="btn" href="${back}">Back</a><span class="muted">${esc(title)} · ${esc(monthLabel(mk))} · ${1 + docs.length} pages</span></div><button class="btn primary" id="pp">Print</button></div><div class="pf-wrap">${cover}${docs.join('')}</div>`;
  document.getElementById('pp').onclick = () => window.print();
}
// Supplier bills: bills and K BIZ slips for transfers to suppliers, paired into one line per payment
async function pageBills() {
  if (!params().m) return pageMonths('bills');
  const all = keepRev(must(await sb.from('kbiz_payments').select('*, kbiz_docs(*)').order('created_at')));
  const loose = must(await sb.from('kbiz_docs').select('*').is('payment_id', null).order('uploaded_at', { ascending: false }).limit(30));
  const months = [...new Set(all.map((p) => p.period_month.slice(0, 7)))].sort().reverse();
  const mk = params().m || months[0] || monthKey();
  if (!S.faVendors) await loadFAVendors();
  await loadAcc();
  const cats = S.categories.filter((x) => x.active);
  const list = all.filter((p) => p.period_month.slice(0, 7) === mk);
  const doc = (p, k) => (p.kbiz_docs || []).find((d) => d.kind === k && d.status === 'ready');
  const reading = (p) => (p.kbiz_docs || []).some((d) => d.status === 'reading');
  const okSup = (p) => p.merchant && S.faVendorSet.has(p.merchant.toLowerCase());
  const ready = (p) => (doc(p, 'bill') || p.no_doc) && doc(p, 'slip') && okSup(p) && (p.account_code || p.category_id);
  const staffPay = list.filter((p) => p.admin_only), sup = list.filter((p) => !p.admin_only);
  const open = sup.filter((p) => !ready(p)), done = sup.filter(ready);
  if (!pageBills.numbered && done.some((p) => !p.fa_ref)) { pageBills.numbered = true; await sb.rpc('assign_fa_refs', { p_month: mk + '-01' }); return pageBills(); }
  pageBills.numbered = false;
  const bpg = Math.min(Math.max(1, Number(params().p) || 1), Math.max(1, Math.ceil(open.length / PER)));
  const when = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
  const title = (p) => p.merchant || doc(p, 'bill')?.party || doc(p, 'slip')?.party || 'Reading…';
  const amt = (p) => doc(p, 'slip')?.amount ?? doc(p, 'bill')?.amount ?? 0;
  const tick = (ok, label) => `<span class="sb-t ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${label}</span>`;
  const sub = (p) => { const s0 = doc(p, 'slip'), b0 = doc(p, 'bill'); return (p.fa_ref ? `<b class="ln-ref">${esc(p.fa_ref)}</b> · ` : '') + [when(s0?.doc_date || b0?.doc_date), s0?.memo || b0?.item || '', s0?.txn_no ? 'K BIZ ' + s0.txn_no : ''].filter(Boolean).map(esc).join(' · '); };
  const files = (p) => (p.kbiz_docs || []).filter((d) => d.status === 'ready').map((d) => `<a href="#" data-view="${esc(d.file_path)}" class="faint" style="font-size:12px">${d.kind === 'bill' ? 'Bill' : 'Slip'}</a>`).join(' · ');
  const chip = (p, k, label) => { const d = doc(p, k); if (!d && k === 'bill' && p.no_doc) return `<span class="ln-c ok">No invoice: ${esc(p.no_doc_reason || '')}</span><button type="button" class="btn ghost small" data-inv="${p.id}">There is a bill</button>`; return d ? `<a href="#" class="ln-c ok" data-view="${esc(d.file_path)}">✓ ${label}${k === 'slip' && d.txn_no ? ' · ' + esc(d.txn_no) : ''}</a>` : `<label class="ln-c add">+ Add ${label.toLowerCase()}<input type="file" hidden multiple accept="image/*,application/pdf" data-addto="${p.id}"></label>${k === 'bill' ? `<button type="button" class="btn ghost small" data-noinv="${p.id}">No invoice</button>` : ''}`; };
  const state = (p) => reading(p) ? lnPill('Reading…', '') : !doc(p, 'bill') && !p.no_doc ? lnPill('Needs bill', 'warn') : !doc(p, 'slip') ? lnPill('Needs slip', 'warn') : lnPill('Needs details', 'warn');
  const form = (p) => `<div class="cc-det" data-pay="${p.id}"><div class="ln-chips">${chip(p, 'bill', 'Bill')}${chip(p, 'slip', 'Slip')}${doc(p, 'bill') ? `<label class="ln-paper"><input type="checkbox" data-paper="${p.id}" ${p.bill_paper ? 'checked' : ''}> We have the paper original</label>` : ''}</div>
    ${!p.merchant && (doc(p, 'bill') || doc(p, 'slip'))?.party && !guessVendor((doc(p, 'bill') || doc(p, 'slip')).party) ? `<div class="cc-sg">New supplier? "${esc((doc(p, 'bill') || doc(p, 'slip')).party)}" is not in the FlowAccount list. <button type="button" class="btn small" data-newsup="${p.id}">Add ${esc((doc(p, 'bill') || doc(p, 'slip')).party)}</button></div>` : ''}
    ${lnForm({ list: 'sbv', cats, wht: true, merchant: p.merchant || guessVendor((doc(p, 'bill') || doc(p, 'slip'))?.party) || doc(p, 'bill')?.party, category_id: p.category_id, purpose: p.purpose, vat_amount: p.vat_amount, wht_rate: p.wht_rate, wht_on_top: p.wht_on_top })}
    <div class="ln-chk" data-chk="${p.id}"></div>
    <div class="ln-foot"><button class="btn ghost small ln-del" data-delpay="${p.id}">Delete line</button><button class="btn primary small" data-savepay="${p.id}">Save</button></div></div>`;
  const badDocs = (p) => (p.kbiz_docs || []).filter((d) => d.status === 'failed' || d.status === 'duplicate').map((d) => `<div class="cc-tag bad" style="display:flex;gap:8px;align-items:center">${esc(d.file_name || 'File')}: ${esc(d.status === 'duplicate' ? 'same slip already saved' : d.error || 'could not be read')} <button class="btn ghost small" data-deldoc2="${d.id}">Remove</button></div>`).join('');
  const fileTicks = (p) => `<span class="ln-ft ${doc(p, 'bill') || p.no_doc ? 'ok' : ''}">${p.no_doc && !doc(p, 'bill') ? 'No invoice' : 'Bill'}</span><span class="ln-ft ${doc(p, 'slip') ? 'ok' : ''}">Slip</span>`;
  const line = (p) => `<div class="cc-r ln-row" style="display:block" data-drop="${p.id}"><button type="button" class="ln-sum" data-tog><span class="ln-d">${esc(when(doc(p, 'slip')?.doc_date || doc(p, 'bill')?.doc_date))}</span><span class="ln-t"><b>${esc(title(p))}</b><small>${p.fa_ref ? `<b class="ln-ref">${esc(p.fa_ref)}</b> · ` : ''}${esc(p.purpose || doc(p, 'slip')?.memo || doc(p, 'bill')?.item || '')}</small></span><span class="ln-fs">${fileTicks(p)}</span><span class="cc-n">${money(amt(p))}</span><span>${(p.kbiz_docs || []).some((d) => d.status === 'failed' || d.status === 'duplicate') ? lnPill('File problem', 'warn') : state(p)}</span><span class="ln-chev">›</span></button><div class="ln-body" hidden>${badDocs(p)}${form(p)}</div></div>`;
  const doneRow = (p) => `<div class="cc-r cc-ok"><div class="cc-m"><b>${esc(title(p))}</b><small>${sub(p)} · ${files(p)}${p.fa_done ? ' · in FlowAccount' : ''}</small></div><div class="cc-a"><span class="cc-n">${money(amt(p))}</span>${!p.fa_done ? `<button class="btn ghost small" data-reopen="${p.id}">Edit</button>` : ''}</div></div>`;
  shell(`<div class="page-head"><div><h1>Bank transfers · ${esc(monthLabel(mk))}</h1><p>${sup.length ? `${done.length} of ${sup.length} ready · ${open.length ? `<span class="error" style="display:inline">${open.length} to finish</span>` : 'all ready'}` : 'Bills and K BIZ slips for transfers to suppliers. Drop them in, many at once, in any order.'}</p></div>
    <div class="row">${sup.length ? `<a class="btn" href="#/sheet/bills?m=${mk}" title="${open.length ? 'Finish every line first' : 'Cover sheet plus slips, in FlowAccount order'}">Print for PPP</a>` : ''}<a class="btn ghost" href="#/bills">‹ All months</a></div></div>
    <label class="sb-drop" id="sbdrop"><input type="file" hidden multiple accept="image/*,application/pdf" id="sbin"><b>Drop bills and payment slips here</b><span>PDF or photo, many at once. Each bill is paired with its slip by amount and name. Do not drop salary slips here.</span></label>
    <div id="sbprog"></div>
    ${loose.length ? `<div class="banner warn" style="margin:10px 0">${loose.map((d) => `<div class="row" style="justify-content:space-between;gap:8px"><span>${esc(d.file_name || 'File')}: ${d.status === 'duplicate' ? `same slip already saved (${esc(d.error || '')})` : d.status === 'reading' ? 'still reading…' : esc(d.error || 'could not be read')}</span><span class="row" style="gap:6px">${d.status !== 'duplicate' ? `<button class="btn small" data-retry="${d.id}">Try again</button>` : ''}<button class="btn ghost small" data-deldoc="${d.id}">Remove</button></span></div>`).join('')}</div>` : ''}
    <datalist id="sbv">${(S.faVendors || []).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
    ${sup.length ? `<div class="cc-bar"><div style="width:${Math.round((done.length / sup.length) * 100)}%"></div></div><div class="card"><div class="card-pad" style="padding-top:4px">${open.length ? '<div class="ln-head"><span>Paid</span><span>Supplier · for</span><span>Files</span><span style="text-align:right">Amount</span><span>Status</span><span></span></div>' : ''}${pageOf(open, bpg).map(line).join('') || '<div class="faint" style="padding:12px 0">Every payment has its bill, slip and details.</div>'}${pager(open.length, bpg, '#/bills?m=' + mk)}
      ${done.length ? `<details class="cc-done"><summary>${done.length} ready</summary>${done.map(doneRow).join('')}</details>` : ''}</div></div>` : ''}
    ${isAdmin() && staffPay.length ? `<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>${staffPay.length} payment${staffPay.length > 1 ? 's' : ''} to staff · admin only</h2><div class="faint" style="font-size:12px">Slips paid to a staff member (salary or expense payout). Data entry does not see these. They are not supplier bills.</div></div></div><div class="card-pad" style="padding-top:4px">${staffPay.map((p) => `<div class="cc-r"><div class="cc-m"><b>${esc(title(p))}</b><small>${sub(p)}</small></div><div class="cc-a"><span class="cc-n">${money(amt(p))}</span><button class="btn ghost small" data-delpay="${p.id}">Delete</button></div></div>`).join('')}</div></div>` : ''}
    <p class="faint" style="font-size:12px">Ready lines go into Accounting › Month close for this month, paid by KBIZ. A slip that is already saved is refused.</p>`);
  const ms = document.getElementById('sbm'); if (ms) ms.onchange = (e) => { location.hash = '#/bills?m=' + e.target.value; };
  const readOne = async (f, paymentId = null) => {
    const path = `${S.user.id}/kbiz/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${f.name.replace(/[^\w.-]+/g, '_')}`;
    must(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream' }));
    const d = must(await sb.from('kbiz_docs').insert({ file_path: path, file_name: f.name, mime: f.type || null, payment_id: paymentId }).select().single());
    const { data, error } = await sb.functions.invoke('bo-read-kbiz-doc', { body: { doc_id: d.id } });
    if (error) throw error;
    return data;
  };
  const many = async (fs, paymentId = null) => {
    const prog = document.getElementById('sbprog'); let n = 0, dup = 0, bad = 0, staffN = 0;
    for (const f of fs) {
      n++; if (prog) prog.innerHTML = `<div class="banner info" style="margin:10px 0">Reading ${n} of ${fs.length}… keep this page open.</div>`;
      try { const r = await readOne(f, paymentId); if (r?.status === 'duplicate') dup++; else if (r?.error) bad++; else if (r?.admin_only) staffN++; } catch { bad++; }
    }
    await sb.rpc('pair_kbiz');
    toast(`${fs.length - dup - bad} read${dup ? ` · ${dup} already saved` : ''}${bad ? ` · ${bad} could not be read` : ''}${staffN ? ` · ${staffN} staff payment${staffN > 1 ? 's' : ''} kept admin only` : ''}`, bad > 0);
    pageBills();
  };
  const inp = document.getElementById('sbin'), drop = document.getElementById('sbdrop');
  inp.onchange = (e) => e.target.files.length && many([...e.target.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('on'); };
  drop.ondragleave = () => drop.classList.remove('on');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('on'); if (e.dataTransfer.files.length) many([...e.dataTransfer.files]); };
  main().querySelectorAll('[data-drop]').forEach((r) => {
    r.ondragover = (e) => { e.preventDefault(); r.classList.add('cc-drop'); };
    r.ondragleave = () => r.classList.remove('cc-drop');
    r.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); r.classList.remove('cc-drop'); if (e.dataTransfer.files.length) many([...e.dataTransfer.files], r.dataset.drop); };
  });
  main().querySelectorAll('[data-addto]').forEach((i) => (i.onchange = (e) => e.target.files.length && many([...e.target.files], i.dataset.addto)));
  main().querySelectorAll('[data-view]').forEach((a) => (a.onclick = async (e) => { e.preventDefault(); const u = await signedUrl(a.dataset.view); if (u) window.open(u, '_blank'); }));
  const chk = (box) => { const p = list.find((x) => x.id === box.dataset.pay); if (!p) return; const out = box.querySelector('[data-chk]');
    const b = doc(p, 'bill'), sl = doc(p, 'slip'); const vat = Number(box.querySelector('[data-f="vat_amount"]').value) || 0; const r = (Number(box.querySelector('[data-f="wht_rate"]').value) || 0) / 100; const top = box.querySelector('[data-f="wht_on_top"]')?.checked;
    const r2 = (x) => Math.round(x * 100) / 100; const parts = [];
    if (b) { const bt = Number(b.amount) || 0; const w = top ? r2(bt / (1 - r) - bt) : r2((bt - vat) * r); const pay = top ? bt : r2(bt - w);
      parts.push(`Bill ${money(bt)}`); if (vat) parts.push(`VAT ${money(vat)}`); if (r) parts.push(top ? `WHT ${r * 100}% = ${money(w)} paid on top by the company` : `WHT ${r * 100}% = ${money(w)}`); parts.push(`Should pay <b>${money(pay)}</b>`);
      if (vat && vat > bt * 0.08) { out.className = 'ln-chk bad'; out.innerHTML = `VAT ${money(vat)} is too high for a bill of ${money(bt)}. VAT is the tax only, about 7% of the bill.`; return; }
      if (sl) { const okk = Math.abs(pay - Number(sl.amount)) <= 1; parts.push(`Slip ${money(sl.amount)} ${okk ? '✓' : '✗ does not match'}`); out.className = 'ln-chk ' + (okk ? 'ok' : 'bad'); } else out.className = 'ln-chk';
    } else if (sl) { const st0 = Number(sl.amount) || 0;
      if (vat && vat > st0 * 0.08) { out.className = 'ln-chk bad'; out.innerHTML = `VAT ${money(vat)} is too high for a payment of ${money(st0)}. VAT is the tax only, about 7% of the bill.`; return; }
      if (top) { parts.push(`Slip ${money(st0)} = bill`); if (r) parts.push(`WHT ${r * 100}% = ${money(r2(st0 / (1 - r) - st0))} paid on top by the company`); out.className = 'ln-chk'; } else {
      const bt = r ? r2((st0 - vat * r) / (1 - r)) : st0; parts.push(`Slip ${money(st0)}`); if (r) parts.push(`WHT ${r * 100}% = ${money(r2(bt - st0))}`); parts.push(`so the bill should be about <b>${money(bt)}</b>`); out.className = 'ln-chk'; }
    } out.innerHTML = parts.join(' · '); };
  main().querySelectorAll('[data-pay]').forEach((box) => { const mi = box.querySelector('[data-f="merchant"]'), ai = box.querySelector('[data-f="category_id"]');
    mi.addEventListener('change', () => { const prev = all.filter((x) => x.merchant && x.merchant.toLowerCase() === mi.value.trim().toLowerCase() && x.id !== box.dataset.pay).pop(); if (!prev) return; if (!ai.value && prev.category_id) ai.value = prev.category_id; const tp = box.querySelector('[data-f="wht_on_top"]'); if (tp) tp.checked = !!prev.wht_on_top; chk(box); });
    chk(box); box.querySelectorAll('[data-f="vat_amount"],[data-f="wht_rate"],[data-f="wht_on_top"]').forEach((i) => { i.addEventListener('input', () => chk(box)); i.addEventListener('change', () => chk(box)); }); });
  main().querySelectorAll('[data-paper]').forEach((x) => (x.onchange = async () => { try { await run(async () => await lineUpd('kbiz_payments', x.dataset.paper, { bill_paper: x.checked }, pageBills), x.checked ? 'Paper original: not reprinted' : 'Digital only: the bill will be printed'); } catch { /* refreshed */ } }));
  main().querySelectorAll('[data-savepay]').forEach((b) => (b.onclick = async () => {
    const box = main().querySelector(`[data-pay="${b.dataset.savepay}"]`), v = (f) => box.querySelector(`[data-f="${f}"]`).value.trim();
    if (v('merchant') && !S.faVendorSet.has(v('merchant').toLowerCase())) { toast('Pick a supplier from the FlowAccount list (new suppliers are added in FlowAccount first)', true); return; }
    try { await run(async () => await lineUpd('kbiz_payments', b.dataset.savepay, { merchant: v('merchant') || null, category_id: v('category_id') || null, account_code: null, purpose: v('purpose') || null, vat_amount: Number(v('vat_amount')) || 0, wht_rate: Number(v('wht_rate')) || 0, wht_on_top: !!box.querySelector('[data-f="wht_on_top"]')?.checked }, pageBills), 'Saved'); } catch { return; }
    pageBills();
  }));
  main().querySelectorAll('[data-newsup]').forEach((b) => (b.onclick = async () => { const p = list.find((x) => x.id === b.dataset.newsup), d = doc(p, 'bill') || doc(p, 'slip');
    const nm = await newSupplier({ name: d.party, tax_id: doc(p, 'bill')?.tax_id, address: doc(p, 'bill')?.address, phone: doc(p, 'bill')?.phone }); if (!nm) return;
    try { await run(async () => await lineUpd('kbiz_payments', p.id, { merchant: nm }, pageBills), 'Supplier added'); } catch { return; } pageBills(); }));
  main().querySelectorAll('[data-noinv]').forEach((b) => (b.onclick = async () => { const r = await askNoInv(); if (!r) return; try { await run(async () => await lineUpd('kbiz_payments', b.dataset.noinv, { no_doc: true, no_doc_reason: r }, pageBills), 'Marked: no invoice'); } catch { return; } pageBills(); }));
  main().querySelectorAll('[data-inv]').forEach((b) => (b.onclick = async () => { try { await run(async () => await lineUpd('kbiz_payments', b.dataset.inv, { no_doc: false, no_doc_reason: null }, pageBills), 'Add the bill'); } catch { return; } pageBills(); }));
  main().querySelectorAll('[data-reopen]').forEach((b) => (b.onclick = async () => { try { await run(async () => await lineUpd('kbiz_payments', b.dataset.reopen, { category_id: null, account_code: null }, pageBills), 'Edit the details'); } catch { return; } pageBills(); }));
  main().querySelectorAll('[data-delpay]').forEach((b) => (b.onclick = async (e) => {
    if (!confirmInline(e.target, 'Delete this line and its files?')) return;
    const p = all.find((x) => x.id === b.dataset.delpay);
    const el = b.closest('.cc-r'); if (el) el.hidden = true;
    laterDelete(`${p.fa_ref ? p.fa_ref + ' ' : ''}deleted.`, async () => { must(await sb.from('kbiz_payments').delete().eq('id', p.id)); await sb.storage.from(BUCKET).remove((p.kbiz_docs || []).map((d) => d.file_path)); if (location.hash.startsWith('#/bills')) pageBills(); }, () => { if (el) el.hidden = false; });
  }));
  main().querySelectorAll('[data-retry]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Reading…';
    await sb.functions.invoke('bo-read-kbiz-doc', { body: { doc_id: b.dataset.retry } }); await sb.rpc('pair_kbiz'); pageBills();
  }));
  main().querySelectorAll('[data-deldoc2]').forEach((b) => (b.onclick = async () => {
    const d = all.flatMap((p) => p.kbiz_docs || []).find((x) => x.id === b.dataset.deldoc2);
    try { await run(async () => must(await sb.from('kbiz_docs').delete().eq('id', d.id)), 'Removed'); } catch { return; }
    await sb.storage.from(BUCKET).remove([d.file_path]); pageBills();
  }));
  main().querySelectorAll('[data-deldoc]').forEach((b) => (b.onclick = async () => {
    const d = loose.find((x) => x.id === b.dataset.deldoc);
    try { await run(async () => must(await sb.from('kbiz_docs').delete().eq('id', d.id)), 'Removed'); } catch { return; }
    await sb.storage.from(BUCKET).remove([d.file_path]); pageBills();
  }));
}
async function pageMessages() {
  const t = params().t;
  if (t) return pageThread(t);
  const all = must(await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(150));
  // One row per question thread (its latest message); everything else as before
  const seen = new Set(), list = [];
  for (const m of all) { if (m.thread_id) { if (seen.has(m.thread_id)) continue; seen.add(m.thread_id); } list.push(m); }
  const tids = [...seen];
  const reps = tids.length ? must(await sb.from('day_question_replies').select('question_id').in('question_id', tids)) : [];
  const cnt = (id) => reps.filter((r) => r.question_id === id).length - 1;
  const when = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const item = (m) => {
    const unread = m.thread_id ? all.some((x) => x.thread_id === m.thread_id && !x.read_at) : !m.read_at;
    const href = m.thread_id ? `#/messages?t=${m.thread_id}` : (m.link || '#/ot');
    const pcOnly = !m.thread_id && isPhone() && !phoneAllowed(href.replace(/^#/, '').split('?')[0]);
    const n = m.thread_id ? cnt(m.thread_id) : 0;
    const main = `<span>${esc(m.body)}</span>${m.thread_id ? `<span class="msg-rc">${n > 0 ? `${n} repl${n === 1 ? 'y' : 'ies'}` : 'Reply'}</span>` : ''}`;
    return `<div class="msg${unread ? ' msg-new' : ''}">${pcOnly ? `<div class="msg-main">${main}</div>` : `<a class="msg-main" href="${esc(href)}">${main}</a>`}${(m.details || []).length && !pcOnly ? `<div class="msg-lines">${m.details.map((d) => `<a href="${esc(d.link)}"><b>${esc(d.label)}</b>${d.note ? ` <span class="msg-note">${esc(d.note)}</span>` : ''}</a>`).join('')}</div>` : ''}<span class="faint msg-t">${esc(when(m.created_at))}${pcOnly ? '<span class="msg-pc">Open on a computer</span>' : ''}</span></div>`;
  };
  shell(`<div class="page-head"><div><h1>Messages</h1><p>Returns, approvals, payments, questions about your timesheet and reminders. Tap one to open it.</p></div></div>
  <div class="card">${list.length ? list.map(item).join('') : '<div class="empty">No messages yet.</div>'}</div>`);
  if (all.some((m) => !m.read_at && !m.thread_id)) { await sb.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null).is('thread_id', null); pollMessages(); }
}
async function pageThread(id) {
  const q = must(await sb.from('day_questions').select('*').eq('id', id).maybeSingle());
  if (!q) { shell('<div class="empty">This question is no longer available.</div>'); return; }
  const reps = must(await sb.from('day_question_replies').select('*').eq('question_id', id).order('created_at'));
  const ids = [...new Set([q.staff_id, q.asked_by, ...reps.map((r) => r.author)])];
  const ppl = Object.fromEntries(must(await sb.from('profiles').select('id, full_name').in('id', ids)).map((x) => [x.id, x.full_name]));
  const mine = q.staff_id === S.user.id;
  const qd = new Date(`${q.day}T00:00:00`), pEnd = iso(new Date(qd.getFullYear(), qd.getMonth() + (qd.getDate() > 25 ? 1 : 0), 25));
  const dayHref = `#/ot?p=${pEnd}&d=${q.day}${mine ? '' : '&u=' + q.staff_id}`;
  const when = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  shell(`<a class="faint" href="#/messages" style="text-decoration:none;font-size:13px">‹ Messages</a>
  <div class="page-head"><div><h1>${esc(dateLabel(q.day))}</h1><p>Question about ${mine ? 'your' : esc(ppl[q.staff_id] || '') + "'s"} timesheet</p></div></div>
  <div class="card card-pad"><div class="th-list">${reps.map((r) => `<div class="th-b${r.author === S.user.id ? ' th-me' : ''}"><div class="th-w">${r.author === S.user.id ? 'You' : esc(ppl[r.author] || '')} · ${esc(when(r.created_at))}</div><div>${esc(r.body)}</div></div>`).join('')}</div>
    <a class="btn" href="${dayHref}" style="width:100%;margin:10px 0">Open ${esc(dateLabel(q.day))} in ${mine ? 'my' : 'their'} timesheet</a>
    <form id="thf" class="row" style="gap:6px;flex-wrap:nowrap"><input class="input" name="b" placeholder="Write a reply" style="flex:1" autocomplete="off"><button class="btn primary">Send</button></form><div class="error" id="therr"></div></div>`);
  document.getElementById('thf').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.b.value.trim();
    if (!b) { document.getElementById('therr').textContent = 'Write a reply first.'; return; }
    const { error } = await sb.rpc('reply_day_question', { p_question: id, p_text: b });
    if (error) { document.getElementById('therr').textContent = error.message; return; }
    pageThread(id);
  };
  await sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('thread_id', id).is('read_at', null);
  pollMessages();
}
// HR and admin: hours per person for one 26th-25th period. Totals count approved timesheets only.
async function pagePayroll() {
  const per = otPeriod(params().p);
  const [people, forms, sets, offs] = await Promise.all([
    sb.from('profiles').select('id, full_name, staff_no, role, active').eq('active', true).eq('no_timesheet', false).order('staff_no').then(must),
    sb.from('ot_forms').select('id, staff_id, status').eq('period_end', per.end).then(must),
    sb.from('ot_settings').select('staff_id, pay_type').then(must),
    sb.from('ot_offday').select('staff_id, day, choice').then(must),
  ]);
  const ents = forms.length ? must(await sb.from('ot_entries').select('*').in('form_id', forms.map((f) => f.id))) : [];
  const ST = { draft: ['Draft', 'off'], submitted: ['Submitted', 'submitted'], checked: ['Checked by HR', 'submitted'], approved: ['Approved', 'paid'], paid: ['Paid', 'paid'], rejected: ['Returned', 'rejected'] };
  const TYPE = { full_time: 'Full-time', part_time: 'Part-time', freelance: 'Freelance' };
  const SHORT = { annual: 'AL', sick: 'Sick', personal: 'Pers', replacement: 'Repl', other: 'Other' };
  const ok = (st) => ['approved', 'paid'].includes(st);
  const tot = { ot: 0, x2: 0, saved: 0, repl: 0 };
  const rows = people.map((x) => {
    const f = forms.find((y) => y.staff_id === x.id);
    const pt = sets.find((y) => y.staff_id === x.id)?.pay_type || 'full_time';
    const es = f ? ents.filter((e) => e.form_id === f.id) : [];
    const offd = Object.fromEntries(offs.filter((o) => o.staff_id === x.id).map((o) => [o.day, o.choice]));
    const sp = otSplit(es, offd);
    const lv = {}; es.filter((e) => e.leave_type).forEach((e) => { (lv[e.leave_type] ||= new Set()).add(e.work_date); });
    const repl = lv.replacement?.size || 0;
    const leave = Object.entries(lv).filter(([k]) => k !== 'replacement').map(([k, d]) => `${SHORT[k] || k} ${d.size}`).join(', ');
    const fl = pt === 'freelance';
    const worked = Math.round(es.reduce((a, e) => a + Number(e.hours || 0), 0) * 100) / 100;
    if (f && ok(f.status) && !fl) { tot.ot += sp.ot; tot.x2 += sp.x2; tot.saved += sp.saved; tot.repl += repl; }
    return { x, f, pt, sp, repl, leave: fl ? (f ? `Worked ${worked} h` : '') : leave, fl };
  });
  const R2 = (n) => Math.round(n * 100) / 100;
  const notOk = rows.filter((r) => !r.f || !ok(r.f.status)).length;
  const cell = (r, v) => (r.fl || !r.f ? '-' : v);
  const table = `<table class="paytbl"><thead><tr><th>Staff</th><th>Type</th><th>Timesheet</th><th class="num">Workday OT<div class="faint">hours</div></th><th class="num">Day off x2<div class="faint">hours</div></th><th class="num">Saved days</th><th class="num">Replacement<div class="faint">days used</div></th><th>Leave</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-href="#/ot?p=${per.end}&u=${r.x.id}"><td>${esc(r.x.full_name)}<div class="faint mono">${esc(r.x.staff_no || '')}</div></td><td>${TYPE[r.pt] || r.pt}</td><td>${r.f ? `<span class="pill ${ST[r.f.status]?.[1] || ''}">${ST[r.f.status]?.[0] || r.f.status}</span>` : '<span class="faint">Not started</span>'}</td><td class="num">${cell(r, r.sp.ot)}</td><td class="num">${cell(r, r.sp.x2)}</td><td class="num">${cell(r, r.sp.saved)}</td><td class="num">${cell(r, r.repl)}</td><td>${esc(r.leave || '-')}</td></tr>`).join('')}
    <tr style="font-weight:600"><td colspan="3">Total (approved only)</td><td class="num">${R2(tot.ot)}</td><td class="num">${R2(tot.x2)}</td><td class="num">${tot.saved}</td><td class="num">${tot.repl}</td><td></td></tr></tbody></table>`;
  shell(`<div class="page-head"><div><h1>Payroll summary · ${esc(per.label)}</h1><p>${esc(dateLabel(per.start))} to ${esc(dateLabel(per.end))} · hours only, rates are applied in payroll</p></div>
    <div class="row"><a class="btn small" href="#/payroll?p=${per.prev}">‹</a><a class="btn small" href="#/payroll?p=${per.next}">›</a><button class="btn small" id="pyprint">Print</button><button class="btn small" id="pycsv">Excel</button></div></div>
  ${notOk ? `<div class="banner warn" style="margin-bottom:12px">${notOk} of ${rows.length} timesheet${rows.length === 1 ? '' : 's'} not approved yet. Their numbers may still change and are left out of the totals.</div>` : ''}
  <div class="card"><div class="table-wrap">${table}</div></div>
  <div class="faint" style="font-size:12px;margin-top:8px">Click a name to open their timesheet. Freelancers show hours worked instead of OT.</div>`);
  bindRowLinks();
  document.getElementById('pyprint').onclick = () => printSheet(`<div class="ps-head"><div><b>Bloom Chiangmai</b><div>Payroll summary · ${esc(per.label)}</div></div><div style="text-align:right">${esc(dateLabel(per.start))} to ${esc(dateLabel(per.end))}<br>Printed ${esc(dateLabel(iso(new Date())))}</div></div>${table}`);
  document.getElementById('pycsv').onclick = () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Staff', 'Staff no', 'Type', 'Timesheet', 'Workday OT h', 'Day off x2 h', 'Saved days', 'Replacement days', 'Leave'].map(q).join(',')]
      .concat(rows.map((r) => [r.x.full_name, r.x.staff_no, TYPE[r.pt] || r.pt, r.f ? ST[r.f.status]?.[0] : 'Not started', cell(r, r.sp.ot), cell(r, r.sp.x2), cell(r, r.sp.saved), cell(r, r.repl), r.leave].map(q).join(',')));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv' })); a.download = `payroll-${per.end.slice(0, 7)}.csv`; a.click();
  };
}
// FlowAccount supplier names for the Supplier box (loaded once, in the background)
async function loadFAVendors() {
  const out = []; let from = 0;
  for (;;) { const { data } = await sb.from('fa_vendors').select('label').order('label').range(from, from + 999); if (!data?.length) break; out.push(...data.map((x) => x.label)); if (data.length < 1000) break; from += 1000; }
  const { data: nv } = await sb.from('fa_new_vendors').select('name, created_by_name').is('exported_at', null);
  S.faNew = nv || [];
  S.faVendors = [...out, ...S.faNew.map((x) => x.name)]; S.faVendorSet = new Set(S.faVendors.map((x) => x.toLowerCase()));
}
// A line needs a supplier picked from the FlowAccount list (receipt forms and cash bills use FlowAccount's ready-made ones)
const needsSupplier = (i) => !['receipt_form', 'cash_bill'].includes(i.doc_type || '') && !(S.faVendorSet || new Set()).has(String(i.merchant || '').trim().toLowerCase());
const normName = (t) => String(t || '').toLowerCase().replace(/(co\.?,?\s*ltd\.?|company limited|บริษัท|จำกัด|\(มหาชน\)|public)/gi, '').replace(/[^\p{L}\p{N}]/gu, '');
// Names in the list that look like the typed one ("Did you mean ...?")
const similarSuppliers = (t) => { const n = normName(t); if (n.length < 3) return []; return (S.faVendors || []).filter((x) => { const m = normName(x); return m && m.length >= 3 && (m === n || m.startsWith(n) || n.startsWith(m) || (n.length >= 5 && m.includes(n))); }).slice(0, 4); };
// Read an .xlsx in the browser: { sheetName: [[cell, cell, ...], ...] } with cells at their real column positions
async function readXlsx(file) {
  const b = new Uint8Array(await file.arrayBuffer()), dv = new DataView(b.buffer);
  let e = b.length - 22; while (e > 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const F = {};
  for (let i = 0; i < n; i++) { const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true); F[new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl))] = { comp: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), lo: dv.getUint32(p + 42, true) }; p += 46 + nl + el + cl; }
  const read = async (name) => { const f = F[name]; if (!f) return ''; const s0 = f.lo + 30 + dv.getUint16(f.lo + 26, true) + dv.getUint16(f.lo + 28, true); const d = b.subarray(s0, s0 + f.size); return f.comp === 0 ? new TextDecoder().decode(d) : new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text(); };
  const X = async (name) => new DOMParser().parseFromString(await read(name), 'text/xml');
  const strs = [...(await X('xl/sharedStrings.xml')).getElementsByTagName('si')].map((x) => x.textContent);
  const rels = Object.fromEntries([...(await X('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')].map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const col = (ref) => { let c = 0; for (const ch of ref.replace(/\d+/g, '')) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };
  const out = {};
  for (const sh of (await X('xl/workbook.xml')).getElementsByTagName('sheet')) {
    const t = rels[sh.getAttribute('r:id')] || ''; const path = 'xl/' + t.replace(/^\/?xl\//, '');
    out[sh.getAttribute('name')] = [...(await X(path)).getElementsByTagName('row')].map((r) => { const a = []; for (const c of r.getElementsByTagName('c')) { const v = c.getElementsByTagName('v')[0]?.textContent ?? c.textContent; a[col(c.getAttribute('r'))] = c.getAttribute('t') === 's' ? strs[+v] : v; } return a; });
  }
  return out;
}
const FA_PAY_LABEL = { own_money: 'Personal cash', cash_advance: 'Petty cash', company_card: 'Company card', kbiz: 'KBIZ' };
// Settings › FlowAccount: refresh suppliers, projects and account codes from FlowAccount's import template
async function pageFALists() {
  const [meta, nv, np, na] = await Promise.all([
    sb.from('fa_meta').select('*').eq('id', 1).single().then(must),
    sb.from('fa_vendors').select('label', { count: 'exact', head: true }),
    sb.from('fa_projects').select('name', { count: 'exact', head: true }),
    sb.from('fa_accounts').select('code', { count: 'exact', head: true }),
  ]);
  const accList = (await sb.from('fa_accounts').select('code, name').order('code')).data || [];
  const pm = meta.pay_map || {};
  shell(`<div class="page-head"><div><h1>FlowAccount</h1><p>The suppliers, projects and account codes the back office uses, copied from FlowAccount.</p></div></div>
  <div class="stack">
    <div class="card card-pad"><div class="spread"><div><b>FlowAccount lists</b><div class="faint" style="font-size:12px">${meta.updated_at ? `Last updated ${esc(dateLabel(meta.updated_at))} by ${esc(meta.updated_by_name || '')}` : 'Not uploaded yet'} · ${nv.count || 0} suppliers · ${np.count || 0} projects · ${na.count || 0} account codes</div></div>
      <label class="btn">Upload new template<input type="file" id="fafile" accept=".xlsx" hidden></label></div>
      <div class="faint" style="font-size:12px;margin-top:8px">In FlowAccount: Expense › Import bills and receipts › Import from .csv, .xls, .xlsx › Download sample file. Upload that file here. Add new suppliers in FlowAccount's Address Book first, then upload again.</div></div>
    <div class="card card-pad"><b>Payment method names in FlowAccount</b><div class="faint" style="font-size:12px;margin:4px 0 10px">Type each name exactly as it appears in FlowAccount's payment channels. Leave blank and those lines import as unpaid.</div>
      <div class="grid-form">${Object.entries(FA_PAY_LABEL).map(([k, l]) => `<div class="field"><label>${l}</label><input class="input" data-pm="${k}" value="${esc(pm[k] || '')}" placeholder="e.g. Cash"></div>`).join('')}</div>
      <div style="margin-top:10px"><button class="btn" id="pmsave">Save names</button></div></div>
    <div class="card"><div class="card-pad"><b>Account codes</b><div class="faint" style="font-size:12px;margin-top:4px">Which FlowAccount account each category goes to in the expenses file. Staff never see these. Bank is used for KBIZ lines.</div></div>
      <div class="table-wrap"><table><thead><tr><th>Category</th><th>Cash or card</th><th>Bank</th></tr></thead><tbody>
      ${(S.categories || []).filter((c) => c.active).map((c) => `<tr data-ac="${c.id}"><td>${esc(c.name)}${!c.fa_code && !c.fa_code_bank ? ' <span class="ln-p warn">No FlowAccount code</span>' : ''}</td><td><input class="input" list="faacc" data-k="fa_code" value="${esc(c.fa_code || '')}" placeholder="Pick an account"></td><td><input class="input" list="faacc" data-k="fa_code_bank" value="${esc(c.fa_code_bank || '')}" placeholder="Pick an account"></td></tr>`).join('')}
      </tbody></table></div><datalist id="faacc">${(accList || []).map((a) => `<option value="${esc(a.code)} ${esc(a.name || '')}">`).join('')}</datalist></div>
  </div>`);
  main().querySelectorAll('[data-ac] input').forEach((el) => (el.onchange = async () => { const id = el.closest('[data-ac]').dataset.ac;
    try { await run(async () => must(await sb.from('expense_categories').update({ [el.dataset.k]: el.value.trim() || null }).eq('id', id)), 'Saved'); } catch { return; }
    S.categories = must(await sb.from('expense_categories').select('*').order('sort_order')); }));
  document.getElementById('fafile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      await run(async () => {
        const x = await readXlsx(file);
        const V = x.Vendors, P = x.Projects, A = x['Chart of Accounts'];
        if (!V || !P || !A) throw new Error('This is not FlowAccount\'s expense import template (Vendors, Projects or Chart of Accounts sheet missing).');
        const vendors = V.slice(1).filter((r) => r && (r[5] || r[0])).map((r) => ({ label: String(r[5] || r[0]).trim(), name: r[1] ? String(r[1]).trim() : String(r[0] || '').trim(), contact_type: r[2] || null, tax_id: r[3] || null, branch: r[4] || null }));
        const projects = P.slice(1).filter((r) => r && r[0]).map((r) => ({ name: String(r[0]).trim() }));
        const accounts = A.filter((r) => r && r[0] && r[3] && /\//.test(r[3])).map((r) => ({ code: String(r[0]).trim(), name: r[1] || '', kind: r[2] || '', label: String(r[3]).trim() }));
        if (!vendors.length) throw new Error('No suppliers found in the file.');
        must(await sb.rpc('fa_replace_lists', { p_vendors: vendors, p_projects: projects, p_accounts: accounts }));
      }, 'FlowAccount lists updated');
    } catch { return; }
    await loadFAVendors(); pageFALists();
  };
  document.getElementById('pmsave').onclick = async () => {
    const m = {}; main().querySelectorAll('[data-pm]').forEach((i) => { if (i.value.trim()) m[i.dataset.pm] = i.value.trim(); });
    try { await run(async () => must(await sb.from('fa_meta').update({ pay_map: m }).eq('id', 1)), 'Saved'); } catch { /* shown */ }
  };
}
// Review › Send to FlowAccount: one CSV per month in FlowAccount's import format, one document per receipt line
async function pageFAExport() {
  const key = params().m || '';
  const reps = must(await sb.from('expense_reports').select('*').in('status', ['approved', 'paid']).order('period_month', { ascending: false }));
  const cardSt = must(await sb.from('card_statements').select('id, period_month').eq('status', 'ready'));
  let kpAll = must(await sb.from('kbiz_payments').select('*, kbiz_docs(*)').eq('admin_only', false));
  const months = [...new Set([...reps.map((r) => r.period_month.slice(0, 7)), ...cardSt.map((x) => x.period_month.slice(0, 7)), ...kpAll.map((x) => x.period_month.slice(0, 7))])].sort().reverse();
  const mk = key || months[0] || new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 7); // empty back office: this month
  // Fixed references (BILLyymmA, CARDyymmA): given once, never move, so paper and FlowAccount always agree
  if (mk) { await sb.rpc('assign_fa_refs', { p_month: mk + '-01' }); kpAll = must(await sb.from('kbiz_payments').select('*, kbiz_docs(*)').eq('admin_only', false)); }
  const stIds = cardSt.filter((x) => x.period_month.slice(0, 7) === mk).map((x) => x.id);
  const cardLines = stIds.length ? must(await sb.from('card_charges').select('*').in('statement_id', stIds).or('doc_path.not.is.null,no_doc.eq.true').is('item_id', null).not('merchant', 'is', null).order('trans_date')).filter((c) => c.account_code || c.category_id) : [];
  const list = reps.filter((r) => r.period_month.slice(0, 7) === mk);
  const ids = list.map((r) => r.id);
  const [items, staff, projs, accs, vend, meta, projRows] = await Promise.all([
    ids.length ? sb.from('expense_items').select('*').in('report_id', ids).order('invoice_date').order('created_at').then(must) : [],
    sb.from('profiles').select('id, full_name').then(must),
    sb.from('fa_projects').select('name').then(must),
    sb.from('fa_accounts').select('code, label').then(must),
    sb.from('fa_vendors').select('label, contact_type').then(must),
    sb.from('fa_meta').select('*').eq('id', 1).single().then(must),
    sb.from('projects').select('id, name, code').then(must),
  ]);
  const P = Object.fromEntries(staff.map((x) => [x.id, x.full_name]));
  const PJ = new Set(projs.map((x) => x.name)), AC = Object.fromEntries(accs.map((x) => [x.code, x.label]));
  // Supplier names: "Uniform tailor (individual payee)" matches "Uniform tailor"
  const vKey = (n) => String(n || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  const VD = Object.fromEntries(vend.flatMap((x) => [[vKey(x.label), x], [x.label.toLowerCase(), x]]));
  const vFind = (n) => VD[String(n || '').trim().toLowerCase()] || VD[vKey(n)];
  const unknown = new Map();
  const miss = (n) => { const k = vKey(n); if (k && !unknown.has(k)) unknown.set(k, String(n).replace(/\s*\([^)]*\)\s*$/, '').trim()); return `supplier "${String(n).replace(/\s*\([^)]*\)\s*$/, '').trim()}" is new: it goes in the new suppliers file (step 1) first`; };
  const pm = meta.pay_map || {};
  const dmy2 = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
  const WHTD = { 1: 'ค่าขนส่ง', 2: 'ค่าโฆษณา', 3: 'ค่าบริการ', 5: 'ค่าเช่า' };
  const rowsFor = (r) => items.filter((i) => i.report_id === r.id).map((i, n) => {
    const c = S.categories.find((x) => x.id === i.category_id) || {};
    const code = String((i.payment_method === 'kbiz' ? (c.fa_code_bank || c.fa_code) : c.fa_code) || '').trim().split(/\s+/)[0];
    // FlowAccount has these 2 as ready-made suppliers in your Address Book
    const sup = i.doc_type === 'receipt_form' ? 'ใบรับรองแทนใบเสร็จรับเงิน/ Receipt form' : i.doc_type === 'cash_bill' && !i.merchant ? 'บิลเงินสด/Cash bill' : (i.merchant || '');
    const v = vFind(sup);
    const pr = projRows.find((x) => x.id === r.project_id);
    const pjName = r.form_type === 'project' ? (pr?.code || '') : `BCMEXP${r.period_month.slice(2, 4)}${r.period_month.slice(5, 7)}`;
    const vat = Number(i.vat_amount || 0), amt = Number(i.amount || 0), wr = Number(i.wht_rate || 0);
    const problems = [!v ? (sup ? miss(sup) : 'no supplier on the line') : '', !code ? `no FlowAccount code for ${c.name || 'category'}` : code && !AC[code] ? `code ${code} not in FlowAccount` : ''].filter(Boolean);
    return { i, n, problems, cols: [dmy2(i.invoice_date), '', '', `${r.ref_no}-${String(n + 1).padStart(2, '0')}`, PJ.has(pjName) ? pjName : '', (i.purpose || '').slice(0, 255), (i.item || '').slice(0, 1500), AC[code] || code || '', 1, '', (Math.round((amt - vat) * 100) / 100).toFixed(2), '', vat > 0 ? '7%' : 'No VAT (N/A)', v ? v.label : sup, '', '', '', '', pm[i.payment_method] ? dmy2(r.paid_at || i.invoice_date) : '', pm[i.payment_method] || '', wr ? (v?.contact_type === 'Corporation' ? 'P.N.D.53' : 'P.N.D.3') : '', wr ? '6. Others (Please specify)' : '', wr ? (WHTD[wr] || 'ค่าบริการ') : '', wr ? `${wr}%` : '', '', `${P[r.staff_id] || ''} · ${r.ref_no}`] };
  });
  const all = list.map((r) => ({ r, rows: rowsFor(r) }));
  // Company card charges finished on the Company card page with an attached file (not on any staff form)
  const yymm = `${mk.slice(2, 4)}${mk.slice(5, 7)}`;
  const cardRows = cardLines.map((c, n) => {
    const cat = S.categories.find((x) => x.id === c.category_id) || {};
    const code = c.account_code || String(cat.fa_code || '').trim().split(/\s+/)[0];
    const v = vFind(c.merchant);
    const vat = Number(c.vat_amount || 0), amt = Number(c.amount || 0), pjName = `BCMEXP${yymm}`;
    const problems = [!c.fa_ref ? 'no fixed number yet, reload the page' : '', !v ? miss(c.merchant) : '', !code ? `no FlowAccount account chosen` : !AC[code] ? `code ${code} not in FlowAccount` : ''].filter(Boolean);
    return { c, problems, cols: [dmy2(c.trans_date), '', '', c.fa_ref || '', PJ.has(pjName) ? pjName : '', `${c.fa_ref || ''} · ${c.purpose || ''}`.slice(0, 255), (c.description || '').slice(0, 1500), AC[code] || code || '', 1, '', (Math.round((amt - vat) * 100) / 100).toFixed(2), '', vat > 0 ? '7%' : 'No VAT (N/A)', v ? v.label : c.merchant, '', '', '', '', pm.company_card ? dmy2(c.trans_date) : '', pm.company_card || '', '', '', '', '', '', `Company card${c.currency && c.foreign_amount ? ` · ${c.currency} ${c.foreign_amount}` : ''}`] };
  });
  const cardReady0 = cardRows.filter((y) => !y.problems.length && !y.c.fa_done), cardBad0 = cardRows.filter((y) => y.problems.length && !y.c.fa_done);
  // Supplier bills paid by KBIZ: bill and slip both there, supplier and category set
  const kd = (p, k) => (p.kbiz_docs || []).find((d) => d.kind === k && d.status === 'ready');
  const billLines = kpAll.filter((p) => p.period_month.slice(0, 7) === mk && (kd(p, 'bill') || p.no_doc) && kd(p, 'slip') && p.merchant && (p.account_code || p.category_id))
    .sort((a, b) => refSort(a.fa_ref, b.fa_ref));
  const billRows = billLines.map((p, n) => {
    const sl = kd(p, 'slip'), b = kd(p, 'bill') || { amount: sl.amount, doc_date: sl.doc_date };
    const cat = S.categories.find((x) => x.id === p.category_id) || {};
    const code = p.account_code || String((cat.fa_code_bank || cat.fa_code) || '').trim().split(/\s+/)[0];
    const v = vFind(p.merchant);
    const vat = Number(p.vat_amount || 0), wr = Number(p.wht_rate || 0), amt0 = Number(b.amount || sl.amount || 0), amt = p.wht_on_top && wr ? Math.round(amt0 / (1 - wr / 100) * 100) / 100 : amt0;
    const problems = [!p.fa_ref ? 'no fixed number yet, reload the page' : '', !v ? miss(p.merchant) : '', !code ? `no FlowAccount account chosen` : !AC[code] ? `code ${code} not in FlowAccount` : ''].filter(Boolean);
    return { c: p, kind: 'bill', problems, cols: [dmy2(b.doc_date || sl.doc_date), '', '', p.fa_ref || '', PJ.has(`BCMEXP${yymm}`) ? `BCMEXP${yymm}` : '', `${p.fa_ref || ''} · ${p.purpose || ''}`.slice(0, 255), (b.item || sl.memo || p.merchant || '').slice(0, 1500), AC[code] || code || '', 1, '', (Math.round((amt - vat) * 100) / 100).toFixed(2), '', vat > 0 ? '7%' : 'No VAT (N/A)', v ? v.label : p.merchant, b.tax_id || '', '', '', '', pm.kbiz ? dmy2(sl.doc_date) : '', pm.kbiz || '', wr ? (v?.contact_type === 'Corporation' ? 'P.N.D.53' : 'P.N.D.3') : '', wr ? '6. Others (Please specify)' : '', wr ? (WHTD[wr] || 'ค่าบริการ') : '', wr ? `${wr}%` : '', '', `K BIZ ${sl.txn_no || ''}${p.wht_on_top && wr ? ` · WHT ${wr}% paid on top, slip ${money(amt0)}` : ''}${p.no_doc ? ` · No invoice: ${p.no_doc_reason || ''}` : ''}`] };
  });
  const cardReady = [...cardReady0, ...billRows.filter((y) => !y.problems.length && !y.c.fa_done)], cardBad = [...cardBad0, ...billRows.filter((y) => y.problems.length && !y.c.fa_done)];
  const todo = all.filter((x) => !x.r.fa_entered_at);
  const ready = todo.flatMap((x) => x.rows.filter((y) => !y.problems.length && !y.i.fa_done));
  const bad = [...todo.flatMap((x) => x.rows.filter((y) => y.problems.length && !y.i.fa_done)), ...cardBad];
  const noLists = !vend.length;
  // Unknown suppliers on finished lines go into the new suppliers file by themselves
  if (unknown.size) {
    const have = new Set(must(await sb.from('fa_new_vendors').select('name')).map((x) => vKey(x.name)));
    const add = [...unknown.entries()].filter(([k]) => !have.has(k)).map(([, name]) => ({ name, business_type: /(co\.?,?\s*ltd|company|limited|inc\.?|corp|part|บริษัท|ห้างหุ้นส่วน|หจก|จำกัด)/i.test(name) ? 'Corporation' : 'Individual', created_by: S.user.id, created_by_name: 'Back office (from the lines)' }));
    for (const r of add) await sb.from('fa_new_vendors').insert(r);
  }
  const newV = must(await sb.from('fa_new_vendors').select('*').is('exported_at', null).order('created_at'));
  // Month close: Status, Spending, FlowAccount tabs
  const [mReps, mCh] = await Promise.all([
    sb.from('expense_reports').select('id, status, form_type, staff_id, ref_no, project_id, project').gte('period_month', mk + '-01').lte('period_month', mk + '-28').then(must),
    stIds.length ? sb.from('card_charges').select('id, item_id, doc_path, no_doc, merchant, account_code, category_id, amount').in('statement_id', stIds).then(must) : [],
  ]);
  const cardOpen = mCh.filter((c) => !c.item_id && !((c.doc_path || c.no_doc) && c.merchant && (c.account_code || c.category_id))).length;
  const mPay = kpAll.filter((p) => p.period_month.slice(0, 7) === mk);
  const billOpen = mPay.length - billLines.length;
  const tab = ['status', 'spending', 'fa'].includes(params().t) ? params().t : 'status';
  const WAIT = ['draft', 'submitted', 'checked', 'rejected'];
  const pcR = mReps.filter((r) => r.form_type !== 'project'), pjR = mReps.filter((r) => r.form_type === 'project');
  const openSrc = [pcR.some((r) => WAIT.includes(r.status)), pjR.some((r) => WAIT.includes(r.status)), billOpen > 0, !stIds.length || cardOpen > 0].filter(Boolean).length;
  const tabs = `<div class="mc-tabs">${[['status', 'Status', openSrc], ['spending', 'Spending', 0], ['fa', 'FlowAccount', 0]].map(([k, l, n]) => `<a href="#/fa-export?m=${mk}&t=${k}" class="${k === tab ? 'on' : ''}">${l}${n ? `<span class="mc-c">${n}</span>` : ''}</a>`).join('')}</div>`;
  let body = '';
  if (tab === 'status') {
    const mItems = mReps.length ? must(await sb.from('expense_items').select('report_id, amount').in('report_id', mReps.map((r) => r.id))) : [];
    const sumOf = (r) => mItems.filter((i) => i.report_id === r.id).reduce((a, i) => a + Number(i.amount || 0), 0);
    const cntOf = (r) => mItems.filter((i) => i.report_id === r.id).length;
    const ORDER = { checked: 0, rejected: 1, submitted: 2, draft: 3 };
    const lab = (r) => r.status === 'draft' ? ['Not submitted', 'gr'] : r.status === 'submitted' ? [r.checker_name ? 'With ' + r.checker_name : 'With checker', 'warn'] : r.status === 'checked' ? [isAdmin() ? 'Waiting for you' : 'Waiting for admin', 'warn'] : r.status === 'rejected' ? [`Returned to ${(P[r.staff_id] || '').split(' ')[0]}`, 'warn'] : r.status === 'paid' ? ['Paid', 'ok'] : ['Approved', 'ok'];
    const person = (r) => { const [t, k] = lab(r); return `<a class="mc-p" href="#/report/${r.id}"><b>${esc(P[r.staff_id] || '')}</b><span class="mono">${esc(r.ref_no || '')}</span><span class="faint">${cntOf(r)} line${cntOf(r) === 1 ? '' : 's'}</span><span class="num">${money(sumOf(r))}</span><span class="ln-p ${k}">${esc(t)}</span></a>`; };
    const group = (key, dot, name, reps, extraSub) => {
      const w = reps.filter((r) => WAIT.includes(r.status)).sort((x, y) => ORDER[x.status] - ORDER[y.status]), d = reps.filter((r) => !WAIT.includes(r.status));
      const total = reps.reduce((a, r) => a + sumOf(r), 0);
      const st = !reps.length ? `<span class="ln-p gr">No forms</span>` : w.length ? `<span class="ln-p warn">${w.length} not approved yet</span>` : `<span class="ln-p ok">Done</span>`;
      return `<details class="mc-row" ${w.length ? 'open' : ''}><summary><i class="mc-dot" style="background:${dot}"></i><b>${name}</b><span class="faint">${reps.length ? `${reps.length} form${reps.length > 1 ? 's' : ''} · THB ${money(total)}${extraSub || ''}` : 'Nothing this month'}</span><span class="mc-r">${st}<span class="ln-chev">›</span></span></summary>
        ${reps.length ? `<div class="mc-in">${w.map(person).join('')}${d.length ? `<details class="mc-done"><summary>${d.length} approved</summary>${d.map(person).join('')}</details>` : ''}</div>` : ''}</details>`;
    };
    const link = (dot, name, href, sub, st) => `<a class="mc-row mc-link" href="${href}"><i class="mc-dot" style="background:${dot}"></i><b>${name}</b><span class="faint">${sub}</span><span class="mc-r">${st}<span class="ln-chev">›</span></span></a>`;
    const bT = mPay.reduce((a, p) => a + Number(((p.kbiz_docs || []).find((d) => d.kind === 'bill' && d.status === 'ready') || (p.kbiz_docs || []).find((d) => d.kind === 'slip' && d.status === 'ready') || {}).amount || 0), 0);
    const doneN = 4 - openSrc;
    body = `<div class="mc-prog"><b>${doneN} of 4 done</b><span class="faint">The month is closed when all 4 are done and in FlowAccount.</span></div><div class="cc-bar" style="margin:6px 0 16px"><div style="width:${doneN * 25}%"></div></div>
      <div class="card mc-list">
      ${group('pc', '#1D9E75', 'Petty Cash', pcR)}
      ${group('pj', '#7F77DD', 'Projects', pjR)}
      ${link('#888780', 'Bank transfers', `#/bills?m=${mk}`, mPay.length ? `${mPay.length} line${mPay.length > 1 ? 's' : ''} · THB ${money(bT)}` : 'Nothing uploaded yet', !mPay.length ? '<span class="ln-p gr">Nothing yet</span>' : billOpen ? `<span class="ln-p warn">${billOpen} to finish</span>` : '<span class="ln-p ok">Done</span>')}
      ${link('#888780', 'Card payments', `#/card?m=${mk}`, stIds.length ? `${mCh.length} charges · THB ${money(mCh.reduce((a, c) => a + Number(c.amount || 0), 0))}` : 'Statement comes next month', !stIds.length ? '<span class="ln-p gr">Not yet</span>' : cardOpen ? `<span class="ln-p warn">${cardOpen} to find</span>` : '<span class="ln-p ok">Done</span>')}
      </div>`;
  } else if (tab === 'spending') {
    const prevK = monthKey(new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 2, 1));
    const spend = async (k) => {
      const reps2 = must(await sb.from('expense_reports').select('id, status, form_type').gte('period_month', k + '-01').lte('period_month', k + '-28'));
      const its = reps2.length ? must(await sb.from('expense_items').select('report_id, amount, category_id').in('report_id', reps2.map((r) => r.id))) : [];
      const sts2 = must(await sb.from('card_statements').select('id, period_month').eq('status', 'ready')).filter((x) => x.period_month.slice(0, 7) === k);
      const chs = sts2.length ? must(await sb.from('card_charges').select('amount, category_id, item_id').in('statement_id', sts2.map((x) => x.id)).is('item_id', null)) : [];
      const pays = kpAll.filter((p) => p.period_month.slice(0, 7) === k);
      const R = Object.fromEntries(reps2.map((r) => [r.id, r]));
      const rows = [];
      its.forEach((i) => rows.push({ a: Number(i.amount || 0), cat: i.category_id, who: R[i.report_id]?.form_type === 'project' ? 'Projects' : 'Petty Cash', pend: WAIT.includes(R[i.report_id]?.status) }));
      chs.forEach((c) => rows.push({ a: Number(c.amount || 0), cat: c.category_id, who: 'Card payments' }));
      pays.forEach((p) => { const d = (p.kbiz_docs || []).find((x) => x.kind === 'bill' && x.status === 'ready') || (p.kbiz_docs || []).find((x) => x.kind === 'slip' && x.status === 'ready'); const a0 = Number(d?.amount || 0), wr = Number(p.wht_rate || 0); rows.push({ a: p.wht_on_top && wr ? Math.round(a0 / (1 - wr / 100) * 100) / 100 : a0, cat: p.category_id, who: 'Bank transfers' }); });
      return { rows, card: sts2.length > 0 };
    };
    const [cur, prev] = await Promise.all([spend(mk), spend(prevK)]);
    const tot = (x) => x.rows.reduce((a, y) => a + y.a, 0);
    const like = !cur.card && prev.card; if (like) prev.rows = prev.rows.filter((y) => y.who !== 'Card payments');
    const T = tot(cur), PT = tot(prev), pend = cur.rows.filter((y) => y.pend).reduce((a, y) => a + y.a, 0);
    const ch = PT ? Math.round(((T - PT) / PT) * 100) : null;
    const bars = (pairs, color) => { const mx = Math.max(1, ...pairs.map((x) => x[1])); return pairs.map(([l, v]) => `<div class="mc-bar"><span>${esc(l)}</span><div class="mc-tr"><div style="width:${Math.round((v / mx) * 100)}%;background:${color}"></div></div><span class="num">${v ? money(v) : '-'}</span></div>`).join(''); };
    const byCat = {}; cur.rows.forEach((y) => { const n = S.categories.find((c) => c.id === y.cat)?.name || 'No category'; byCat[n] = (byCat[n] || 0) + y.a; });
    const byWho = ['Petty Cash', 'Projects', 'Bank transfers', 'Card payments'].map((w) => [w, cur.rows.filter((y) => y.who === w).reduce((a, y) => a + y.a, 0)]);
    body = `<div class="mc-mets"><div><small>Spent so far</small><b>${money(T)}</b><small>${pend ? `THB ${money(pend)} not approved yet` : 'THB, all approved'}</small></div><div><small>${esc(monthLabel(prevK))}</small><b>${money(PT)}</b><small>${like ? 'THB, without card payments' : 'THB'}</small></div><div><small>Change</small><b>${ch == null ? '-' : (ch > 0 ? '+' : '') + ch + '%'}</b><small>${like ? 'like for like, card statement not in yet' : 'all sources'}</small></div></div>
      <div class="card card-pad" style="margin-bottom:12px"><h2 style="margin:0 0 10px">By category</h2>${bars(Object.entries(byCat).sort((x, y) => y[1] - x[1]), '#1D9E75') || '<div class="faint">Nothing yet</div>'}</div>
      <div class="card card-pad"><h2 style="margin:0 0 10px">By who paid</h2>${bars(byWho, '#888780')}</div>
      <p class="faint" style="font-size:12px">Counts every saved line, approved or not. FlowAccount stays the official number once the month is imported.</p>`;
  } else {
    const nReady = ready.length + cardReady.length;
    const waitSup = bad.filter((y) => y.problems.some((t) => /is new/.test(t)));
    const newNames = newV.map((x) => x.name);
    const nvMissing = (x) => [!String(x.name || '').trim() ? 'name' : '', !/^\d{13}$/.test(String(x.tax_id || '').replace(/\D/g, '')) ? 'Tax ID' : '', String(x.address || '').trim().length < 10 ? 'address' : '', String(x.phone || '').replace(/\D/g, '').length < 9 ? 'phone' : ''].filter(Boolean);
    var nvDone = newV.filter((x) => !nvMissing(x).length);
    body = `${noLists ? '<div class="banner warn" style="margin-bottom:12px">FlowAccount lists are not uploaded yet. Go to Settings › FlowAccount and upload FlowAccount\'s template first.</div>' : ''}
    <div class="card mc-step"><span class="mc-n ${newV.length ? '' : 'ok'}">${newV.length ? '1' : '✓'}</span><div style="flex:1;min-width:0">
      <b>New suppliers file</b> ${newV.length ? `<span class="ln-p ${nvDone.length === newV.length ? 'ok' : 'warn'}">${nvDone.length} of ${newV.length} complete</span>` : '<span class="ln-p ok">Nothing new</span>'}
      <div class="faint" style="font-size:12px;margin-top:4px">${newV.length ? 'Fill in each new supplier: name, type, Tax ID (13 digits), address and phone. Only complete suppliers go into the file; their expense lines follow once they are in FlowAccount.' : 'No new suppliers to add to FlowAccount.'}</div>
      ${newV.length ? `<div class="nv-list">${newV.map((x) => { const m = nvMissing(x); return `<details class="nv-row" data-nv="${x.id}"><summary class="nv-s"><b>${esc(x.name)}</b><span class="faint">${x.business_type === 'Corporation' ? 'Company' : 'Person'}</span><span class="${m.length ? 'ln-p warn' : 'ln-p ok'}">${m.length ? 'Missing: ' + m.join(', ') : 'Complete'}</span><span class="ln-chev">›</span></summary>
        <div class="nv-g">
          <label><span>Business name</span><input class="input" data-k="name" value="${esc(x.name)}"></label>
          <label><span>Type</span><select class="input" data-k="business_type"><option value="Corporation" ${x.business_type === 'Corporation' ? 'selected' : ''}>Company</option><option value="Individual" ${x.business_type === 'Individual' ? 'selected' : ''}>Person</option></select></label>
          <label><span>Tax ID</span><input class="input mono" data-k="tax_id" inputmode="numeric" placeholder="13 digits" value="${esc(x.tax_id || '')}"></label>
          <label class="wide"><span>Address</span><input class="input" data-k="address" placeholder="Number, road, district, province, postcode" value="${esc(x.address || '')}"></label>
          <label><span>Phone</span><input class="input mono" data-k="phone" value="${esc(x.phone || '')}"></label>
        </div>
        <div class="nv-f"><span class="faint" style="font-size:12px;margin-right:auto">Added by ${esc(x.created_by_name || '')}</span><button class="btn ghost small danger" data-nvx="${x.id}">Remove</button><button class="btn small primary" data-nvs="${x.id}">Save</button></div></details>`; }).join('')}</div>
      <div class="faint" style="font-size:12px;margin-top:8px">In FlowAccount: Contacts › Import Contact List.</div>
      <div class="row" style="margin-top:8px;gap:8px"><button class="btn primary" id="nvdl" ${nvDone.length ? '' : 'disabled'}>Download new suppliers (${nvDone.length})</button><button class="btn" id="nvdone" ${nvDone.length ? '' : 'disabled'}>Added in FlowAccount</button></div>` : ''}
    </div></div>
    <div class="card mc-step"><span class="mc-n">2</span><div style="flex:1;min-width:0">
      <b>Expenses file</b> <span class="faint">${nReady} line${nReady === 1 ? '' : 's'} ready</span>
      <div class="faint" style="font-size:12px;margin-top:4px">${[ready.length ? `Staff forms ${ready.length} ready` : '', billRows.filter((y) => !y.problems.length && !y.c.fa_done).length ? `Bank transfers ${billRows.filter((y) => !y.problems.length && !y.c.fa_done).length} ready` : '', cardReady0.length ? `Card payments ${cardReady0.length} ready` : '', !stIds.length ? 'Card payments: statement comes next month' : ''].filter(Boolean).join(' · ') || 'Nothing ready yet.'}</div>
      ${bad.length ? `<div class="mc-wait">${waitSup.length ? `${waitSup.length} line${waitSup.length > 1 ? 's' : ''} wait for new suppliers in step 1.` : ''}${bad.length > waitSup.length ? `${waitSup.length ? ' ' : ''}${bad.length - waitSup.length} other line${bad.length - waitSup.length > 1 ? 's' : ''} not in this file:<ul>${[...new Set(bad.filter((y) => !waitSup.includes(y)).flatMap((y) => y.problems))].map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${bad.length > waitSup.length ? '<div style="margin-top:4px">Correct the line, then it joins the next file.</div>' : ''}</div>` : ''}
      <div class="faint" style="font-size:12px">In FlowAccount: Expense › Import bills and receipts › Import from .csv. On Match Column Headers set Unit Price to <b>Excluding VAT</b>.</div>
      <div class="row" style="margin-top:10px;gap:8px"><button class="btn primary" id="fadl" ${nReady ? '' : 'disabled'}>Download expenses (${nReady})</button><button class="btn" id="faent" ${nReady ? '' : 'disabled'}>Entered in FlowAccount</button></div>
    </div></div>
    <p class="faint" style="font-size:12px">Lines not ready yet go into a later file. Nothing is imported twice.</p>`;
  }
  shell(`<div class="page-head"><div><h1>Month close · ${esc(monthLabel(mk) || '')}</h1></div>
    <div class="row"><select class="input" id="fam" style="width:auto">${months.map((k) => `<option value="${k}" ${k === mk ? 'selected' : ''}>${monthLabel(k)}</option>`).join('') || '<option>No months yet</option>'}</select></div></div>
  ${tabs}${body}`);
  bindRowLinks();
  document.getElementById('fam').onchange = (e) => { location.hash = `#/fa-export?m=${e.target.value}&t=${tab}`; };
  const H = ['Document Date*', 'Credit (days)', 'Due Date', 'Purchase Order / Reference No.', 'Project', 'Document Description', 'Expense Description*', 'Chart of Accounts*', 'Quantity', 'Unit', 'Unit Price*', 'Discount (THB)', 'Tax', 'Vendor*', 'Tax ID', 'Branch Code', 'Address', 'Postal Code', 'Payment Date', 'Payment Method', 'Form (P.N.D.)', 'Income Type', 'Income Type Description', 'WHT Rate %', 'Remarks', 'Internal Note'];
  const fadl = document.getElementById('fadl'); if (fadl) fadl.onclick = () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [H.map(q).join(',')].concat([...ready, ...cardReady].map((y) => y.cols.map(q).join(','))).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); a.download = `flowaccount-expenses-${mk}.csv`; a.click();
  };
  const nvdl = document.getElementById('nvdl');
  if (nvdl) {
    const CH = ['Contact ID', 'Business Name*', 'Contact Type*', 'Business Type*', 'Tax ID', 'Branch Name', 'Branch Code', 'Address', 'Zip Code', 'Shipping Info', 'Phone', 'Fax Number', 'Website', 'Contact Name', 'Email', 'Mobile', 'Credit (Days)', 'Bank', 'Account Name', 'Account Number', 'Bank Branch Code', 'Bank Branch Name', 'Account Type', 'Notes'];
    nvdl.onclick = () => {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [CH.map(q).join(',')].concat(newV.filter((x) => /^\d{13}$/.test(String(x.tax_id || '').replace(/\D/g, '')) && String(x.address || '').trim().length >= 10 && String(x.phone || '').replace(/\D/g, '').length >= 9 && String(x.name || '').trim()).map((x) => [`BO-${x.id}`, x.name, 'Supplier', x.business_type, x.tax_id || '', x.business_type === 'Corporation' ? 'Head Office' : '', x.business_type === 'Corporation' ? '00000' : '', x.address || '', (String(x.address || '').match(/\b(\d{5})\s*$/) || [])[1] || '', '', x.phone || '', '', '', '', '', '', '', '', '', '', '', '', '', `Added in back office by ${x.created_by_name || ''}`].map(q).join(','))).join('\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })); a.download = `flowaccount-new-suppliers-${iso(new Date())}.csv`; a.click();
    };
    document.getElementById('nvdone').onclick = async (e) => {
      if (!confirmInline(e.target, 'Imported in FlowAccount?')) return;
      try { await run(async () => must(await sb.rpc('fa_new_vendors_added', { p_ids: newV.filter((x) => /^\d{13}$/.test(String(x.tax_id || '').replace(/\D/g, '')) && String(x.address || '').trim().length >= 10 && String(x.phone || '').replace(/\D/g, '').length >= 9).map((x) => x.id) })), 'Suppliers added to the FlowAccount list'); } catch { return; }
      await loadFAVendors(); pageFAExport();
    };
    main().querySelectorAll('[data-nvs]').forEach((b) => (b.onclick = async () => {
      const row = main().querySelector(`[data-nv="${b.dataset.nvs}"]`), g = (k) => row.querySelector(`[data-k="${k}"]`).value.trim();
      const tax = g('tax_id').replace(/\D/g, '');
      if (tax && !/^\d{13}$/.test(tax)) { toast('Tax ID must be 13 digits', true); return; }
      try { await run(async () => must(await sb.from('fa_new_vendors').update({ name: g('name'), business_type: g('business_type'), tax_id: tax || null, address: g('address') || null, phone: g('phone') || null }).eq('id', b.dataset.nvs)), 'Saved'); } catch { return; }
      pageFAExport();
    }));
    main().querySelectorAll('[data-nvx]').forEach((b) => (b.onclick = async () => { if (!confirmInline(b, 'Remove?')) return; try { await run(async () => must(await sb.from('fa_new_vendors').delete().eq('id', b.dataset.nvx)), 'Removed'); } catch { return; } pageFAExport(); }));
  }
  const faent = document.getElementById('faent'); if (faent) faent.onclick = async (e) => {
    if (!confirmInline(e.target, `Mark ${ready.length + cardReady.length} lines entered?`)) return;
    try { await run(async () => { for (const y of ready) must(await sb.rpc('mark_fa_line', { p_item: y.i.id, p_done: true })); const cIds = cardReady.filter((y) => y.kind !== 'bill').map((y) => y.c.id), bIds = cardReady.filter((y) => y.kind === 'bill').map((y) => y.c.id);
      if (cIds.length) must(await sb.from('card_charges').update({ fa_done: true }).in('id', cIds));
      if (bIds.length) must(await sb.from('kbiz_payments').update({ fa_done: true }).in('id', bIds)); }, 'Marked as entered in FlowAccount'); } catch { return; }
    pageFAExport();
  };
}
async function pageAgree() {
  const list = must(await sb.from('hr_requests').select('*').eq('staff_id', S.user.id).order('created_at', { ascending: false }).limit(20));
  const LBL = { pay_type: ['Type', { full_time: 'Full-time', part_time: 'Part-time', freelance: 'Freelance' }], start_time: ['Start'], end_time: ['End'], week_pattern: ['Work week', { alt_sat: 'Long/short week', mon_fri: 'Mon to Fri', mon_sat: 'Mon to Sat' }], sat_off_anchor: ['Saturday off'] };
  const show = (k, v) => (v == null || v === '' ? '-' : LBL[k]?.[1]?.[v] || (k.endsWith('_time') ? String(v).slice(0, 5) : k === 'sat_off_anchor' ? dateLabel(v) : String(v)));
  const card = (r) => `<div class="card card-pad" style="margin-bottom:12px">
    <div class="spread"><b>${esc(r.created_by_name || 'HR')} wants to change your timesheet settings</b><span class="faint" style="font-size:12px">${esc(dateLabel(r.created_at.slice(0, 10)))}</span></div>
    <table style="margin:10px 0"><tbody>${Object.entries(r.changes).map(([k, v]) => `<tr><td class="faint" style="width:120px">${esc(LBL[k]?.[0] || k)}</td><td>${esc(show(k, r.before?.[k]))} → <b>${esc(show(k, v))}</b></td></tr>`).join('')}</tbody></table>
    ${r.status === 'pending' ? `<div class="row"><button class="btn primary" data-ag="${r.id}">Agree</button><button class="btn" data-dc="${r.id}">Decline</button></div>` : `<span class="pill">${r.status === 'agreed' ? 'Agreed' : r.status === 'declined' ? 'Declined' : 'Cancelled'}</span>`}</div>`;
  shell(`<div class="page-head"><div><h1>Changes to agree</h1><p>Changes HR wants to make to your timesheet settings. Nothing changes until you agree.</p></div></div>
  ${list.length ? list.map(card).join('') : '<div class="card"><div class="empty">Nothing to agree.</div></div>'}`);
  const go = (id, ok) => async () => { try { await run(async () => must(await sb.rpc('hr_decide', { p_id: id, p_agree: ok })), ok ? 'Agreed, settings updated' : 'Declined'); } catch { return; } pageAgree(); };
  main().querySelectorAll('[data-ag]').forEach((b) => (b.onclick = go(Number(b.dataset.ag), true)));
  main().querySelectorAll('[data-dc]').forEach((b) => (b.onclick = go(Number(b.dataset.dc), false)));
}
async function pageRoster() {
  const first = otPeriod(params().p);
  let span = 2; try { span = Number(localStorage.getItem('bo_roster_span')) || 2; } catch { /* ignore */ }
  if (isPhone()) span = 1; // phone: 1 month at a time
  const pers = [first]; while (pers.length < span) pers.push(otPeriod(pers[pers.length - 1].next));
  const parts = await Promise.all(pers.map((per, i) => rosterTable(per, i === 0)));
  const appr = isAdmin();
  let minOn = 2; try { minOn = Number(localStorage.getItem('bo_roster_min')) || 2; } catch { /* ignore */ }
  const label = span > 1 ? `${pers[0].label} to ${pers[span - 1].label}` : first.label;
  shell(`<div class="page-head"><div><h1>Roster · ${esc(label)}</h1><p>Everyone's days. Click a day in your own row to change it. Only each person changes their own days.</p></div>
    <div class="ro-nav" id="rospan">${[1, 2, 3].map((n) => `<button class="${n === span ? 'on' : ''}" data-n="${n}">${n}</button>`).join('<span>·</span>')}<span class="faint">months</span><a href="#/roster?p=${first.prev}" title="Earlier periods">‹ Earlier</a><a href="#/roster" title="Back to this month">Today</a><a href="#/roster?p=${first.next}" title="Later">›</a><button class="btn small" id="roprint" style="margin-left:10px">Preview</button></div></div>
  ${parts.map((x) => x.html).join('')}
  <div class="row ro-lg"><span><i class="ro-c ro-w ro-past"></i>Past</span><span><i class="ro-c ro-w"></i>Working</span><span><i class="ro-c ro-l"></i>Leave (AL, Sick, Pers, Repl)</span><span><i class="ro-c ro-o"></i>Day off</span><span><i class="ro-c ro-ho"></i>Holiday</span>${appr ? `<span style="margin-left:auto">Warn when fewer than <input class="input" id="romin" type="number" min="0" value="${minOn}" style="width:56px;padding:2px 6px;display:inline-block"> are working</span>` : ''}</div>`);
  document.querySelectorAll('#rospan button').forEach((x) => (x.onclick = () => { try { localStorage.setItem('bo_roster_span', x.dataset.n); } catch { /* ignore */ } pageRoster(); }));
  const mi = document.getElementById('romin');
  if (mi) mi.onchange = (e) => { try { localStorage.setItem('bo_roster_min', String(Number(e.target.value) || 0)); } catch { /* ignore */ } pageRoster(); };
  parts.forEach((x) => x.wire());
  // open at today: scroll the current period so today's column is in view
  { const t = main().querySelector('th.ro-today'); const w = t?.closest('.table-wrap'); if (t && w) w.scrollLeft = Math.max(0, t.offsetLeft - 160); }
  document.getElementById('roprint').onclick = () => printSheet(`<div class="ps-head"><div><b>Bloom Chiangmai</b><div>Roster · ${esc(label)}</div></div><div style="text-align:right">Printed ${esc(dateLabel(iso(new Date())))}</div></div>${parts.map((x) => x.html).join('')}<div class="ps-sub">Working (green) · Day off (grey) · Leave: AL, Sick, Pers, Repl (amber) · Holiday (red)</div>`, true, 'Roster preview');
}
async function rosterTable(per) {
  const appr = isAdmin();
  const K = per.end;
  // Everyone sees the roster (types only, no notes). Approvers can change anyone's day; staff only their own row.
  const [rv, hols] = await Promise.all([
    sb.rpc('roster_view', { p_start: per.start, p_end: per.end }).then(must),
    sb.from('holidays').select('day, name').then(must),
  ]);
  const { people, sets, ovs, forms, ents } = rv;
  HOLNAME = Object.fromEntries(hols.map((x) => [x.day, x.name || 'Holiday']));
  const hol = hols.map((x) => x.day);
  const days = periodWeeks(per).flat();
  const today = iso(new Date());
  const short = { annual: 'AL', sick: 'Sick', personal: 'Pers', replacement: 'Repl', saved: 'Saved' };
  const headArr = days.map((d) => { const x = new Date(`${d}T00:00:00`); const h = hol.includes(d); return `<th class="ro-h${h ? ' ro-hol' : ''}${[0, 6].includes(x.getDay()) ? ' ro-we' : ''}${d === today ? ' ro-today' : ''}" title="${h ? esc(HOLNAME[d]) : ''}"><span class="ro-m">${x.getDate() === 1 || d === days[0] ? x.toLocaleDateString('en-GB', { month: 'short' }) : '&nbsp;'}</span>${x.toLocaleDateString('en-GB', { weekday: 'narrow' })}<br>${x.getDate()}</th>`; });
  const working = Object.fromEntries(days.map((d) => [d, 0])), sched = Object.fromEntries(days.map((d) => [d, 0])), offWho = Object.fromEntries(days.map((d) => [d, []]));
  let minOn = 2; try { minOn = Number(localStorage.getItem('bo_roster_min')) || 2; } catch { /* ignore */ }
  const ctx = {}, dayList = {};
  const dot = (f) => { const st = f ? f.status : 'none'; const c = { none: 'grey', draft: 'amber', rejected: 'red', submitted: 'blue', approved: 'green', paid: 'green' }[st] || 'grey'; return `<i class="ro-dot ro-${c}" title="${f ? esc(STATUS_TEXT[f.status] || f.status) : 'Nothing logged'}"></i>`; };
  const rows = people.map((p) => {
    const set = { ...(sets.find((x) => x.staff_id === p.id) || { start_time: '08:00', end_time: '16:30', lunch_hours: 1, week_pattern: 'mon_fri', sat_off_anchor: null, dayoff_mult: 1, holiday_mult: 1, pay_type: 'full_time' }) };
    set.__sid = p.id; set.ovr = Object.fromEntries(ovs.filter((x) => x.staff_id === p.id).map((x) => [x.day, x.treat_as]));
    const f = forms.find((x) => x.staff_id === p.id);
    const es = f ? ents.filter((e) => e.form_id === f.id) : [];
    const own = p.id === S.user.id;
    const canEdit = own && (!f || ['draft', 'rejected'].includes(f.status));
    const showHrs = own || appr;
    ctx[p.id] = { set, form: f, es, canEdit, name: p.full_name };
    let ot = 0, hrs = 0;
    const free = set.pay_type === 'freelance';
    const normalH = (tmin(hhmm(set.end_time)) - tmin(hhmm(set.start_time))) / 60;
    const cellArr = days.map((d) => {
      const x = dayInfo(d, es, set, hol);
      ot += free ? 0 : x.ot; hrs += x.hours;
      let cls = 'ro-w', txt = '';
      if (x.hours && !x.lv) working[d]++; else offWho[d].push(p.full_name);
      (dayList[d] = dayList[d] || []).push({ id: p.id, name: p.full_name, own, canEdit, kind: x.lv ? 'leave' : x.hours ? 'on' : (x.type === 'holiday' ? 'hol' : 'off'), txt: x.lv ? LEAVE[x.lv.leave_type] : x.hours ? (showHrs ? `Working · ${x.hours} h${x.ot ? `, OT ${x.ot}` : ''}` : 'Working') : (x.type === 'holiday' ? (HOLNAME[d] || 'Holiday') : 'Day off') });
      if (baseTypeOf(d, set, hol) === 'workday') sched[d]++;
      if (x.lv) { cls = 'ro-l'; txt = short[x.lv.leave_type]; }
      else if (!x.hours) { cls = x.type === 'holiday' ? 'ro-ho' : 'ro-o'; txt = free ? '' : 'off'; }
      const tip = `${esc(p.full_name)} · ${esc(dateLabel(d))}${x.lv ? ' · ' + LEAVE[x.lv.leave_type] : x.hours ? (showHrs ? ` · ${x.hours} h${x.ot ? `, OT ${x.ot}` : ''}` : ' · working') : ' · off'}`;
      const tapRo = own && !canEdit;
      return `<td><${canEdit || tapRo ? 'button' : 'span'} class="ro-c ${cls}${canEdit ? ' ro-ed' : ''}${tapRo ? ' ro-rd' : ''}${d < today ? ' ro-past' : ''}" data-p="${p.id}" data-d="${d}" data-k="${K}" title="${tip}">${txt}</${canEdit || tapRo ? 'button' : 'span'}></td>`;
    });
    const nm = appr || own ? `<a href="#/ot?p=${per.end}${own ? '' : '&u=' + p.id}">${esc(p.full_name)}</a>` : esc(p.full_name);
    return { own, nm, cellArr };
  });
  // Computer: the whole period in one row. Phone: rows of 2 weeks stacked, so nothing goes off the screen.
  const chunks = [];
  const step = isPhone() ? 14 : days.length;
  for (let k = 0; k < days.length; k += step) chunks.push([k, Math.min(days.length, k + step)]);
  const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const tableFor = ([a, b]) => `${chunks.length > 1 ? `<div class="ro-sub">${fmt(days[a])} to ${fmt(days[b - 1])}</div>` : ''}<div class="table-wrap"><table class="roster${isPhone() ? ' ro-phone' : ''}"><thead><tr><th class="ro-stick"></th>${headArr.slice(a, b).join('')}</tr></thead><tbody>${rows.map((r) => `<tr${r.own ? ' class="ro-me"' : ''}><th class="ro-n ro-stick">${r.nm}</th>${r.cellArr.slice(a, b).join('')}</tr>`).join('') || `<tr><td class="faint">No staff yet.</td></tr>`}</tbody>
    <tfoot><tr><th class="ro-n ro-stick">${isPhone() ? 'On' : 'Working'}</th>${days.slice(a, b).map((d) => `<td class="ro-cov${sched[d] && working[d] < minOn ? ' ro-low' : ''}" data-off="${d}" data-k="${K}" title="Click to see who's off">${isPhone() ? working[d] : `${working[d]}/${people.length}`}</td>`).join('')}</tr></tfoot></table></div>`;
  // Phone: a month calendar. Each day box shows the number on and who is off; tap a day for the full list.
  const tag = (e) => `<span class="rc-t rc-${e.kind}">${esc(e.name)}</span>`;
  const calHtml = () => {
    const lead = (new Date(`${days[0]}T00:00:00`).getDay() + 6) % 7;
    const cells = Array(lead).fill('<div></div>').concat(days.map((d) => {
      const L = dayList[d] || [], ex = L.filter((e) => e.kind !== 'on'), n = new Date(`${d}T00:00:00`);
      const low = sched[d] && working[d] < minOn, we = [0, 6].includes(n.getDay());
      const tags = L.length && ex.length === L.length ? '<span class="rc-t rc-off">All off</span>' : ex.slice(0, 2).map(tag).join('') + (ex.length > 2 ? `<span class="rc-more">+${ex.length - 2}</span>` : '');
      return `<button class="rc-d${we ? ' rc-we' : ''}${d === today ? ' rc-today' : ''}" data-cd="${d}" data-k="${K}"><span class="rc-top"><b>${n.getDate()}</b><span class="${low ? 'rc-low' : ''}">${working[d]}</span></span>${tags}</button>`;
    }));
    return `<div class="rc-lg"><span class="rc-t rc-off">Off</span><span class="rc-t rc-leave">Leave</span><span class="faint">Number = people working</span></div>
      <div class="rc-g rc-wk">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="rc-g">${cells.join('')}</div><div class="rc-det" id="rcdet-${K}"></div>`;
  };
  const html = `<div class="card" style="margin-bottom:14px"><div class="ro-ph">${esc(per.label)}</div>${isPhone() ? calHtml() : chunks.map(tableFor).join('')}</div>`;
  const showDay = (d) => {
    main().querySelectorAll(`[data-cd][data-k="${K}"]`).forEach((b) => b.classList.toggle('rc-sel', b.dataset.cd === d));
    const L = dayList[d] || [], box = document.getElementById(`rcdet-${K}`); if (!box) return;
    box.innerHTML = `<div class="rc-dh">${esc(dateLabel(d))}${HOLNAME[d] ? ' · ' + esc(HOLNAME[d]) : ''}</div><div class="faint" style="font-size:13px">${working[d]} of ${L.length} working</div>`
      + L.map((e) => `<${e.canEdit ? 'button' : 'div'} class="rc-row${e.canEdit ? ' ro-ed' : ''}" data-p="${e.id}" data-d="${d}" data-k="${K}"><span><span class="rc-nm">${esc(e.name)}${e.own ? ' (you)' : ''}</span><span class="faint rc-tx">${esc(e.txt)}</span></span><span class="rc-t rc-${e.kind}">${{ on: 'On', off: 'Off', hol: 'Holiday', leave: 'Leave' }[e.kind]}</span></${e.canEdit ? 'button' : 'div'}>`).join('')
      + (L.some((e) => e.canEdit) ? '<div class="faint" style="font-size:12px;margin-top:6px">Tap a name to change that day.</div>' : '');
    bindEd();
  };
  const bindEd = () => main().querySelectorAll(`.ro-ed[data-k="${K}"]`).forEach((b) => (b.onclick = async () => {
    const c = ctx[b.dataset.p];
    // full entries (with notes) for the dialog; RLS allows own or approver
    const es = c.form ? must(await sb.from('ot_entries').select('*').eq('form_id', c.form.id)) : [];
    const odr = must(await sb.from('ot_offday').select('day, choice, swap_date').eq('staff_id', b.dataset.p));
    c.set.offd = Object.fromEntries(odr.map((o) => [o.day, o.choice])); c.set.swapd = Object.fromEntries(odr.filter((o) => o.swap_date).map((o) => [o.day, o.swap_date]));
    let form = c.form;
    const ensureForm = async () => {
      if (form) return form;
      form = must(await sb.from('ot_forms').insert({ staff_id: b.dataset.p, period_start: per.start, period_end: per.end }).select().single());
      return form;
    };
    dayDialog({ x: dayInfo(b.dataset.d, es, c.set, hol), set: c.set, hol, editable: true, ensureForm, reload: pageRoster, ents: es });
  }));
  const bindRd = () => main().querySelectorAll(`.ro-rd[data-k="${K}"]`).forEach((b) => (b.onclick = async () => {
    const c = ctx[b.dataset.p];
    const es = c.form ? must(await sb.from('ot_entries').select('*').eq('form_id', c.form.id)) : [];
    dayDialog({ x: dayInfo(b.dataset.d, es, c.set, hol), set: c.set, hol, editable: false, lock: c.form ? `Your timesheet is ${(STATUS_TEXT[c.form.status] || c.form.status).toLowerCase()}. To change it, ask HR or admin to return it.` : '' });
  }));
  const wire = () => {
    main().querySelectorAll(`[data-off][data-k="${K}"]`).forEach((td) => (td.onclick = () => toast(offWho[td.dataset.off].length ? `Off ${dateLabel(td.dataset.off)}: ${offWho[td.dataset.off].join(', ')}` : `Everyone working ${dateLabel(td.dataset.off)}`)));
    bindEd(); bindRd();
    if (isPhone()) {
      main().querySelectorAll(`[data-cd][data-k="${K}"]`).forEach((b) => (b.onclick = () => showDay(b.dataset.cd)));
      showDay(days.includes(today) ? today : days[0]);
    }
  };
  return { html, wire };
}
