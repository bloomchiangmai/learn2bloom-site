// Group People and companies page (11 Nov 2026).
// Called from the INGROUP ASIA back office (the hub) by an IGA admin. Adds, removes and sets up
// linked people in Bloom Chiangmai: their Bloom account, Bloom role, and whether their timesheet is here.
// The caller proves who they are with their IGA session; Bloom checks it with IGA before doing anything.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const HUB_URL = "https://yuwkaauznyypytjmbrez.supabase.co";
const HUB_KEY = "sb_publishable_Dy28xtg2buG-5ILIfLQ5jA_1DndPC3b";
const ALLOWED = ["https://iga-backoffice.netlify.app"];
const HUB_ID = /^IGA[A-Z]{3}\d{3}$/;
const ROLES: Record<string, string> = {
  admin: "Admin", director: "Director", operations_manager: "Operations Manager",
  education_lead: "Education Lead", education_consultant: "Education Consultant", lead_teacher: "Lead Teacher",
  learning_coach: "Learning Coach", learning_coach_assistant: "Learning Coach Assistant",
  admissions: "Admissions Officer", enrollment: "Enrollment Coordinator", front_desk: "Front Desk / Office Manager",
  it: "IT Support", teaching_assistant: "Teaching Assistant", marketing: "Marketing", accountant: "Accountant (outside)",
};

function reply(req: Request, body: unknown, status = 200) {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED.includes(origin) || /^https:\/\/[a-z0-9-]+--iga-backoffice\.netlify\.app$/.test(origin) ? origin : ALLOWED[0];
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": allow, "Vary": "Origin",
      "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json",
    },
  });
}

// Is the caller an active IGA admin? Checked with IGA using the caller's own session.
async function igaAdmin(token: string): Promise<string | null> {
  if (!token) return null;
  const u = await fetch(`${HUB_URL}/auth/v1/user`, { headers: { apikey: HUB_KEY, Authorization: `Bearer ${token}` } });
  if (!u.ok) return null;
  const user = await u.json();
  const p = await fetch(`${HUB_URL}/rest/v1/profiles?select=role,active,staff_no&id=eq.${user.id}`, { headers: { apikey: HUB_KEY, Authorization: `Bearer ${token}` } });
  const rows = p.ok ? await p.json() : [];
  return rows?.[0]?.active && rows[0].role === "admin" ? rows[0].staff_no : null;
}

async function linked() {
  const { data: staff } = await admin.from("staff").select("id, auth_user_id, name, role, status, staff_id_code, hub_id").not("hub_id", "is", null);
  const ids = (staff || []).map((s: any) => s.auth_user_id).filter(Boolean);
  const { data: prof } = ids.length ? await admin.schema("bo").from("profiles").select("id, no_timesheet, is_data_entry, is_hr, is_accountant").in("id", ids) : { data: [] };
  return (staff || []).map((s: any) => {
    const p = (prof || []).find((x: any) => x.id === s.auth_user_id) || {};
    return { hub_id: String(s.hub_id).toUpperCase(), name: s.name, role: s.role, active: s.status === "active", bloom_id: s.staff_id_code, timesheet_here: p.no_timesheet === false };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return reply(req, null, 204);
  if (req.method !== "POST") return reply(req, { error: "Method not allowed" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return reply(req, { error: "Invalid request" }, 400); }
  const by = await igaAdmin(String(b.token || ""));
  if (!by) return reply(req, { error: "Only an INGROUP ASIA admin can do this." }, 403);

  if (b.action === "list") return reply(req, { people: await linked(), roles: ROLES });

  const hub = String(b.hub_id || "").toUpperCase();
  if (!HUB_ID.test(hub)) return reply(req, { error: "Not a valid IGA ID." }, 400);
  const { data: rows } = await admin.from("staff").select("id, auth_user_id, status, role, hub_id").not("hub_id", "is", null);
  const row: any = (rows || []).find((r: any) => String(r.hub_id).toUpperCase() === hub);

  if (b.action === "link") {
    const role = String(b.role || "");
    if (!ROLES[role]) return reply(req, { error: "Choose a Bloom role." }, 400);
    if (row) {
      const { error } = await admin.from("staff").update({ status: "active", archived_at: null, role, job_title: ROLES[role] }).eq("id", row.id);
      if (error) return reply(req, { error: error.message }, 400);
      if (row.auth_user_id) await admin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: "none" });
    } else {
      const name = String(b.name || "").trim() || hub;
      const pw = crypto.randomUUID() + crypto.randomUUID(); // never used: linked people sign in with their IGA password
      const { data: nu, error: ce } = await admin.auth.admin.createUser({ email: `${hub.toLowerCase()}@staff.ingroup.asia`, password: pw, email_confirm: true });
      if (ce || !nu?.user) return reply(req, { error: "Could not create the Bloom account: " + (ce?.message || "") }, 400);
      const { error: se } = await admin.from("staff").insert({ auth_user_id: nu.user.id, name, role, job_title: ROLES[role], staff_id_code: hub, hub_id: hub });
      if (se) { await admin.auth.admin.deleteUser(nu.user.id); return reply(req, { error: "Could not create the Bloom staff record: " + se.message }, 400); }
    }
    // New links keep their timesheet in IGA unless told otherwise
    const { data: s2 } = await admin.from("staff").select("auth_user_id").eq("hub_id", hub).maybeSingle();
    if (s2?.auth_user_id) await admin.schema("bo").from("profiles").update({ no_timesheet: b.timesheet_here !== true }).eq("id", s2.auth_user_id);
    return reply(req, { ok: true, people: await linked() });
  }

  if (!row) return reply(req, { error: "This person is not in Bloom Chiangmai." }, 404);

  if (b.action === "unlink") {
    const { error } = await admin.from("staff").update({ status: "archived", archived_at: new Date().toISOString() }).eq("id", row.id);
    if (error) return reply(req, { error: error.message }, 400);
    if (row.auth_user_id) await admin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: "876000h" });
    return reply(req, { ok: true, people: await linked() });
  }

  if (b.action === "role") {
    const role = String(b.role || "");
    if (!ROLES[role]) return reply(req, { error: "Choose a Bloom role." }, 400);
    const { error } = await admin.from("staff").update({ role, job_title: ROLES[role] }).eq("id", row.id);
    if (error) return reply(req, { error: error.message }, 400);
    return reply(req, { ok: true, people: await linked() });
  }

  if (b.action === "timesheet") {
    if (!row.auth_user_id) return reply(req, { error: "No Bloom account." }, 400);
    const { error } = await admin.schema("bo").from("profiles").update({ no_timesheet: b.here !== true }).eq("id", row.auth_user_id);
    if (error) return reply(req, { error: error.message }, 400);
    return reply(req, { ok: true, people: await linked() });
  }

  return reply(req, { error: "Unknown action" }, 400);
});
