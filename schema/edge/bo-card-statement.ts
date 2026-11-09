// Bloom Chiangmai back office (S23), ported from the IGA back office.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// Reads a company card statement (PDF or photo) into card_charges.
// Only admin or data entry may call it. Payments to the card (autopayment, "thank you") are skipped;
// interest and bank fees are kept but marked no_doc (no receipt needed).
// Needs secret ANTHROPIC_API_KEY. Optional ANTHROPIC_MODEL.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false }, db: { schema: 'bo' } });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u?.user) return json({ error: "Not signed in" }, 401);
  const { data: me } = await admin.from("profiles").select("role, is_data_entry, active").eq("id", u.user.id).single();
  if (!me?.active || !(me.role === "admin" || me.is_data_entry)) return json({ error: "Not allowed" }, 403);

  let body: { statement_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const { data: st } = await admin.from("card_statements").select("*").eq("id", body.statement_id ?? "").single();
  if (!st) return json({ error: "Statement not found" }, 404);
  const fail = async (msg: string) => { await admin.from("card_statements").update({ status: "failed", error: msg }).eq("id", st.id); return json({ error: msg }, 200); };

  const key = Deno.env.get("ANTHROPIC_API_KEY_BACKOFFICE");
  if (!key) return await fail("The reader is not set up");
  const { data: file, error: dErr } = await admin.storage.from("bo-receipts").download(st.file_path);
  if (dErr || !file) return await fail("Could not open the file");
  const mime = file.type || (st.file_path.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
  const b64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
  const doc = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };

  const prompt = `This should be a Thai company CREDIT CARD statement (KBank Visa or similar), listing card purchases by merchant.
First decide what it is. A bank ACCOUNT statement (savings or current account, with Withdrawal / Deposit / Outstanding Balance columns, transfers "To ..." / "From ...") is NOT a card statement.
Reply with ONLY a JSON object, no other text, no code fences:
{"is_card_statement": true or false, "charges": [{"trans_date": "YYYY-MM-DD", "posting_date": "YYYY-MM-DD" or null, "description": "merchant text exactly as printed", "place": "second column text (city, website or reference) or null", "currency": "foreign currency code if shown, else null", "foreign_amount": number or null, "amount": number in THB (positive for charges, negative for payments and refunds), "kind": "charge" | "payment" | "fee"}]}
If is_card_statement is false, return an empty charges list.
kind: "payment" for payments to the card (AUTOPAYMENT, PAYMENT - THANK YOU, refunds and credits). "fee" for interest, late fees, annual fees and bank charges. Everything else is "charge".
Skip PREVIOUS BALANCE and TOTAL BALANCE lines. Dates are DD/MM/YY; Thai Buddhist years subtract 543. Amounts may have thousand commas.`;

  let rows: Array<Record<string, unknown>> = [];
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5", max_tokens: 6000, messages: [{ role: "user", content: [doc, { type: "text", text: prompt }] }] }),
    });
    const j = await r.json();
    if (!r.ok) return await fail(j?.error?.message || "The reader failed");
    const text = (j.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    if (parsed.is_card_statement === false) return await fail("This is not a company card statement (it looks like a bank account statement). Upload the Visa card statement instead");
    rows = Array.isArray(parsed.charges) ? parsed.charges : [];
  } catch (e) { return await fail("The reader failed: " + String(e)); }

  const charges = rows.filter((x) => x.kind !== "payment" && Number(x.amount) > 0 && x.trans_date)
    .map((x) => ({
      statement_id: st.id,
      trans_date: String(x.trans_date),
      posting_date: x.posting_date ? String(x.posting_date) : null,
      description: String(x.description ?? "").slice(0, 200),
      place: x.place ? String(x.place).slice(0, 200) : null,
      currency: x.currency ? String(x.currency).slice(0, 3).toUpperCase() : null,
      foreign_amount: x.foreign_amount != null ? Number(x.foreign_amount) : null,
      amount: Number(x.amount),
      no_doc: x.kind === "fee",
      note: x.kind === "fee" ? "Bank charge, no receipt needed" : null,
    }));
  if (!charges.length) return await fail("No charges found in this file");
  // Uploading the same month again: keep lines already matched, filed, filled in or asked about; add only the new ones
  await admin.from("card_charges").delete().eq("statement_id", st.id).is("item_id", null).is("doc_path", null).is("merchant", null).is("asked_staff", null);
  const { data: kept } = await admin.from("card_charges").select("trans_date, amount, description").eq("statement_id", st.id);
  const left = [...(kept ?? [])];
  const fresh = charges.filter((c) => { const k = left.findIndex((x) => x.trans_date === c.trans_date && Number(x.amount) === c.amount); if (k >= 0) { left.splice(k, 1); return false; } return true; });
  const { error: iErr } = fresh.length ? await admin.from("card_charges").insert(fresh) : { error: null };
  if (iErr) return await fail(iErr.message);
  await admin.from("card_statements").update({ status: "ready", error: null }).eq("id", st.id);
  return json({ count: charges.length });
});
