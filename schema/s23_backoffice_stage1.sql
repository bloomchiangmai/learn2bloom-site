-- S23 stage 1: IGA back office ported into schemas bo / bo_private (Bloom). Generated.

set local check_function_bodies = off;
create schema if not exists bo; create schema if not exists bo_private;
set local search_path = bo, public, extensions;

-- Public schema tables, reconstructed from pg_attribute / pg_attrdef (same data as information_schema.columns,
-- with full udt names), pg_constraint (pg_get_constraintdef) and pg_indexes (indexdef).
-- Order: enums, sequence, tables, PK/unique/check, foreign keys, extra indexes, RLS enable.
-- FK targets are unqualified (pg_get_constraintdef output): run with search_path = bo.
-- 34 tables. RLS is enabled on all 34 (none use FORCE).

-- ===== Enums =====
create type bo.app_role as enum ('admin', 'approver', 'staff');
create type bo.report_status as enum ('draft', 'submitted', 'checked', 'approved', 'rejected', 'paid');

-- ===== Sequence used by reset_requests.id (non-identity serial) =====
create sequence if not exists bo.reset_requests_id_seq;

-- ===== Tables =====
create table bo.card_charges (
  id uuid default gen_random_uuid() not null,
  statement_id uuid not null,
  trans_date date not null,
  posting_date date,
  description text not null,
  place text,
  currency text,
  foreign_amount numeric(12,2),
  amount numeric(12,2) not null,
  item_id uuid,
  doc_path text,
  doc_name text,
  asked_staff uuid,
  asked_at timestamp with time zone,
  note text,
  created_at timestamp with time zone default now() not null,
  no_doc boolean default false not null,
  category_id uuid,
  merchant text,
  purpose text,
  vat_amount numeric(12,2) default 0 not null,
  fa_done boolean default false not null,
  rev integer default 0 not null,
  fa_ref text,
  account_code text,
  no_doc_reason text
);

create table bo.card_statements (
  id uuid default gen_random_uuid() not null,
  period_month date not null,
  file_path text not null,
  file_name text,
  status text default 'reading'::text not null,
  error text,
  uploaded_by uuid default auth.uid() not null,
  uploaded_at timestamp with time zone default now() not null,
  subs_notified_at timestamp with time zone
);

create table bo.day_question_replies (
  id uuid default gen_random_uuid() not null,
  question_id uuid not null,
  author uuid not null,
  body text not null,
  created_at timestamp with time zone default now() not null
);

create table bo.day_questions (
  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  day date not null,
  asked_by uuid not null,
  created_at timestamp with time zone default now() not null
);

create table bo.expense_categories (
  id uuid default gen_random_uuid() not null,
  name text not null,
  code text,
  sort_order integer default 0 not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  fa_code text,
  fa_code_bank text,
  company_only boolean default false not null,
  on_petty boolean default true not null,
  on_project boolean default true not null,
  on_acct boolean default true not null
);

create table bo.expense_items (
  id uuid default gen_random_uuid() not null,
  report_id uuid not null,
  invoice_date date not null,
  item text not null,
  category_id uuid not null,
  accounting_code text,
  purpose text default ''::text not null,
  qty numeric(10,2) default 1 not null,
  amount numeric(12,2) not null,
  currency text default 'THB'::text not null,
  original_amount numeric(12,2),
  payment_method text default 'cash_advance'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  needs_review boolean default false not null,
  duplicate_of uuid,
  duplicate_ok boolean default false not null,
  merchant text,
  receipt_time text,
  exchange_rate numeric(14,6),
  return_note text,
  staff_reply text,
  returned_snapshot jsonb,
  doc_type text,
  fa_done boolean default false not null,
  vat_amount numeric(12,2),
  wht_rate numeric(4,2),
  wht_amount numeric(12,2),
  merchant_raw text
);

create table bo.expense_reports (
  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  ref_no text not null,
  period_month date not null,
  report_date date default CURRENT_DATE not null,
  opening_advance numeric(12,2) default 0 not null,
  advance_topup numeric(12,2) default 0 not null,
  status report_status default 'draft'::report_status not null,
  remarks text,
  submitted_at timestamp with time zone,
  approved_by uuid,
  approved_at timestamp with time zone,
  rejection_reason text,
  paid_at timestamp with time zone,
  received_at date,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  form_type text default 'personal'::text not null,
  project text,
  approved_by_name text,
  applicant_signature text,
  approver_signature text,
  last_returned_at timestamp with time zone,
  paid_slip_path text,
  paid_ref text,
  project_id uuid,
  checked_by uuid,
  checked_by_name text,
  checked_at timestamp with time zone,
  checked_signature text,
  fa_entered_at timestamp with time zone,
  fa_entered_by_name text
);

create table bo.fa_accounts (
  code text not null,
  name text,
  kind text,
  label text
);

create table bo.fa_meta (
  id integer default 1 not null,
  updated_at timestamp with time zone,
  updated_by_name text,
  pay_map jsonb default '{}'::jsonb not null
);

create table bo.fa_new_vendors (
  id bigint generated always as identity not null,
  name text not null,
  business_type text default 'Corporation'::text not null,
  tax_id text,
  branch text,
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamp with time zone default now() not null,
  exported_at timestamp with time zone,
  address text,
  phone text
);

create table bo.fa_projects (
  name text not null
);

create table bo.fa_vendors (
  label text not null,
  name text,
  contact_type text,
  tax_id text,
  branch text
);

create table bo.holiday_meta (
  id integer default 1 not null,
  checked_at timestamp with time zone,
  note text
);

create table bo.holiday_suggestions (
  day date not null,
  name text not null,
  status text default 'ask'::text not null,
  created_at timestamp with time zone default now() not null
);

create table bo.holidays (
  day date not null,
  name text
);

create table bo.hr_requests (
  id bigint generated always as identity not null,
  staff_id uuid not null,
  changes jsonb not null,
  before jsonb,
  status text default 'pending'::text not null,
  created_by uuid default auth.uid() not null,
  created_by_name text,
  created_at timestamp with time zone default now() not null,
  decided_at timestamp with time zone
);

create table bo.kbiz_docs (
  id uuid default gen_random_uuid() not null,
  payment_id uuid,
  kind text default 'unknown'::text not null,
  status text default 'reading'::text not null,
  error text,
  file_path text not null,
  file_name text,
  mime text,
  doc_date date,
  amount numeric(12,2),
  party text,
  tax_id text,
  vat_amount numeric(12,2),
  wht_amount numeric(12,2),
  wht_rate numeric(5,2),
  txn_no text,
  memo text,
  item text,
  admin_only boolean default false not null,
  uploaded_by uuid default auth.uid() not null,
  uploaded_at timestamp with time zone default now() not null,
  address text,
  phone text
);

create table bo.kbiz_payments (
  id uuid default gen_random_uuid() not null,
  period_month date not null,
  merchant text,
  category_id uuid,
  purpose text,
  vat_amount numeric(12,2) default 0 not null,
  wht_rate numeric(5,2) default 0 not null,
  fa_done boolean default false not null,
  admin_only boolean default false not null,
  created_by uuid default auth.uid(),
  created_at timestamp with time zone default now() not null,
  rev integer default 0 not null,
  fa_ref text,
  bill_paper boolean default true not null,
  account_code text,
  wht_on_top boolean default false not null,
  no_doc boolean default false not null,
  no_doc_reason text
);

create table bo.notifications (
  id bigint generated always as identity not null,
  staff_id uuid not null,
  body text not null,
  link text,
  created_by uuid,
  created_by_name text,
  created_at timestamp with time zone default now() not null,
  read_at timestamp with time zone,
  details jsonb,
  thread_id uuid
);

create table bo.ot_day_type (
  staff_id uuid not null,
  day date not null,
  treat_as text not null
);

create table bo.ot_entries (
  id uuid default gen_random_uuid() not null,
  form_id uuid not null,
  work_date date not null,
  start_time time without time zone,
  end_time time without time zone,
  reason text default ''::text not null,
  day_type text,
  hours numeric,
  counted numeric,
  return_note text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  leave_type text
);

create table bo.ot_forms (
  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  period_start date not null,
  period_end date not null,
  status text default 'draft'::text not null,
  take_as text default 'pay'::text not null,
  remarks text,
  rejection_reason text,
  submitted_at timestamp with time zone,
  seen_at timestamp with time zone,
  last_returned_at timestamp with time zone,
  approved_by uuid,
  approved_by_name text,
  approved_at timestamp with time zone,
  paid_at timestamp with time zone,
  applicant_signature text,
  approver_signature text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  time_off_hours numeric default 0 not null,
  expiry_action text,
  extended_until date,
  checked_by uuid,
  checked_by_name text,
  checked_at timestamp with time zone,
  checked_signature text
);

create table bo.ot_offday (
  staff_id uuid not null,
  day date not null,
  choice text not null,
  save_until date,
  swap_date date
);

create table bo.ot_settings (
  staff_id uuid not null,
  pay_type text default 'full_time'::text not null,
  start_time time without time zone default '09:00:00'::time without time zone not null,
  end_time time without time zone default '18:00:00'::time without time zone not null,
  lunch_hours numeric default 1 not null,
  week_pattern text default 'alt_sat'::text not null,
  sat_off_anchor date default '2026-10-03'::date,
  dayoff_mult numeric default 1 not null,
  holiday_mult numeric default 1 not null,
  freelance_rate numeric,
  updated_at timestamp with time zone default now()
);

create table bo.profiles (
  id uuid not null,
  email text not null,
  full_name text default ''::text not null,
  thai_name text,
  role app_role default 'staff'::app_role not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  staff_no text,
  contact_email text,
  signature text,
  is_accountant boolean default false not null,
  is_data_entry boolean default false not null,
  is_hr boolean default false not null
);

create table bo.project_pics (
  project_id uuid not null,
  staff_id uuid not null
);

create table bo.projects (
  id uuid default gen_random_uuid() not null,
  name text not null,
  code text,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  needs_setup boolean default false not null,
  created_by uuid,
  created_by_name text
);

create table bo.receipts (
  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  item_id uuid,
  drive_file_id text,
  file_url text,
  file_name text,
  mime_type text,
  captured_via text default 'desktop'::text not null,
  note text,
  created_at timestamp with time zone default now() not null,
  storage_path text,
  category_id uuid,
  report_id uuid,
  ai_status text default 'pending'::text not null,
  ai_data jsonb,
  ai_error text,
  file_hash text,
  rotation smallint default 0 not null
);

create table bo.report_events (
  id bigint generated always as identity not null,
  report_id uuid not null,
  at timestamp with time zone default now() not null,
  by_id uuid,
  by_name text,
  action text not null,
  note text
);

create table bo.report_notes (
  report_id uuid not null,
  note text,
  updated_by_name text,
  updated_at timestamp with time zone default now()
);

create table bo.reset_requests (
  id bigint default nextval('reset_requests_id_seq'::regclass) not null,
  staff_id uuid not null,
  created_at timestamp with time zone default now() not null
);

create table bo.staff_bank_details (
  staff_id uuid not null,
  bank_name text not null,
  account_no text not null,
  account_name text not null,
  updated_at timestamp with time zone default now() not null
);

create table bo.subscriptions (
  id uuid default gen_random_uuid() not null,
  match_key text not null,
  name text not null,
  purpose text,
  used_by text,
  merchant text,
  category_id uuid,
  no_invoice boolean default false not null,
  no_doc_reason text,
  cancel_url text,
  reviewed_month text,
  active boolean default true not null,
  created_by uuid default auth.uid(),
  created_at timestamp with time zone default now() not null,
  dismissed boolean default false not null,
  cancel_auto boolean default false not null,
  ack_month text
);

create table bo.trash (
  id uuid default gen_random_uuid() not null,
  kind text not null,
  row_id uuid not null,
  staff_id uuid not null,
  data jsonb not null,
  linked_receipts uuid[],
  deleted_by uuid,
  deleted_at timestamp with time zone default now() not null
);

-- ===== Primary key, unique and check constraints =====
alter table bo.card_charges add constraint card_charges_fa_ref_key UNIQUE (fa_ref);
alter table bo.card_charges add constraint card_charges_pkey PRIMARY KEY (id);
alter table bo.card_statements add constraint card_statements_pkey PRIMARY KEY (id);
alter table bo.day_question_replies add constraint day_question_replies_pkey PRIMARY KEY (id);
alter table bo.day_questions add constraint day_questions_pkey PRIMARY KEY (id);
alter table bo.expense_categories add constraint expense_categories_name_key UNIQUE (name);
alter table bo.expense_categories add constraint expense_categories_pkey PRIMARY KEY (id);
alter table bo.expense_items add constraint expense_items_amount_check CHECK ((amount >= (0)::numeric));
alter table bo.expense_items add constraint expense_items_doc_type_check CHECK ((doc_type = ANY (ARRAY['tax_invoice'::text, 'receipt'::text, 'voucher'::text, 'receipt_form'::text, 'cash_bill'::text, 'online'::text])));
alter table bo.expense_items add constraint expense_items_payment_method_check CHECK ((payment_method = ANY (ARRAY['own_money'::text, 'company_card'::text, 'cash_advance'::text, 'kbiz'::text])));
alter table bo.expense_items add constraint expense_items_pkey PRIMARY KEY (id);
alter table bo.expense_items add constraint expense_items_qty_check CHECK ((qty > (0)::numeric));
alter table bo.expense_items add constraint expense_items_receipt_time_check CHECK (((receipt_time IS NULL) OR (receipt_time ~ '^[0-2][0-9]:[0-5][0-9]$'::text)));
alter table bo.expense_items add constraint expense_items_vat_amount_check CHECK (((vat_amount IS NULL) OR (vat_amount >= (0)::numeric)));
alter table bo.expense_items add constraint expense_items_wht_amount_check CHECK (((wht_amount IS NULL) OR (wht_amount >= (0)::numeric)));
alter table bo.expense_items add constraint expense_items_wht_rate_check CHECK (((wht_rate IS NULL) OR (wht_rate = ANY (ARRAY[(0)::numeric, (1)::numeric, (2)::numeric, (3)::numeric, (5)::numeric]))));
alter table bo.expense_reports add constraint expense_reports_form_type_check CHECK ((form_type = ANY (ARRAY['personal'::text, 'project'::text])));
alter table bo.expense_reports add constraint expense_reports_period_month_check CHECK ((EXTRACT(day FROM period_month) = (1)::numeric));
alter table bo.expense_reports add constraint expense_reports_pkey PRIMARY KEY (id);
alter table bo.expense_reports add constraint expense_reports_project_needed CHECK (((form_type = 'personal'::text) OR (COALESCE(TRIM(BOTH FROM project), ''::text) <> ''::text)));
alter table bo.expense_reports add constraint expense_reports_ref_no_key UNIQUE (ref_no);
alter table bo.fa_accounts add constraint fa_accounts_pkey PRIMARY KEY (code);
alter table bo.fa_meta add constraint fa_meta_id_check CHECK ((id = 1));
alter table bo.fa_meta add constraint fa_meta_pkey PRIMARY KEY (id);
alter table bo.fa_new_vendors add constraint fa_new_vendors_business_type_check CHECK ((business_type = ANY (ARRAY['Corporation'::text, 'Individual'::text])));
alter table bo.fa_new_vendors add constraint fa_new_vendors_pkey PRIMARY KEY (id);
alter table bo.fa_new_vendors add constraint fa_new_vendors_tax_id_check CHECK (((tax_id IS NULL) OR (tax_id ~ '^([0-9]{10}|[0-9]{13})$'::text)));
alter table bo.fa_projects add constraint fa_projects_pkey PRIMARY KEY (name);
alter table bo.fa_vendors add constraint fa_vendors_pkey PRIMARY KEY (label);
alter table bo.holiday_meta add constraint holiday_meta_pkey PRIMARY KEY (id);
alter table bo.holiday_suggestions add constraint holiday_suggestions_pkey PRIMARY KEY (day, name);
alter table bo.holidays add constraint holidays_pkey PRIMARY KEY (day);
alter table bo.hr_requests add constraint hr_requests_pkey PRIMARY KEY (id);
alter table bo.hr_requests add constraint hr_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'agreed'::text, 'declined'::text, 'cancelled'::text])));
alter table bo.kbiz_docs add constraint kbiz_docs_pkey PRIMARY KEY (id);
alter table bo.kbiz_payments add constraint kbiz_payments_fa_ref_key UNIQUE (fa_ref);
alter table bo.kbiz_payments add constraint kbiz_payments_pkey PRIMARY KEY (id);
alter table bo.notifications add constraint notifications_pkey PRIMARY KEY (id);
alter table bo.ot_day_type add constraint ot_day_type_pkey PRIMARY KEY (staff_id, day);
alter table bo.ot_day_type add constraint ot_day_type_treat_as_check CHECK ((treat_as = ANY (ARRAY['workday'::text, 'day_off'::text])));
alter table bo.ot_entries add constraint ot_entries_leave_type_check CHECK ((leave_type = ANY (ARRAY['annual'::text, 'sick'::text, 'personal'::text, 'replacement'::text])));
alter table bo.ot_entries add constraint ot_entries_pkey PRIMARY KEY (id);
alter table bo.ot_forms add constraint ot_forms_expiry_action_check CHECK ((expiry_action = ANY (ARRAY['paid'::text, 'extended'::text])));
alter table bo.ot_forms add constraint ot_forms_period_end_25 CHECK ((EXTRACT(day FROM period_end) = (25)::numeric));
alter table bo.ot_forms add constraint ot_forms_pkey PRIMARY KEY (id);
alter table bo.ot_forms add constraint ot_forms_staff_id_period_end_key UNIQUE (staff_id, period_end);
alter table bo.ot_forms add constraint ot_forms_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'checked'::text, 'approved'::text, 'rejected'::text, 'paid'::text])));
alter table bo.ot_forms add constraint ot_forms_take_as_check CHECK ((take_as = ANY (ARRAY['pay'::text, 'time_off'::text])));
alter table bo.ot_forms add constraint ot_forms_time_off_hours_check CHECK ((time_off_hours >= (0)::numeric));
alter table bo.ot_offday add constraint ot_offday_choice_check CHECK ((choice = ANY (ARRAY['pay'::text, 'save'::text, 'swap'::text])));
alter table bo.ot_offday add constraint ot_offday_pkey PRIMARY KEY (staff_id, day);
alter table bo.ot_offday add constraint ot_offday_swap_date CHECK (((choice <> 'swap'::text) OR (swap_date IS NOT NULL)));
alter table bo.ot_settings add constraint ot_settings_pay_type_check CHECK ((pay_type = ANY (ARRAY['full_time'::text, 'part_time'::text, 'freelance'::text])));
alter table bo.ot_settings add constraint ot_settings_pkey PRIMARY KEY (staff_id);
alter table bo.ot_settings add constraint ot_settings_week_pattern_check CHECK ((week_pattern = ANY (ARRAY['alt_sat'::text, 'mon_fri'::text, 'mon_sat'::text, 'one_sat'::text])));
alter table bo.profiles add constraint profiles_contact_email_check CHECK (((contact_email IS NULL) OR (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text)));
alter table bo.profiles add constraint profiles_email_key UNIQUE (email);
alter table bo.profiles add constraint profiles_pkey PRIMARY KEY (id);
alter table bo.profiles add constraint profiles_signature_check CHECK (((signature IS NULL) OR ((signature ~~ 'data:image/png;base64,%'::text) AND (length(signature) < 300000))));
alter table bo.profiles add constraint profiles_staff_no_key UNIQUE (staff_no);
alter table bo.project_pics add constraint project_pics_pkey PRIMARY KEY (project_id, staff_id);
alter table bo.projects add constraint projects_name_key UNIQUE (name);
alter table bo.projects add constraint projects_pkey PRIMARY KEY (id);
alter table bo.receipts add constraint receipts_ai_status_check CHECK ((ai_status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text, 'off'::text])));
alter table bo.receipts add constraint receipts_captured_via_check CHECK ((captured_via = ANY (ARRAY['phone'::text, 'desktop'::text])));
alter table bo.receipts add constraint receipts_pkey PRIMARY KEY (id);
alter table bo.receipts add constraint receipts_rotation_check CHECK ((rotation = ANY (ARRAY[0, 90, 180, 270])));
alter table bo.report_events add constraint report_events_pkey PRIMARY KEY (id);
alter table bo.report_notes add constraint report_notes_pkey PRIMARY KEY (report_id);
alter table bo.reset_requests add constraint reset_requests_pkey PRIMARY KEY (id);
alter table bo.staff_bank_details add constraint staff_bank_details_pkey PRIMARY KEY (staff_id);
alter table bo.subscriptions add constraint subscriptions_match_key_key UNIQUE (match_key);
alter table bo.subscriptions add constraint subscriptions_pkey PRIMARY KEY (id);
alter table bo.trash add constraint trash_kind_check CHECK ((kind = ANY (ARRAY['receipt'::text, 'item'::text])));
alter table bo.trash add constraint trash_pkey PRIMARY KEY (id);

