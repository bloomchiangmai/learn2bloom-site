-- S24: Operations Manager role (Casy). Not an admin.
-- Staff system: Full on families, students, calendar, library, payments; Edit on staff; View on settings; no marketing.
-- Back office: role 'approver'. Final approval and paying up to 10,000 THB per form, never her own form.
-- No staff pay slips (admin only), no cash advances, no reopen, no Roles and access.

-- 1. Role list
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check check (role = any (array['admin','director','operations_manager','education_lead','education_consultant','lead_teacher','learning_coach','learning_coach_assistant','admissions','enrollment','front_desk','it','teaching_assistant','marketing','accountant']));
alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check check (role = any (array['admin','director','operations_manager','education_lead','education_consultant','lead_teacher','learning_coach','learning_coach_assistant','admissions','enrollment','front_desk','it','teaching_assistant','marketing','accountant']));

-- 2. Default access for the role (copies the shape of the existing rows)
insert into public.role_permissions (role, module, level, requires_approval)
select 'operations_manager', m.module,
  (case m.module when 'staff' then 'edit' when 'settings' then 'view' when 'marketing' then 'none' when 'backoffice' then 'edit' else 'full' end)::public.permission_level, false
from (select distinct module from public.role_permissions) m
on conflict do nothing;

-- 3. Limit and the "can finalise" test
create or replace function bo_private.mgr_limit() returns numeric language sql immutable as $$ select 10000::numeric $$;

create or replace function bo_private.can_finalise(rid uuid) returns boolean
language sql stable security definer set search_path to '' as $$
select bo_private.is_admin() or (
  coalesce(bo_private.my_role() = 'approver', false) and exists (
    select 1 from bo.expense_reports r
    where r.id = rid and r.staff_id <> (select auth.uid())
      and (select coalesce(sum(i.amount), 0) from bo.expense_items i where i.report_id = r.id) <= bo_private.mgr_limit()))
$$;

-- 4. The Operations Manager sees every form (like the accountant)
create or replace function bo_private.can_view_report(rid uuid)
 returns boolean language sql stable security definer set search_path to '' as $function$
select exists (
select 1 from bo.expense_reports r
where r.id = rid and (
r.staff_id = (select auth.uid())
or r.checker_id = (select auth.uid())
or bo_private.is_admin() or bo_private.is_accountant()
or coalesce(bo_private.my_role() = 'approver', false)
or (r.form_type = 'project' and bo_private.is_pic(r.project_id))
or (bo_private.is_data_entry() and r.status in ('approved', 'paid'))
)
) $function$;

-- 5. Back office role from the staff role
create or replace function bo_private.sync_profiles()
 returns void language plpgsql security definer set search_path to '' as $function$
begin
  perform set_config('bo.syncing', '1', true);
  insert into bo.profiles (id, email, full_name, role, active, staff_no, is_accountant, is_data_entry, is_hr)
  select s.auth_user_id, coalesce(u.email, ''), coalesce(s.name, ''),
    case when lv = 'full' then 'admin'::bo.app_role when s.role = 'operations_manager' then 'approver'::bo.app_role else 'staff'::bo.app_role end,
    s.status = 'active' and lv <> 'none',
    s.staff_id_code,
    s.role = 'accountant' or exists (select 1 from bo.jobs j where j.staff_id = s.id and j.job = 'accountant'),
    exists (select 1 from bo.jobs j where j.staff_id = s.id and j.job = 'data_entry'),
    exists (select 1 from bo.jobs j where j.staff_id = s.id and j.job = 'hr')
  from (select s.*, coalesce(o.level, rp.level, 'none'::public.permission_level)::text as lv
        from public.staff s
        left join public.role_permissions rp on rp.role = s.role and rp.module = 'backoffice'
        left join public.staff_permission_overrides o on o.staff_id = s.id and o.module = 'backoffice') s
  left join auth.users u on u.id = s.auth_user_id
  where s.auth_user_id is not null
  on conflict (id) do update set email = excluded.email, full_name = excluded.full_name, role = excluded.role,
    active = excluded.active, staff_no = excluded.staff_no, is_accountant = excluded.is_accountant,
    is_data_entry = excluded.is_data_entry, is_hr = excluded.is_hr
  where (bo.profiles.email, bo.profiles.full_name, bo.profiles.role, bo.profiles.active, bo.profiles.staff_no, bo.profiles.is_accountant, bo.profiles.is_data_entry, bo.profiles.is_hr)
    is distinct from (excluded.email, excluded.full_name, excluded.role, excluded.active, excluded.staff_no, excluded.is_accountant, excluded.is_data_entry, excluded.is_hr);
  update bo.profiles p set active = false where p.active and not exists (select 1 from public.staff s where s.auth_user_id = p.id);
  perform set_config('bo.syncing', '', true);
