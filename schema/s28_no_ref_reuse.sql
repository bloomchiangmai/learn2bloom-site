-- Form numbers are never reused (same as IGA): deleted forms count, and their numbers cannot be given again.
create or replace function bo.suggest_personal_ref(p_month text)
returns text language sql stable security definer set search_path to '' as $function$
select * from (
select 'BCMEXP' || substr(p_month, 3, 2) || substr(p_month, 6, 2) ||
bo_private.ref_letters(coalesce(max(bo_private.ref_number(substring(ref_no from '^BCMEXP' || substr(p_month, 3, 2) || substr(p_month, 6, 2) || '([A-Z]+)$'))), 0) + 1)
from (select ref_no from bo.expense_reports union all select ref_no from bo.deleted_reports) x
where ref_no like 'BCMEXP' || substr(p_month, 3, 2) || substr(p_month, 6, 2) || '%'
) q where bo_private.is_member()
$function$;

create or replace function bo.suggest_report_ref(p_year integer)
returns text language sql stable security definer set search_path to '' as $function$
select * from (
select 'BCMEX' || p_year::text ||
lpad((coalesce(max(nullif(substring(ref_no from '^BCMEX' || p_year::text || '([0-9]{2})'), '')::int), 0) + 1)::text, 2, '0') || 'A'
from (select ref_no from bo.expense_reports union all select ref_no from bo.deleted_reports) x
where ref_no like 'BCMEX' || p_year::text || '%'
) q where bo_private.is_member()
$function$;

create or replace function bo_private.next_project_ref(pid uuid)
returns text language sql stable security definer set search_path to '' as $function$
select p.code || '-' || lpad((coalesce(max(nullif(substring(x.ref_no from length(p.code) + 2), '')::int), 0) + 1)::text, 2, '0')
from bo.projects p
left join (select ref_no, project_id from bo.expense_reports
           union all select ref_no, (report->>'project_id')::uuid from bo.deleted_reports) x
  on x.project_id = p.id and x.ref_no ~ ('^' || p.code || '-[0-9]+$')
where p.id = pid and p.code is not null group by p.code
$function$;

create or replace function bo_private.ref_not_deleted()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.ref_no is not null and (tg_op = 'INSERT' or new.ref_no is distinct from old.ref_no)
     and exists (select 1 from bo.deleted_reports d where d.ref_no = new.ref_no) then
    raise exception 'Form number % was used by a deleted form and is not reused. Pick the next number.', new.ref_no;
  end if;
  return new;
end $$;
drop trigger if exists trg_ref_not_deleted on bo.expense_reports;
create trigger trg_ref_not_deleted before insert or update of ref_no on bo.expense_reports
  for each row execute function bo_private.ref_not_deleted();