-- ===== Foreign keys =====
alter table bo.card_charges add constraint card_charges_asked_staff_fkey FOREIGN KEY (asked_staff) REFERENCES profiles(id);
alter table bo.card_charges add constraint card_charges_category_id_fkey FOREIGN KEY (category_id) REFERENCES expense_categories(id);
alter table bo.card_charges add constraint card_charges_item_id_fkey FOREIGN KEY (item_id) REFERENCES expense_items(id) ON DELETE SET NULL;
alter table bo.card_charges add constraint card_charges_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES card_statements(id) ON DELETE CASCADE;
alter table bo.card_statements add constraint card_statements_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
alter table bo.day_question_replies add constraint day_question_replies_author_fkey FOREIGN KEY (author) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.day_question_replies add constraint day_question_replies_question_id_fkey FOREIGN KEY (question_id) REFERENCES day_questions(id) ON DELETE CASCADE;
alter table bo.day_questions add constraint day_questions_asked_by_fkey FOREIGN KEY (asked_by) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.day_questions add constraint day_questions_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.expense_items add constraint expense_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES expense_categories(id);
alter table bo.expense_items add constraint expense_items_duplicate_of_fkey FOREIGN KEY (duplicate_of) REFERENCES expense_items(id) ON DELETE SET NULL;
alter table bo.expense_items add constraint expense_items_report_id_fkey FOREIGN KEY (report_id) REFERENCES expense_reports(id) ON DELETE CASCADE;
alter table bo.expense_reports add constraint expense_reports_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id);
alter table bo.expense_reports add constraint expense_reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);
alter table bo.expense_reports add constraint expense_reports_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE RESTRICT;
alter table bo.fa_new_vendors add constraint fa_new_vendors_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table bo.hr_requests add constraint hr_requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table bo.hr_requests add constraint hr_requests_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.kbiz_docs add constraint kbiz_docs_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES kbiz_payments(id) ON DELETE CASCADE;
alter table bo.kbiz_docs add constraint kbiz_docs_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
alter table bo.kbiz_payments add constraint kbiz_payments_category_id_fkey FOREIGN KEY (category_id) REFERENCES expense_categories(id);
alter table bo.kbiz_payments add constraint kbiz_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table bo.notifications add constraint notifications_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.notifications add constraint notifications_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES day_questions(id) ON DELETE CASCADE;
alter table bo.ot_day_type add constraint ot_day_type_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.ot_entries add constraint ot_entries_form_id_fkey FOREIGN KEY (form_id) REFERENCES ot_forms(id) ON DELETE CASCADE;
alter table bo.ot_forms add constraint ot_forms_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.ot_offday add constraint ot_offday_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.ot_settings add constraint ot_settings_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table bo.project_pics add constraint project_pics_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
alter table bo.project_pics add constraint project_pics_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.receipts add constraint receipts_category_id_fkey FOREIGN KEY (category_id) REFERENCES expense_categories(id);
alter table bo.receipts add constraint receipts_item_id_fkey FOREIGN KEY (item_id) REFERENCES expense_items(id) ON DELETE SET NULL;
alter table bo.receipts add constraint receipts_report_id_fkey FOREIGN KEY (report_id) REFERENCES expense_reports(id) ON DELETE SET NULL;
alter table bo.receipts add constraint receipts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE RESTRICT;
alter table bo.report_events add constraint report_events_report_id_fkey FOREIGN KEY (report_id) REFERENCES expense_reports(id) ON DELETE CASCADE;
alter table bo.report_notes add constraint report_notes_report_id_fkey FOREIGN KEY (report_id) REFERENCES expense_reports(id) ON DELETE CASCADE;
alter table bo.reset_requests add constraint reset_requests_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.staff_bank_details add constraint staff_bank_details_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table bo.subscriptions add constraint subscriptions_category_id_fkey FOREIGN KEY (category_id) REFERENCES expense_categories(id);
alter table bo.trash add constraint trash_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ===== Indexes (not backing a constraint) =====
CREATE UNIQUE INDEX card_charges_item_once ON bo.card_charges USING btree (item_id) WHERE (item_id IS NOT NULL);
CREATE INDEX card_charges_statement_id_idx ON bo.card_charges USING btree (statement_id);
CREATE INDEX day_question_replies_question_id_created_at_idx ON bo.day_question_replies USING btree (question_id, created_at);
CREATE INDEX expense_items_category_id_idx ON bo.expense_items USING btree (category_id);
CREATE INDEX expense_items_report_id_idx ON bo.expense_items USING btree (report_id);
CREATE INDEX expense_reports_approved_by_idx ON bo.expense_reports USING btree (approved_by);
CREATE INDEX expense_reports_staff_id_idx ON bo.expense_reports USING btree (staff_id);
CREATE UNIQUE INDEX fa_new_vendors_name ON bo.fa_new_vendors USING btree (lower(name));
CREATE INDEX kbiz_docs_payment_id_idx ON bo.kbiz_docs USING btree (payment_id);
CREATE UNIQUE INDEX kbiz_docs_txn_once ON bo.kbiz_docs USING btree (txn_no) WHERE ((txn_no IS NOT NULL) AND (status <> 'duplicate'::text));
CREATE INDEX notifications_staff_id_read_at_idx ON bo.notifications USING btree (staff_id, read_at);
CREATE INDEX ot_entries_form ON bo.ot_entries USING btree (form_id, work_date);
CREATE UNIQUE INDEX ot_forms_one_per_period ON bo.ot_forms USING btree (staff_id, period_end);
CREATE INDEX receipts_category_id_idx ON bo.receipts USING btree (category_id);
CREATE INDEX receipts_item_id_idx ON bo.receipts USING btree (item_id);
CREATE INDEX receipts_report_id_idx ON bo.receipts USING btree (report_id);
CREATE UNIQUE INDEX receipts_staff_file_hash_uq ON bo.receipts USING btree (staff_id, file_hash) WHERE (file_hash IS NOT NULL);
CREATE INDEX receipts_staff_id_idx ON bo.receipts USING btree (staff_id);
CREATE INDEX report_events_report ON bo.report_events USING btree (report_id, at);
CREATE INDEX trash_row_id_idx ON bo.trash USING btree (row_id);
CREATE INDEX trash_staff_id_deleted_at_idx ON bo.trash USING btree (staff_id, deleted_at DESC);

-- ===== Row level security =====
alter table bo.card_charges enable row level security;
alter table bo.card_statements enable row level security;
alter table bo.day_question_replies enable row level security;
alter table bo.day_questions enable row level security;
alter table bo.expense_categories enable row level security;
alter table bo.expense_items enable row level security;
alter table bo.expense_reports enable row level security;
alter table bo.fa_accounts enable row level security;
alter table bo.fa_meta enable row level security;
alter table bo.fa_new_vendors enable row level security;
alter table bo.fa_projects enable row level security;
alter table bo.fa_vendors enable row level security;
alter table bo.holiday_meta enable row level security;
alter table bo.holiday_suggestions enable row level security;
alter table bo.holidays enable row level security;
alter table bo.hr_requests enable row level security;
alter table bo.kbiz_docs enable row level security;
alter table bo.kbiz_payments enable row level security;
alter table bo.notifications enable row level security;
alter table bo.ot_day_type enable row level security;
alter table bo.ot_entries enable row level security;
alter table bo.ot_forms enable row level security;
alter table bo.ot_offday enable row level security;
alter table bo.ot_settings enable row level security;
alter table bo.profiles enable row level security;
alter table bo.project_pics enable row level security;
alter table bo.projects enable row level security;
alter table bo.receipts enable row level security;
alter table bo.report_events enable row level security;
alter table bo.report_notes enable row level security;
alter table bo.reset_requests enable row level security;
alter table bo.staff_bank_details enable row level security;
alter table bo.subscriptions enable row level security;
alter table bo.trash enable row level security;
alter sequence bo.reset_requests_id_seq owned by bo.reset_requests.id;


-- BCM: the sender picks who checks each form
alter table bo.expense_reports add column checker_id uuid references bo.profiles(id), add column checker_name text;
alter table bo.ot_forms add column checker_id uuid references bo.profiles(id);
-- BCM: finance jobs per staff member (set in Admin > Roles and access)
create table bo.jobs (staff_id uuid not null references public.staff(id) on delete cascade, job text not null check (job in ('data_entry','accountant','hr')), primary key (staff_id, job));
alter table bo.jobs enable row level security;

CREATE OR REPLACE FUNCTION bo_private.bump_payment_rev()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update bo.kbiz_payments set rev = rev + 1 where id in (coalesce(new.payment_id, old.payment_id), coalesce(old.payment_id, new.payment_id));
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.bump_rev()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.rev is distinct from old.rev then return new; end if; -- explicit bump (a file added or removed)
  if (to_jsonb(new) - 'fa_ref' - 'fa_done') = (to_jsonb(old) - 'fa_ref' - 'fa_done') then return new; end if; -- numbering or FlowAccount tick only
  new.rev := old.rev + 1; return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.can_check(rid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from bo.expense_reports r where r.id = rid and r.staff_id <> (select auth.uid()) and (
    (r.form_type = 'project' and bo_private.is_pic(r.project_id))
    or (coalesce(r.form_type::text, 'personal') <> 'project' and bo_private.my_role() = 'approver'))) $function$
;


CREATE OR REPLACE FUNCTION bo_private.can_edit_report(rid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from bo.expense_reports r
    where r.id = rid
      and r.staff_id = (select auth.uid())
      and r.status in ('draft', 'rejected')
  )
$function$
;


CREATE OR REPLACE FUNCTION bo_private.can_fa()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select bo_private.is_admin() or bo_private.is_accountant() or bo_private.is_data_entry() $function$
;


CREATE OR REPLACE FUNCTION bo_private.can_view_report(rid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from bo.expense_reports r
    where r.id = rid and (
      r.staff_id = (select auth.uid())
      or bo_private.is_admin() or bo_private.is_accountant()
      or (r.form_type = 'project' and bo_private.is_pic(r.project_id))
      or (coalesce(r.form_type, 'personal') <> 'project' and bo_private.my_role() = 'approver')
      or (bo_private.is_data_entry() and r.status in ('approved', 'paid'))
    )
  ) $function$
;


CREATE OR REPLACE FUNCTION bo_private.guard_duplicates_on_submit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.status = 'submitted' and old.status is distinct from 'submitted' and auth.uid() is not null
     and exists (select 1 from bo.expense_items i where i.report_id = old.id and i.duplicate_of is not null and not i.duplicate_ok) then
    raise exception 'There are possible duplicate lines. Delete them, or open them and confirm they are separate.';
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.guard_profile_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then return new; end if;
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.staff_no is distinct from old.staff_no
      or new.email is distinct from old.email or new.is_accountant is distinct from old.is_accountant or new.is_data_entry is distinct from old.is_data_entry
      or new.is_hr is distinct from old.is_hr)
     and not bo_private.is_admin() then
    raise exception 'Only admins can change access, staff number, email or active status';
  end if;
  if new.id = auth.uid() and old.role = 'admin' and new.role <> 'admin' then
    raise exception 'You cannot remove your own admin access';
  end if;
  if new.signature is distinct from old.signature and new.id <> auth.uid() then
    raise exception 'Only the person themselves can change their signature';
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.guard_report_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid := auth.uid(); sig text;
begin
  if uid is null then return new; end if;
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
      -- nobody else can do step 1 (e.g. the PIC submits on their own project): go straight to the admin
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
      if not bo_private.is_admin() then raise exception 'Only an admin gives the final approval'; end if;
      if old.status = 'submitted' and old.checker_id is not null then raise exception 'The picked checker checks this form first'; end if;
      if old.checked_by = uid then raise exception 'You checked this form, so another admin gives the final approval'; end if;
      if old.status not in ('submitted', 'checked') then raise exception 'Only submitted forms can be approved'; end if;
      new.approved_by := uid; new.approved_at := now();
    elsif new.status = 'rejected' then
      if old.status not in ('submitted', 'checked') then raise exception 'Only submitted forms can be returned'; end if;
      if not (bo_private.is_admin() or (old.status = 'submitted' and bo_private.can_check(old.id))) then raise exception 'You cannot return this form'; end if;
      if coalesce(trim(new.rejection_reason), '') = '' then raise exception 'A reason is required when returning'; end if;
      new.approved_by := uid; new.approved_at := now();
      new.checked_by := null; new.checked_by_name := null; new.checked_at := null; new.checked_signature := null;
    elsif new.status = 'paid' then
      if not bo_private.is_admin() then raise exception 'Only an admin can mark a form as paid'; end if;
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
       or (new.approved_by is distinct from old.approved_by and new.status not in ('rejected'))
       or new.approver_signature is distinct from old.approver_signature and new.status <> 'rejected'
       or (new.paid_at is distinct from old.paid_at and new.status <> 'paid')
       or (new.paid_slip_path is distinct from old.paid_slip_path and not bo_private.is_accountant())
       or (new.paid_ref is distinct from old.paid_ref and not bo_private.is_accountant()) then
      raise exception 'You cannot change owner, approval, payment or carried-forward fields';
    end if;
    -- reviewers who are not the owner may only move the status / FlowAccount mark, not edit the form
    if old.staff_id <> uid and (new.advance_topup is distinct from old.advance_topup or new.project_id is distinct from old.project_id
       or new.form_type is distinct from old.form_type or new.ref_no is distinct from old.ref_no) and not bo_private.is_approver_or_admin() then
      raise exception 'You cannot edit someone else''s form';
    end if;
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.has_other_checker(rid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from bo.expense_reports r where r.id = rid and (
    (r.form_type = 'project' and exists (select 1 from bo.project_pics pp join bo.profiles p on p.id = pp.staff_id where pp.project_id = r.project_id and pp.staff_id <> r.staff_id and p.active))
    or (coalesce(r.form_type::text, 'personal') <> 'project' and exists (select 1 from bo.profiles p where p.role = 'approver' and p.active and p.id <> r.staff_id)))) $function$
