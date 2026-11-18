-- Speed: role checks in row rules (bo_private.is_admin() and the like) take no row values, so they are
-- asked once per query instead of once per row. The rules themselves do not change. Same as IGA (19 Nov).
do $$
declare p record; q text; c text; re text := '(?<!SELECT )bo_private\.([a-z_]+)\(\)'; rep text := '(SELECT bo_private.\1())';
begin
  for p in select * from pg_policies where schemaname = 'bo'
           and (coalesce(qual, '') ~ re or coalesce(with_check, '') ~ re) loop
    q := case when p.qual is not null then regexp_replace(p.qual, re, rep, 'g') end;
    c := case when p.with_check is not null then regexp_replace(p.with_check, re, rep, 'g') end;
    execute format('alter policy %I on bo.%I%s%s', p.policyname, p.tablename,
      case when q is not null then ' using (' || q || ')' else '' end,
      case when c is not null then ' with check (' || c || ')' else '' end);
  end loop;
end $$;
