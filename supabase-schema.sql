create table if not exists public.house_movements (
  id uuid primary key,
  household_id text not null default 'aleja-alejo',
  movement_date date not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists house_movements_household_date_idx
  on public.house_movements (household_id, movement_date desc);

alter table public.house_movements enable row level security;

drop policy if exists "allow shared house read" on public.house_movements;
drop policy if exists "allow shared house insert" on public.house_movements;
drop policy if exists "allow shared house update" on public.house_movements;
drop policy if exists "allow shared house delete" on public.house_movements;

create policy "allow shared house read"
  on public.house_movements
  for select
  to authenticated
  using (household_id = 'aleja-alejo');

create policy "allow shared house insert"
  on public.house_movements
  for insert
  to authenticated
  with check (
    household_id = 'aleja-alejo'
    and data ->> 'createdBy' = auth.uid()::text
  );

create policy "allow shared house update"
  on public.house_movements
  for update
  to authenticated
  using (
    household_id = 'aleja-alejo'
    and (
      data ->> 'createdBy' = auth.uid()::text
      or (
        data ->> 'createdBy' is null
        and data ->> 'paidBy' = auth.jwt() -> 'user_metadata' ->> 'person'
      )
    )
  )
  with check (
    household_id = 'aleja-alejo'
    and data ->> 'createdBy' = auth.uid()::text
  );

create policy "allow shared house delete"
  on public.house_movements
  for delete
  to authenticated
  using (
    household_id = 'aleja-alejo'
    and (
      data ->> 'createdBy' = auth.uid()::text
      or (
        data ->> 'createdBy' is null
        and data ->> 'paidBy' = auth.jwt() -> 'user_metadata' ->> 'person'
      )
    )
  );

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_house_movements_updated_at on public.house_movements;

create trigger set_house_movements_updated_at
  before update on public.house_movements
  for each row
  execute function public.set_updated_at();
