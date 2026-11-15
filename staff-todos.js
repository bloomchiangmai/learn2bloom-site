// S26: everything that waits on a staff member, from every system. Used by the dashboard
// (Waiting on you, cards, Today, quick buttons) and by the main sidebar counts on other pages.
const escD = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// S26: one dashboard for all of Bloom. Each source returns any of:
//   cards: [{ area, order, items:[{ num, label, href }] }]  (number cards, one per area)
//   lines: [{ tag, t, d, n, at, late, watch, href | subOnly+sub }]  (For you, or Keep an eye on when watch)
//          t = what to do, d = detail, n = how many, at = oldest date (for "waiting 6 h"), late = overdue
//   today: [{ h, order, rows:[[left, right]] }]              (Today column)
//   quick: [{ label, href, order }]                          (quick buttons)
// A source only returns what this person can open.
const SOURCES = [];
const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = () => isoD(new Date());
const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;
// Dates read as people say them: today, tomorrow, Wed, or Wed 25 Nov further out
const shortDate = d => {
  const x = new Date(d + 'T00:00:00'), t0 = new Date(TODAY() + 'T00:00:00'), days = Math.round((x - t0) / 864e5);
  if(days === 0) return 'today'; if(days === 1) return 'tomorrow'; if(days === -1) return 'yesterday';
  if(days > 1 && days < 7) return x.toLocaleDateString('en-GB', { weekday:'short' });
  return x.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
};
// How long something has waited: "waiting 6 h", "waiting 3 days"
const waited = at => { if(!at) return ''; const h = Math.floor((Date.now() - new Date(at)) / 36e5); return h < 1 ? 'new' : h < 48 ? `waiting ${h} h` : `waiting ${Math.floor(h / 24)} days`; };
const oldest = rows => (rows || []).map(r => r.created_at || r.submitted_at).filter(Boolean).sort()[0] || null;
const hmT = t => String(t || '').slice(0, 5);

// Admissions and Learners: new enquiries and parent requests
SOURCES.push(async () => {
  if(!canAccess('students', 'view')) return null;
  const [{ count: active }, { data: enq }, { data: notes }] = await Promise.all([
    sb.from('students').select('*', { count: 'exact', head: true }).eq('status', 'enrolled'),
    sb.from('students').select('id, first_name, last_name, student_id_code, created_at').eq('status', 'enquiry'),
    sb.from('parent_notes').select('id, note, student_id, students(first_name, last_name, student_id_code)').eq('resolved', false).order('created_at', { ascending: false })
  ]);
  const e = enq || [], n = notes || [];
  const lines = [];
  if(e.length){ const at = oldest(e); lines.push({ tag:'Admissions', t: e.length === 1 ? 'Reply to a new enquiry' : 'Reply to new enquiries', d:'Admissions', n:e.length, at, late: at && Date.now() - new Date(at) > 864e5, href:'staff-admissions.html' }); }
  // Student absences reported by parents (moved from the School calendar, 10 Nov)
  const { count: absN } = await sb.from('bloom_absence_reports').select('id', { count: 'exact', head: true }).eq('status', 'new');
  if(absN) lines.push({ tag:'Learners', t: absN === 1 ? 'Read a student absence' : 'Read student absences', d:'Learners · reported by parents', n:absN, href:'student-absences.html' });
  if(n.length) lines.push({ tag:'Learners', t: n.length === 1 ? 'Answer a parent request' : 'Answer parent requests', d:'Learners · tap to see them', n:n.length, subOnly:true,
    sub: n.map(x => { const st = x.students || {}; const link = st.student_id_code ? `learners.html?student=${encodeURIComponent(st.student_id_code)}` : 'learners.html';
      return `<a href="${link}"><b>${escD(st.first_name)} ${escD(st.last_name || '')}</b><br><span style="color:#5F5E5A;font-size:13px;">${escD(x.note)}</span></a>`; }).join('') });
  return { cards: [{ area:'School', order:1, items:[{ num: active ?? '—', label:'students', href:'learners.html', zero:'No students enrolled' }, { num: e.length, label: e.length === 1 ? 'new enquiry' : 'new enquiries', href:'staff-admissions.html', act:true, zero:'No new enquiries' }] }], lines };
});