end $function$;

-- 6. Status guard: final approval, returning at the final step and paying up to the limit
create or replace function bo_private.guard_report_status()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare uid uuid := auth.uid(); sig text; fin boolean;
begin
if uid is null then return new; end if;
fin := bo_private.can_finalise(old.id);
if new.status is distinct from old.status then
if new.status = 'submitted' then
if old.status not in ('draft', 'rejected') then raise exception 'Only draft or returned forms can be submitted'; end if;
if not exists (select 1 from bo.expense_items i where i.report_id = old.id) then raise exception 'The report has no expense lines.'; end if;
if exists (select 1 from bo.expense_items i where i.report_id = old.id and not exists (select 1 from bo.receipts r where r.item_id = i.id)) then
raise exception 'Every expense line needs at least 1 receipt.'; end if;
if exists (select 1 from bo.expense_items i where i.report_id = old.id and (i.needs_review or coalesce(trim(i.purpose), '') = '')) then
raise exception 'Some lines still need checking and a purpose.'; end if;
if exists (select 1 from bo.expense_items i where i.report_id = old.id and i.duplicate_of is not null and not coalesce(i.duplicate_ok, false)) then
raise exception 'Some lines are possible duplicates. Resolve them first.'; end if;
if old.form_type = 'project' and old.project_id is null then raise exception 'Choose the project for this form.'; end if;
if exists (select 1 from bo.fa_vendors) and exists (select 1 from bo.expense_items i where i.report_id = old.id
and coalesce(i.doc_type, '') not in ('receipt_form', 'cash_bill') and not bo_private.known_supplier(i.merchant)) then
raise exception 'Choose a supplier from the list (or add a new one) on every line before submitting.'; end if;
if old.status = 'rejected' and bo_private.unanswered_lines(old.id) > 0 then
raise exception 'Reply to or fix each returned line first (a changed amount needs a reply).'; end if;
new.submitted_at := now(); new.rejection_reason := null;
new.checked_by := null; new.checked_by_name := null; new.checked_at := null; new.checked_signature := null;
if not bo_private.has_other_checker(old.id) then
new.status := 'checked'; new.checked_at := now(); new.checked_by_name := 'No checker picked, sent to admin';
end if;
elsif new.status = 'checked' then
if old.status <> 'submitted' then raise exception 'Only submitted forms can be checked'; end if;
if not bo_private.can_check(old.id) then raise exception 'Only the person picked to check this form can do this step'; end if;
sig := (select signature from bo.profiles where id = uid);
if sig is null then raise exception 'Add your signature before approving.'; end if;
new.checked_by := uid; new.checked_at := now(); new.checked_signature := sig;
new.checked_by_name := (select full_name from bo.profiles where id = uid);
elsif new.status = 'approved' then
if not fin then raise exception 'An admin gives the final approval on this form. The Operations Manager approves forms up to 10,000 THB, never her own.'; end if;
if old.status = 'submitted' and old.checker_id is not null then raise exception 'The picked checker checks this form first'; end if;
if old.checked_by = uid then raise exception 'You checked this form, so another admin gives the final approval'; end if;
if old.status not in ('submitted', 'checked') then raise exception 'Only submitted forms can be approved'; end if;
new.approved_by := uid; new.approved_at := now();
elsif new.status = 'rejected' then
if old.status not in ('submitted', 'checked') then raise exception 'Only submitted forms can be returned'; end if;
if not (bo_private.is_admin() or (old.status = 'checked' and fin) or (old.status = 'submitted' and bo_private.can_check(old.id))) then raise exception 'You cannot return this form'; end if;
if coalesce(trim(new.rejection_reason), '') = '' then raise exception 'A reason is required when returning'; end if;
new.approved_by := uid; new.approved_at := now();
new.checked_by := null; new.checked_by_name := null; new.checked_at := null; new.checked_signature := null;
elsif new.status = 'paid' then
if not fin then raise exception 'An admin pays this form. The Operations Manager pays forms up to 10,000 THB, never her own.'; end if;
if old.status <> 'approved' then raise exception 'Only approved forms can be marked paid'; end if;
new.paid_at := now();
elsif new.status = 'draft' then
if not bo_private.is_admin() then raise exception 'Only admins can reopen a form'; end if;
end if;
end if;
if new.fa_entered_at is distinct from old.fa_entered_at then
if not (bo_private.is_data_entry() or bo_private.is_accountant()) then raise exception 'Only data entry or the accountant can mark FlowAccount entry'; end if;
if old.status not in ('approved', 'paid') then raise exception 'Only approved forms can be entered in FlowAccount'; end if;
new.fa_entered_by_name := case when new.fa_entered_at is null then null else (select full_name from bo.profiles where id = uid) end;
end if;
if not bo_private.is_admin() and old.staff_id = uid then
if new.advance_topup is distinct from old.advance_topup and old.status not in ('draft', 'rejected') then
raise exception 'The cash advance can only be changed while the form is a draft'; end if;
end if;
if new.advance_topup < 0 then raise exception 'The cash advance cannot be negative'; end if;
if not bo_private.is_admin() then
if new.staff_id is distinct from old.staff_id or new.opening_advance is distinct from old.opening_advance
or new.last_returned_at is distinct from old.last_returned_at
or (new.approved_by is distinct from old.approved_by and new.status not in ('rejected') and not (fin and new.status = 'approved'))
or (new.approver_signature is distinct from old.approver_signature and new.status <> 'rejected' and not (fin and new.status = 'approved'))
or (new.paid_at is distinct from old.paid_at and new.status <> 'paid')
or (new.paid_slip_path is distinct from old.paid_slip_path and not bo_private.is_accountant() and not (fin and new.status = 'paid'))
or (new.paid_ref is distinct from old.paid_ref and not bo_private.is_accountant() and not (fin and new.status = 'paid')) then
raise exception 'You cannot change owner, approval, payment or carried-forward fields';
end if;
if old.staff_id <> uid and (new.advance_topup is distinct from old.advance_topup or new.project_id is distinct from old.project_id
or new.form_type is distinct from old.form_type or new.ref_no is distinct from old.ref_no) and not bo_private.is_approver_or_admin() then
raise exception 'You cannot edit someone else''s form';
end if;
end if;
return new;
end $function$;

