-- S23 stages 2 and 3: BCM defaults for Time, an outside-accountant role for PPP, timesheet reminder
-- BCM working hours: 08:00 to 16:30, lunch 1 hour, Monday to Friday
alter table bo.ot_settings alter column start_time set default '08:00', alter column end_time set default '16:30',
  alter column lunch_hours set default 1, alter column week_pattern set default 'mon_fri', alter column sat_off_anchor set default null;
-- Outside accountant (PPP): a staff role that sees only the back office (View + Accountant)
alter table public.staff drop constraint staff_role_check;
alter table public.staff add constraint staff_role_check check (role = any (array['admin','director','education_lead','education_consultant','lead_teacher','learning_coach','learning_coach_assistant','admissions','enrollment','front_desk','it','teaching_assistant','marketing','accountant']));
alter table public.role_permissions drop constraint role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check check (role = any (array['admin','director','education_lead','education_consultant','lead_teacher','learning_coach','learning_coach_assistant','admissions','enrollment','front_desk','it','teaching_assistant','marketing','accountant']));
insert into public.role_permissions (role, module, level, requires_approval)
select 'accountant', m, case when m = 'backoffice' then 'view' else 'none' end::public.permission_level, false
from unnest(enum_range(null::public.admin_module)) m on conflict do nothing;
-- The outside accountant is not "staff" for school data (families, students, payments, staff documents, calendar)
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as
$$ select exists (select 1 from staff where auth_user_id = auth.uid() and status = 'active' and role <> 'accountant'); $$;
create or replace function public.is_core_staff() returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as
$$ select exists (select 1 from staff where auth_user_id = auth.uid() and status = 'active' and role not in ('marketing', 'accountant')); $$;
-- ...but can still read their own staff row and access levels, so the staff sign-in and sidebar work
create policy "staff view own row" on public.staff for select to authenticated using (auth_user_id = (select auth.uid()));
create policy "view own role permissions" on public.role_permissions for select to authenticated using (role = (select s.role from public.staff s where s.auth_user_id = (select auth.uid())));
create policy "view own overrides" on public.staff_permission_overrides for select to authenticated using (staff_id = (select s.id from public.staff s where s.auth_user_id = (select auth.uid())));
-- Monthly timesheet reminder (24th, 09:00 Bangkok)
select cron.schedule('bo-timesheet-reminder-24th', '0 2 24 * *', 'select bo_private.timesheet_reminders()');
create or replace function bo_private.sync_profiles()
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform set_config('bo.syncing', '1', true);
  insert into bo.profiles (id, email, full_name, role, active, staff_no, is_accountant, is_data_entry, is_hr)
  select s.auth_user_id, coalesce(u.email, ''), coalesce(s.name, ''),
    case when lv = 'full' then 'admin'::bo.app_role else 'staff'::bo.app_role end,
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
  -- staff removed from Bloom (or login removed): switch off
  update bo.profiles p set active = false where p.active and not exists (select 1 from public.staff s where s.auth_user_id = p.id);
  perform set_config('bo.syncing', '', true);
end $$;select bo_private.sync_profiles();

-- seed
insert into bo.fa_meta (id) values (1) on conflict do nothing;
insert into bo.holiday_meta (id) values (1) on conflict do nothing;