// Approvals (admin and IT)
SOURCES.push(async () => {
  if(!window._isAdminOrIt) return null;
  const { count } = await sb.from('approval_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  const c = count || 0;
  return { lines: c ? [{ tag:'Access and settings', t: c === 1 ? 'Review a change request' : 'Review change requests', d:'Access and settings', n:c, href:'staff-permissions.html#approvals' }] : [] };
});

// Calendar: changes this person asked for, and what kind of day today is
SOURCES.push(async () => {
  if(!canAccess('calendar', 'view')) return null;
  const t = TODAY(), until = isoD(new Date(Date.now() + 14 * 864e5));
  const [req, { data: ev }] = await Promise.all([
    window._isAdminOrIt ? Promise.resolve({ count: 0 }) : sb.from('approval_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending').eq('module', 'calendar').eq('requested_by', window.currentStaff.id),
    sb.from('bloom_calendar_events').select('date, day_type, label').eq('is_draft', false).gte('date', t).lte('date', until).order('date')
  ]);
  const c = req.count || 0;
  const name = e => e.label || ({ school:'School day', break:'School break', pd:'Staff training', holiday:'Holiday' }[e.day_type] || e.day_type);
  const rows = [];
  const todays = (ev || []).filter(e => e.date === t);
  if(todays.length) rows.push(['Today', escD(todays.map(name).join(', '))]);
  // School closed today: a break or holiday on the calendar, or a weekend
  const dow = new Date().getDay(), offDay = todays.find(e => ['break','holiday'].includes(e.day_type));
  const closed = offDay ? `School closed: ${name(offDay)}` : (dow === 0 || dow === 6) && !todays.some(e => e.day_type === 'school') ? 'School closed today' : '';
  // Coming up: the next days that are not ordinary school days
  const seen = new Set();
  (ev || []).filter(e => e.date > t && e.day_type !== 'school').forEach(e => { const k = name(e); if(!seen.has(k) && rows.length < 4){ seen.add(k); rows.push([shortDate(e.date), escD(k)]); } });
  return {
    lines: c ? [{ tag:'School calendar', watch:true, t: c === 1 ? '1 calendar change waiting for approval' : `${c} calendar changes waiting for approval`, d:'School calendar · you asked for ' + (c === 1 ? 'it' : 'them'), href:'staff-calendar.html' }] : [],
    closed,
    today: rows.length ? [{ h:'School calendar', order:3, rows: rows.map(([a, b]) => [a === 'Today' ? 'All day' : a, `<a href="staff-calendar.html">${b}</a>`]) }] : []
  };
});

// Back office expenses (S23, S24): forms to check, final approvals and payments, my returned forms
SOURCES.push(async () => {
  if(!canAccess('backoffice', 'edit')) return null;
  const me = window.currentStaff.auth_user_id, full = canAccess('backoffice', 'full'), mgr = window.currentStaff.role === 'operations_manager', fullOrMgr = full || mgr, bo = sb.schema('bo');
  const BO = 'backoffice/#';
  const [chk, back, fin, pay] = await Promise.all([
    bo.from('expense_reports').select('id, submitted_at').eq('status', 'submitted').eq('checker_id', me),
    bo.from('expense_reports').select('id', { count: 'exact', head: true }).eq('status', 'rejected').eq('staff_id', me),
    fullOrMgr ? bo.from('expense_reports').select('id, staff_id, checked_by, submitted_at').eq('status', 'checked') : Promise.resolve({ data: [] }),
    fullOrMgr ? bo.from('expense_reports').select('id, staff_id, submitted_at').eq('status', 'approved') : Promise.resolve({ data: [] }),
  ]);
  // Operations Manager: final approval and paying up to 10,000 THB, never her own form
  let over = new Set();
  if(mgr){
    const ids = [...(fin.data || []), ...(pay.data || [])].map(r => r.id);
    const { data: t } = ids.length ? await bo.from('expense_report_totals').select('report_id, total_spent').in('report_id', ids) : { data: [] };
    over = new Set((t || []).filter(x => Number(x.total_spent) > 10000).map(x => x.report_id));
  }
  const r1 = chk.data || [], r3 = (fin.data || []).filter(r => r.staff_id !== me && r.checked_by !== me && !over.has(r.id)), r4 = (pay.data || []).filter(r => full || (r.staff_id !== me && !over.has(r.id)));
  const n1 = r1.length, n2 = back.count || 0, n3 = r3.length, n4 = r4.length;
  const lines = [], old3 = d => d && Date.now() - new Date(d) > 3 * 864e5;
  if(n1){ const at = oldest(r1); lines.push({ tag:'Back office', t: n1 === 1 ? 'Check an expense form' : 'Check expense forms', d:'Money', n:n1, at, late: old3(at), href: BO + '/approvals' }); }
  if(n3){ const at = oldest(r3); lines.push({ tag:'Back office', t: n3 === 1 ? 'Approve an expense form' : 'Approve expense forms', d:'Money · final approval', n:n3, at, late: old3(at), href: BO + '/approvals?s=checked' }); }
  if(n4){ const at = oldest(r4); lines.push({ tag:'Back office', t: n4 === 1 ? 'Pay an approved form' : 'Pay approved forms', d:'Money', n:n4, at, late: old3(at), href: BO + '/approvals?s=approved' }); }
  if(n2) lines.push({ tag:'Back office', t: n2 === 1 ? 'Fix your returned expense form' : 'Fix your returned expense forms', d:'Money · returned to you', n:n2, late:true, href: BO + '/forms' });
  return {
    lines,
    cards: fullOrMgr ? [{ area:'Money', order:2, items:[{ num:n3, label: n3 === 1 ? 'form to approve' : 'forms to approve', href: BO + '/approvals?s=checked', act:true, zero:'Nothing to approve' }, { num:n4, label:'to pay', href: BO + '/approvals?s=approved', act:true, zero:'nothing to pay' }] }] : [],
    quick: [{ label:'Add receipt', href: BO + '/capture', order:1 }]
  };
});

// Timesheets (back office Time): my time today, timesheets to check or approve, who is off
SOURCES.push(async () => {
  if(!canAccess('backoffice', 'edit')) return null;
  const me = window.currentStaff.auth_user_id, bo = sb.schema('bo'), BO = 'backoffice/#', t = TODAY();
  const { data: prof } = await bo.from('profiles').select('role, is_hr, no_timesheet').eq('id', me).maybeSingle();
  if(!prof) return null;
  const admin = prof.role === 'admin', hr = !!prof.is_hr, keeps = !prof.no_timesheet;
  const out = { lines: [], today: [], cards: [], quick: [] };
  const [mine, toCheck, toApprove, hol] = await Promise.all([
    keeps ? bo.from('ot_forms').select('id, status, period_start, period_end').eq('staff_id', me).lte('period_start', t).gte('period_end', t).maybeSingle() : Promise.resolve({ data: null }),
    hr ? bo.from('ot_forms').select('id, submitted_at').eq('status', 'submitted').neq('staff_id', me) : Promise.resolve({ data: [] }),
    admin ? bo.from('ot_forms').select('id, submitted_at').eq('status', 'checked').neq('staff_id', me) : Promise.resolve({ data: [] }),
    bo.from('holidays').select('name').eq('day', t)
  ]);
  const nC = (toCheck.data || []).length, nA = (toApprove.data || []).length;
  if(nC) out.lines.push({ tag:'Timesheets', t: nC === 1 ? 'Check a timesheet' : 'Check timesheets', d:'Team', n:nC, at: oldest(toCheck.data), href: BO + '/approvals?s=todo&k=ts' });
  if(nA) out.lines.push({ tag:'Timesheets', t: nA === 1 ? 'Approve a timesheet' : 'Approve timesheets', d: nA > 1 ? 'Team · approve all in one go' : 'Team', n:nA, at: oldest(toApprove.data), href: BO + '/approvals?s=todo&k=ts' });
  const off = [];
  (hol.data || []).forEach(h => off.push(['All day', `Public holiday: ${escD(h.name)}`]));
  if(admin || hr){
    const { data: leave } = await bo.from('ot_entries').select('leave_type, start_time, end_time, ot_forms!inner(staff_id)').eq('work_date', t).not('leave_type', 'is', null);
    const ids = [...new Set((leave || []).map(l => l.ot_forms.staff_id))];
    const { data: names } = ids.length ? await bo.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
    const nm = Object.fromEntries((names || []).map(p => [p.id, p.full_name]));
    (leave || []).forEach(l => off.push([l.start_time ? `${hmT(l.start_time)}–${hmT(l.end_time)}` : 'All day', escD(nm[l.ot_forms.staff_id] || 'Someone')]));
    out.cards.push({ area:'Team', order:3, items:[
      { num: hr ? nC : nA, label: hr ? (nC === 1 ? 'timesheet to check' : 'timesheets to check') : (nA === 1 ? 'timesheet to approve' : 'timesheets to approve'), href: BO + '/approvals?s=todo&k=ts', act:true, zero:'No timesheets waiting' },
      { num: (leave || []).length, label:'off today', href: BO + '/roster', zero:'Nobody off' }] });
  }
  if(off.length) out.today.push({ h:'Off today', order:2, rows: off });
  if(keeps){
    out.quick.push({ label:'My timesheet', href: BO + '/ot', order:2 });
    const { data: set } = await bo.from('ot_settings').select('start_time, end_time').eq('staff_id', me).maybeSingle();
    // My time shows only when something was logged today; a returned timesheet is a To do
    const rows = [];
    const f = mine.data;
    if(f){
      const { data: ents } = await bo.from('ot_entries').select('hours, leave_type').eq('form_id', f.id).eq('work_date', t);
      (ents || []).forEach(e => rows.push(['Today', e.leave_type ? 'Time off' : `${Number(e.hours || 0)} h overtime logged`]));
      if(f.status === 'rejected') out.lines.push({ tag:'Timesheets', t:'Fix your returned timesheet', d:'Team · returned to you', late:true, href: BO + '/ot' });
    }
    if(rows.length) out.today.push({ h:'My time', order:1, rows: rows.map(([a, b]) => [a, `<a href="${BO}/ot">${b}</a>`]) });
  }
  return out;
});

// Marketing HQ: posts at this person's step, late ones, this week's numbers, today's posts
SOURCES.push(async () => {
  if(!canAccess('marketing', 'view')) return null;
  // Site features: no HQ lines while the HQ is switched off, except for admin, director and IT
  const { data: st } = await sb.from('bloom_settings').select('marketing_enabled').limit(1).maybeSingle();
  if(st && st.marketing_enabled === false && !['admin','director','it'].includes(window.currentStaff.role)) return null;
  const me = window.currentStaff.id;
  const now = new Date(), mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  // Item 58: each post names its own writer, reviewer and translator.
  const [{ data: posts }, { data: week }] = await Promise.all([
    sb.from('marketing_posts').select('id, title, step, pic, writer, translator, poster, post_date, sent_back').not('step', 'in', '("posted","cancelled")'),
    sb.from('marketing_posts').select('id, title, step, post_date').gte('post_date', isoD(mon)).lte('post_date', isoD(sun)).neq('step', 'cancelled')
  ]);
  const today = TODAY();
  const back = { english: 3, review: 2, thai: 1, post: 0 };
  const due = p => { if(!p.post_date || back[p.step] === undefined) return null; const d = new Date(p.post_date + 'T00:00:00'); d.setDate(d.getDate() - back[p.step]); return isoD(d); };
  const mine = (posts || []).filter(p => (p.post_date || p.sent_back) && (
    (p.writer === me && p.step === 'english') ||
    ((p.poster || p.writer) === me && p.step === 'post') ||
    (p.translator === me && p.step === 'thai') ||
    (p.step === 'review' && p.pic === me)));
  const word = { english:'Write the English for', review:'Review', thai:'Translate', post:'Post' };
  const lines = mine.sort((a, b) => String(due(a) || '9').localeCompare(String(due(b) || '9'))).slice(0, 5).map(p => {
    const d = due(p), late = d && d < today;
    return { tag:'Marketing HQ', href:`staff-marketing.html#post/${p.id}`, late, dueOrder: d || '9',
      t:`${p.sent_back ? 'Fix, sent back:' : (word[p.step] || '')} ${p.title}`, d:`Marketing HQ${d ? (late ? ` · late, was due ${shortDate(d)}` : ` · due ${shortDate(d)}`) : ''}` };
  });
  if(mine.length > 5) lines.push({ tag:'Marketing HQ', t:`${mine.length - 5} more posts at your step`, d:'Marketing HQ', n: mine.length - 5, href:'staff-marketing.html#turn' });
  // Item 86: people kept informed see how many posts were approved since they last cleared the list
  const { data: tm } = await sb.from('marketing_team').select('informed, fyi_read_at').eq('staff_id', me).maybeSingle();
  if(tm && tm.informed){
    const since = tm.fyi_read_at || new Date(Date.now() - 14*864e5).toISOString();
    const { data: ev } = await sb.from('marketing_post_events').select('post_id').like('kind', 'approved%').gt('created_at', since).neq('actor', me).limit(200);
    const open = new Set((posts || []).map(p => p.id));
    const n = new Set((ev || []).map(e => e.post_id).filter(id => open.has(id))).size;
    if(n) lines.push({ tag:'Marketing HQ', watch:true, t:`${n} post${n === 1 ? ' was' : 's were'} approved`, d:'Marketing HQ · for your info', href:'staff-marketing.html#turn' });
  }
  const lateAll = (posts || []).filter(p => p.post_date && due(p) && due(p) < today);
  const boss = window._isAdminOrIt && canAccess('marketing', 'full');
  // The admin sees posts that are late at someone else's step
  if(boss){
    const lateOthers = lateAll.filter(p => !mine.includes(p));
    if(lateOthers.length) lines.push({ tag:'Marketing HQ', watch:true, t:`${plural(lateOthers.length, 'post')} late`, d:"Marketing HQ · at someone else's step", href:'staff-marketing.html#overview' });
  }
  const todays = (week || []).filter(p => p.post_date === today);
  return {
    lines,
    cards: canAccess('marketing', 'full') ? [{ area:'Marketing', order:4, items:[{ num:(week || []).length, label:'posts this week', href:'staff-marketing.html#overview', zero:'No posts this week' }, { num:lateAll.length, label:'late', href:'staff-marketing.html#overview', act:true, zero:'' }] }] : [],
    today: todays.length ? [{ h:'Marketing', order:4, rows: todays.slice(0, 3).map(p => [p.step === 'posted' ? 'Posted' : 'Goes out', `<a href="staff-marketing.html#post/${p.id}">${escD(p.title)}</a>`]) }] : [],
    quick: canAccess('marketing', 'edit') ? [{ label:'New post', href:'staff-marketing.html#new', order:3 }] : []
  };
});


async function collectTodos(){
  window._isAdminOrIt = ['admin','director','it'].includes(window.currentStaffRole);
  return (await Promise.all(SOURCES.map(fn => fn().catch(err => { console.log('todo source failed', err); return null; })))).filter(Boolean);
}
