-- Withholding tax on a staff line: deducted from the supplier (false) or paid on top by the company (true).
alter table bo.expense_items add column if not exists wht_on_top boolean;
