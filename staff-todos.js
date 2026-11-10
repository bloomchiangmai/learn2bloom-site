// S26: everything that waits on a staff member, from every system. Used by the dashboard
// (Waiting on you, cards, Today, quick buttons) and by the main sidebar counts on other pages.
const escD = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// S26: one dashboard for all of Bloom. Each source returns any of:
//   cards: [{ area, order, items:[{ num, label, href }] }]  (number cards, one per area)
//   lines: [{ tag, html, href | subOnly+sub, btn }]          (Waiting on you, grouped by tag)
//   today: [{ h, order, rows:[[left, right]] }]              (Today column)
//   quick: [{ label, href, order }]                          (quick buttons)
// A source only returns what this person can open.
const SOURCES = [];
const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = () => isoD(new Date());
const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;
const shortDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
const hmT = t => String(t || '').slice(0, 5);

// Admissions and Learners: new enquiries and parent requests
SOURCES.push(async () => {
  if(!canAccess('students', 'view')) return null;
  const [{ count: active }, { data: enq }, { data: notes }] = await Promise.all([
    sb.from('students').select('*', { count: 'exact', head: true }).eq('status', 'enrolled'),
    sb.from('students').select('id, first_name, last_name, student_id_code').eq('status', 'enquiry'),
    sb.from('parent_notes').select('id, note, student_id, students(first_name, last_name, student_id_code)').eq('resolved', false).order('created_at', { ascending: false })
  ]);
  const e = enq || [], n = notes || [];
  const lines = [];
  if(e.length) lines.push({ tag:'Admissions', html:`${plural(e.length, 'new enquiry', 'new enquiries')} to reply to`, href:'staff-admissions.html', btn:'Open' });
  // Student absences reported by parents (moved from the School calendar, 10 Nov)
  const { count: absN } = await sb.from('bloom_absence_reports').select('id', { count: 'exact', head: true }).eq('status', 'new');
  if(absN) lines.push({ tag:'Learners', html:`${plural(absN, 'new student absence')} reported by parents`, href:'student-absences.html', btn:'Open' });
  if(n.length) lines.push({ tag:'Learners', html:`${plural(n.length, 'parent request')}`, btn:'Show', subOnly:true,
    sub: n.map(x => { const st = x.students || {}; const link = st.student_id_code ? `learners.html?student=${encodeURIComponent(st.student_id_code)}` : 'learners.html';
      return `<a href="${link}"><b>${escD(st.first_name)} ${escD(st.last_name || '')}</b><br><span style="color:#5F5E5A;font-size:13px;">${escD(x.note)}</span></a>`; }).join('') });
  return { cards: [{ area:'School', order:1, items:[{ num: active ?? '—', label:'enrolled students', href:'learners.html' }, { num: e.length, label: e.length === 1 ? 'new enquiry' : 'new enquiries', href:'staff-admissions.html' }] }], lines };
});

