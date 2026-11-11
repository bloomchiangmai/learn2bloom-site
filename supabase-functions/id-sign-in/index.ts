// Sign in (or send a reset link) with a Student ID or Staff ID, without ever
// telling the browser which email belongs to an ID. Replaces
// resolve-login-identity and resolve-staff-login-identity (8 Nov 2026).
//
// 11 Nov 2026, group login: people who also work at INGROUP ASIA (the hub) sign in to Bloom
// with their IGA ID and IGA password. Bloom checks the password with IGA, never stores it,
// and opens the person's own Bloom account (linked through staff.hub_id).
// action "hub": a one-time 60-second pass from the IGA back office opens Bloom without typing.
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const publicClient = () => createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

// The hub: INGROUP ASIA back office (publishable key, safe to embed)
const HUB_URL = "https://yuwkaauznyypytjmbrez.supabase.co";
const HUB_KEY = "sb_publishable_Dy28xtg2buG-5ILIfLQ5jA_1DndPC3b";
const HUB_ID = /^IGA[A-Z]{3}\d{3}$/i;

const ALLOWED_ORIGINS = ["https://learn2bloom.org", "https://www.learn2bloom.org", "https://portal.learn2bloom.org", "https://learn2bloom-staging.netlify.app"];
const RESET_TO = { parent: "https://portal.learn2bloom.org/reset-password.html", staff: "https://learn2bloom.org/staff-reset-password.html" };

function cors(req: Request, body: unknown, status = 200) {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+--learn2bloom[a-z0-9-]*\.netlify\.app$/.test(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": allow,
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
    },
  });
}

async function emailForAuthId(authId: string | null): Promise<string | null> {
  if (!authId) return null;
  const { data: u } = await admin.auth.admin.getUserById(authId);
  return u?.user?.email ?? null;
}

async function emailFor(kind: string, id: string): Promise<string | null> {
  let authId: string | null = null;
  if (kind === "staff") {
    const { data } = await admin.from("staff").select("auth_user_id, status").eq("staff_id_code", id.toUpperCase()).maybeSingle();
    if (data && data.status === "active") authId = data.auth_user_id;
  } else if (kind === "parent") {
    const { data: s } = await admin.from("students").select("family_id").eq("student_id_code", id).maybeSingle();
    if (s?.family_id) {
      const { data: f } = await admin.from("families").select("auth_user_id").eq("id", s.family_id).maybeSingle();
      authId = f?.auth_user_id ?? null;
    }
  }
  return emailForAuthId(authId);
}

// Bloom account linked to an IGA ID (active staff only)
async function emailForHub(hubId: string): Promise<string | null> {
  const { data } = await admin.from("staff").select("auth_user_id, status, hub_id").not("hub_id", "is", null);
  const row = (data || []).find((r: any) => String(r.hub_id).toUpperCase() === hubId.toUpperCase());
  if (!row || row.status !== "active") return null;
  return emailForAuthId(row.auth_user_id);
}

// Ask the hub whether this IGA ID and password are right, and the person is active there.
async function hubPasswordOk(hubId: string, password: string): Promise<"ok" | "wrong" | "rate"> {
  const r = await fetch(`${HUB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: HUB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${hubId.toLowerCase()}@staff.ingroup.asia`, password }),
  });
  if (r.status === 429) return "rate";
  if (!r.ok) return "wrong";
  const t = await r.json();
  let ok = false;
  try {
    const p = await fetch(`${HUB_URL}/rest/v1/profiles?select=active,staff_no&id=eq.${t.user?.id}`, {
      headers: { apikey: HUB_KEY, Authorization: `Bearer ${t.access_token}` },
    });
    const rows = await p.json();
    ok = Array.isArray(rows) && rows[0]?.active === true && String(rows[0].staff_no).toUpperCase() === hubId.toUpperCase();
  } finally {
    // Close the session we opened at the hub; we only needed the answer.
    await fetch(`${HUB_URL}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: HUB_KEY, Authorization: `Bearer ${t.access_token}` } }).catch(() => {});
  }
  return ok ? "ok" : "wrong";
}

// Swap a one-time pass from the hub for the IGA ID it was issued to (null if expired or used).
async function hubRedeem(pass: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(pass)) return null;
  const r = await fetch(`${HUB_URL}/rest/v1/rpc/hub_pass_redeem`, {
    method: "POST",
    headers: { apikey: HUB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: pass }),
  });
  if (!r.ok) return null;
  const v = await r.json();
  return typeof v === "string" && v ? v : null;
}

// Open a Bloom session for a linked person without their Bloom password.
async function sessionFor(email: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) throw error || new Error("no link");
  const { data: v, error: e2 } = await publicClient().auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "magiclink" });
  if (e2 || !v?.session) throw e2 || new Error("no session");
  return { access_token: v.session.access_token, refresh_token: v.session.refresh_token };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors(req, null, 204);
  if (req.method !== "POST") return cors(req, { error: "Method not allowed" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return cors(req, { error: "Invalid request" }, 400); }

  // Switch from the INGROUP ASIA back office with a one-time pass
  if (b.action === "hub") {
    const hubId = await hubRedeem(String(b.pass || ""));
    const email = hubId ? await emailForHub(hubId) : null;
    if (!email) return cors(req, { error: "That link has expired. Please sign in." }, 401);
    try { return cors(req, await sessionFor(email)); } catch { return cors(req, { error: "Could not sign you in. Please sign in." }, 500); }
  }

  const kind = b.kind === "staff" ? "staff" : b.kind === "parent" ? "parent" : "";
  const id = String(b.id || "").trim();
  if (!kind || !id) return cors(req, { error: kind === "staff" ? "Please enter your Staff ID." : "Please enter your Student ID." }, 400);
  const isHub = kind === "staff" && HUB_ID.test(id);

  if (b.action === "reset") {
    // IGA IDs use their INGROUP ASIA password, so the reset happens there.
    if (isHub) return cors(req, { ok: true, hub: true });
    const email = await emailFor(kind, id);
    // Same answer whether or not the ID exists, so IDs cannot be tested.
    if (email) await publicClient().auth.resetPasswordForEmail(email, { redirectTo: RESET_TO[kind as "parent" | "staff"] });
    return cors(req, { ok: true });
  }

  const password = String(b.password || "");
  const wrong = kind === "staff" ? "Incorrect Staff ID or password." : "Incorrect Student ID or password. Please try again.";
  if (!password) return cors(req, { error: wrong }, 401);

  if (isHub) {
    const email = await emailForHub(id);
    if (!email) return cors(req, { error: wrong }, 401);
    const check = await hubPasswordOk(id, password);
    if (check === "rate") return cors(req, { error: "Too many attempts. Please wait a few minutes and try again." }, 429);
    if (check !== "ok") return cors(req, { error: wrong }, 401);
    try { return cors(req, await sessionFor(email)); } catch { return cors(req, { error: "Could not sign you in. Please try again." }, 500); }
  }

  const email = await emailFor(kind, id);
  if (!email) return cors(req, { error: wrong }, 401);
  const { data, error } = await publicClient().auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    const tooMany = /rate|too many/i.test(error?.message || "");
    return cors(req, { error: tooMany ? "Too many attempts. Please wait a few minutes and try again." : wrong }, tooMany ? 429 : 401);
  }
  return cors(req, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});
