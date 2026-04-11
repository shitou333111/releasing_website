-- Enable uuid generation helpers when available.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  avatar text,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.annotations (
  id uuid primary key,
  page_path text not null,
  creator_id uuid not null references auth.users(id) on delete cascade,
  privacy text not null check (privacy in ('public', 'private')),
  payload jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists annotations_page_path_idx on public.annotations(page_path);
create index if not exists annotations_creator_id_idx on public.annotations(creator_id);
create unique index if not exists profiles_name_unique_idx on public.profiles(name);

alter table public.profiles enable row level security;
alter table public.annotations enable row level security;

-- Profiles: anyone can read, only owner can write.
drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_all
on public.profiles
for select
using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles
for insert
with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- Annotations: public rows are readable by everyone, private rows only by creator.
drop policy if exists annotations_select_public_or_owner on public.annotations;
create policy annotations_select_public_or_owner
on public.annotations
for select
using (privacy = 'public' or creator_id = auth.uid());

-- Write operations require authenticated owner identity.
drop policy if exists annotations_insert_owner_only on public.annotations;
create policy annotations_insert_owner_only
on public.annotations
for insert
with check (creator_id = auth.uid());

drop policy if exists annotations_update_owner_only on public.annotations;
create policy annotations_update_owner_only
on public.annotations
for update
using (creator_id = auth.uid())
with check (creator_id = auth.uid());

drop policy if exists annotations_delete_owner_only on public.annotations;
create policy annotations_delete_owner_only
on public.annotations
for delete
using (creator_id = auth.uid());

-- ------------------------------------------------------------
-- Optional cleanup SQL (run manually in Supabase SQL Editor)
-- ------------------------------------------------------------

-- 1) Delete specific users by username (replace placeholder values first).
-- with target_users as (
--   select p.id
--   from public.profiles p
--   where p.name = any (array['__replace_username_1__', '__replace_username_2__'])
-- )
-- delete from public.annotations a
-- where a.creator_id in (select id from target_users);
--
-- with target_users as (
--   select p.id
--   from public.profiles p
--   where p.name = any (array['__replace_username_1__', '__replace_username_2__'])
-- )
-- delete from public.profiles p
-- where p.id in (select id from target_users);
--
-- with target_users as (
--   select u.id
--   from auth.users u
--   where u.raw_user_meta_data ->> 'name' = any (array['__replace_username_1__', '__replace_username_2__'])
-- )
-- delete from auth.users u
-- where u.id in (select id from target_users);

-- 2) Delete legacy email-based test users that are not mapped to a profile.
-- delete from auth.users u
-- where u.email not like '%@releasing.local'
--   and not exists (
--     select 1
--     from public.profiles p
--     where p.id = u.id
--   );

-- 3) Full data reset (DANGEROUS): clears annotation/profile business tables only.
-- truncate table public.annotations, public.profiles restart identity cascade;
