// Web push for Bloom staff. Actions:
//   key          -> the public key the browser needs to subscribe
//   subscribe    -> save this browser for the signed-in staff member (Bearer token)
//   unsubscribe  -> forget this browser
//   test         -> send "Notifications are on" to the signed-in staff member
//   send         -> from the database only (x-hook-secret): notify a list of staff
// The signing keys are made here on first use and kept in push_private; nobody copies them anywhere.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://learn2bloom.org", "https://www.learn2bloom.org", "https://learn2bloom-staging.netlify.app", "http://localhost:8765"];
const cors = (req: Request) => {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
};
const reply = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

let ready: Promise<{ pub: string }> | null = null;
async function vapid() {
  const get = async () => Object.fromEntries(((await admin.from("push_private").select("k, v").in("k", ["vapid_public", "vapid_private"])).data || []).map((r) => [r.k, r.v]));
  let k = await get();
  if (!k.vapid_public || !k.vapid_private) {
    const g = webpush.generateVAPIDKeys();
    await admin.from("push_private").upsert([{ k: "vapid_public", v: g.publicKey }, { k: "vapid_private", v: g.privateKey }], { onConflict: "k", ignoreDuplicates: true });
    k = await get();
  }
  webpush.setVapidDetails("mailto:hello@learn2bloom.org", k.vapid_public, k.vapid_private);
  return { pub: k.vapid_public as string };
}

async function sendTo(staffIds: string[], payload: Record<string, unknown>) {
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth").in("staff_id", staffIds);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    }
  }
  return sent;
}

async function me(req: Request) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const { data } = await admin.auth.getUser(tok);
  if (!data?.user) return null;
  const { data: st } = await admin.from("staff").select("id, status").eq("auth_user_id", data.user.id).maybeSingle();
  return st && st.status === "active" ? st : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    ready = ready || vapid();
    const { pub } = await ready;
    const b = await req.json().catch(() => ({}));
    if (b.action === "key") return reply(req, { publicKey: pub });
    if (b.action === "send") {
      const { data: sec } = await admin.from("push_private").select("v").eq("k", "hook_secret").maybeSingle();
      if (!sec || req.headers.get("x-hook-secret") !== sec.v) return reply(req, { error: "Not allowed" }, 403);
      const n = await sendTo((b.staff || []).map(String), { title: String(b.title || "Bloom"), body: String(b.body || ""), url: String(b.url || "/staff-dashboard.html"), tag: b.tag || undefined });
      return reply(req, { sent: n });
    }
    const st = await me(req);
    if (!st) return reply(req, { error: "Please sign in again." }, 401);
    if (b.action === "subscribe") {
      const s = b.sub || {};
      if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) return reply(req, { error: "Bad subscription" }, 400);
      const { error } = await admin.from("push_subscriptions").upsert({ endpoint: s.endpoint, staff_id: st.id, p256dh: s.keys.p256dh, auth: s.keys.auth, ua: String(b.ua || "").slice(0, 200) }, { onConflict: "endpoint" });
      if (error) return reply(req, { error: error.message }, 400);
      return reply(req, { ok: true });
    }
    if (b.action === "unsubscribe") {
      if (b.endpoint) await admin.from("push_subscriptions").delete().eq("endpoint", b.endpoint).eq("staff_id", st.id);
      return reply(req, { ok: true });
    }
    if (b.action === "test") {
      const n = await sendTo([st.id], { title: "Notifications are on", body: "You will get a message here when something waits for you.", url: "/staff-dashboard.html", tag: "test" });
      return reply(req, { sent: n });
    }
    return reply(req, { error: "Unknown action" }, 400);
  } catch (e) {
    return reply(req, { error: String((e as Error).message || e) }, 500);
  }
});
