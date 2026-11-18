-- Admin clean-up: delete a test form, remove a supplier from the back office lists.
-- Both keep a copy of what was removed (deleted_reports, trash) and say who did it.

create table if not exists bo.deleted_reports (
  id bigint generated always as identity primary key,
  report_id uuid not null,
  ref_no text,
  report jsonb not null,
  items jsonb not null default '[]',
  reason text,
  deleted_by uuid default auth.uid(),
  deleted_by_name text,
  deleted_at timestamptz not null default now()
);
alter table bo.deleted_reports enable row level security;
drop policy if exists "deleted reports: admins read" on bo.deleted_reports;
create policy "deleted reports: admins read" on bo.deleted_reports for select to authenticated using (bo_private.is_admin());

-- A form can be deleted by an admin unless it is already entered in FlowAccount.
create or replace function bo.admin_delete_report(p_id uuid, p_reason text)
returns text language plpgsql security definer set search_path to '' as $$
declare r bo.expense_reports; nm text;
begin
  if not bo_private.is_admin() then raise exception 'Only an admin can delete a form'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why it is deleted'; end if;
  select * into r from bo.expense_reports where id = p_id for update;
  if not found then raise exception 'Form not found'; end if;
  if r.fa_entered_at is not null then raise exception 'This form is entered in FlowAccount. Remove it there first, then untick "Entered in FlowAccount".'; end if;
  if exists (select 1 from bo.expense_items where report_id = p_id and fa_done) then raise exception 'Some lines are entered in FlowAccount. Remove them there first.'; end if;
  select full_name into nm from bo.profiles where id = auth.uid();
  insert into bo.deleted_reports (report_id, ref_no, report, items, reason, deleted_by_name)
  values (p_id, r.ref_no, to_jsonb(r),
          coalesce((select jsonb_agg(to_jsonb(i)) from bo.expense_items i where i.report_id = p_id), '[]'),
          trim(p_reason), nm);
  -- receipts and lines first (each copied to trash by its trigger), then the form
  delete from bo.receipts where report_id = p_id or item_id in (select id from bo.expense_items where report_id = p_id);
  delete from bo.expense_items where report_id = p_id;
  delete from bo.expense_reports where id = p_id;
  return r.ref_no;
end $$;
revoke all on function bo.admin_delete_report(uuid, text) from public, anon;
grant execute on function bo.admin_delete_report(uuid, text) to authenticated;

-- Remove a supplier from the back office lists (FlowAccount list copy and the new suppliers file).
-- It comes back if it is still in FlowAccount and the FlowAccount template is uploaded again.
create or replace function bo.admin_remove_supplier(p_name text)
returns integer language plpgsql security definer set search_path to '' as $$
declare n int := 0; k int;
begin
  if not bo_private.is_admin() then raise exception 'Only an admin can remove a supplier'; end if;
  delete from bo.fa_vendors where lower(trim(label)) = lower(trim(p_name)) or lower(trim(name)) = lower(trim(p_name));
  get diagnostics k = row_count; n := n + k;
  delete from bo.fa_new_vendors where lower(trim(name)) = lower(trim(p_name));
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function bo.admin_remove_supplier(text) from public, anon;
grant execute on function bo.admin_remove_supplier(text) to authenticated;

-- Supplier matching on save: same name only (ignoring case, spaces, "Co., Ltd."). The old "starts with" step
-- turned "TEST VENDOR 2" into "TEST VENDOR". A name that is not the same stays as typed or read, and the
-- line editor offers the close names to pick from.
create or replace function bo_private.match_supplier(t text)
returns text language plpgsql stable security definer set search_path to '' as $$
declare n text := bo_private.norm_name(t); c int; m text;
begin
  if length(n) < 4 then return null; end if;
  select count(*), min(x) into c, m from (
    select label x from bo.fa_vendors where bo_private.norm_name(label) = n
    union select name from bo.fa_new_vendors where bo_private.norm_name(name) = n) s;
  if c = 1 then return m; end if;
  return null;
end $$;
