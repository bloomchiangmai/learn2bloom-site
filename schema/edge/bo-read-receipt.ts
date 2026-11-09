// Bloom Chiangmai back office (S23): reads receipt photos. Ported from the IGA back office.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// Supporting documents (order pages, payment slips, confirmations) count as receipts (decided 1 Nov 2026).
// Reads a receipt photo with Claude. A photo may contain several receipts.
// Clean receipts become expense lines (needs_review). Anything questionable is HELD
// in Needs attention (ai_data.held_reason) for a person to decide:
//   duplicate   - same date, time and amount as an existing line (same store when no time)
//   unsure      - low confidence, no date, or no amount
//   not_receipt - not a receipt
//   currency    - not THB and no exchange rate found (otherwise converted to THB automatically)
// preview: true  -> read only (e.g. after cropping), return the result, create nothing.
// Needs secret ANTHROPIC_API_KEY. Optional ANTHROPIC_MODEL (default claude-haiku-5-5).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// THB per 1 unit on a date (European Central Bank reference rates via frankfurter.dev)
async function fxRate(cur: string, date: string | null): Promise<number | null> {
  if (!cur || cur === "THB" || !date) return null;
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${encodeURIComponent(cur)}&symbols=THB`);
    const j = await r.json();
    return Number(j?.rates?.THB) || null;
  } catch { return null; }
}
const norm = (t: unknown) => String(t ?? "").toLowerCase().replace(/[^a-z0-9ก-๙]+/g, "");

function extractJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  const open = text[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// GROUP mode (Add / Edit expense window): several documents attached to 1 line.
// Decide which belong to the same purchase (receipt + payment slip + order page...) and which are a
// different purchase. Reads only, writes nothing.
// deno-lint-ignore no-explicit-any
async function groupDocs(admin: any, uid: string, body: { saved_ids?: string[]; files?: { mime: string; data: string; name?: string }[] }) {
  const key = Deno.env.get("ANTHROPIC_API_KEY_BACKOFFICE");
  if (!key) return json({ status: "off" });
  const docs: { mime: string; data: string }[] = [];
  const ids = (body.saved_ids ?? []).slice(0, 6);
  if (ids.length) {
    const { data: rows } = await admin.from("receipts").select("id, staff_id, storage_path, mime_type").in("id", ids);
    for (const id of ids) {
      const r = (rows ?? []).find((x: { id: string }) => x.id === id);
      if (!r || r.staff_id !== uid) return json({ error: "Receipt not found" }, 404);
      const { data: file } = await admin.storage.from("bo-receipts").download(r.storage_path);
      if (!file) return json({ status: "failed", error: "Could not open a file" });
      docs.push({ mime: String(r.mime_type || ""), data: encodeBase64(new Uint8Array(await file.arrayBuffer())) });
    }
  }
  for (const f of (body.files ?? []).slice(0, 6)) docs.push({ mime: String(f.mime || ""), data: String(f.data || "") });
  if (!docs.length || docs.length > 8) return json({ status: "failed", error: "Attach 1 to 8 files" });
  if (docs.some((d) => d.mime !== "application/pdf" && !IMAGE_TYPES.includes(d.mime))) return json({ status: "failed", error: "File type cannot be read" });

  const { data: cats0 } = await admin.from("expense_categories").select("id, name, on_petty, on_project").eq("active", true).order("sort_order");
  const cats = (cats0 ?? []).filter((c) => c.on_petty || c.on_project);
  const names = (cats ?? []).map((c: { name: string }) => c.name);
  const content: unknown[] = [];
  docs.forEach((d, i) => {
    content.push({ type: "text", text: `Document ${i}:` });
    content.push(d.mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data } }
      : { type: "image", source: { type: "base64", media_type: d.mime, data: d.data } });
  });
  content.push({ type: "text", text: `These ${docs.length} documents were attached to ONE expense line by a staff member of a school in Chiang Mai, Thailand.
Some may be supporting documents for the SAME purchase (receipt, tax invoice, bank transfer or payment slip, online order page, delivery note). Others may be a DIFFERENT purchase attached by mistake.
Group the documents by purchase. Same purchase = same seller or payee AND exactly the same final amount paid, dates within a few days. If the amounts are different, they are ALWAYS different purchases, even for the same seller or order.
Reply with ONLY a JSON array, one object per purchase, no other text:
[{"docs": [document numbers], "kinds": ["receipt" | "tax invoice" | "payment slip" | "order page" | "delivery note" | "other", one per document in the same order], "amounts": [final amount shown on each document, number or null, one per document in the same order], "receipts_in_doc": [how many separate receipts each document shows, one per document in the same order; an original and its photocopy side by side count as 1], "invoice_date": "YYYY-MM-DD" or null, "receipt_time": "HH:MM" or null, "merchant": "seller name", "short_name": "short everyday brand name in English, max 3 words (for a payment slip: the payee, not the bank or app)", "item": "what was bought, max 5 words, English; for a payment slip with no item shown, write Transfer", "total_amount": number (final amount actually paid) or null, "currency": "THB", "category": one of ${JSON.stringify(names)}, "confidence": 0 to 1}]
If one photo shows several separate receipts, still list that document once and report the count in receipts_in_doc. Every document number must appear in exactly one group. Thai Buddhist years: subtract 543 (2569 = 2026, 69 = 2026). Dates are often DD/MM/YYYY.
This is a school (learning hub). Pick the closest category from the list: e.g. fuel, taxi, Grab, Bolt, tolls, parking, flights, train, bus = travel; restaurants, cafes, drinks, groceries, snacks = food; books, stationery, art and class materials = teaching; paper, ink, office items = office. If nothing fits, use the one called Other (or Miscellaneous).` });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5", max_tokens: 2000, messages: [{ role: "user", content }] }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out?.error?.message || `API error ${res.status}`);
    const text = ((out.content ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const raw = extractJson(text);
    if (!raw) throw new Error("No JSON");
    const parsed = JSON.parse(raw);
    const groups = (Array.isArray(parsed) ? parsed : [parsed]).filter((g) => g && Array.isArray(g.docs));
    // Make sure every document is in exactly 1 group
    const seen = new Set<number>();
    for (const g of groups) g.docs = g.docs.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n < docs.length && !seen.has(n) && (seen.add(n), true));
    // Company rule: a different amount is always a different line. Split any group whose papers show different amounts.
    for (const g of [...groups]) {
      const docs0: number[] = g.docs, kinds0: unknown[] = g.kinds || [];
      const amts: (number | null)[] = Array.isArray(g.amounts) ? g.amounts.map((x: unknown) => (x == null || x === "" ? null : Math.round(Number(x) * 100) / 100)) : [];
      const distinct = [...new Set(amts.filter((x): x is number => x != null && Number.isFinite(x)))];
      if (distinct.length < 2) continue;
      const keep = distinct.includes(Math.round(Number(g.total_amount) * 100) / 100) ? Math.round(Number(g.total_amount) * 100) / 100 : distinct[0];
      for (const a of distinct) {
        if (a === keep) continue;
        const idx = docs0.map((_, k) => k).filter((k) => amts[k] === a);
        groups.push({ ...g, docs: idx.map((k) => docs0[k]), kinds: idx.map((k) => kinds0[k]), amounts: idx.map(() => a), total_amount: a, item: kinds0[idx[0]] === "payment slip" ? "Transfer" : g.item });
      }
      const stay = docs0.map((_, k) => k).filter((k) => amts[k] == null || amts[k] === keep);
      g.docs = stay.map((k) => docs0[k]); g.kinds = stay.map((k) => kinds0[k]); g.amounts = stay.map((k) => amts[k]); g.total_amount = keep;
    }
    const missing = docs.map((_, i) => i).filter((i) => !seen.has(i));
    if (missing.length) groups.push({ docs: missing, kinds: missing.map(() => "other"), confidence: 0 });
    for (const g of groups) {
      const cat = (cats ?? []).find((c: { name: string }) => c.name.toLowerCase() === String(g.category ?? "").toLowerCase());
      g.category_id = cat?.id ?? null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(g.invoice_date))) g.invoice_date = null;
    }
    return json({ status: "done", groups: groups.filter((g) => g.docs.length) });
  } catch (e) {
    return json({ status: "failed", error: String((e as Error).message).slice(0, 200) });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false }, db: { schema: "bo" } });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u?.user) return json({ error: "Not signed in" }, 401);

  let body: { receipt_id?: string; preview?: boolean; mode?: string; saved_ids?: string[]; files?: { mime: string; data: string; name?: string }[] };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  if (body.mode === "group") return await groupDocs(admin, u.user.id, body);
  const preview = body.preview === true;
  const { data: rc } = await admin.from("receipts").select("*").eq("id", body.receipt_id ?? "").single();
  if (!rc || rc.staff_id !== u.user.id) return json({ error: "Receipt not found" }, 404);
  const setRc = (id: string, patch: Record<string, unknown>) => admin.from("receipts").update(patch).eq("id", id);

  const key = Deno.env.get("ANTHROPIC_API_KEY_BACKOFFICE");
  if (!key) { if (!preview) await setRc(rc.id, { ai_status: "off" }); return json({ status: "off" }); }

  const mime = String(rc.mime_type || "");
  const isPdf = mime === "application/pdf";
  if (!isPdf && !IMAGE_TYPES.includes(mime)) {
    if (!preview) await setRc(rc.id, { ai_status: "failed", ai_error: "File type cannot be read automatically" });
    return json({ status: "failed" });
  }
  const { data: file, error: dErr } = await admin.storage.from("bo-receipts").download(rc.storage_path);
  if (dErr || !file) { if (!preview) await setRc(rc.id, { ai_status: "failed", ai_error: "Could not open file" }); return json({ status: "failed" }); }
  const b64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));

  const { data: cats0 } = await admin.from("expense_categories").select("id, name, on_petty, on_project").eq("active", true).order("sort_order");
  const cats = (cats0 ?? []).filter((c) => c.on_petty || c.on_project);
  const names = (cats ?? []).map((c) => c.name);

  const prompt = `This image is from a school in Chiang Mai, Thailand. It may show ONE or SEVERAL purchase receipts, invoices or payment slips (Thai, English or Chinese).
Find every separate receipt in the image. Reply with ONLY a JSON array, one object per receipt, no other text, no code fences:
[{"is_receipt": true or false, "invoice_date": "YYYY-MM-DD" or null, "receipt_time": "HH:MM" (24h) or null, "merchant": "shop name", "item": "what was bought, max 5 words, English, no plan names or legal wording", "short_name": "short everyday store or brand name in English, max 3 words, e.g. True Move H, 7-Eleven, Zuro Sushi; no Co., Ltd. or company registration name", "total_amount": number or null, "currency": "THB", "category": one of ${JSON.stringify(names)}, "confidence": number 0 to 1, "box": [left, top, right, bottom]}]
"box" is where that receipt sits in the image, as fractions of the image width and height from 0 to 1 (top-left is 0,0). Include the whole receipt paper.
Our staff often put the ORIGINAL receipt and a PHOTOCOPY of the same receipt side by side (the copy keeps the text readable after thermal paper fades). If two receipts in the image show the same store, date, time and total, they are ONE receipt: return it once, with "box" covering BOTH copies.
Any proof of a purchase or payment counts as a receipt (is_receipt true): receipts, tax invoices, bank transfer or payment slips, online order pages or order confirmations, e-receipts, booking confirmations. Many purchases have no proper receipt, so these supporting documents are fine. Only use is_receipt false when the image shows no purchase or payment at all (e.g. a chat with no amount, a random photo).
Rules: Dates are often printed as DD/MM/YYYY. Thai Buddhist years (25xx, e.g. 2569) must be converted by subtracting 543 (2569 = 2026); a 2-digit year like 69 means 2569 = 2026. Read the date and time printed on the receipt carefully; if unsure, lower confidence. total_amount is the final total paid after discounts and VAT. This is a school (learning hub). Pick the closest category from the list: e.g. fuel, taxi, Grab, Bolt, tolls, parking, flights, train, bus = travel; restaurants, cafes, drinks, groceries, snacks = food; books, stationery, art and class materials = teaching; paper, ink, office items = office. If nothing fits, use the one called Other (or Miscellaneous).`;

  const content: unknown[] = [
    isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
          : { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
    { type: "text", text: prompt },
  ];

  let list: Record<string, unknown>[];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5", max_tokens: 2500, messages: [{ role: "user", content }] }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out?.error?.message || `API error ${res.status}`);
    const blocks = (out.content ?? []) as { type: string; text?: string }[];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const raw = extractJson(text);
    if (!raw) throw new Error(`No JSON. stop=${out.stop_reason} text=${text.slice(0, 200)}`);
    const parsed = JSON.parse(raw);
    list = (Array.isArray(parsed) ? parsed : [parsed]).filter((x) => x && typeof x === "object").slice(0, 10);
    if (!list.length) throw new Error("Empty result");
    // Original + photocopy side by side: same store, date, time and total in one photo = 1 receipt.
    // Keep one entry and widen its box so the crop keeps both copies.
    const merged: Record<string, unknown>[] = [];
    for (const x of list) {
      const same = merged.find((m) =>
        Number(m.total_amount) === Number(x.total_amount) && Number.isFinite(Number(x.total_amount)) &&
        String(m.invoice_date || "") === String(x.invoice_date || "") && !!x.invoice_date &&
        String(m.receipt_time || "") === String(x.receipt_time || "") &&
        (!!x.receipt_time || norm(m.merchant) === norm(x.merchant)));
      if (!same) { merged.push(x); continue; }
      const a = same.box as number[] | undefined, b = x.box as number[] | undefined;
      if (Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4) {
        same.box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
      }
      same.copies = Number(same.copies || 1) + 1;
      if (Number(x.confidence ?? 0) > Number(same.confidence ?? 0)) same.confidence = x.confidence;
    }
    list = merged;
  } catch (e) {
    if (!preview) await setRc(rc.id, { ai_status: "failed", ai_error: String((e as Error).message).slice(0, 500) });
    return json({ status: "failed", error: String((e as Error).message).slice(0, 200) });
  }

  const shape = (p: Record<string, unknown>) => {
    const cat = (cats ?? []).find((c) => c.name.toLowerCase() === String(p.category ?? "").toLowerCase());
    const amount = typeof p.total_amount === "number" ? p.total_amount : Number(p.total_amount);
    return {
      p, cat,
      amount, amt: Math.round(amount * 100) / 100,
      currency: String(p.currency || "THB").toUpperCase().slice(0, 3),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.invoice_date)) ? String(p.invoice_date) : null,
      time: /^[0-2]\d:[0-5]\d$/.test(String(p.receipt_time)) ? String(p.receipt_time) : null,
      merchant: String(p.merchant || "").trim(),
      conf: Number(p.confidence ?? 0),
    };
  };

  // Read-only (after crop): return the first receipt, store it on the receipt, create nothing
  if (preview) {
    const x = shape(list[0]);
    const ai = { ...x.p, receipt_time: x.time, invoice_date: x.date, category_id: x.cat?.id ?? null, held_reason: null, duplicate_item: null, part: null, reread: true };
    await setRc(rc.id, { ai_status: "done", ai_data: ai, ai_error: null, category_id: x.cat?.id ?? rc.category_id });
    return json({ status: "done", data: ai, found: list.length });
  }

  const { data: rep } = rc.report_id
    ? await admin.from("expense_reports").select("id, status, staff_id, form_type").eq("id", rc.report_id).single()
    : { data: null };
  const reportOk = rep && rep.staff_id === u.user.id && ["draft", "rejected"].includes(rep.status);

  const { data: myReps } = await admin.from("expense_reports").select("id").eq("staff_id", u.user.id);
  const repIds = (myReps ?? []).map((r) => r.id);
  const { data: myLines } = repIds.length
    ? await admin.from("expense_items").select("id, invoice_date, amount, merchant, receipt_time, item").in("report_id", repIds)
    : { data: [] as { id: string; invoice_date: string; amount: number; merchant: string | null; receipt_time: string | null; item: string }[] };
  const seen = [...(myLines ?? [])];

  const results: { data: Record<string, unknown>; item_id: string | null; receipt_id: string }[] = [];
  for (let k = 0; k < list.length; k++) {
    const { p, cat, amount, amt, currency, date, time, merchant, conf } = shape(list[k]);

    // Foreign receipt: convert to THB with the reference rate of the receipt date; hold only if no rate
    const rate = currency !== "THB" && Number.isFinite(amt) ? await fxRate(currency, date) : null;
    const thb = currency === "THB" ? amt : rate ? Math.round(amt * rate * 100) / 100 : NaN;
    // Lines are stored in THB, so compare in THB (foreign receipts too)
    const dup = date && Number.isFinite(thb) ? seen.find((l) =>
      Number(l.amount) === thb && l.invoice_date === date &&
      ((l.receipt_time && time && l.receipt_time === time) ||
       ((!l.receipt_time || !time) && (!norm(l.merchant) || !norm(merchant) || norm(l.merchant) === norm(merchant))))) : undefined;

    let held: string | null = null;
    if (p.is_receipt === false) held = "not_receipt";
    else if (dup) held = "duplicate";
    else if (currency !== "THB" && !rate) held = "currency";
    else if (!cat || !date || !Number.isFinite(amount) || amount <= 0 || conf < 0.7) held = "unsure";

    const ai = {
      ...p, receipt_time: time, category_id: cat?.id ?? null, part: list.length > 1 ? `${k + 1} of ${list.length}` : null,
      held_reason: held,
      duplicate_item: dup ? { id: dup.id, invoice_date: dup.invoice_date, amount: dup.amount, item: dup.item, receipt_time: dup.receipt_time } : null,
    };

    let rid = rc.id;
    if (k === 0) {
      await setRc(rc.id, { ai_status: "done", ai_data: ai, ai_error: null, category_id: cat?.id ?? rc.category_id });
    } else {
      const { data: extra } = await admin.from("receipts").insert({
        staff_id: rc.staff_id, report_id: rc.report_id, storage_path: rc.storage_path, file_name: rc.file_name,
        mime_type: rc.mime_type, captured_via: rc.captured_via, ai_status: "done", ai_data: ai, category_id: cat?.id ?? null,
      }).select("id").single();
      if (!extra) continue;
      rid = extra.id;
    }

    let itemId: string | null = null;
    if (!held && reportOk && !(k === 0 && rc.item_id)) {
      const what = String(p.item || "").trim();
      const { data: item } = await admin.from("expense_items").insert({
        report_id: rep!.id, invoice_date: date, receipt_time: time, merchant: merchant || null,
        item: ((s) => (s && !what.toLowerCase().includes(s.toLowerCase()) ? [what, s].filter(Boolean).join(", ") : what || s))(String(p.short_name || "").trim() || merchant).slice(0, 60) || "Receipt",
        // A category not ticked for this form type (Settings › Categories) becomes Miscellaneous
        category_id: (rep!.form_type === "project" ? cat!.on_project : cat!.on_petty) ? cat!.id : ((cats ?? []).find((c) => /misc|other/i.test(c.name))?.id ?? cat!.id), purpose: "", qty: 1, amount: thb,
        currency, original_amount: currency === "THB" ? null : amt, exchange_rate: currency === "THB" ? null : rate,
        payment_method: "cash_advance", needs_review: true,
      }).select("id, invoice_date, amount, merchant, receipt_time, item").single();
      if (item) { itemId = item.id; seen.push(item); await setRc(rid, { item_id: item.id }); }
    }
    results.push({ data: ai, item_id: itemId, receipt_id: rid });
  }
  return json({ status: "done", count: results.length, results, data: results[0]?.data, item_id: results[0]?.item_id ?? null });
});