-- 7. Returning with line notes at the final step
create or replace function bo.return_form(p_report uuid, p_reason text, p_notes jsonb default '[]'::jsonb)
 returns void language plpgsql security definer set search_path to '' as $function$
begin
  if not bo_private.is_member() then raise exception 'No back office access'; end if;
if not (bo_private.is_admin() or bo_private.can_check(p_report)
  or (bo_private.can_finalise(p_report) and exists (select 1 from bo.expense_reports r where r.id = p_report and r.status = 'checked'))) then
  raise exception 'You cannot return this form'; end if;
update bo.expense_items set return_note = null, staff_reply = null, returned_snapshot = null where report_id = p_report;
update bo.expense_items i set return_note = nullif(trim(n->>'note'), ''),
returned_snapshot = jsonb_build_object('amount', i.amount, 'purpose', i.purpose, 'item', i.item, 'category_id', i.category_id, 'invoice_date', i.invoice_date)
from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) n
where i.report_id = p_report and i.id = (n->>'id')::uuid;
update bo.expense_reports set status = 'rejected', rejection_reason = p_reason where id = p_report;
end $function$;

-- 8. Bank details of the person being reimbursed, for the Operations Manager (read only)
drop policy if exists "bank: operations manager read" on bo.staff_bank_details;
create policy "bank: operations manager read" on bo.staff_bank_details for select
  using (coalesce(bo_private.my_role() = 'approver', false) and staff_id <> (select auth.uid()));

-- 9. Casy: Operations Manager, with the Data entry and HR jobs
insert into bo.jobs (staff_id, job) select id, 'hr' from public.staff where staff_id_code = 'BMSSTF03' on conflict do nothing;
insert into bo.jobs (staff_id, job) select id, 'data_entry' from public.staff where staff_id_code = 'BMSSTF03' on conflict do nothing;
do $$ begin
  set local session_replication_role = replica;
  update public.staff set role = 'operations_manager', job_title = 'Operations Manager' where staff_id_code = 'BMSSTF03';
  set local session_replication_role = origin;
end $$;
select bo_private.sync_profiles();