;


CREATE OR REPLACE FUNCTION bo_private.has_other_hr(p_staff uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from bo.profiles where active and is_hr and id <> p_staff) $function$
;


CREATE OR REPLACE FUNCTION bo_private.is_accountant()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select is_accountant from bo.profiles where id = (select auth.uid())), false) or bo_private.is_admin() $function$
;


CREATE OR REPLACE FUNCTION bo_private.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(bo_private.my_role() = 'admin', false)
$function$
;


CREATE OR REPLACE FUNCTION bo_private.is_any_pic()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from bo.project_pics where staff_id = (select auth.uid())) $function$
;


CREATE OR REPLACE FUNCTION bo_private.is_approver_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(bo_private.my_role() in ('admin', 'approver'), false)
$function$
;


CREATE OR REPLACE FUNCTION bo_private.is_data_entry()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select is_data_entry from bo.profiles where id = (select auth.uid())), false) $function$
;


CREATE OR REPLACE FUNCTION bo_private.is_freelancer(sid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select pay_type = 'freelance' from bo.ot_settings where staff_id = sid), false) $function$
;


CREATE OR REPLACE FUNCTION bo_private.is_hr()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select is_hr from bo.profiles where id = (select auth.uid())), false) $function$
;


CREATE OR REPLACE FUNCTION bo_private.is_pic(pid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pid is not null and exists (select 1 from bo.project_pics where project_id = pid and staff_id = (select auth.uid())) $function$
;


CREATE OR REPLACE FUNCTION bo_private.item_match_supplier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m text;
begin
  if new.merchant is null or trim(new.merchant) = '' then return new; end if;
  if tg_op = 'UPDATE' and new.merchant is not distinct from old.merchant then return new; end if;
  if bo_private.known_supplier(new.merchant) then return new; end if;
  m := bo_private.match_supplier(new.merchant);
  if m is not null then new.merchant_raw := coalesce(new.merchant_raw, new.merchant); new.merchant := m; end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.known_supplier(t text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from bo.fa_vendors where lower(label) = lower(trim(t))) or exists (select 1 from bo.fa_new_vendors where lower(name) = lower(trim(t))) $function$
;


CREATE OR REPLACE FUNCTION bo_private.match_supplier(t text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n text := bo_private.norm_name(t); c int; m text;
begin
  if length(n) < 4 then return null; end if;
  select count(*), min(x) into c, m from (
    select label x from bo.fa_vendors where bo_private.norm_name(label) = n
    union select name from bo.fa_new_vendors where bo_private.norm_name(name) = n) s;
  if c = 1 then return m; end if;
  if length(n) < 5 then return null; end if;
  select count(*), min(x) into c, m from (
    select label x from bo.fa_vendors where length(bo_private.norm_name(label)) >= 5 and (n like bo_private.norm_name(label) || '%' or bo_private.norm_name(label) like n || '%')
    union select name from bo.fa_new_vendors where length(bo_private.norm_name(name)) >= 5 and (n like bo_private.norm_name(name) || '%' or bo_private.norm_name(name) like n || '%')) s;
  if c = 1 then return m; end if;
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.my_role()
 RETURNS app_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select role from bo.profiles where id = (select auth.uid()) and active
$function$
;


CREATE OR REPLACE FUNCTION bo_private.new_vendor_rename()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.name is distinct from old.name then update bo.expense_items set merchant = new.name where lower(merchant) = lower(old.name); end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.next_project_ref(pid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.code || '-' || lpad((coalesce(max(nullif(substring(r.ref_no from length(p.code) + 2), '')::int), 0) + 1)::text, 2, '0')
  from bo.projects p left join bo.expense_reports r on r.project_id = p.id and r.ref_no ~ ('^' || p.code || '-[0-9]+$')
  where p.id = pid and p.code is not null group by p.code $function$
;


CREATE OR REPLACE FUNCTION bo_private.no_admin_timesheet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists (select 1 from bo.profiles where id = new.staff_id and role = 'admin') then
    raise exception 'Admins do not keep a timesheet.';
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.no_self_approval()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.status is distinct from old.status and new.status in ('checked','approved') and new.staff_id = auth.uid() then
    raise exception 'You cannot check or approve your own form';
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.norm_merchant(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select nullif(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9ก-๙]+', '', 'g'), '')
$function$
;


CREATE OR REPLACE FUNCTION bo_private.norm_name(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select lower(regexp_replace(regexp_replace(coalesce(t,''), '(co\.?,?\s*ltd\.?|company limited|บริษัท|จำกัด|\(มหาชน\)|public)', '', 'gi'), '[^[:alnum:]]', '', 'g')) $function$
;


CREATE OR REPLACE FUNCTION bo_private.notify_day_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid := auth.uid(); owner uuid; d date; msg text; pend date;
begin
  if uid is null then return coalesce(new, old); end if;
  if tg_table_name = 'ot_entries' then
    select f.staff_id, f.period_end into owner, pend from bo.ot_forms f where f.id = coalesce(new.form_id, old.form_id);
    d := coalesce(new.work_date, old.work_date);
    if tg_op = 'DELETE' then msg := 'removed an entry';
    elsif new.leave_type is not null then msg := 'set it to ' || initcap(new.leave_type) || ' leave';
    elsif tg_op = 'UPDATE' and new.reason is distinct from old.reason and new.start_time is not distinct from old.start_time and new.end_time is not distinct from old.end_time and new.leave_type is not distinct from old.leave_type then return coalesce(new, old);
    elsif tg_op = 'UPDATE' and new.start_time is not distinct from old.start_time and new.end_time is not distinct from old.end_time and new.leave_type is not distinct from old.leave_type then return coalesce(new, old);
    else msg := 'set hours ' || coalesce(to_char(new.start_time,'HH24:MI'),'') || '–' || coalesce(to_char(new.end_time,'HH24:MI'),'');
    end if;
  else
    owner := coalesce(new.staff_id, old.staff_id); d := coalesce(new.day, old.day);
    msg := case when tg_op = 'DELETE' then 'set it back to your normal schedule' else 'set it to ' || case new.treat_as when 'workday' then 'Workday' else 'Day off' end end;
  end if;
  if owner is null or owner = uid then return coalesce(new, old); end if;
  -- merge repeated changes to the same day within 2 minutes
  delete from bo.notifications where staff_id = owner and created_by = uid and read_at is null and created_at > now() - interval '2 minutes' and link like '%&d=' || d::text;
  insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
  values (owner, (select full_name from bo.profiles where id = uid) || ' changed ' || to_char(d, 'Dy DD Mon') || ': ' || msg,
          '#/ot?p=' || coalesce(pend, (case when extract(day from d) > 25 then (date_trunc('month', d) + interval '1 month')::date + 24 else date_trunc('month', d)::date + 24 end))::text || '&d=' || d::text,
          uid, (select full_name from bo.profiles where id = uid));
  return coalesce(new, old);
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.notify_pic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; who text; pn text; pic text;
begin
  if tg_op = 'INSERT' then r := new; else r := old; end if;
  if auth.uid() is null then return null; end if;
  who := (select full_name from bo.profiles where id = auth.uid());
  pn := (select name from bo.projects where id = r.project_id);
  pic := (select full_name from bo.profiles where id = r.staff_id);
  if r.staff_id <> auth.uid() then
    insert into bo.notifications (staff_id, body, link, created_by, created_by_name)
    values (r.staff_id, case when tg_op = 'INSERT' then who || ' made you PIC of ' || pn || '. You check its expense forms first.' else who || ' removed you as PIC of ' || pn || '.' end, '#/approvals', auth.uid(), who);
  end if;
  insert into bo.notifications (staff_id, body, link, created_by, created_by_name)
  select p.id, case when tg_op = 'INSERT' then who || ' made ' || pic || ' PIC of ' || pn else who || ' removed ' || pic || ' as PIC of ' || pn end, '#/admin/access', auth.uid(), who
  from bo.profiles p where p.active and p.role = 'admin' and p.id <> auth.uid() and p.id <> r.staff_id;
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.notify_settings_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare summ text; me text; o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end; n jsonb := to_jsonb(new);
begin
  if auth.uid() is null or new.staff_id = auth.uid() then return new; end if;
  select string_agg(bo_private.settings_label(k, n ->> k), ', ') into summ
    from unnest(array['pay_type','start_time','end_time','week_pattern','sat_off_anchor']) k where (o ->> k) is distinct from (n ->> k);
  if summ is null then return new; end if;
  select full_name into me from bo.profiles where id = auth.uid();
  insert into bo.notifications (staff_id, body, link, created_by, created_by_name)
    values (new.staff_id, me || ' changed your timesheet settings: ' || summ, '#/ot', auth.uid(), me);
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.notify_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid := auth.uid(); who text; staff text; what text; link text; first_line uuid; n int; per text; rlink text;
begin
  if new.status is not distinct from old.status then return new; end if;
  who := coalesce((select full_name from bo.profiles where id = uid), 'Admin');
  staff := (select full_name from bo.profiles where id = new.staff_id);
  if tg_table_name = 'expense_reports' then
    what := new.ref_no; link := '#/report/' || new.id; rlink := '#/report/' || new.id;
  else
    per := to_char(new.period_end, 'Mon YYYY'); what := 'your ' || per || ' timesheet'; link := '#/ot?p=' || new.period_end; rlink := '#/ot/review/' || new.id;
  end if;

  if tg_table_name = 'ot_forms' and new.status = 'submitted' then
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
    select p.id, staff || ' submitted the ' || per || ' timesheet', rlink, uid, who
    from bo.profiles p where p.active and p.id <> new.staff_id
      and (p.is_hr or (p.role = 'admin' and not bo_private.has_other_hr(new.staff_id)));
  elsif tg_table_name = 'ot_forms' and new.status = 'checked' then
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
    select p.id, staff || '''s ' || per || ' timesheet needs your final approval (checked by ' || coalesce(new.checked_by_name, who) || ')', rlink, uid, who
    from bo.profiles p where p.active and p.role = 'admin' and p.id <> new.staff_id;
  elsif tg_table_name = 'expense_reports' and new.status::text = 'submitted' then
    -- step 1: the project's PICs, or office approvers for personal forms
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
    select p.id, staff || ' submitted ' || new.ref_no || case when new.form_type = 'project' then ' (' || coalesce((select name from bo.projects where id = new.project_id), 'project') || ')' else ' (personal)' end || ': please check', rlink, uid, who
    from bo.profiles p where p.active and p.id <> new.staff_id and p.id = new.checker_id;
  elsif tg_table_name = 'expense_reports' and new.status::text = 'checked' then
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
    select p.id, new.ref_no || ' from ' || staff || ' needs your final approval' || case when new.checked_by is not null then ' (checked by ' || new.checked_by_name || ')' else '' end, rlink, uid, who
    from bo.profiles p where p.active and p.role = 'admin' and p.id <> new.staff_id and p.id is distinct from new.checked_by;
  elsif new.status::text = 'rejected' then
    if tg_table_name = 'expense_reports' then
      select count(*) into n from bo.expense_items where report_id = new.id and coalesce(return_note,'') <> '';
      select id into first_line from bo.expense_items where report_id = new.id and coalesce(return_note,'') <> '' order by invoice_date, created_at limit 1;
      link := '#/expenses?id=' || new.id || case when first_line is not null then '&line=' || first_line else '' end;
    end if;
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name, details)
    values (new.staff_id, who || ' returned ' || what || ': ' || coalesce(nullif(trim(new.rejection_reason), ''), 'please check')
      || case when coalesce(n, 0) > 0 and coalesce(new.rejection_reason, '') not ilike '%line%' then ' (' || n || ' line' || case when n > 1 then 's' else '' end || ' to fix)' else '' end,
      link, uid, who, case when tg_table_name = 'expense_reports' then bo_private.return_lines(new.id) end);
  elsif new.status::text = 'approved' then
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name) values (new.staff_id, who || ' approved ' || what, link, uid, who);
    if tg_table_name = 'expense_reports' then
      insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
      select p.id, new.ref_no || ' from ' || staff || ' is approved: ready to pay', rlink, uid, who
      from bo.profiles p where p.active and p.role = 'admin' and p.id <> new.staff_id and p.id <> uid;
    end if;
  elsif new.status::text = 'paid' then
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name) values (new.staff_id, upper(left(what, 1)) || substr(what, 2) || ' marked as paid', link, uid, who);
    if tg_table_name = 'expense_reports' then
      insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
      select p.id, new.ref_no || ' from ' || staff || ' is paid: enter it in FlowAccount', rlink, uid, who
      from bo.profiles p where p.active and p.is_data_entry and p.id <> new.staff_id;
    end if;
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_after()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op in ('INSERT', 'UPDATE') then perform bo_private.ot_recalc_day(new.form_id, new.work_date); end if;
  if tg_op in ('DELETE', 'UPDATE') then perform bo_private.ot_recalc_day(old.form_id, old.work_date); end if;
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_calc()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s bo.ot_settings; sid uuid; dow int; h numeric; normal numeric; lunch numeric; ov text;
begin
  select staff_id into sid from bo.ot_forms where id = new.form_id;
  select * into s from bo.ot_settings where staff_id = sid;
  if s.staff_id is null then insert into bo.ot_settings(staff_id) values (sid) returning * into s; end if;
  dow := extract(isodow from new.work_date);
  select treat_as into ov from bo.ot_day_type where staff_id = sid and day = new.work_date;
  if ov is not null then new.day_type := ov;
  elsif exists (select 1 from bo.holidays where day = new.work_date) then new.day_type := 'holiday';
  elsif dow = 7 then new.day_type := 'day_off';
  elsif dow = 6 and (s.week_pattern = 'mon_fri' or (s.week_pattern = 'alt_sat' and s.sat_off_anchor is not null and mod(abs(new.work_date - s.sat_off_anchor), 14) = 0)) then new.day_type := 'day_off';
  else new.day_type := 'workday'; end if;
  new.updated_at := now();
  if new.leave_type is not null or new.start_time is null or new.end_time is null then new.hours := 0; new.counted := 0; return new; end if;
  if s.pay_type = 'freelance' then
    h := extract(epoch from (new.end_time - new.start_time)) / 3600.0; if h <= 0 then h := h + 24; end if;
    new.hours := round(h, 2); new.counted := 0; return new;
  end if;
  h := extract(epoch from (new.end_time - new.start_time)) / 3600.0;
  if h <= 0 then h := h + 24; end if;
  new.hours := round(h, 2);
  normal := extract(epoch from (s.end_time - s.start_time)) / 3600.0;
  if new.day_type = 'workday' then new.counted := greatest(0, round(h - normal, 2));
  else
    lunch := case when h > 5 then s.lunch_hours else 0 end;
    new.counted := round(greatest(0, h - lunch) * case when new.day_type = 'holiday' then s.holiday_mult else s.dayoff_mult end, 2);
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_day_type_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare sid uuid := coalesce(new.staff_id, old.staff_id); d date := coalesce(new.day, old.day);
begin
  update bo.ot_entries e set work_date = e.work_date from bo.ot_forms f where f.id = e.form_id and f.staff_id = sid and e.work_date = d;
  perform bo_private.ot_recalc_day(f.id, d) from bo.ot_forms f where f.staff_id = sid and d between f.period_start and f.period_end;
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_entry_note_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then return new; end if;
  if exists (select 1 from bo.ot_forms f where f.id = new.form_id and f.staff_id = auth.uid()) then return new; end if;
  if (to_jsonb(new) - 'return_note' - 'updated_at') is distinct from (to_jsonb(old) - 'return_note' - 'updated_at') then
    raise exception 'Only the staff member can change their own days. You can ask them a question instead.';
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid := auth.uid(); sig text; adm boolean := bo_private.is_admin(); hr boolean := bo_private.is_hr();
begin
  if uid is null then return new; end if;
  if new.status is distinct from old.status then
    if new.status = 'submitted' then
      if old.status not in ('draft','rejected') then raise exception 'Only a draft or returned timesheet can be submitted'; end if;
      if exists (select 1 from bo.ot_entries where form_id = old.id and counted > 0 and coalesce(trim(reason),'') = '') then raise exception 'Add a note on each day with OT.'; end if;
      if bo_private.ot_offday_missing(old.id) then raise exception 'For each day off you worked, choose Paid x2 or Keep as a day off.'; end if;
      sig := (select signature from bo.profiles where id = old.staff_id);
      if sig is null then raise exception 'Add your signature before submitting.'; end if;
      new.applicant_signature := sig; new.approver_signature := null; new.submitted_at := now(); new.rejection_reason := null;
      new.checked_by := null; new.checked_by_name := null; new.checked_at := null; new.checked_signature := null;
    elsif new.status = 'checked' then
      if not hr then raise exception 'Only HR can check timesheets'; end if;
      if old.status <> 'submitted' then raise exception 'Only submitted timesheets can be checked'; end if;
      if old.staff_id = uid then raise exception 'You cannot check your own timesheet'; end if;
      sig := (select signature from bo.profiles where id = uid);
      if sig is null then raise exception 'Add your signature before checking.'; end if;
      new.checked_by := uid; new.checked_at := now(); new.checked_signature := sig;
      new.checked_by_name := (select full_name from bo.profiles where id = uid);
    elsif new.status = 'approved' then
      if not adm then raise exception 'Only an admin gives final approval'; end if;
      if old.status = 'submitted' and bo_private.has_other_hr(old.staff_id) then raise exception 'HR checks this timesheet first'; end if;
      if old.status not in ('submitted','checked') then raise exception 'Only checked timesheets can be approved'; end if;
      sig := (select signature from bo.profiles where id = uid);
      if sig is null then raise exception 'Add your signature before approving.'; end if;
      new.approver_signature := sig; new.approved_by := uid; new.approved_at := now();
      new.approved_by_name := (select full_name from bo.profiles where id = uid);
    elsif new.status = 'rejected' then
      if not (adm or (hr and old.staff_id <> uid)) then raise exception 'Only HR or an admin can return a timesheet'; end if;
      if old.status not in ('submitted','checked') or (not adm and old.status <> 'submitted') then raise exception 'This timesheet cannot be returned now'; end if;
      if coalesce(trim(new.rejection_reason),'') = '' then raise exception 'A reason is required when returning'; end if;
      new.last_returned_at := now(); new.approver_signature := null;
      new.approved_by := uid; new.approved_at := now(); new.approved_by_name := (select full_name from bo.profiles where id = uid);
    elsif new.status = 'paid' then
      if not (adm or bo_private.is_accountant()) or old.status <> 'approved' then raise exception 'Only approved timesheets can be marked paid'; end if;
      new.paid_at := now();
    elsif new.status = 'draft' then
      if not adm then raise exception 'Only admins can reopen'; end if;
    end if;
  end if;
  if not (adm or hr) then
    if new.staff_id is distinct from old.staff_id or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
       or new.approved_by_name is distinct from old.approved_by_name or new.approver_signature is distinct from old.approver_signature
       or new.checked_by is distinct from old.checked_by or new.checked_signature is distinct from old.checked_signature
       or new.paid_at is distinct from old.paid_at or new.seen_at is distinct from old.seen_at
       or new.expiry_action is distinct from old.expiry_action or new.extended_until is distinct from old.extended_until then
      raise exception 'You cannot change approval fields';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_offday_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.choice = 'save' and new.save_until is null then new.save_until := (new.day + interval '3 months')::date; end if;
  -- only approvers can extend
  if tg_op = 'UPDATE' and new.save_until is distinct from old.save_until and old.save_until is not null and not bo_private.is_approver_or_admin() then new.save_until := old.save_until; end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_offday_missing(p_form uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from bo.ot_entries e join bo.ot_forms f on f.id = e.form_id
    join bo.ot_settings st on st.staff_id = f.staff_id and st.pay_type <> 'freelance'
    where e.form_id = p_form and e.leave_type is null and e.hours > 0 and e.day_type <> 'workday'
      and not exists (select 1 from bo.ot_offday o where o.staff_id = f.staff_id and o.day = e.work_date));
$function$
;


CREATE OR REPLACE FUNCTION bo_private.ot_recalc_day(p_form uuid, p_day date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s bo.ot_settings; sid uuid; normal numeric; left_normal numeric; tot numeric; lunch numeric; mult numeric; r record; c numeric; ch text;
begin
  select staff_id into sid from bo.ot_forms where id = p_form;
  select * into s from bo.ot_settings where staff_id = sid;
  if s.staff_id is null or s.pay_type = 'freelance' then return; end if;
  select choice into ch from bo.ot_offday where staff_id = sid and day = p_day;
  normal := extract(epoch from (s.end_time - s.start_time)) / 3600.0;
  select coalesce(sum(hours), 0) into tot from bo.ot_entries where form_id = p_form and work_date = p_day and leave_type is null;
  left_normal := normal;
  lunch := case when tot > 5 then s.lunch_hours else 0 end;
  for r in select id, day_type, hours from bo.ot_entries where form_id = p_form and work_date = p_day and leave_type is null and start_time is not null order by start_time loop
    if r.day_type = 'workday' or ch = 'swap' then c := greatest(0, r.hours - left_normal); left_normal := greatest(0, left_normal - r.hours);
    elsif ch = 'save' then c := 0;
    else
      mult := case when r.day_type = 'holiday' then s.holiday_mult else s.dayoff_mult end;
      c := greatest(0, r.hours - lunch) * mult; lunch := greatest(0, lunch - r.hours);
    end if;
    update bo.ot_entries set counted = round(c, 2) where id = r.id and counted is distinct from round(c, 2);
  end loop;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.project_after()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; newcode boolean;
begin
  if tg_op = 'INSERT' then newcode := new.code is not null; else newcode := new.code is not null and new.code is distinct from old.code; end if;
  if newcode then
    for r in select id from bo.expense_reports where project_id = new.id and status in ('draft','rejected','submitted','checked')
             and ref_no !~ ('^' || new.code || '-[0-9]+$') order by created_at loop
      update bo.expense_reports set ref_no = bo_private.next_project_ref(new.id) where id = r.id;
    end loop;
  end if;
  -- let admins know (no approval needed), so they can add a PIC
  if tg_op = 'INSERT' and not bo_private.is_admin() then
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
    select p.id, coalesce(new.created_by_name, 'Staff') || ' added project "' || new.name || '"' || coalesce(' (' || new.code || ')', '') || ': add a PIC if needed', '#/admin/access', new.created_by, new.created_by_name
    from bo.profiles p where p.active and p.role = 'admin';
  end if;
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.project_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := (select full_name from bo.profiles where id = auth.uid());
    new.needs_setup := false;
  end if;
  if new.code is not null then new.code := nullif(upper(regexp_replace(new.code, '\s+', '', 'g')), ''); end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ref_letters(n integer)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare s text := ''; k int := n;
begin
  while k > 0 loop s := chr(65 + ((k - 1) % 26)) || s; k := (k - 1) / 26; end loop;
  return s;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.ref_number(t text)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare n int := 0; c text;
begin
  if t is null or t !~ '^[A-Z]+$' then return 0; end if;
  foreach c in array regexp_split_to_array(t, '') loop n := n * 26 + (ascii(c) - 64); end loop;
  return n;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.report_project_ref()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c text; changed boolean;
begin
  if tg_op = 'INSERT' then changed := true; else changed := new.project_id is distinct from old.project_id; end if;
  if changed and new.form_type = 'project' and new.project_id is not null then
    c := (select code from bo.projects where id = new.project_id);
    if c is not null and new.ref_no !~ ('^' || c || '-[0-9]+$') then new.ref_no := bo_private.next_project_ref(new.project_id); end if;
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.report_status_side()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare who text := (select full_name from bo.profiles where id = auth.uid());
begin
  if new.status is distinct from old.status then
    if new.status = 'rejected' then update bo.expense_reports set last_returned_at = now() where id = new.id;
    elsif new.status = 'approved' then update bo.expense_items set return_note = null where report_id = new.id and return_note is not null;
    end if;
    insert into bo.report_events(report_id, by_id, by_name, action, note)
    values (new.id, auth.uid(), coalesce(who, 'System'),
      case new.status::text when 'submitted' then case when old.status::text = 'rejected' then 'Resubmitted' else 'Submitted' end
        when 'checked' then case when new.checked_by is null then 'Sent to admin (no checker picked)' else 'Approved (step 1)' end
        when 'approved' then 'Final approval' when 'rejected' then 'Returned' when 'paid' then 'Paid' when 'draft' then 'Reopened as draft' else new.status::text end,
      case when new.status::text = 'rejected' then new.rejection_reason when new.status::text = 'paid' then new.paid_ref end);
  end if;
  if new.fa_entered_at is distinct from old.fa_entered_at and new.fa_entered_at is not null then
    insert into bo.report_events(report_id, by_id, by_name, action) values (new.id, auth.uid(), coalesce(who, 'System'), 'Entered in FlowAccount');
  end if;
  return null;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.return_lines(p_report uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'label', to_char(i.invoice_date, 'DD Mon') || ' · ' || left(i.item, 60),
    'note', i.return_note,
    'link', '#/expenses?id=' || p_report || '&line=' || i.id) order by i.invoice_date, i.created_at), '[]'::jsonb)
  from bo.expense_items i where i.report_id = p_report and coalesce(i.return_note, '') <> '';
$function$
;


CREATE OR REPLACE FUNCTION bo_private.set_approver_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare sig text;
begin
  if new.approved_by is distinct from old.approved_by then
    new.approved_by_name := (select full_name from bo.profiles where id = new.approved_by);
  end if;
  if new.status is distinct from old.status then
    if new.status in ('submitted', 'checked') and old.status in ('draft', 'rejected') then
      sig := (select signature from bo.profiles where id = new.staff_id);
      if sig is null and auth.uid() is not null then raise exception 'Add your signature before submitting.'; end if;
      new.applicant_signature := sig; new.approver_signature := null;
    elsif new.status = 'approved' then
      sig := (select signature from bo.profiles where id = new.approved_by);
      if sig is null and auth.uid() is not null then raise exception 'Add your signature before approving.'; end if;
      new.approver_signature := sig;
    elsif new.status in ('rejected', 'draft') then
      new.approver_signature := null;
    end if;
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.set_duplicate_flag()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d uuid;
begin
  -- Same date + amount, and: same printed time (store name ignored, it is often read differently),
  -- or, when a time is missing, the same store.
  select o.id into d
  from bo.expense_reports rm
  join bo.expense_reports ro on ro.staff_id = rm.staff_id
  join bo.expense_items o on o.report_id = ro.id and o.id <> new.id
    and o.amount = new.amount
    and o.invoice_date = new.invoice_date
    and (
      (o.receipt_time is not null and new.receipt_time is not null and o.receipt_time = new.receipt_time)
      or ((o.receipt_time is null or new.receipt_time is null)
          and (bo_private.norm_merchant(o.merchant) is null or bo_private.norm_merchant(new.merchant) is null
               or bo_private.norm_merchant(o.merchant) = bo_private.norm_merchant(new.merchant)))
    )
    and o.created_at < coalesce(new.created_at, now())
  where rm.id = new.report_id
  order by o.created_at limit 1;
  if d is distinct from new.duplicate_of then
    new.duplicate_of := d;
    if d is null then new.duplicate_ok := false; end if;
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.set_opening_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare prev_balance numeric(12,2);
begin
  if new.form_type = 'project' then
    new.opening_advance := 0;
  else
    -- Only cash still held carries forward. A negative balance is money the company owes, which is reimbursed, not carried.
    select t.balance into prev_balance
    from bo.expense_report_totals t
    join bo.expense_reports r on r.id = t.report_id
    where t.staff_id = new.staff_id and r.form_type = 'personal' and r.id is distinct from new.id
      and (r.period_month < new.period_month or (r.period_month = new.period_month and r.created_at < coalesce(new.created_at, now())))
    order by r.period_month desc, r.created_at desc
    limit 1;
    new.opening_advance := greatest(coalesce(prev_balance, 0), 0);
  end if;
  if not bo_private.is_admin() then
    new.advance_topup := 0;
  end if;
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.settings_label(k text, v text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case k
    when 'pay_type' then 'Type: ' || coalesce(case v when 'full_time' then 'Full-time' when 'part_time' then 'Part-time' when 'freelance' then 'Freelance' else v end, '-')
    when 'start_time' then 'Start: ' || coalesce(left(v,5), '-')
    when 'end_time' then 'End: ' || coalesce(left(v,5), '-')
    when 'week_pattern' then 'Work week: ' || coalesce(case v when 'alt_sat' then 'Long/short week' when 'mon_fri' then 'Mon to Fri' when 'mon_sat' then 'Mon to Sat' else v end, '-')
    when 'sat_off_anchor' then 'Saturday off: ' || coalesce(v, '-')
    else k || ': ' || coalesce(v, '-') end $function$
;


CREATE OR REPLACE FUNCTION bo_private.timesheet_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pend date := (date_trunc('month', now() at time zone 'Asia/Bangkok')::date + 24);
begin
  insert into bo.notifications(staff_id, body, link, created_by_name)
  select p.id, 'Timesheet due tomorrow: ' || to_char(pend, 'Mon YYYY') || ' (' || to_char(pend - interval '1 month' + interval '1 day', 'DD Mon') || ' to ' || to_char(pend, 'DD Mon') || ') closes on ' || to_char(pend, 'DD Mon') || '. Check your days and submit.',
         '#/ot?p=' || pend::text, 'Reminder'
  from bo.profiles p
  where p.active and p.role <> 'admin'
    and not exists (select 1 from bo.ot_forms f where f.staff_id = p.id and f.period_end = pend and f.status not in ('draft','rejected'));
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.trash_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare sid uuid;
begin
  select staff_id into sid from bo.expense_reports where id = old.report_id;
  insert into bo.trash (kind, row_id, staff_id, data, linked_receipts, deleted_by)
  values ('item', old.id, sid, to_jsonb(old),
          array(select r.id from bo.receipts r where r.item_id = old.id), auth.uid());
  return old;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.trash_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into bo.trash (kind, row_id, staff_id, data, deleted_by)
  values ('receipt', old.id, old.staff_id, to_jsonb(old), auth.uid());
  return old;
end $function$
;


CREATE OR REPLACE FUNCTION bo_private.unanswered_lines(p_report uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select count(*)::int from bo.expense_items i
  where i.report_id = p_report and coalesce(i.return_note, '') <> '' and i.returned_snapshot is not null
    and coalesce(trim(i.staff_reply), '') = ''
    and (
      i.amount::text <> i.returned_snapshot->>'amount'
      or (coalesce(i.purpose, '') = coalesce(i.returned_snapshot->>'purpose', '') and coalesce(i.item, '') = coalesce(i.returned_snapshot->>'item', '')
        and coalesce(i.category_id::text, '') = coalesce(i.returned_snapshot->>'category_id', '') and i.invoice_date::text = i.returned_snapshot->>'invoice_date')
    );
$function$
;


CREATE OR REPLACE FUNCTION bo.ask_about_day(p_staff uuid, p_day date, p_text text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid := auth.uid(); pend date; nm text; qid uuid;
begin
  if uid is null or not (bo_private.is_admin() or bo_private.is_hr()) then raise exception 'Only admin and HR can ask about a timesheet day'; end if;
  if p_staff = uid then raise exception 'This is your own timesheet'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Write a question first'; end if;
  pend := case when extract(day from p_day) > 25 then (date_trunc('month', p_day) + interval '1 month')::date + 24 else date_trunc('month', p_day)::date + 24 end;
  select full_name into nm from bo.profiles where id = uid;
  insert into bo.day_questions(staff_id, day, asked_by) values (p_staff, p_day, uid) returning id into qid;
  insert into bo.day_question_replies(question_id, author, body) values (qid, uid, left(trim(p_text), 1000));
  insert into bo.notifications(staff_id, body, link, created_by, created_by_name, thread_id)
  values (p_staff, nm || ' asked about ' || to_char(p_day, 'Dy DD Mon') || ': ' || left(trim(p_text), 300), '#/ot?p=' || pend::text || '&d=' || p_day::text, uid, nm, qid);
  return qid;
end $function$
;


CREATE OR REPLACE FUNCTION bo.ask_card_receipt(p_charge uuid, p_staff uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c bo.card_charges; nm text;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  select * into c from bo.card_charges where id = p_charge;
  if c.id is null then raise exception 'Charge not found'; end if;
  select full_name into nm from bo.profiles where id = auth.uid();
  update bo.card_charges set asked_staff = p_staff, asked_at = now() where id = p_charge;
  insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
  values (p_staff, nm || ' asks for a company card receipt: ' || c.description || ', ' || to_char(c.amount, 'FM999,999,990.00') || ' THB on ' || to_char(c.trans_date, 'DD Mon') || '. Snap it and choose Who paid: Company card.', '#/capture', auth.uid(), nm);
end $function$
;


CREATE OR REPLACE FUNCTION bo.assign_fa_refs(p_month date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare yymm text := to_char(p_month, 'YYMM'); nb int; nc int; r record;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  perform pg_advisory_xact_lock(hashtext('fa_refs' || yymm));
  select coalesce(max(bo_private.ref_number(substring(fa_ref from '^BILL' || yymm || '([A-Z]+)$'))), 0) into nb from bo.kbiz_payments where fa_ref like 'BILL' || yymm || '%';
  for r in
    select p.id from bo.kbiz_payments p
    join bo.kbiz_docs s on s.payment_id = p.id and s.kind = 'slip' and s.status = 'ready'
    where p.fa_ref is null and not p.admin_only and date_trunc('month', p.period_month) = date_trunc('month', p_month)
      and p.merchant is not null and (p.account_code is not null or p.category_id is not null)
      and exists (select 1 from bo.kbiz_docs b where b.payment_id = p.id and b.kind = 'bill' and b.status = 'ready')
    order by s.doc_date nulls last, p.created_at
  loop nb := nb + 1; update bo.kbiz_payments set fa_ref = 'BILL' || yymm || bo_private.ref_letters(nb) where id = r.id; end loop;
  select coalesce(max(bo_private.ref_number(substring(c.fa_ref from '^CARD' || yymm || '([A-Z]+)$'))), 0) into nc from bo.card_charges c where c.fa_ref like 'CARD' || yymm || '%';
  for r in
    select c.id from bo.card_charges c join bo.card_statements st on st.id = c.statement_id
    where c.fa_ref is null and date_trunc('month', st.period_month) = date_trunc('month', p_month)
      and c.item_id is null and (c.doc_path is not null or c.no_doc) and c.merchant is not null and (c.account_code is not null or c.category_id is not null)
    order by c.trans_date, c.id
  loop nc := nc + 1; update bo.card_charges set fa_ref = 'CARD' || yymm || bo_private.ref_letters(nc) where id = r.id; end loop;
end $function$
;


CREATE OR REPLACE FUNCTION bo.card_not_company(p_item uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i bo.expense_items; r bo.expense_reports; nm text;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  select * into i from bo.expense_items where id = p_item;
  select * into r from bo.expense_reports where id = i.report_id;
  if i.id is null then raise exception 'Not found'; end if;
  if r.status = 'paid' then raise exception 'That form is already paid. Sort it out with the staff member first'; end if;
  if exists (select 1 from bo.card_charges c where c.item_id = i.id) then raise exception 'This receipt is matched to a card line'; end if;
  update bo.expense_items set payment_method = 'own_money' where id = i.id;
  select full_name into nm from bo.profiles where id = auth.uid();
  insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
  values (r.staff_id, nm || ' changed your receipt ' || coalesce(nullif(i.merchant, ''), i.item) || ' (' || to_char(i.amount, 'FM999,999,990.00') || ' THB) to Who paid: Me. It is not on the company card statement, so it will be repaid to you. Tell ' || nm || ' if that is wrong.', '#/expenses?id=' || r.id, auth.uid(), nm);
end $function$
;


CREATE OR REPLACE FUNCTION bo.card_suggestions(p_statement uuid)
 RETURNS TABLE(charge_id uuid, item_id uuid, staff_name text, item_label text, paid_by text, report_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  return query
  select distinct on (c.id) c.id, i.id, p.full_name, coalesce(nullif(i.merchant, ''), i.item), i.payment_method, r.status
  from bo.card_charges c
  join bo.expense_items i on i.payment_method <> 'company_card'
    and abs(i.amount - c.amount) <= greatest(5, c.amount * 0.03)
    and abs(i.invoice_date - c.trans_date) <= 4
  join bo.expense_reports r on r.id = i.report_id
  join bo.profiles p on p.id = r.staff_id
  where c.statement_id = p_statement and c.item_id is null and c.doc_path is null and not c.no_doc
    and not exists (select 1 from bo.card_charges x where x.item_id = i.id)
    and r.status <> 'paid'
  order by c.id, abs(i.amount - c.amount), abs(i.invoice_date - c.trans_date);
end $function$
;


CREATE OR REPLACE FUNCTION bo.card_unmatched(p_statement uuid)
 RETURNS TABLE(item_id uuid, staff_name text, item_label text, purpose text, amount numeric, invoice_date date, report_ref text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m date;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  select period_month into m from bo.card_statements where id = p_statement;
  return query
  select i.id, p.full_name, coalesce(nullif(i.merchant, ''), i.item), i.purpose, i.amount, i.invoice_date, r.ref_no
  from bo.expense_items i
  join bo.expense_reports r on r.id = i.report_id
  join bo.profiles p on p.id = r.staff_id
  where i.payment_method = 'company_card'
    and i.invoice_date < (m + interval '1 month')::date
    and i.invoice_date >= (m - interval '2 months')::date
    and not exists (select 1 from bo.card_charges c where c.item_id = i.id)
    and r.status <> 'paid'
  order by i.invoice_date;
end $function$
;


CREATE OR REPLACE FUNCTION bo.confirm_card_match(p_charge uuid, p_item uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c bo.card_charges; i bo.expense_items; r bo.expense_reports; nm text;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  select * into c from bo.card_charges where id = p_charge;
  select * into i from bo.expense_items where id = p_item;
  select * into r from bo.expense_reports where id = i.report_id;
  if c.id is null or i.id is null then raise exception 'Not found'; end if;
  if c.item_id is not null then raise exception 'This card line is already matched'; end if;
  if r.status = 'paid' then raise exception 'That form is already paid. Sort it out with the staff member first'; end if;
  update bo.card_charges set item_id = i.id where id = c.id;
  if i.payment_method <> 'company_card' then
    update bo.expense_items set payment_method = 'company_card' where id = i.id;
    select full_name into nm from bo.profiles where id = auth.uid();
    insert into bo.notifications(staff_id, body, link, created_by, created_by_name)
    values (r.staff_id, nm || ' changed your receipt ' || coalesce(nullif(i.merchant, ''), i.item) || ' (' || to_char(i.amount, 'FM999,999,990.00') || ' THB) to Who paid: Company card. It was paid with the company card, so it is not repaid to you.', '#/expenses?id=' || r.id, auth.uid(), nm);
  end if;
end $function$
;


CREATE OR REPLACE FUNCTION bo.fa_new_vendors_added(p_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not bo_private.can_fa() then raise exception 'Not allowed'; end if;
  insert into bo.fa_vendors (label, name, contact_type, tax_id, branch)
    select name, name, business_type, tax_id, coalesce(branch, 'Head Office') from bo.fa_new_vendors where id = any(p_ids) on conflict do nothing;
  update bo.fa_new_vendors set exported_at = now() where id = any(p_ids);
end $function$
;


CREATE OR REPLACE FUNCTION bo.fa_replace_lists(p_vendors jsonb, p_projects jsonb, p_accounts jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not bo_private.can_fa() then raise exception 'Not allowed'; end if;
  delete from bo.fa_vendors where true; delete from bo.fa_projects where true; delete from bo.fa_accounts where true;
  insert into bo.fa_vendors select * from jsonb_to_recordset(p_vendors) as x(label text, name text, contact_type text, tax_id text, branch text) where label is not null on conflict do nothing;
  insert into bo.fa_projects select * from jsonb_to_recordset(p_projects) as x(name text) where name is not null on conflict do nothing;
  insert into bo.fa_accounts select * from jsonb_to_recordset(p_accounts) as x(code text, name text, kind text, label text) where code is not null on conflict do nothing;
  update bo.fa_meta set updated_at = now(), updated_by_name = (select full_name from bo.profiles where id = auth.uid()) where id = 1;
end $function$
;


CREATE OR REPLACE FUNCTION bo.find_duplicate_item(p_item uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select o.id
  from bo.expense_items me
  join bo.expense_reports rm on rm.id = me.report_id
  join bo.expense_items o on o.id <> me.id and o.invoice_date = me.invoice_date and o.amount = me.amount
  join bo.expense_reports ro on ro.id = o.report_id and ro.staff_id = rm.staff_id
  where me.id = p_item
  order by o.created_at
  limit 1
$function$
;


CREATE OR REPLACE FUNCTION bo.hr_cancel(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (bo_private.is_hr() or bo_private.is_admin()) then raise exception 'Not allowed'; end if;
  update bo.hr_requests set status = 'cancelled', decided_at = now() where id = p_id and status = 'pending';
end $function$
;


CREATE OR REPLACE FUNCTION bo.hr_decide(p_id bigint, p_agree boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r bo.hr_requests; k text; v jsonb; me text; summ text;
begin
  select * into r from bo.hr_requests where id = p_id for update;
  if r.id is null or r.staff_id <> auth.uid() then raise exception 'Not your request'; end if;
  if r.status <> 'pending' then raise exception 'Already decided'; end if;
  if p_agree then
    insert into bo.ot_settings (staff_id) values (r.staff_id) on conflict (staff_id) do nothing;
    for k, v in select * from jsonb_each(r.changes) loop
      if k not in ('pay_type','start_time','end_time','week_pattern','sat_off_anchor') then continue; end if;
      execute format('update bo.ot_settings set %I = ($1)::%s, updated_at = now() where staff_id = $2', k,
        case when k in ('start_time','end_time') then 'time' when k = 'sat_off_anchor' then 'date' else 'text' end) using (v #>> '{}'), r.staff_id;
    end loop;
  end if;
  update bo.hr_requests set status = case when p_agree then 'agreed' else 'declined' end, decided_at = now() where id = p_id;
  select full_name into me from bo.profiles where id = auth.uid();
  select string_agg(bo_private.settings_label(key, value #>> '{}'), ', ') into summ from jsonb_each(r.changes);
  insert into bo.notifications (staff_id, body, link, created_by, created_by_name)
    values (r.created_by, me || case when p_agree then ' agreed to: ' else ' declined: ' end || summ, '#/admin/ot', auth.uid(), me);
end $function$
;


CREATE OR REPLACE FUNCTION bo.hr_propose(p_staff uuid, p_changes jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare bad text; old jsonb; rid bigint; me text; summ text;
begin
  if not bo_private.is_hr() then raise exception 'Only HR can propose changes'; end if;
  if p_staff = auth.uid() then raise exception 'Change your own settings directly'; end if;
  select string_agg(x, ', ') into bad from jsonb_object_keys(p_changes) x where x not in ('pay_type','start_time','end_time','week_pattern','sat_off_anchor');
  if bad is not null then raise exception 'Not allowed: %', bad; end if;
  select to_jsonb(s) into old from bo.ot_settings s where staff_id = p_staff;
  select full_name into me from bo.profiles where id = auth.uid();
  select id into rid from bo.hr_requests where staff_id = p_staff and status = 'pending' limit 1;
  if rid is null then
    insert into bo.hr_requests (staff_id, changes, before, created_by_name) values (p_staff, p_changes, old, me) returning id into rid;
  else
    update bo.hr_requests set changes = changes || p_changes, created_at = now(), created_by = auth.uid(), created_by_name = me where id = rid;
  end if;
  select string_agg(bo_private.settings_label(key, value #>> '{}'), ', ') into summ from jsonb_each((select changes from bo.hr_requests where id = rid));
  insert into bo.notifications (staff_id, body, link, created_by, created_by_name)
    values (p_staff, me || ' (HR) wants to change your timesheet settings: ' || summ || '. Please agree or decline.', '#/agree', auth.uid(), me);
  return rid;
end $function$
;


CREATE OR REPLACE FUNCTION bo.mark_fa_line(p_item uuid, p_done boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rid uuid; st text;
begin
  select i.report_id, r.status::text into rid, st from bo.expense_items i join bo.expense_reports r on r.id = i.report_id where i.id = p_item;
  if not bo_private.is_data_entry() then raise exception 'Only data entry can mark lines entered in FlowAccount'; end if;
  if st not in ('approved', 'paid') then raise exception 'Only approved forms can be entered in FlowAccount'; end if;
  update bo.expense_items set fa_done = p_done where id = p_item;
  if p_done and not exists (select 1 from bo.expense_items where report_id = rid and not fa_done) then
    update bo.expense_reports set fa_entered_at = now() where id = rid and fa_entered_at is null;
  elsif not p_done then
    update bo.expense_reports set fa_entered_at = null where id = rid;
  end if;
end $function$
;


CREATE OR REPLACE FUNCTION bo.mark_seen(p_report uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r bo.expense_reports; last_sub timestamptz;
begin
  if not bo_private.is_approver_or_admin() then return; end if;
  select * into r from bo.expense_reports where id = p_report;
  if r.id is null or r.status <> 'submitted' or r.staff_id = auth.uid() then return; end if;
  select max(at) into last_sub from bo.report_events where report_id = p_report and action in ('Submitted', 'Resubmitted');
  if exists (select 1 from bo.report_events where report_id = p_report and action = 'Seen' and by_id = auth.uid() and at >= coalesce(last_sub, r.submitted_at, '-infinity')) then return; end if;
  insert into bo.report_events(report_id, by_id, by_name, action)
  values (p_report, auth.uid(), (select full_name from bo.profiles where id = auth.uid()), 'Seen');
end $function$
;


CREATE OR REPLACE FUNCTION bo.match_card_charges(p_statement uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c record; it uuid; n int := 0;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  for c in select * from bo.card_charges where statement_id = p_statement and item_id is null and doc_path is null order by amount desc loop
    select i.id into it from bo.expense_items i
      where i.payment_method = 'company_card'
        and not exists (select 1 from bo.card_charges x where x.item_id = i.id)
        and abs(i.amount - c.amount) <= greatest(5, c.amount * 0.03)
        and abs(i.invoice_date - c.trans_date) <= 4
      order by abs(i.amount - c.amount), abs(i.invoice_date - c.trans_date) limit 1;
    if it is not null then update bo.card_charges set item_id = it where id = c.id; n := n + 1; end if;
  end loop;
  return n;
end $function$
;


CREATE OR REPLACE FUNCTION bo.notify_subs_review(p_statement uuid, p_body text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare done timestamptz;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  select subs_notified_at into done from bo.card_statements where id = p_statement for update;
  if done is not null then return false; end if;
  insert into bo.notifications (staff_id, body, link, created_by, created_by_name)
    select p.id, left(p_body, 600), '#/subs', auth.uid(), 'Back office'
    from bo.profiles p where p.role = 'admin' and p.active;
  update bo.card_statements set subs_notified_at = now() where id = p_statement;
  return true;
end $function$
;


CREATE OR REPLACE FUNCTION bo.pair_kbiz()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; b record; n int := 0;
begin
  if not (bo_private.is_admin() or bo_private.is_data_entry()) then raise exception 'Not allowed'; end if;
  for s in
    select p.id as pid, d.amount, d.doc_date, d.party, p.admin_only
    from bo.kbiz_payments p join bo.kbiz_docs d on d.payment_id = p.id and d.kind = 'slip' and d.status = 'ready'
    where not exists (select 1 from bo.kbiz_docs x where x.payment_id = p.id and x.kind = 'bill')
  loop
    select p.id as pid, p.merchant, p.category_id, p.purpose, p.vat_amount, p.wht_rate, p.wht_on_top, d.id as did into b
    from bo.kbiz_payments p join bo.kbiz_docs d on d.payment_id = p.id and d.kind = 'bill' and d.status = 'ready'
    where p.admin_only = s.admin_only
      and not exists (select 1 from bo.kbiz_docs x where x.payment_id = p.id and x.kind = 'slip')
      and (abs(d.amount - s.amount) <= 1
        or abs(d.amount - coalesce(d.wht_amount, 0) - s.amount) <= 1
        or abs(d.amount - round((d.amount - coalesce(d.vat_amount, p.vat_amount, 0)) * coalesce(nullif(d.wht_rate, 0), nullif(p.wht_rate, 0), 0) / 100, 2) - s.amount) <= 1)
      and (d.doc_date is null or s.doc_date is null or abs(d.doc_date - s.doc_date) <= 45)
    order by (lower(split_part(coalesce(d.party, ''), ' ', 1)) <> '' and lower(coalesce(s.party, '')) like '%' || lower(split_part(coalesce(d.party, ''), ' ', 1)) || '%') desc,
             abs(coalesce(d.doc_date, s.doc_date) - coalesce(s.doc_date, d.doc_date))
    limit 1;
    if b.pid is not null then
      update bo.kbiz_docs set payment_id = s.pid where payment_id = b.pid;
      update bo.kbiz_payments t set merchant = coalesce(t.merchant, b.merchant), category_id = coalesce(t.category_id, b.category_id), purpose = coalesce(t.purpose, b.purpose),
        vat_amount = case when t.vat_amount = 0 then b.vat_amount else t.vat_amount end, wht_rate = case when t.wht_rate = 0 then b.wht_rate else t.wht_rate end,
        wht_on_top = t.wht_on_top or b.wht_on_top, no_doc = false where t.id = s.pid;
      delete from bo.kbiz_payments where id = b.pid;
      n := n + 1;
    end if;
    b := null;
  end loop;
  return n;
end $function$
;


CREATE OR REPLACE FUNCTION bo.pic_names()
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select distinct p.id, p.full_name from bo.profiles p join bo.project_pics pp on pp.staff_id = p.id where (select auth.uid()) is not null $function$
;


CREATE OR REPLACE FUNCTION bo.preview_project_ref(p_project uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select bo_private.next_project_ref(p_project) where (select auth.uid()) is not null $function$
;


CREATE OR REPLACE FUNCTION bo.reply_day_question(p_question uuid, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid := auth.uid(); q bo.day_questions; nm text; pend date; tgt uuid;
begin
  select * into q from bo.day_questions where id = p_question;
  if q.id is null then raise exception 'Question not found'; end if;
  if uid is null or not (uid = q.staff_id or uid = q.asked_by or bo_private.is_admin() or bo_private.is_hr()) then raise exception 'You are not part of this question'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Write a reply first'; end if;
  insert into bo.day_question_replies(question_id, author, body) values (q.id, uid, left(trim(p_text), 1000));
  select full_name into nm from bo.profiles where id = uid;
  pend := case when extract(day from q.day) > 25 then (date_trunc('month', q.day) + interval '1 month')::date + 24 else date_trunc('month', q.day)::date + 24 end;
  tgt := case when uid = q.staff_id then q.asked_by else q.staff_id end;
  insert into bo.notifications(staff_id, body, link, created_by, created_by_name, thread_id)
  values (tgt, nm || ' replied about ' || to_char(q.day, 'Dy DD Mon') || ': ' || left(trim(p_text), 300),
          '#/ot?p=' || pend::text || '&d=' || q.day::text || case when tgt = q.staff_id then '' else '&u=' || q.staff_id::text end, uid, nm, q.id);
end $function$
;


CREATE OR REPLACE FUNCTION bo.restore_deleted(p_row_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t record; n int := 0; d jsonb;
begin
  -- receipts first, then items, newest deletion of each row only
  for t in
    select distinct on (row_id) * from bo.trash
    where row_id = any(p_row_ids) and (staff_id = auth.uid() or bo_private.is_admin())
    order by row_id, deleted_at desc
  loop
    d := t.data;
    if t.kind = 'receipt' then
      if exists (select 1 from bo.receipts where id = t.row_id) then continue; end if;
      if d->>'item_id' is not null and not exists (select 1 from bo.expense_items where id = (d->>'item_id')::uuid) then
        d := d || '{"item_id": null}';
      end if;
      insert into bo.receipts select * from jsonb_populate_record(null::bo.receipts, d);
    end if;
  end loop;
  for t in
    select distinct on (row_id) * from bo.trash
    where row_id = any(p_row_ids) and kind = 'item' and (staff_id = auth.uid() or bo_private.is_admin())
    order by row_id, deleted_at desc
  loop
    if exists (select 1 from bo.expense_items where id = t.row_id) then continue; end if;
    insert into bo.expense_items select * from jsonb_populate_record(null::bo.expense_items, t.data);
    update bo.receipts set item_id = t.row_id where id = any(coalesce(t.linked_receipts, '{}')) and item_id is null;
    n := n + 1;
  end loop;
  delete from bo.trash where row_id = any(p_row_ids)
    and (exists (select 1 from bo.receipts r where r.id = trash.row_id) or exists (select 1 from bo.expense_items i where i.id = trash.row_id));
  get diagnostics n = row_count;
  return n;
end $function$
;


CREATE OR REPLACE FUNCTION bo.return_form(p_report uuid, p_reason text, p_notes jsonb DEFAULT '[]'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (bo_private.is_admin() or bo_private.can_check(p_report)) then raise exception 'You cannot return this form'; end if;
  update bo.expense_items set return_note = null, staff_reply = null, returned_snapshot = null where report_id = p_report;
  update bo.expense_items i set return_note = nullif(trim(n->>'note'), ''),
    returned_snapshot = jsonb_build_object('amount', i.amount, 'purpose', i.purpose, 'item', i.item, 'category_id', i.category_id, 'invoice_date', i.invoice_date)
    from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) n
    where i.report_id = p_report and i.id = (n->>'id')::uuid;
  update bo.expense_reports set status = 'rejected', rejection_reason = p_reason where id = p_report;
end $function$
;


CREATE OR REPLACE FUNCTION bo.roster_view(p_start date, p_end date)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with me as (select auth.uid() uid, bo_private.is_approver_or_admin() appr)
  select json_build_object(
    'people', (select coalesce(json_agg(json_build_object('id', id, 'full_name', full_name, 'staff_no', staff_no) order by staff_no), '[]') from bo.profiles where active and role <> 'admin'),
    'sets', (select coalesce(json_agg(json_build_object('staff_id', s.staff_id, 'start_time', s.start_time, 'end_time', s.end_time, 'lunch_hours', s.lunch_hours, 'week_pattern', s.week_pattern, 'sat_off_anchor', s.sat_off_anchor, 'pay_type', s.pay_type, 'dayoff_mult', 1, 'holiday_mult', 1)), '[]') from bo.ot_settings s),
    'ovs', (select coalesce(json_agg(t), '[]') from bo.ot_day_type t where day between p_start and p_end),
    'forms', (select coalesce(json_agg(json_build_object('id', f.id, 'staff_id', f.staff_id, 'status', case when f.staff_id = me.uid or me.appr then f.status else 'hidden' end)), '[]') from bo.ot_forms f, me where period_end = p_end),
    'ents', (select coalesce(json_agg(case when f.staff_id = me.uid or me.appr
               then json_build_object('id', e.id, 'form_id', e.form_id, 'work_date', e.work_date, 'start_time', e.start_time, 'end_time', e.end_time, 'day_type', e.day_type, 'hours', e.hours, 'counted', e.counted, 'leave_type', e.leave_type)
               else json_build_object('id', e.id, 'form_id', e.form_id, 'work_date', e.work_date, 'start_time', case when e.leave_type is null then '09:00' end, 'end_time', case when e.leave_type is null then '10:00' end, 'day_type', e.day_type, 'hours', case when e.leave_type is null then 1 else 0 end, 'counted', 0, 'leave_type', e.leave_type) end), '[]')
             from bo.ot_entries e join bo.ot_forms f on f.id = e.form_id, me where f.period_end = p_end)
  ) from me where me.uid is not null;
$function$
;


CREATE OR REPLACE FUNCTION bo.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$
;


CREATE OR REPLACE FUNCTION bo.suggest_personal_ref(p_month text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- BCMEXP + YYMM + letter, lettered across the company within the month (e.g. BCMEXP2611A)
  select 'BCMEXP' || substr(p_month, 3, 2) || substr(p_month, 6, 2) ||
    bo_private.ref_letters(coalesce(max(bo_private.ref_number(substring(ref_no from '^BCMEXP' || substr(p_month, 3, 2) || substr(p_month, 6, 2) || '([A-Z]+)$'))), 0) + 1)
  from bo.expense_reports
  where ref_no like 'BCMEXP' || substr(p_month, 3, 2) || substr(p_month, 6, 2) || '%'
$function$
;


CREATE OR REPLACE FUNCTION bo.suggest_report_ref(p_year integer)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'BCMEX' || p_year::text ||
         lpad((coalesce(max(nullif(substring(ref_no from '^BCMEX' || p_year::text || '([0-9]{2})'), '')::int), 0) + 1)::text, 2, '0')
         || 'A'
  from bo.expense_reports
  where ref_no like 'BCMEX' || p_year::text || '%'
$function$
;


-- Public views (pg_get_viewdef output). Table names inside are unqualified: run with search_path = bo.
-- Order matters: saved_days_balance must exist before time_off_balance.

create or replace view bo.expense_report_totals with (security_invoker = true) as
 SELECT r.id AS report_id,
    r.staff_id,
    r.ref_no,
    r.period_month,
    r.opening_advance,
    r.advance_topup,
    (COALESCE(sum(i.amount), (0)::numeric))::numeric(12,2) AS total_spent,
    (((r.opening_advance + r.advance_topup) - COALESCE(sum(i.amount) FILTER (WHERE (COALESCE(i.payment_method, 'own_money'::text) <> ALL (ARRAY['company_card'::text, 'kbiz'::text]))), (0)::numeric)))::numeric(12,2) AS balance,
    r.form_type,
    r.project
   FROM (expense_reports r
     LEFT JOIN expense_items i ON ((i.report_id = r.id)))
  GROUP BY r.id;

create or replace view bo.saved_days_balance with (security_invoker = true) as
 WITH s AS (
         SELECT o.staff_id,
            o.save_until
           FROM ot_offday o
          WHERE ((o.choice = 'save'::text) AND (EXISTS ( SELECT 1
                   FROM (ot_entries e
                     JOIN ot_forms f ON ((f.id = e.form_id)))
                  WHERE ((f.staff_id = o.staff_id) AND (e.work_date = o.day) AND (e.leave_type IS NULL) AND (f.status = ANY (ARRAY['approved'::text, 'paid'::text]))))))
        ), r AS (
         SELECT f.staff_id,
            count(*) AS n
           FROM (ot_entries e
             JOIN ot_forms f ON ((f.id = e.form_id)))
          WHERE (e.leave_type = 'replacement'::text)
          GROUP BY f.staff_id
        ), b AS (
         SELECT p.id AS staff_id,
            ( SELECT count(*) AS count
                   FROM s
                  WHERE (s.staff_id = p.id)) AS earned,
            ( SELECT count(*) AS count
                   FROM s
                  WHERE ((s.staff_id = p.id) AND (s.save_until < CURRENT_DATE))) AS expired,
            COALESCE(( SELECT r.n
                   FROM r
                  WHERE (r.staff_id = p.id)), (0)::bigint) AS repl,
            ( SELECT min(s.save_until) AS min
                   FROM s
                  WHERE ((s.staff_id = p.id) AND (s.save_until >= CURRENT_DATE))) AS next_expiry
           FROM profiles p
        )
 SELECT staff_id,
    earned,
    LEAST(repl, (earned - GREATEST((0)::bigint, (expired - LEAST(repl, earned))))) AS used,
    ((earned - LEAST(repl, (earned - GREATEST((0)::bigint, (expired - LEAST(repl, earned)))))) - GREATEST((0)::bigint, (expired - LEAST(repl, earned)))) AS days_left,
    (repl - LEAST(repl, (earned - GREATEST((0)::bigint, (expired - LEAST(repl, earned)))))) AS repl_from_hours,
    next_expiry
   FROM b;

create or replace view bo.time_off_balance with (security_invoker = true) as
 SELECT id AS staff_id,
    COALESCE(( SELECT sum(e.counted) AS sum
           FROM (ot_entries e
             JOIN ot_forms f ON ((f.id = e.form_id)))
          WHERE ((f.staff_id = p.id) AND (f.status = ANY (ARRAY['approved'::text, 'paid'::text])) AND (COALESCE(f.expiry_action, ''::text) <> 'paid'::text) AND (
                CASE
                    WHEN (f.expiry_action = 'extended'::text) THEN f.extended_until
                    ELSE ((f.period_end + '3 mons'::interval))::date
                END >= CURRENT_DATE))), (0)::numeric) AS earned,
    ((COALESCE(( SELECT sd.repl_from_hours
           FROM saved_days_balance sd
          WHERE (sd.staff_id = p.id)), (0)::bigint))::numeric * COALESCE(( SELECT ((EXTRACT(epoch FROM (s.end_time - s.start_time)) / 3600.0) - s.lunch_hours)
           FROM ot_settings s
          WHERE (s.staff_id = p.id)), (8)::numeric)) AS used,
    COALESCE(( SELECT ((EXTRACT(epoch FROM (s.end_time - s.start_time)) / 3600.0) - s.lunch_hours)
           FROM ot_settings s
          WHERE (s.staff_id = p.id)), (8)::numeric) AS day_hours
   FROM profiles p;

-- "set_updated_at()" and "handle_new_user()" are bo.set_updated_at / bo.handle_new_user.

-- ===== auth schema =====


-- ===== public tables =====
-- bump_rev on bo.card_charges (enabled, bo_private.bump_rev)
CREATE TRIGGER bump_rev BEFORE UPDATE ON bo.card_charges FOR EACH ROW EXECUTE FUNCTION bo_private.bump_rev();

-- item_match_supplier on bo.expense_items (enabled, bo_private.item_match_supplier)
CREATE TRIGGER item_match_supplier BEFORE INSERT OR UPDATE OF merchant ON bo.expense_items FOR EACH ROW EXECUTE FUNCTION bo_private.item_match_supplier();

-- trg_items_duplicate on bo.expense_items (enabled, bo_private.set_duplicate_flag)
CREATE TRIGGER trg_items_duplicate BEFORE INSERT OR UPDATE OF invoice_date, amount, merchant, receipt_time ON bo.expense_items FOR EACH ROW EXECUTE FUNCTION bo_private.set_duplicate_flag();

-- trg_items_updated on bo.expense_items (enabled, set_updated_at)
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON bo.expense_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- trg_trash_item on bo.expense_items (enabled, bo_private.trash_item)
CREATE TRIGGER trg_trash_item BEFORE DELETE ON bo.expense_items FOR EACH ROW EXECUTE FUNCTION bo_private.trash_item();

-- trg_guard_duplicates on bo.expense_reports (enabled, bo_private.guard_duplicates_on_submit)
CREATE TRIGGER trg_guard_duplicates BEFORE UPDATE OF status ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.guard_duplicates_on_submit();

-- trg_guard_report on bo.expense_reports (enabled, bo_private.guard_report_status)
CREATE TRIGGER trg_guard_report BEFORE UPDATE ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.guard_report_status();

-- trg_no_self_approval on bo.expense_reports (enabled, bo_private.no_self_approval)
CREATE TRIGGER trg_no_self_approval BEFORE UPDATE ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.no_self_approval();

-- trg_notify_status on bo.expense_reports (enabled, bo_private.notify_status)
CREATE TRIGGER trg_notify_status AFTER UPDATE OF status ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.notify_status();

-- trg_report_opening on bo.expense_reports (enabled, bo_private.set_opening_advance)
CREATE TRIGGER trg_report_opening BEFORE INSERT ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.set_opening_advance();

-- trg_report_project_ref on bo.expense_reports (enabled, bo_private.report_project_ref)
CREATE TRIGGER trg_report_project_ref BEFORE INSERT OR UPDATE OF project_id ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.report_project_ref();

-- trg_report_status_side on bo.expense_reports (enabled, bo_private.report_status_side)
CREATE TRIGGER trg_report_status_side AFTER UPDATE OF status ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.report_status_side();

-- trg_reports_updated on bo.expense_reports (enabled, set_updated_at)
CREATE TRIGGER trg_reports_updated BEFORE UPDATE ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- trg_set_approver_name on bo.expense_reports (enabled, bo_private.set_approver_name)
CREATE TRIGGER trg_set_approver_name BEFORE UPDATE ON bo.expense_reports FOR EACH ROW EXECUTE FUNCTION bo_private.set_approver_name();

-- new_vendor_rename on bo.fa_new_vendors (enabled, bo_private.new_vendor_rename)
CREATE TRIGGER new_vendor_rename AFTER UPDATE OF name ON bo.fa_new_vendors FOR EACH ROW EXECUTE FUNCTION bo_private.new_vendor_rename();

-- bump_payment_rev on bo.kbiz_docs (enabled, bo_private.bump_payment_rev)
CREATE TRIGGER bump_payment_rev AFTER INSERT OR DELETE OR UPDATE OF payment_id ON bo.kbiz_docs FOR EACH ROW EXECUTE FUNCTION bo_private.bump_payment_rev();

-- bump_rev on bo.kbiz_payments (enabled, bo_private.bump_rev)
CREATE TRIGGER bump_rev BEFORE UPDATE ON bo.kbiz_payments FOR EACH ROW EXECUTE FUNCTION bo_private.bump_rev();

-- notify_change on bo.ot_day_type (enabled, bo_private.notify_day_change)
CREATE TRIGGER notify_change AFTER INSERT OR DELETE OR UPDATE ON bo.ot_day_type FOR EACH ROW EXECUTE FUNCTION bo_private.notify_day_change();

-- trg_no_admin_daytype on bo.ot_day_type (enabled, bo_private.no_admin_timesheet)
CREATE TRIGGER trg_no_admin_daytype BEFORE INSERT ON bo.ot_day_type FOR EACH ROW EXECUTE FUNCTION bo_private.no_admin_timesheet();

-- trg_ot_day_type on bo.ot_day_type (enabled, bo_private.ot_day_type_changed)
CREATE TRIGGER trg_ot_day_type AFTER INSERT OR DELETE OR UPDATE ON bo.ot_day_type FOR EACH ROW EXECUTE FUNCTION bo_private.ot_day_type_changed();

-- notify_change on bo.ot_entries (enabled, bo_private.notify_day_change)
CREATE TRIGGER notify_change AFTER INSERT OR DELETE OR UPDATE ON bo.ot_entries FOR EACH ROW EXECUTE FUNCTION bo_private.notify_day_change();

-- ot_entry_note_only on bo.ot_entries (enabled, bo_private.ot_entry_note_only)
CREATE TRIGGER ot_entry_note_only BEFORE UPDATE ON bo.ot_entries FOR EACH ROW EXECUTE FUNCTION bo_private.ot_entry_note_only();

-- trg_ot_after on bo.ot_entries (enabled, bo_private.ot_after)
CREATE TRIGGER trg_ot_after AFTER INSERT OR DELETE OR UPDATE OF work_date, start_time, end_time, leave_type ON bo.ot_entries FOR EACH ROW EXECUTE FUNCTION bo_private.ot_after();

-- trg_ot_calc on bo.ot_entries (enabled, bo_private.ot_calc)
CREATE TRIGGER trg_ot_calc BEFORE INSERT OR UPDATE OF work_date, start_time, end_time, leave_type ON bo.ot_entries FOR EACH ROW EXECUTE FUNCTION bo_private.ot_calc();

-- trg_no_admin_timesheet on bo.ot_forms (enabled, bo_private.no_admin_timesheet)
CREATE TRIGGER trg_no_admin_timesheet BEFORE INSERT ON bo.ot_forms FOR EACH ROW EXECUTE FUNCTION bo_private.no_admin_timesheet();

-- trg_notify_status on bo.ot_forms (enabled, bo_private.notify_status)
CREATE TRIGGER trg_notify_status AFTER UPDATE OF status ON bo.ot_forms FOR EACH ROW EXECUTE FUNCTION bo_private.notify_status();

-- trg_ot_guard on bo.ot_forms (enabled, bo_private.ot_guard)
CREATE TRIGGER trg_ot_guard BEFORE UPDATE ON bo.ot_forms FOR EACH ROW EXECUTE FUNCTION bo_private.ot_guard();

-- trg_no_admin_offday on bo.ot_offday (enabled, bo_private.no_admin_timesheet)
CREATE TRIGGER trg_no_admin_offday BEFORE INSERT ON bo.ot_offday FOR EACH ROW EXECUTE FUNCTION bo_private.no_admin_timesheet();

-- trg_offday_before on bo.ot_offday (enabled, bo_private.ot_offday_before)
CREATE TRIGGER trg_offday_before BEFORE INSERT OR UPDATE ON bo.ot_offday FOR EACH ROW EXECUTE FUNCTION bo_private.ot_offday_before();

-- trg_offday_changed on bo.ot_offday (enabled, bo_private.ot_day_type_changed)
CREATE TRIGGER trg_offday_changed AFTER INSERT OR DELETE OR UPDATE ON bo.ot_offday FOR EACH ROW EXECUTE FUNCTION bo_private.ot_day_type_changed();

-- ot_settings_notify on bo.ot_settings (enabled, bo_private.notify_settings_change)
CREATE TRIGGER ot_settings_notify AFTER INSERT OR UPDATE ON bo.ot_settings FOR EACH ROW EXECUTE FUNCTION bo_private.notify_settings_change();

-- trg_guard_profile on bo.profiles (enabled, bo_private.guard_profile_admin_fields)
CREATE TRIGGER trg_guard_profile BEFORE UPDATE ON bo.profiles FOR EACH ROW EXECUTE FUNCTION bo_private.guard_profile_admin_fields();

-- trg_profiles_updated on bo.profiles (enabled, set_updated_at)
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON bo.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- pics_notify on bo.project_pics (enabled, bo_private.notify_pic)
CREATE TRIGGER pics_notify AFTER INSERT OR DELETE ON bo.project_pics FOR EACH ROW EXECUTE FUNCTION bo_private.notify_pic();

-- trg_project_after on bo.projects (enabled, bo_private.project_after)
CREATE TRIGGER trg_project_after AFTER INSERT OR UPDATE ON bo.projects FOR EACH ROW EXECUTE FUNCTION bo_private.project_after();

-- trg_project_before on bo.projects (enabled, bo_private.project_before)
CREATE TRIGGER trg_project_before BEFORE INSERT OR UPDATE ON bo.projects FOR EACH ROW EXECUTE FUNCTION bo_private.project_before();

-- trg_trash_receipt on bo.receipts (enabled, bo_private.trash_receipt)
CREATE TRIGGER trg_trash_receipt BEFORE DELETE ON bo.receipts FOR EACH ROW EXECUTE FUNCTION bo_private.trash_receipt();

-- trg_bank_updated on bo.staff_bank_details (enabled, set_updated_at)
CREATE TRIGGER trg_bank_updated BEFORE UPDATE ON bo.staff_bank_details FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS policies from pg_policies, full qual / with_check text.
-- 87 on public tables + 5 on storage.objects = 92. Unqualified table names: run with search_path = bo.

create policy "card charges: data entry or admin" on bo.card_charges as PERMISSIVE for ALL to public
  using ((bo_private.is_admin() OR bo_private.is_data_entry()))
  with check ((bo_private.is_admin() OR bo_private.is_data_entry()));

create policy "card statements: data entry or admin" on bo.card_statements as PERMISSIVE for ALL to public
  using ((bo_private.is_admin() OR bo_private.is_data_entry()))
  with check ((bo_private.is_admin() OR bo_private.is_data_entry()));

create policy "dqr: read" on bo.day_question_replies as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM day_questions q
  WHERE ((q.id = day_question_replies.question_id) AND ((q.staff_id = ( SELECT auth.uid() AS uid)) OR (q.asked_by = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin() OR bo_private.is_hr())))));

create policy "dq: read" on bo.day_questions as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR (asked_by = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin() OR bo_private.is_hr()));

create policy "categories: admin delete" on bo.expense_categories as PERMISSIVE for DELETE to authenticated
  using (bo_private.is_admin());

create policy "categories: admin insert" on bo.expense_categories as PERMISSIVE for INSERT to authenticated
  with check (bo_private.is_admin());

create policy "categories: admin update" on bo.expense_categories as PERMISSIVE for UPDATE to authenticated
  using (bo_private.is_admin())
  with check (bo_private.is_admin());

create policy "categories: approver insert" on bo.expense_categories as PERMISSIVE for INSERT to authenticated
  with check (bo_private.is_approver_or_admin());

create policy "categories: approver update" on bo.expense_categories as PERMISSIVE for UPDATE to authenticated
  using ((bo_private.is_approver_or_admin() OR bo_private.is_data_entry()))
  with check ((bo_private.is_approver_or_admin() OR bo_private.is_data_entry()));

create policy "categories: read" on bo.expense_categories as PERMISSIVE for SELECT to authenticated
  using (true);

create policy "items: owner adds to editable report" on bo.expense_items as PERMISSIVE for INSERT to authenticated
  with check (bo_private.can_edit_report(report_id));

create policy "items: owner deletes on editable report" on bo.expense_items as PERMISSIVE for DELETE to authenticated
  using (bo_private.can_edit_report(report_id));

create policy "items: owner edits on editable report" on bo.expense_items as PERMISSIVE for UPDATE to authenticated
  using (bo_private.can_edit_report(report_id))
  with check (bo_private.can_edit_report(report_id));

create policy "items: read if can view report" on bo.expense_items as PERMISSIVE for SELECT to authenticated
  using (bo_private.can_view_report(report_id));

create policy "reports: create own draft" on bo.expense_reports as PERMISSIVE for INSERT to authenticated
  with check (((staff_id = ( SELECT auth.uid() AS uid)) AND (status = 'draft'::report_status)));

create policy "reports: owner deletes draft" on bo.expense_reports as PERMISSIVE for DELETE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) AND (status = 'draft'::report_status)));

create policy "reports: owner edits draft/rejected" on bo.expense_reports as PERMISSIVE for UPDATE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['draft'::report_status, 'rejected'::report_status]))))
  with check (((staff_id = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['draft'::report_status, 'rejected'::report_status, 'submitted'::report_status]))));

create policy "reports: read if allowed" on bo.expense_reports as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.can_view_report(id)));

create policy "reports: reviewers update" on bo.expense_reports as PERMISSIVE for UPDATE to public
  using ((bo_private.can_view_report(id) AND (bo_private.is_approver_or_admin() OR (checker_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_pic(project_id) OR bo_private.is_accountant() OR bo_private.is_data_entry())))
  with check (bo_private.can_view_report(id));

create policy "fa accounts read" on bo.fa_accounts as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "fa accounts write" on bo.fa_accounts as PERMISSIVE for ALL to public
  using (bo_private.can_fa())
  with check (bo_private.can_fa());

create policy "fa meta read" on bo.fa_meta as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "fa meta write" on bo.fa_meta as PERMISSIVE for UPDATE to public
  using (bo_private.can_fa())
  with check (bo_private.can_fa());

create policy "new vendors add" on bo.fa_new_vendors as PERMISSIVE for INSERT to public
  with check (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (created_by = ( SELECT auth.uid() AS uid))));

create policy "new vendors fix" on bo.fa_new_vendors as PERMISSIVE for UPDATE to public
  using ((bo_private.can_fa() OR ((created_by = ( SELECT auth.uid() AS uid)) AND (exported_at IS NULL))));

create policy "new vendors read" on bo.fa_new_vendors as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "new vendors remove" on bo.fa_new_vendors as PERMISSIVE for DELETE to public
  using ((bo_private.can_fa() AND (exported_at IS NULL)));

create policy "fa projects read" on bo.fa_projects as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "fa projects write" on bo.fa_projects as PERMISSIVE for ALL to public
  using (bo_private.can_fa())
  with check (bo_private.can_fa());

create policy "fa vendors read" on bo.fa_vendors as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "fa vendors write" on bo.fa_vendors as PERMISSIVE for ALL to public
  using (bo_private.can_fa())
  with check (bo_private.can_fa());

create policy "hm read" on bo.holiday_meta as PERMISSIVE for SELECT to authenticated
  using (true);

create policy "hs read" on bo.holiday_suggestions as PERMISSIVE for SELECT to authenticated
  using (true);

create policy "hs write" on bo.holiday_suggestions as PERMISSIVE for ALL to authenticated
  using ((bo_private.is_admin() OR bo_private.is_hr()))
  with check ((bo_private.is_admin() OR bo_private.is_hr()));

create policy "holidays: all read" on bo.holidays as PERMISSIVE for SELECT to authenticated
  using (true);

create policy "holidays: hr or admin write" on bo.holidays as PERMISSIVE for ALL to public
  using ((bo_private.is_admin() OR bo_private.is_hr()))
  with check ((bo_private.is_admin() OR bo_private.is_hr()));

create policy "hr requests: read" on bo.hr_requests as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_hr() OR bo_private.is_admin()));

create policy "kbiz docs: admin" on bo.kbiz_docs as PERMISSIVE for ALL to public
  using (bo_private.is_admin())
  with check (bo_private.is_admin());

create policy "kbiz docs: data entry, not admin-only" on bo.kbiz_docs as PERMISSIVE for ALL to public
  using ((bo_private.is_data_entry() AND (NOT admin_only)))
  with check ((bo_private.is_data_entry() AND (NOT admin_only)));

create policy "kbiz payments: admin" on bo.kbiz_payments as PERMISSIVE for ALL to public
  using (bo_private.is_admin())
  with check (bo_private.is_admin());

create policy "kbiz payments: data entry, not admin-only" on bo.kbiz_payments as PERMISSIVE for ALL to public
  using ((bo_private.is_data_entry() AND (NOT admin_only)))
  with check ((bo_private.is_data_entry() AND (NOT admin_only)));

create policy "notif: mark own read" on bo.notifications as PERMISSIVE for UPDATE to public
  using ((staff_id = ( SELECT auth.uid() AS uid)))
  with check ((staff_id = ( SELECT auth.uid() AS uid)));

create policy "notif: read own" on bo.notifications as PERMISSIVE for SELECT to public
  using ((staff_id = ( SELECT auth.uid() AS uid)));

create policy "day type: accountant read" on bo.ot_day_type as PERMISSIVE for SELECT to public
  using ((bo_private.is_accountant() OR (bo_private.is_data_entry() AND bo_private.is_freelancer(staff_id))));

create policy "day type: hr read" on bo.ot_day_type as PERMISSIVE for SELECT to public
  using (bo_private.is_hr());

create policy "day type: own or admin read" on bo.ot_day_type as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "day type: own write" on bo.ot_day_type as PERMISSIVE for ALL to public
  using ((staff_id = ( SELECT auth.uid() AS uid)))
  with check ((staff_id = ( SELECT auth.uid() AS uid)));

create policy "ot entries: accountant / data entry (freelance) read" on bo.ot_entries as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM ot_forms f
  WHERE ((f.id = ot_entries.form_id) AND (bo_private.is_accountant() OR (bo_private.is_data_entry() AND bo_private.is_freelancer(f.staff_id)))))));

create policy "ot entries: hr or admin notes" on bo.ot_entries as PERMISSIVE for UPDATE to public
  using ((bo_private.is_admin() OR bo_private.is_hr()));

create policy "ot entries: hr read" on bo.ot_entries as PERMISSIVE for SELECT to public
  using (bo_private.is_hr());

create policy "ot entries: owner writes draft" on bo.ot_entries as PERMISSIVE for ALL to authenticated
  using ((EXISTS ( SELECT 1
   FROM ot_forms f
  WHERE ((f.id = ot_entries.form_id) AND (f.staff_id = ( SELECT auth.uid() AS uid)) AND (f.status = ANY (ARRAY['draft'::text, 'rejected'::text]))))))
  with check ((EXISTS ( SELECT 1
   FROM ot_forms f
  WHERE ((f.id = ot_entries.form_id) AND (f.staff_id = ( SELECT auth.uid() AS uid)) AND (f.status = ANY (ARRAY['draft'::text, 'rejected'::text]))))));

create policy "ot entries: read" on bo.ot_entries as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM ot_forms f
  WHERE ((f.id = ot_entries.form_id) AND ((f.staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin())))));

create policy "ot forms: accountant / data entry (freelance) read" on bo.ot_forms as PERMISSIVE for SELECT to public
  using ((bo_private.is_accountant() OR (bo_private.is_data_entry() AND bo_private.is_freelancer(staff_id))));

create policy "ot forms: create own" on bo.ot_forms as PERMISSIVE for INSERT to authenticated
  with check ((staff_id = ( SELECT auth.uid() AS uid)));

create policy "ot forms: hr or admin update" on bo.ot_forms as PERMISSIVE for UPDATE to public
  using ((bo_private.is_admin() OR bo_private.is_hr()));

create policy "ot forms: hr read" on bo.ot_forms as PERMISSIVE for SELECT to public
  using (bo_private.is_hr());

create policy "ot forms: owner deletes draft" on bo.ot_forms as PERMISSIVE for DELETE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) AND (status = 'draft'::text)));

create policy "ot forms: owner edits draft" on bo.ot_forms as PERMISSIVE for UPDATE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['draft'::text, 'rejected'::text]))));

create policy "ot forms: read own or admin" on bo.ot_forms as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "offday: accountant read" on bo.ot_offday as PERMISSIVE for SELECT to public
  using (bo_private.is_accountant());

create policy "offday: hr read" on bo.ot_offday as PERMISSIVE for SELECT to public
  using (bo_private.is_hr());

create policy "offday: own or admin read" on bo.ot_offday as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "offday: own write" on bo.ot_offday as PERMISSIVE for ALL to public
  using ((staff_id = ( SELECT auth.uid() AS uid)))
  with check ((staff_id = ( SELECT auth.uid() AS uid)));

create policy "ot settings: accountant / data entry (freelance) read" on bo.ot_settings as PERMISSIVE for SELECT to public
  using ((bo_private.is_accountant() OR (bo_private.is_data_entry() AND (pay_type = 'freelance'::text))));

create policy "ot settings: admin or hr own write" on bo.ot_settings as PERMISSIVE for ALL to public
  using ((bo_private.is_admin() OR (bo_private.is_hr() AND (staff_id = ( SELECT auth.uid() AS uid)))))
  with check ((bo_private.is_admin() OR (bo_private.is_hr() AND (staff_id = ( SELECT auth.uid() AS uid)))));

create policy "ot settings: hr read" on bo.ot_settings as PERMISSIVE for SELECT to public
  using (bo_private.is_hr());

create policy "ot settings: own or admin read" on bo.ot_settings as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "profiles: admins update" on bo.profiles as PERMISSIVE for UPDATE to authenticated
  using (bo_private.is_admin())
  with check (bo_private.is_admin());

create policy "profiles: read own, reviewers read all" on bo.profiles as PERMISSIVE for SELECT to public
  using (((id = ( SELECT auth.uid() AS uid)) OR bo_private.is_approver_or_admin() OR bo_private.is_accountant() OR bo_private.is_data_entry() OR bo_private.is_any_pic()));

create policy "profiles: self update names" on bo.profiles as PERMISSIVE for UPDATE to authenticated
  using ((id = ( SELECT auth.uid() AS uid)))
  with check ((id = ( SELECT auth.uid() AS uid)));

create policy "pics: admin or approver writes" on bo.project_pics as PERMISSIVE for ALL to public
  using (bo_private.is_approver_or_admin())
  with check (bo_private.is_approver_or_admin());

create policy "pics: everyone reads" on bo.project_pics as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "projects: admin writes" on bo.projects as PERMISSIVE for ALL to public
  using (bo_private.is_admin())
  with check (bo_private.is_admin());

create policy "projects: anyone adds" on bo.projects as PERMISSIVE for INSERT to public
  with check ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "projects: everyone reads" on bo.projects as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy "receipts: add own" on bo.receipts as PERMISSIVE for INSERT to authenticated
  with check (((staff_id = ( SELECT auth.uid() AS uid)) AND ((report_id IS NULL) OR (EXISTS ( SELECT 1
   FROM expense_reports r
  WHERE ((r.id = receipts.report_id) AND (r.staff_id = ( SELECT auth.uid() AS uid)))))) AND ((item_id IS NULL) OR bo_private.can_edit_report(( SELECT i.report_id
   FROM expense_items i
  WHERE (i.id = receipts.item_id))))));

create policy "receipts: delete own while editable" on bo.receipts as PERMISSIVE for DELETE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) AND ((item_id IS NULL) OR bo_private.can_edit_report(( SELECT i.report_id
   FROM expense_items i
  WHERE (i.id = receipts.item_id))))));

create policy "receipts: edit own while editable" on bo.receipts as PERMISSIVE for UPDATE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) AND ((item_id IS NULL) OR bo_private.can_edit_report(( SELECT i.report_id
   FROM expense_items i
  WHERE (i.id = receipts.item_id))))))
  with check (((staff_id = ( SELECT auth.uid() AS uid)) AND ((item_id IS NULL) OR bo_private.can_edit_report(( SELECT i.report_id
   FROM expense_items i
  WHERE (i.id = receipts.item_id))))));

create policy "receipts: read if allowed" on bo.receipts as PERMISSIVE for SELECT to public
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin() OR ((report_id IS NOT NULL) AND bo_private.can_view_report(report_id)) OR ((item_id IS NOT NULL) AND bo_private.can_view_report(( SELECT i.report_id
   FROM expense_items i
  WHERE (i.id = receipts.item_id))))));

create policy "events: read if allowed" on bo.report_events as PERMISSIVE for SELECT to public
  using (bo_private.can_view_report(report_id));

create policy "notes: approvers only" on bo.report_notes as PERMISSIVE for ALL to authenticated
  using (bo_private.is_approver_or_admin())
  with check (bo_private.is_approver_or_admin());

create policy "bank: own insert" on bo.staff_bank_details as PERMISSIVE for INSERT to authenticated
  with check (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "bank: own or admin read" on bo.staff_bank_details as PERMISSIVE for SELECT to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "bank: own or admin update" on bo.staff_bank_details as PERMISSIVE for UPDATE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()))
  with check (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy subs_rw on bo.subscriptions as PERMISSIVE for ALL to authenticated
  using ((bo_private.is_admin() OR bo_private.is_data_entry()))
  with check ((bo_private.is_admin() OR bo_private.is_data_entry()));

create policy "trash: own or admin delete" on bo.trash as PERMISSIVE for DELETE to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "trash: own or admin read" on bo.trash as PERMISSIVE for SELECT to authenticated
  using (((staff_id = ( SELECT auth.uid() AS uid)) OR bo_private.is_admin()));

create policy "card files: data entry or admin read" on storage.objects as PERMISSIVE for SELECT to public
  using (((bucket_id = 'bo-receipts'::text) AND (bo_private.is_admin() OR bo_private.is_data_entry()) AND ((EXISTS ( SELECT 1
   FROM card_statements s
  WHERE (s.file_path = objects.name))) OR (EXISTS ( SELECT 1
   FROM card_charges c
  WHERE (c.doc_path = objects.name))) OR (EXISTS ( SELECT 1
   FROM (receipts r
     JOIN card_charges c ON ((c.item_id = r.item_id)))
  WHERE (r.storage_path = objects.name))))));

create policy "kbiz files: data entry or admin read" on storage.objects as PERMISSIVE for SELECT to public
  using (((bucket_id = 'bo-receipts'::text) AND (EXISTS ( SELECT 1
   FROM kbiz_docs d
  WHERE ((d.file_path = objects.name) AND (bo_private.is_admin() OR (bo_private.is_data_entry() AND (NOT d.admin_only))))))));

create policy "receipt files: owner delete" on storage.objects as PERMISSIVE for DELETE to public
  using (((bucket_id = 'bo-receipts'::text) AND (((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR (EXISTS ( SELECT 1
   FROM receipts r
  WHERE ((r.storage_path = objects.name) AND (r.staff_id = ( SELECT auth.uid() AS uid))))))));

create policy "receipt files: owner upload" on storage.objects as PERMISSIVE for INSERT to authenticated
  with check (((bucket_id = 'bo-receipts'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

create policy "receipt files: read if allowed" on storage.objects as PERMISSIVE for SELECT to public
  using (((bucket_id = 'bo-receipts'::text) AND (((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR bo_private.is_admin() OR (EXISTS ( SELECT 1
   FROM receipts r
  WHERE ((r.storage_path = objects.name) AND ((r.staff_id = ( SELECT auth.uid() AS uid)) OR ((r.report_id IS NOT NULL) AND bo_private.can_view_report(r.report_id)) OR ((r.item_id IS NOT NULL) AND bo_private.can_view_report(( SELECT i.report_id
           FROM expense_items i
          WHERE (i.id = r.item_id)))))))) OR (EXISTS ( SELECT 1
   FROM expense_reports e
  WHERE ((e.paid_slip_path = objects.name) AND bo_private.can_view_report(e.id)))))));
-- ===== BCM overrides =====
-- Sync bo.profiles from Bloom staff + Roles and access (module backoffice) + finance jobs
create or replace function bo_private.sync_profiles()
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform set_config('bo.syncing', '1', true);
  insert into bo.profiles (id, email, full_name, role, active, staff_no, is_accountant, is_data_entry, is_hr)
  select s.auth_user_id, coalesce(u.email, ''), coalesce(s.name, ''),
    case when lv = 'full' then 'admin'::bo.app_role else 'staff'::bo.app_role end,
    s.status = 'active' and lv <> 'none',
    s.staff_id_code,
    exists (select 1 from bo.jobs j where j.staff_id = s.id and j.job = 'accountant'),
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
end $$;

create or replace function bo_private.sync_profiles_trg()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  begin perform bo_private.sync_profiles(); exception when others then raise warning 'back office sync failed: %', sqlerrm; end;
  return null;
end $$;

create trigger bo_sync after insert or update or delete on public.staff for each statement execute function bo_private.sync_profiles_trg();
create trigger bo_sync after insert or update or delete on public.staff_permission_overrides for each statement execute function bo_private.sync_profiles_trg();
create trigger bo_sync after insert or update or delete on public.role_permissions for each statement execute function bo_private.sync_profiles_trg();
create trigger bo_sync after insert or update or delete on bo.jobs for each statement execute function bo_private.sync_profiles_trg();

-- Access fields come from Bloom; only the sync changes them. Names come from Bloom too.
create or replace function bo_private.guard_profile_admin_fields()
 returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if current_setting('bo.syncing', true) = '1' or auth.uid() is null then return new; end if;
  if new.role is distinct from old.role or new.active is distinct from old.active or new.staff_no is distinct from old.staff_no
      or new.email is distinct from old.email or new.is_accountant is distinct from old.is_accountant or new.is_data_entry is distinct from old.is_data_entry
      or new.is_hr is distinct from old.is_hr or new.full_name is distinct from old.full_name then
    raise exception 'Names and access are set in the staff system (Staff and Admin > Roles and access)';
  end if;
  if new.signature is distinct from old.signature and new.id <> auth.uid() then
    raise exception 'Only the person themselves can change their signature';
  end if;
  return new;
end $function$;

-- Jobs: everyone signed in reads (to show who does what); only admins change
create policy "jobs read" on bo.jobs for select to authenticated using (true);
create policy "jobs admin write" on bo.jobs for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Step 1 is done by the person the sender picked (checker_id); nobody checks their own form
create or replace function bo_private.can_check(rid uuid)
 returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (select 1 from bo.expense_reports r where r.id = rid and r.staff_id <> (select auth.uid()) and r.checker_id = (select auth.uid())) $function$;

create or replace function bo_private.has_other_checker(rid uuid)
 returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (select 1 from bo.expense_reports r join bo.profiles p on p.id = r.checker_id
    where r.id = rid and r.checker_id <> r.staff_id and p.active) $function$;

create or replace function bo_private.can_view_report(rid uuid)
 returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (
    select 1 from bo.expense_reports r
    where r.id = rid and (
      r.staff_id = (select auth.uid())
      or r.checker_id = (select auth.uid())
      or bo_private.is_admin() or bo_private.is_accountant()
      or (r.form_type = 'project' and bo_private.is_pic(r.project_id))
      or (bo_private.is_data_entry() and r.status in ('approved', 'paid'))
    )
  ) $function$;

-- Checkers may read the names of colleagues (picker list) - everyone signed in may list active people
create policy "profiles: everyone reads active names" on bo.profiles for select to authenticated using (active);

create or replace function bo_private.checker_name()
 returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.checker_id is distinct from old.checker_id or tg_op = 'INSERT' then
    if new.checker_id = new.staff_id then raise exception 'Pick someone else to check your form'; end if;
    new.checker_name := (select full_name from bo.profiles where id = new.checker_id);
  end if;
  if tg_op = 'UPDATE' and new.checker_id is distinct from old.checker_id and old.status not in ('draft', 'rejected') and not bo_private.is_admin() then
    raise exception 'The checker can only be changed before the form is submitted';
  end if;
  return new;
end $function$;
create trigger trg_checker_name before insert or update of checker_id on bo.expense_reports for each row execute function bo_private.checker_name();

create or replace function bo.mark_seen(p_report uuid)
 returns void language plpgsql security definer set search_path to '' as $function$
declare r bo.expense_reports; last_sub timestamptz;
begin
  select * into r from bo.expense_reports where id = p_report;
  if r.id is null or r.status <> 'submitted' or r.staff_id = auth.uid() then return; end if;
  if not (bo_private.is_admin() or r.checker_id = auth.uid()) then return; end if;
  select max(at) into last_sub from bo.report_events where report_id = p_report and action in ('Submitted', 'Resubmitted');
  if exists (select 1 from bo.report_events where report_id = p_report and action = 'Seen' and by_id = auth.uid() and at >= coalesce(last_sub, r.submitted_at, '-infinity')) then return; end if;
  insert into bo.report_events(report_id, by_id, by_name, action)
  values (p_report, auth.uid(), (select full_name from bo.profiles where id = auth.uid()), 'Seen');
end $function$;
-- ===== grants =====
grant usage on schema bo to authenticated, service_role;
grant usage on schema bo_private to authenticated, service_role;
grant select, insert, update, delete on all tables in schema bo to authenticated, service_role;
grant usage, select on all sequences in schema bo to authenticated, service_role;
grant execute on all functions in schema bo to authenticated, service_role;
grant execute on all functions in schema bo_private to authenticated, service_role;
revoke execute on all functions in schema bo from anon, public;
alter default privileges in schema bo grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema bo grant execute on functions to authenticated, service_role;

-- ===== storage =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bo-receipts', 'bo-receipts', false, 10485760, '{image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf}'::text[])
on conflict (id) do nothing;

-- ===== cron (timesheet reminder waits for stage 2) =====
select cron.schedule('bo-empty-trash-30d', '15 20 * * *', 'delete from bo.trash where deleted_at < now() - interval ''30 days''');

-- ===== Roles and access: Back office defaults (admin, director = full; everyone else = edit) =====
insert into public.role_permissions (role, module, level, requires_approval)
select r.role, 'backoffice', case when r.role in ('admin', 'director') then 'full' else 'edit' end::public.permission_level, false
from (select distinct role from public.role_permissions) r
on conflict do nothing;

-- ===== finance jobs: Casy = data entry =====
insert into bo.jobs (staff_id, job) select id, 'data_entry' from public.staff where staff_id_code = 'BMSSTF03' on conflict do nothing;

-- ===== starter categories (admin edits in Settings > Categories) =====
insert into bo.expense_categories (name, sort_order) values
 ('Teaching supplies',1),('Office supplies',2),('Travel and transport',3),('Food and drinks',4),('Repairs and maintenance',5),
 ('Utilities',6),('Marketing and events',7),('Software and subscriptions',8),('Cleaning and household',9),('Other',10);

select bo_private.sync_profiles();
-- S23: only people with back office access (an active bo.profiles row) may touch bo. Families and staff with Back office: None are kept out.
create or replace function bo_private.is_member() returns boolean language sql stable security definer set search_path to '' as
$$ select exists (select 1 from bo.profiles where id = (select auth.uid()) and active) $$;
grant execute on function bo_private.is_member() to authenticated, service_role;
do $do$ declare t record; f record; src text; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'bo' and c.relkind = 'r' loop
    execute format('drop policy if exists "back office members only" on bo.%I', t.relname);
    execute format('create policy "back office members only" on bo.%I as restrictive for all to authenticated using (bo_private.is_member()) with check (bo_private.is_member())', t.relname);
  end loop;
  -- plpgsql RPCs: refuse at the start
  for f in select p.oid, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
           where n.nspname = 'bo' and l.lanname = 'plpgsql' and p.prosecdef loop
    if position('bo_private.is_member()' in f.prosrc) = 0 then
      src := regexp_replace(pg_get_functiondef(f.oid), '\$function\$(\s*declare.*?)?\s*begin', '$function$\1
begin
  if not bo_private.is_member() then raise exception ''No back office access''; end if;', 'si');
      execute src;
    end if;
  end loop;
  -- sql RPCs: return nothing to non-members
  for f in select p.oid, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
           where n.nspname = 'bo' and l.lanname = 'sql' and p.prosecdef loop
    if position('bo_private.is_member()' in f.prosrc) = 0 then
      src := replace(pg_get_functiondef(f.oid), f.prosrc, E'\nselect * from (\n' || regexp_replace(f.prosrc, ';\s*$', '') || E'\n) q where bo_private.is_member()\n');
      execute src;
    end if;
  end loop;
end $do$;
drop policy if exists "bo receipts: members only" on storage.objects;
create policy "bo receipts: members only" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'bo-receipts' or bo_private.is_member()) with check (bucket_id <> 'bo-receipts' or bo_private.is_member());
create policy "reset requests: none" on bo.reset_requests for select to authenticated using (false);
alter function bo_private.no_self_approval() set search_path to '';
alter function bo_private.norm_name(text) set search_path to '';
select (select count(*) from pg_policies where schemaname='bo' and policyname='back office members only') restrictive_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bo' and p.prosecdef and position('is_member' in p.prosrc)>0) gated_fns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bo' and p.prosecdef) all_definer_fns;
