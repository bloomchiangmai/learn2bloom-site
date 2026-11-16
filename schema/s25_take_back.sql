-- S25 Take back (applied 16 Nov 2026, same as IGA's 12 Nov change)
-- While a submitted timesheet or expense form has not been approved by anyone, its owner can pull it back to draft.
-- People asked to check it lose that to-do and get a short note instead.
-- Tested on live data inside a rolled-back block: others refused, owner allowed, second take back refused,
-- expense form with no checker allowed, approved form refused.
do $p$ declare d text; begin
  d := pg_get_functiondef('bo_private.guard_report_status()'::regprocedure);
  if position('app.take_back' in d) = 0 then
    d := replace(d, $q$elsif new.status = 'draft' then
if not bo_private.is_admin() then raise exception 'Only admins can reopen a form'; end if;$q$,
      $q$elsif new.status = 'draft' then
if not bo_private.is_admin() and coalesce(current_setting('app.take_back', true), '') <> old.id::text then raise exception 'Only admins can reopen a form'; end if;$q$);
    if position('app.take_back' in d) = 0 then raise exception 'guard_report_status: pattern not found'; end if;
    execute d;
  end if;
  d := pg_get_functiondef('bo_private.ot_guard()'::regprocedure);
  if position('app.take_back' in d) = 0 then
    d := replace(d, $q$elsif new.status = 'draft' then
if not adm then raise exception 'Only admins can reopen'; end if;$q$,
      $q$elsif new.status = 'draft' then
if not adm and coalesce(current_setting('app.take_back', true), '') <> old.id::text then raise exception 'Only admins can reopen'; end if;$q$);
    if position('app.take_back' in d) = 0 then raise exception 'ot_guard: pattern not found'; end if;
    execute d;
  end if;
end $p$;

create or replace function bo.take_back(p_kind text, p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); me text; st text; owner uuid; sub timestamptz; chk uuid; rlink text; what text;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  me := (select full_name from bo.profiles where id = uid);
  if p_kind = 'ot' then
    select f.status::text, f.staff_id, f.submitted_at, f.checked_by into st, owner, sub, chk from bo.ot_forms f where f.id = p_id;
    rlink := '#/ot/review/' || p_id;
    what := (select 'the ' || to_char(period_end, 'Mon YYYY') || ' timesheet' from bo.ot_forms where id = p_id);
  elsif p_kind = 'report' then
    select r.status::text, r.staff_id, r.submitted_at, r.checked_by into st, owner, sub, chk from bo.expense_reports r where r.id = p_id;
    rlink := '#/report/' || p_id;
    what := (select ref_no from bo.expense_reports where id = p_id);
  else raise exception 'Unknown form'; end if;
  if owner is null then raise exception 'Form not found'; end if;
  if owner <> uid then raise exception 'Only the person who sent it can take it back'; end if;
  if not (st = 'submitted' or (p_kind = 'report' and st = 'checked' and chk is null)) then
    raise exception 'Someone has already approved it. Ask them to return it to you.';
  end if;
  perform set_config('app.take_back', p_id::text, true);
  if p_kind = 'ot' then update bo.ot_forms set status = 'draft' where id = p_id;
  else update bo.expense_reports set status = 'draft', checked_at = null, checked_by_name = null where id = p_id; end if;
  perform set_config('app.take_back', '', true);
  with gone as (
    delete from bo.notifications n where n.link = rlink and n.staff_id <> uid and n.created_at >= coalesce(sub, now() - interval '60 days') returning n.staff_id
  )
  insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
  select distinct g.staff_id, me || ' took back ' || what || ' to edit. Nothing to check for now.', null, uid, me from gone g;
  return 'draft';
end $$;
revoke all on function bo.take_back(text, uuid) from public, anon;
grant execute on function bo.take_back(text, uuid) to authenticated;
