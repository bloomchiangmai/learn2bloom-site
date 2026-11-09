// Bloom Chiangmai back office (S23), ported from the IGA back office.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// Reads one supplier bill or K BIZ payment slip (photo or PDF) into kbiz_docs and gives it a kbiz_payments line.
// Admin or data entry only. A slip whose transaction number already exists is marked duplicate (no line).
// A slip paid to a staff member (matched on their bank account name or full name) is admin-only, so data entry never sees it.
// Needs secret ANTHROPIC_API_KEY. Optional ANTHROPIC_MODEL.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const norm = (s: string) => String(s || "").toLowerCase().replace(/^(mr|mrs|ms|miss|นาย|นาง|นางสาว)\.?\s+/, "").replace(/\s+(mr|mrs|ms|miss)\.?$/, "").replace(/[^a-z฀-๿ ]/g, " ").replace(/\s+/g, " ").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false }, db: { schema: 'bo' } });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u?.user) return json({ error: "Not signed in" }, 401);
  const { data: me } = await admin.from("profiles").select("role, is_data_entry, active").eq("id", u.user.id).single();
  if (!me?.active || !(me.role === "admin" || me.is_data_entry)) return json({ error: "Not allowed" }, 403);

  let body: { doc_id?: string; peek_path?: string; mime?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  // Peek: read a file (e.g. an invoice for a card charge) and return what it says, without saving anything
  const peek = !!body.peek_path;
  const { data: d0 } = peek ? { data: { id: null, file_path: body.peek_path, mime: body.mime ?? null, payment_id: null } } : await admin.from("kbiz_docs").select("*").eq("id", body.doc_id ?? "").single();
  const d = d0 as Record<string, any> | null;
  if (!d) return json({ error: "Not found" }, 404);
  const fail = async (msg: string) => { if (!peek) await admin.from("kbiz_docs").update({ status: "failed", error: msg }).eq("id", d.id); return json({ error: msg }); };

  const key = Deno.env.get("ANTHROPIC_API_KEY_BACKOFFICE");
  if (!key) return await fail("The reader is not set up");
  const { data: file, error: dErr } = await admin.storage.from("bo-receipts").download(d.file_path);
  if (dErr || !file) return await fail("Could not open the file");
  const mime = d.mime || file.type || "image/jpeg";
  const b64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
  const doc = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime.startsWith("image/") ? mime : "image/jpeg", data: b64 } };

  const prompt = `This document belongs to Bloom Chiangmai, a school (learning hub) in Chiang Mai, Thailand. It is EITHER a bank payment slip (e.g. a K BIZ "Transfer Completed" slip showing From the school's account, To someone, amount, transaction number, memo) OR a bill from a supplier (invoice, tax invoice, receipt, bill, quotation marked paid).
Reply with ONLY a JSON object, no other text, no code fences:
{"kind": "slip" | "bill" | "other", "date": "YYYY-MM-DD" or null, "amount": number or null, "party": "for a slip: the payee (To) name; for a bill: the supplier name", "tax_id": "supplier 13-digit tax ID on a bill, else null", "vat_amount": number or null, "wht_rate": number (percent, e.g. 3) or null, "wht_amount": number or null, "txn_no": "slip transaction number, else null", "memo": "slip memo text, else null", "item": "what the bill is for, max 6 words, English, else null", "currency": "3-letter currency of amount, e.g. THB or USD", "address": "supplier address on a bill, one line, else null", "phone": "supplier phone on a bill, else null"}
For a bill, "amount" is the bill total including VAT, before any withholding tax. For a slip, "amount" is the amount transferred. Thai Buddhist years: subtract 543 (2569 = 2026, 69 = 2026).`;

  let x: Record<string, unknown> = {};
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5", max_tokens: 1200, messages: [{ role: "user", content: [doc, { type: "text", text: prompt }] }] }),
    });
    const j = await r.json();
    if (!r.ok) return await fail(j?.error?.message || "The reader failed");
    const text = (j.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    x = m ? JSON.parse(m[0]) : {};
  } catch (e) { return await fail("The reader failed: " + String(e)); }
  if (peek) return json({ ...x, supplier: await vendorFor(admin, String(x.party || "")) });
  if (x.kind !== "slip" && x.kind !== "bill") return await fail("This does not look like a supplier bill or a payment slip");

  const patch: Record<string, unknown> = {
    kind: x.kind, doc_date: x.date || null, amount: x.amount != null ? Number(x.amount) : null,
    party: x.party ? String(x.party).slice(0, 200) : null, tax_id: x.tax_id ? String(x.tax_id).replace(/\D/g, "").slice(0, 13) || null : null,
    vat_amount: x.vat_amount != null ? Number(x.vat_amount) : null, wht_rate: x.wht_rate != null ? Number(x.wht_rate) : null,
    wht_amount: x.wht_amount != null ? Number(x.wht_amount) : null, txn_no: x.txn_no ? String(x.txn_no).trim().slice(0, 60) : null,
    memo: x.memo ? String(x.memo).slice(0, 300) : null, item: x.item ? String(x.item).slice(0, 120) : null,
    address: x.address ? String(x.address).slice(0, 300) : null, phone: x.phone ? String(x.phone).slice(0, 40) : null,
  };

  // Same slip twice: refuse it
  if (patch.txn_no) {
    const { data: dup } = await admin.from("kbiz_docs").select("id, doc_date, party, amount").eq("txn_no", patch.txn_no).neq("id", d.id).neq("status", "duplicate").limit(1);
    if (dup?.length) {
      await admin.from("kbiz_docs").update({ ...patch, txn_no: null, status: "duplicate", error: `Already saved: ${dup[0].party ?? ""} ${dup[0].amount ?? ""} on ${dup[0].doc_date ?? ""}` }).eq("id", d.id);
      return json({ status: "duplicate" });
    }
  }

  // Slip to a staff member: admin only (may be a salary)
  let adminOnly = false;
  if (d.payment_id) {
    const { data: pp } = await admin.from("kbiz_payments").select("admin_only").eq("id", d.payment_id).single();
    adminOnly = !!pp?.admin_only;
  } else if (x.kind === "slip" && patch.party) {
    const pn = norm(String(patch.party));
    const [{ data: banks }, { data: ppl }] = await Promise.all([
      admin.from("staff_bank_details").select("account_name"),
      admin.from("profiles").select("full_name, thai_name"),
    ]);
    const two = (v: string) => v.split(" ").slice(0, 2);
    const [a1, a2] = two(pn);
    const names = [...(banks ?? []).map((b) => b.account_name), ...(ppl ?? []).flatMap((p) => [p.full_name, p.thai_name])].map(norm).filter((v) => v.split(" ").length >= 2);
    adminOnly = !!a1 && !!a2 && names.some((n) => { const [b1, b2] = two(n); return b1 === a1 && (b2.startsWith(a2) || a2.startsWith(b2)); });
  }

  const dt = String(patch.doc_date || new Date().toISOString().slice(0, 10));
  const month = dt.slice(0, 7) + "-01";
  let pid = d.payment_id;
  if (!pid) {
    // Fill the line by itself: supplier from the FlowAccount list, and the category and tax-on-top used last time for that supplier
    const sup = adminOnly ? null : await vendorFor(admin, String(patch.party || ""));
    const { data: last } = sup ? await admin.from("kbiz_payments").select("category_id, wht_on_top, wht_rate").eq("merchant", sup).not("category_id", "is", null).order("created_at", { ascending: false }).limit(1) : { data: null };
    const { data: p, error: pErr } = await admin.from("kbiz_payments").insert({
      period_month: month, admin_only: adminOnly, created_by: u.user.id,
      merchant: sup, category_id: last?.[0]?.category_id ?? null, wht_on_top: !!last?.[0]?.wht_on_top,
      vat_amount: x.kind === "bill" && patch.vat_amount ? patch.vat_amount : 0,
      wht_rate: x.kind === "bill" && patch.wht_rate ? patch.wht_rate : (last?.[0]?.wht_on_top ? Number(last[0].wht_rate) || 0 : 0),
      purpose: x.kind === "slip" ? patch.memo : patch.item,
    }).select("id").single();
    if (pErr) return await fail(pErr.message);
    pid = p.id;
  } else if (x.kind === "bill") {
    const { data: cur } = await admin.from("kbiz_payments").select("merchant, vat_amount, wht_rate").eq("id", pid).single();
    const up: Record<string, unknown> = {};
    if (!Number(cur?.vat_amount) && patch.vat_amount) up.vat_amount = patch.vat_amount;
    if (!Number(cur?.wht_rate) && patch.wht_rate) up.wht_rate = patch.wht_rate;
    if (!cur?.merchant) { const sup = await vendorFor(admin, String(patch.party || "")); if (sup) up.merchant = sup; }
    if (Object.keys(up).length) await admin.from("kbiz_payments").update(up).eq("id", pid);
  }
  const { error: uErr2 } = await admin.from("kbiz_docs").update({ ...patch, status: "ready", error: null, admin_only: adminOnly, payment_id: pid }).eq("id", d.id);
  if (uErr2) return await fail(uErr2.message);
  return json({ status: "ready", kind: x.kind, admin_only: adminOnly });
});

// Match a name on a slip or bill to the FlowAccount supplier list: exact, else the only supplier sharing the first 2 words
async function vendorFor(admin: any, party: string): Promise<string | null> {
  const n = (v: string) => String(v || "").toLowerCase().replace(/\b(co|ltd|company|limited|part|mr|mrs|ms|miss)\b\.?/g, " ").replace(/(บริษัท|จำกัด|ห้างหุ้นส่วน|นางสาว|นาย|นาง)/g, " ").replace(/[^a-z0-9฀-๿ ]/g, " ").replace(/\s+/g, " ").trim();
  const p = n(party); if (!p) return null;
  const { data } = await admin.from("fa_vendors").select("label");
  const L = (data ?? []).map((v: { label: string }) => v.label);
  const ex = L.filter((l: string) => n(l) === p); if (ex.length === 1) return ex[0];
  const w = p.split(" ").slice(0, 2).join(" ");
  const hit = L.filter((l: string) => { const m = n(l); return m && (m.startsWith(w) || p.startsWith(m.split(" ").slice(0, 2).join(" "))); });
  return hit.length === 1 ? hit[0] : null;
}
