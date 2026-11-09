// Bloom Chiangmai back office (S23), ported from the IGA back office.
// Finds the official page where a subscription is cancelled or its billing managed. Admin and data entry only.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'bo' } });
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return out({ error: 'Sign in again' }, 401);
  const { data: p } = await admin.from('profiles').select('role, is_data_entry').eq('id', u.user.id).maybeSingle();
  if (!p || (p.role !== 'admin' && !p.is_data_entry)) return out({ error: 'Not allowed' }, 403);
  const { shop, place } = await req.json().catch(() => ({}));
  if (!shop) return out({ url: null });
  const prompt = `A company card statement shows a recurring charge from "${shop}"${place ? ` (${place})` : ''}. Find the official web page where a customer manages or cancels this subscription (account billing or subscription settings page on the company's own site, or its official help article on cancelling). Reply with only the URL, nothing else. If you cannot find an official page, reply NONE.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY_BACKOFFICE')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-5-5', max_tokens: 800, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }], messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) return out({ url: null, error: `lookup failed ${r.status}` });
  const j = await r.json();
  const text = (j.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join(' ');
  const m = text.match(/https?:\/\/[^\s)"'<>]+/);
  return out({ url: m ? m[0].replace(/[.,]$/, '') : null });
});