// Approvals (admin and IT)
SOURCES.push(async () => {
  if(!window._isAdminOrIt) return null;
  const { count } = await sb.from('approval_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  const c = count || 0;
  return { lines: c ? [{ tag:'Access and settings', html:`${plural(c, 'change request')} waiting for you`, href:'staff-permissions.html#approvals', btn:'Review' }] : [] };
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
  rows.push(['Today', todays.length ? escD(todays.map(name).join(', ')) : 'Nothing on the calendar']);
  // Coming up: the next days that are not ordinary school days
  const seen = new Set();
  (ev || []).filter(e => e.date > t && e.day_type !== 'school').forEach(e => { const k = name(e); if(!seen.has(k) && rows.length < 4){ seen.add(k); rows.push([shortDate(e.date), escD(k)]); } });
  return {
    lines: c ? [{ tag:'School calendar', html:`${plural(c, 'calendar change')} you asked for ${c === 1 ? 'is' : 'are'} waiting for approval`, href:'staff-calendar.html', btn:'View' }] : [],
    today: [{ h:'School calendar', order:3, rows: rows.map(([a, b]) => [a, `<a href="staff-calendar.html">${b}</a>`]) }]
  };
});

// Back office expenses (S23, S24): forms to check, final approvals and payments, my returned forms
SOURCES.push(async () => {
  if(!canAccess('backoffice', 'edit')) return null;
  const me = window.currentStaff.auth_user_id, full = canAccess('backoffice', 'full'), mgr = window.currentStaff.role === 'operations_manager', fullOrMgr = full || mgr, bo = sb.schema('bo');
  const BO = 'backoffice/#';
  const [chk, back, fin, pay] = await Promise.all([
    bo.from('expense_reports').select('id', { count: 'exact', head: true }).eq('status', 'submitted').eq('checker_id', me),
    bo.from('expense_reports').select('id', { count: 'exact', head: true }).eq('status', 'rejected').eq('staff_id', me),
    fullOrMgr ? bo.from('expense_reports').select('id, staff_id, checked_by').eq('status', 'checked') : Promise.resolve({ data: [] }),
    fullOrMgr ? bo.from('expense_reports').select('id, staff_id').eq('status', 'approved') : Promise.resolve({ data: [] }),
  ]);
  // Operations Manager: final approval and paying up to 10,000 THB, never her own form
  let over = new Set();
  if(mgr){
    const ids = [...(fin.data || []), ...(pay.data || [])].map(r => r.id);
    const { data: t } = ids.length ? await bo.from('expense_report_totals').select('report_id, total_spent').in('report_id', ids) : { data: [] };
    over = new Set((t || []).filter(x => Number(x.total_spent) > 10000).map(x => x.report_id));
  }
  const n1 = chk.count || 0, n2 = back.count || 0, n3 = (fin.data || []).filter(r => r.staff_id !== me && r.checked_by !== me && !over.has(r.id)).length, n4 = (pay.data || []).filter(r => full || (r.staff_id !== me && !over.has(r.id))).length;
  const lines = [];
  if(n1) lines.push({ tag:'Back office', html:`${plural(n1, 'expense form')} for you to check`, href: BO + '/approvals', btn:'Check' });
  if(n3) lines.push({ tag:'Back office', html:`${plural(n3, 'expense form')} ${n3 === 1 ? 'needs' : 'need'} your final approval`, href: BO + '/approvals?s=checked', btn:'Review' });
  if(n4) lines.push({ tag:'Back office', html:`${plural(n4, 'approved form')} waiting to be paid`, href: BO + '/approvals?s=approved', btn:'Pay' });
  if(n2) lines.push({ tag:'Back office', html:`${plural(n2, 'expense form')} returned to you to fix`, href: BO + '/forms', btn:'Open' });
  return {
    lines,
    cards: fullOrMgr ? [{ area:'Money', order:2, items:[{ num:n3, label: n3 === 1 ? 'form to approve' : 'forms to approve', href: BO + '/approvals?s=checked' }, { num:n4, label:'to pay', href: BO + '/approvals?s=approved' }] }] : [],
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
    hr ? bo.from('ot_forms').select('id', { count: 'exact', head: true }).eq('status', 'submitted').neq('staff_id', me) : Promise.resolve({ count: 0 }),
    admin ? bo.from('ot_forms').select('id', { count: 'exact', head: true }).eq('status', 'checked').neq('staff_id', me) : Promise.resolve({ count: 0 }),
    bo.from('holidays').select('name').eq('day', t)
  ]);
  const nC = toCheck.count || 0, nA = toApprove.count || 0;
  if(nC) out.lines.push({ tag:'Timesheets', html:`${plural(nC, 'timesheet')} to check`, href: BO + '/approvals?s=todo&k=ts', btn:'Check' });
  if(nA) out.lines.push({ tag:'Timesheets', html:`${plural(nA, 'timesheet')} ${nA === 1 ? 'needs' : 'need'} your final approval`, href: BO + '/approvals?s=todo&k=ts', btn:'Review' });
  const off = [];
  (hol.data || []).forEach(h => off.push(['All day', `Public holiday: ${escD(h.name)}`]));
  if(admin || hr){
    const { data: leave } = await bo.from('ot_entries').select('leave_type, start_time, end_time, ot_forms!inner(staff_id)').eq('work_date', t).not('leave_type', 'is', null);
    const ids = [...new Set((leave || []).map(l => l.ot_forms.staff_id))];
    const { data: names } = ids.length ? await bo.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
    const nm = Object.fromEntries((names || []).map(p => [p.id, p.full_name]));
    (leave || []).forEach(l => off.push([l.start_time ? `${hmT(l.start_time)}–${hmT(l.end_time)}` : 'All day', escD(nm[l.ot_forms.staff_id] || 'Someone')]));
    out.cards.push({ area:'Team', order:3, items:[
      { num: hr ? nC : nA, label: hr ? (nC === 1 ? 'timesheet to check' : 'timesheets to check') : (nA === 1 ? 'timesheet to approve' : 'timesheets to approve'), href: BO + '/approvals?s=todo&k=ts' },
      { num: (leave || []).length, label:'off today', href: BO + '/roster' }] });
    if(!off.length) off.push(['Today', 'Nobody']);
  }
  if(off.length) out.today.push({ h:'Off today', order:2, rows: off });
  if(keeps){
    out.quick.push({ label:'My timesheet', href: BO + '/ot', order:2 });
    const { data: set } = await bo.from('ot_settings').select('start_time, end_time').eq('staff_id', me).maybeSingle();
    const rows = [['Usual', `${hmT(set?.start_time) || '08:00'} to ${hmT(set?.end_time) || '16:30'}`]];
    const f = mine.data;
    if(f){
      const { data: ents } = await bo.from('ot_entries').select('hours, leave_type').eq('form_id', f.id).eq('work_date', t);
      (ents || []).forEach(e => rows.push(['Today', e.leave_type ? 'Time off' : `${Number(e.hours || 0)} h overtime logged`]));
      const word = { draft:'Not sent yet', submitted:'Sent, being checked', checked:'Checked, waiting for approval', approved:'Approved', paid:'Paid', rejected:'Returned to you' }[f.status] || f.status;
      rows.push(['This period', word]);
      if(f.status === 'rejected') out.lines.push({ tag:'Timesheets', html:'Your timesheet was returned to fix', href: BO + '/ot', btn:'Open' });
    }
    out.today.push({ h:'My time', order:1, rows: rows.map(([a, b]) => [a, `<a href="${BO}/ot">${b}</a>`]) });
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
    return { tag:'Marketing HQ', href:`staff-marketing.html#post/${p.id}`, btn:'Open',
      html:`${p.sent_back ? 'Sent back: ' : (word[p.step] || '') + ' '}${escD(p.title)}${d ? (late ? ` <span class="late">(late, due ${shortDate(d)})</span>` : ` <span style="color:#888780;">(due ${shortDate(d)})</span>`) : ''}` };
  });
  if(mine.length > 5) lines.push({ tag:'Marketing HQ', html:`${mine.length - 5} more posts are your turn`, href:'staff-marketing.html#turn', btn:'See all' });
  // Item 86: people kept informed see how many posts were approved since they last cleared the list
  const { data: tm } = await sb.from('marketing_team').select('informed, fyi_read_at').eq('staff_id', me).maybeSingle();
  if(tm && tm.informed){
    const since = tm.fyi_read_at || new Date(Date.now() - 14*864e5).toISOString();
    const { data: ev } = await sb.from('marketing_post_events').select('post_id').like('kind', 'approved%').gt('created_at', since).neq('actor', me).limit(200);
    const open = new Set((posts || []).map(p => p.id));
    const n = new Set((ev || []).map(e => e.post_id).filter(id => open.has(id))).size;
    if(n) lines.push({ tag:'Marketing HQ', html:`${n} post${n === 1 ? ' was' : 's were'} approved, for your info`, href:'staff-marketing.html#turn', btn:'See' });
  }
  const lateAll = (posts || []).filter(p => p.post_date && due(p) && due(p) < today);
  const boss = window._isAdminOrIt && canAccess('marketing', 'full');
  // The admin sees posts that are late at someone else's step
  if(boss){
    const lateOthers = lateAll.filter(p => !mine.includes(p));
    if(lateOthers.length) lines.push({ tag:'Marketing HQ', html:`${plural(lateOthers.length, 'post is', 'posts are')} late at someone else's step`, href:'staff-marketing.html#overview', btn:'Overview' });
  }
  const todays = (week || []).filter(p => p.post_date === today);
  return {
    lines,
    cards: canAccess('marketing', 'full') ? [{ area:'Marketing', order:4, items:[{ num:(week || []).length, label:'posts this week', href:'staff-marketing.html#overview' }, { num:lateAll.length, label:'late', href:'staff-marketing.html#overview' }] }] : [],
    today: todays.length ? [{ h:'Marketing', order:4, rows: todays.slice(0, 3).map(p => [p.step === 'posted' ? 'Posted' : 'Goes out', `<a href="staff-marketing.html#post/${p.id}">${escD(p.title)}</a>`]) }] : [],
    quick: canAccess('marketing', 'edit') ? [{ label:'New post', href:'staff-marketing.html#new', order:3 }] : []
  };
});


async function collectTodos(){
  window._isAdminOrIt = ['admin','director','it'].includes(window.currentStaffRole);
  return (await Promise.all(SOURCES.map(fn => fn().catch(err => { console.log('todo source failed', err); return null; })))).filter(Boolean);
}
