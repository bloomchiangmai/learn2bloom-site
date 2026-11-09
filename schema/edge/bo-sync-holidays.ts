// Bloom Chiangmai back office (S23), ported from the IGA back office.
// Fetches the official Thai holidays (Bank of Thailand financial institutions' holidays) for this year and next.
// Days the company already gives (matched by name) are added by themselves; new kinds of days are asked about once.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
// Short English names, and a key used to match "the same holiday" across years
const NAMES: [RegExp, string][] = [
  [/new year'?s eve/i, "New Year's Eve"], [/new year/i, 'New Year'], [/makha/i, 'Makha Bucha'], [/chakri/i, 'Chakri Day'],
  [/songkran/i, 'Songkran'], [/labou?r/i, 'Labour Day'], [/coronation/i, 'Coronation Day'], [/visakha/i, 'Visakha Bucha'],
  [/ploughing/i, 'Ploughing Ceremony'], [/suthida|queen'?s birthday|june 3/i, "Queen's Birthday"], [/asarnha|asalha/i, 'Asarnha Bucha'],
  [/khao phansa|buddhist lent/i, 'Khao Phansa'], [/vajiralongkorn|king'?s birthday|july 28/i, "King's Birthday"], [/mother/i, "Mother's Day"],
  [/bhumibol.*memorial|october 13|passing of/i, 'King Bhumibol Memorial'], [/chulalongkorn/i, 'Chulalongkorn Day'], [/father/i, "Father's Day"],
  [/constitution/i, 'Constitution'], [/special/i, 'Special holiday'],
];
const nice = (t: string) => { const sub = /substitut/i.test(t); const n = (NAMES.find(([re]) => re.test(t)) || [, t.replace(/\s+/g, ' ').trim().slice(0, 40)])[1]; return sub ? `${n} (sub)` : n; };
const key = (n: string) => n.replace(/\s*\(sub\)$/i, '').toLowerCase().trim();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'bo' } });
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return out({ error: 'Sign in again' }, 401);
  const { data: p } = await admin.from('profiles').select('role, is_hr').eq('id', u.user.id).maybeSingle();
  if (!p || (p.role !== 'admin' && !p.is_hr)) return out({ error: 'Not allowed' }, 403);
  const bot = Deno.env.get('BOT_API_KEY');
  if (!bot) { await admin.from('holiday_meta').upsert({ id: 1, checked_at: new Date().toISOString(), note: 'nokey' }); return out({ setup: false }); }
  const { data: hols } = await admin.from('holidays').select('day, name');
  const { data: sugg } = await admin.from('holiday_suggestions').select('day, name, status');
  const given = new Set((hols ?? []).map((h) => key(h.name || '')).filter(Boolean));
  const declined = new Set((sugg ?? []).filter((s) => s.status === 'declined').map((s) => key(s.name)));
  const have = new Set((hols ?? []).map((h) => h.day));
  const asked = new Set((sugg ?? []).map((s) => `${s.day}|${s.name}`));
  const y0 = new Date().getFullYear();
  let added = 0, newAsk: string[] = [];
  for (const y of [y0, y0 + 1]) {
    const r = await fetch(`https://gateway.api.bot.or.th/financial-institutions-holidays/?year=${y}`, { headers: { Authorization: bot, accept: 'application/json' } });
    if (!r.ok) continue;
    const j = await r.json();
    const arr: Record<string, string>[] = Array.isArray(j) ? j : j?.result?.data ?? j?.data ?? [];
    for (const x of arr) {
      const day = String(x.Date || x.date || x.HolidayDate || '').slice(0, 10);
      const desc = String(x.HolidayDescription || x.description || x.name || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !desc) continue;
      const name = nice(desc), k = key(name);
      if (have.has(day)) continue;
      if (given.has(k)) { await admin.from('holidays').upsert({ day, name }); have.add(day); added++; continue; }
      if (declined.has(k) || asked.has(`${day}|${name}`)) continue;
      await admin.from('holiday_suggestions').upsert({ day, name, status: 'ask' }); asked.add(`${day}|${name}`); newAsk.push(`${day} ${name}`);
    }
  }
  await admin.from('holiday_meta').upsert({ id: 1, checked_at: new Date().toISOString(), note: null });
  if (added || newAsk.length) {
    const { data: who } = await admin.from('profiles').select('id').eq('active', true).or('role.eq.admin,is_hr.eq.true');
    const body = `Public holidays updated from the Bank of Thailand: ${added} day${added === 1 ? '' : 's'} added${newAsk.length ? `, ${newAsk.length} new day${newAsk.length === 1 ? '' : 's'} to decide (give it or not)` : ''}.`;
    for (const w of who ?? []) await admin.from('notifications').insert({ staff_id: w.id, body, link: '#/admin/ot', created_by_name: 'Back office' });
  }
  return out({ ok: true, changed: !!(added || newAsk.length), added, asked: newAsk.length });
});
