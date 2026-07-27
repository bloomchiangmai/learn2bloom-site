-- Bloom Chiangmai — Admissions & Learners System Schema
-- Project: learn2bloom-bloombrary (Supabase project ndlcfgkhxjoancdvmgmr)
-- This file documents the current schema for the staff-admissions.html and
-- learners.html tools. It is a reference snapshot, not an executable migration
-- history — apply future changes here AND in Supabase, in that order, whenever
-- the schema changes.
--
-- Last synced: 2026-07-26

-- ============================================================
-- FAMILIES
-- ============================================================
create table families (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  family_name text not null,
  contact_email text,
  contact_phone text,
  created_at timestamptz default now(),
  intake_data jsonb
  -- intake_data holds: preferred_contact, line_wechat_id, emergency_name,
  -- emergency_relationship, emergency_country_code, emergency_number,
  -- bcm_interest, bcm_interest_more, photo_permission, learning_hopes,
  -- learning_hopes_more, additional_notes
);

alter table families enable row level security;

create policy "staff full access families" on families
  for all using (is_staff());

create policy "parent view own family" on families
  for select using (auth_user_id = auth.uid());

create policy "parent update own family" on families
  for update using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
  -- Lets parents edit their own contact info (phone, preferred contact,
  -- emergency contact) from the Parent Portal dashboard. Learner details
  -- (DOB, health notes, etc.) remain staff-only after initial registration.


-- ============================================================
-- STAFF
-- ============================================================
create table staff (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  name text not null,
  role text not null check (role in ('admin','front_desk','teacher')),
  created_at timestamptz default now()
);

alter table staff enable row level security;

create policy "staff view staff" on staff
  for select using (is_staff());

-- Helper function used across all four tables' RLS policies
create or replace function is_staff() returns boolean as $$
  select exists (select 1 from staff where auth_user_id = auth.uid());
$$ language sql security definer stable;


-- ============================================================
-- STUDENTS  (called "Learners" in the UI)
-- ============================================================
create table students (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id),
  student_id_code text unique,
  -- Format: BMS26001 = hub code (BMS = Bloom Space) + 2-digit year + 3-digit
  -- sequence, resetting per hub per year. Assigned via nextStudentIdCode() in
  -- both staff-admissions.html and learners.html.
  first_name text not null,   -- functions as "preferred name" / nickname
  last_name text not null,    -- functions as surname / rest of legal name
  date_of_birth date,
  class_group text check (class_group in ('Nest','Early Explorers','Builders','Navigators')),
  status text not null default 'enquiry' check (status in (
    'enquiry','application','interview','approved','offer_sent',
    'payment_received','enrolled','withdrawn','archived'
  )),
  activation_code text,       -- one-time code for parent registration; only
                               -- issuable once status = 'enrolled'
  activated_at timestamptz,
  created_at timestamptz default now(),
  intake_data jsonb,
  -- intake_data holds: gender, nationality, first_language, other_languages,
  -- current_school, previous_school, health_learning_notes
  staff_notes text,           -- internal-only notes, never shown to parents
  previous_status text        -- status held just before being archived, used
                               -- by archive.html's Restore button to send
                               -- someone back to where they were (e.g. straight
                               -- back to 'enrolled' rather than resetting to
                               -- 'enquiry')
);

alter table students enable row level security;

create policy "staff full access students" on students
  for all using (is_staff());

create policy "parent view own students" on students
  for select using (
    family_id in (select id from families where auth_user_id = auth.uid())
  );


-- ============================================================
-- PAYMENTS
-- ============================================================
create table payments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) not null,
  amount numeric not null,
  currency text default 'THB',
  category text not null check (category in ('tuition','registration','discount','scholarship','other')),
  status text not null check (status in ('paid','unpaid','partially_paid','cancelled','pending')),
  payment_date date,
  recorded_by uuid references staff(id),
  note text,
  created_at timestamptz default now()
);

alter table payments enable row level security;

create policy "staff full access payments" on payments
  for all using (is_staff());

create policy "parent view own payments" on payments
  for select using (
    student_id in (
      select s.id from students s
      join families f on f.id = s.family_id
      where f.auth_user_id = auth.uid()
    )
  );


-- ============================================================
-- CHANGE LOG
-- ============================================================
-- 2026-07-26  Initial tables created: families, staff, students, payments + RLS
-- 2026-07-26  Added intake_data jsonb to families and students
-- 2026-07-26  Added payment_received to students.status check
-- 2026-07-26  Added pending to payments.status check
-- 2026-07-26  Added staff_notes to students
-- 2026-07-26  Added archived to students.status check
-- 2026-07-26  Added previous_status to students, used by Archive page's
--             Restore button to send someone back to their prior status
--             instead of always resetting to 'enquiry'
-- 2026-07-27  Added parent update RLS policy on families, so parents can
--             edit their own contact info from the Parent Portal dashboard
--
-- When making a future schema change: add the migration SQL above this line,
-- update the relevant table definition above, and add a dated entry here.
