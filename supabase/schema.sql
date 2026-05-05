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
-- TreeHole schema (threads, replies, favorites, aliases, images)
-- ------------------------------------------------------------

create sequence if not exists public.treehole_thread_no_seq;

create table if not exists public.treehole_daily_thread_counters (
  day_key date primary key,
  last_value integer not null check (last_value >= 0),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.treehole_next_thread_no()
returns text
language plpgsql
as $$
declare
  current_day date := timezone('utc', now())::date;
  next_value integer;
begin
  insert into public.treehole_daily_thread_counters (day_key, last_value)
  values (current_day, 1)
  on conflict (day_key)
  do update
    set last_value = public.treehole_daily_thread_counters.last_value + 1,
        updated_at = timezone('utc', now())
  returning last_value into next_value;

  return to_char(current_day, 'YYYYMMDD') || '-' || lpad(next_value::text, 3, '0');
end;
$$;

create or replace function public.treehole_alias_from_index(idx integer)
returns text
language plpgsql
immutable
as $$
declare
  value integer;
  remainder integer;
  result text := '';
begin
  if idx < 0 then
    raise exception 'alias index must be >= 0';
  end if;

  value := idx + 1;

  while value > 0 loop
    remainder := (value - 1) % 26;
    result := chr(65 + remainder) || result;
    value := (value - 1) / 26;
  end loop;

  return result;
end;
$$;

create or replace function public.treehole_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.treehole_threads (
  id uuid primary key default gen_random_uuid(),
  thread_no text not null unique default public.treehole_next_thread_no(),
  title text not null check (char_length(trim(title)) between 1 and 120),
  creator_id uuid not null references auth.users(id) on delete cascade,
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  status text not null default 'open' check (status in ('open', 'closed', 'deleted')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.treehole_posts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null unique references public.treehole_threads(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_alias_label text not null,
  content text not null check (char_length(trim(content)) > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.treehole_replies (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.treehole_threads(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_alias_label text not null,
  content text not null check (char_length(trim(content)) > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.treehole_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.treehole_threads(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, thread_id)
);

create table if not exists public.treehole_thread_aliases (
  thread_id uuid not null references public.treehole_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  alias_index integer not null check (alias_index >= 0),
  alias_label text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (thread_id, user_id),
  unique (thread_id, alias_index),
  unique (thread_id, alias_label)
);

create table if not exists public.treehole_images (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.treehole_threads(id) on delete cascade,
  reply_id uuid references public.treehole_replies(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  public_url text not null,
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (thread_id is not null and reply_id is null)
    or (thread_id is not null and reply_id is not null)
  )
);

create index if not exists treehole_threads_creator_updated_idx
  on public.treehole_threads(creator_id, updated_at desc);
create index if not exists treehole_threads_visibility_status_updated_idx
  on public.treehole_threads(visibility, status, updated_at desc);
create index if not exists treehole_replies_thread_created_idx
  on public.treehole_replies(thread_id, created_at asc);
create index if not exists treehole_replies_author_created_idx
  on public.treehole_replies(author_id, created_at desc);
create index if not exists treehole_favorites_user_created_idx
  on public.treehole_favorites(user_id, created_at desc);
create index if not exists treehole_favorites_thread_created_idx
  on public.treehole_favorites(thread_id, created_at desc);
create index if not exists treehole_images_thread_idx
  on public.treehole_images(thread_id);
create index if not exists treehole_images_reply_idx
  on public.treehole_images(reply_id);

drop trigger if exists treehole_threads_touch_updated_at on public.treehole_threads;
create trigger treehole_threads_touch_updated_at
before update on public.treehole_threads
for each row execute function public.treehole_touch_updated_at();

drop trigger if exists treehole_posts_touch_updated_at on public.treehole_posts;
create trigger treehole_posts_touch_updated_at
before update on public.treehole_posts
for each row execute function public.treehole_touch_updated_at();

drop trigger if exists treehole_replies_touch_updated_at on public.treehole_replies;
create trigger treehole_replies_touch_updated_at
before update on public.treehole_replies
for each row execute function public.treehole_touch_updated_at();

drop trigger if exists treehole_aliases_touch_updated_at on public.treehole_thread_aliases;
create trigger treehole_aliases_touch_updated_at
before update on public.treehole_thread_aliases
for each row execute function public.treehole_touch_updated_at();

create or replace function public.treehole_claim_alias(p_thread_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_alias text;
  next_alias_index integer;
  next_alias_label text;
begin
  if p_thread_id is null then
    raise exception 'thread id is required';
  end if;

  if p_user_id is null then
    raise exception 'user id is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_thread_id::text));

  select alias_label
  into existing_alias
  from public.treehole_thread_aliases
  where thread_id = p_thread_id
    and user_id = p_user_id;

  if existing_alias is not null then
    return existing_alias;
  end if;

  select coalesce(max(alias_index), -1) + 1
  into next_alias_index
  from public.treehole_thread_aliases
  where thread_id = p_thread_id;

  next_alias_label := public.treehole_alias_from_index(next_alias_index);

  insert into public.treehole_thread_aliases (thread_id, user_id, alias_index, alias_label)
  values (p_thread_id, p_user_id, next_alias_index, next_alias_label);

  return next_alias_label;
end;
$$;

create or replace function public.treehole_create_thread(p_title text, p_content text, p_visibility text default 'public')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  thread_id uuid;
  alias_label text;
begin
  if caller_id is null then
    raise exception 'authentication required';
  end if;

  if char_length(trim(coalesce(p_title, ''))) = 0 then
    raise exception 'title is required';
  end if;

  if char_length(trim(coalesce(p_content, ''))) = 0 then
    raise exception 'content is required';
  end if;

  if p_visibility not in ('public', 'private') then
    raise exception 'invalid visibility';
  end if;

  insert into public.treehole_threads (title, creator_id, visibility)
  values (trim(p_title), caller_id, p_visibility)
  returning id into thread_id;

  alias_label := public.treehole_claim_alias(thread_id, caller_id);

  insert into public.treehole_posts (thread_id, author_id, author_alias_label, content)
  values (thread_id, caller_id, alias_label, trim(p_content));

  update public.treehole_threads
  set updated_at = timezone('utc', now())
  where id = thread_id;

  return thread_id;
end;
$$;

create or replace function public.treehole_create_reply(p_thread_id uuid, p_content text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  reply_id uuid;
  alias_label text;
  thread_status text;
begin
  if caller_id is null then
    raise exception 'authentication required';
  end if;

  if p_thread_id is null then
    raise exception 'thread id is required';
  end if;

  if char_length(trim(coalesce(p_content, ''))) = 0 then
    raise exception 'content is required';
  end if;

  select status into thread_status
  from public.treehole_threads
  where id = p_thread_id;

  if thread_status is null then
    raise exception 'thread not found';
  end if;

  if thread_status <> 'open' then
    raise exception 'thread is not open for replies';
  end if;

  alias_label := public.treehole_claim_alias(p_thread_id, caller_id);

  insert into public.treehole_replies (thread_id, author_id, author_alias_label, content)
  values (p_thread_id, caller_id, alias_label, trim(p_content))
  returning id into reply_id;

  update public.treehole_threads
  set updated_at = timezone('utc', now())
  where id = p_thread_id;

  return reply_id;
end;
$$;

create or replace view public.treehole_thread_cards as
select
  t.id,
  t.thread_no,
  t.title,
  p.content,
  p.author_alias_label as creator_alias_label,
  t.creator_id,
  t.visibility,
  t.status,
  t.created_at,
  greatest(t.updated_at, coalesce(r.last_reply_at, t.updated_at)) as updated_at,
  coalesce(r.reply_count, 0)::integer as reply_count,
  coalesce(f.favorite_count, 0)::integer as favorite_count
from public.treehole_threads t
join public.treehole_posts p on p.thread_id = t.id
left join (
  select thread_id, count(*) as reply_count, max(created_at) as last_reply_at
  from public.treehole_replies
  group by thread_id
) r on r.thread_id = t.id
left join (
  select thread_id, count(*) as favorite_count
  from public.treehole_favorites
  group by thread_id
) f on f.thread_id = t.id;

grant execute on function public.treehole_claim_alias(uuid, uuid) to authenticated;
grant execute on function public.treehole_create_thread(text, text, text) to authenticated;
grant execute on function public.treehole_create_reply(uuid, text) to authenticated;

grant select on public.treehole_thread_cards to anon, authenticated;
grant select on public.treehole_threads to anon, authenticated;
grant select on public.treehole_posts to anon, authenticated;
grant select on public.treehole_replies to anon, authenticated;
grant select on public.treehole_thread_aliases to anon, authenticated;
grant select on public.treehole_images to anon, authenticated;
grant select on public.treehole_favorites to authenticated;

grant insert, update, delete on public.treehole_threads to authenticated;
grant insert, update, delete on public.treehole_posts to authenticated;
grant insert, update, delete on public.treehole_replies to authenticated;
grant insert, update, delete on public.treehole_favorites to authenticated;
grant insert, update, delete on public.treehole_images to authenticated;

alter table public.treehole_threads enable row level security;
alter table public.treehole_posts enable row level security;
alter table public.treehole_replies enable row level security;
alter table public.treehole_favorites enable row level security;
alter table public.treehole_thread_aliases enable row level security;
alter table public.treehole_images enable row level security;

drop policy if exists treehole_threads_select_public_or_owner on public.treehole_threads;
create policy treehole_threads_select_public_or_owner
on public.treehole_threads
for select
using (visibility = 'public' or creator_id = auth.uid());

drop policy if exists treehole_threads_insert_owner_only on public.treehole_threads;
create policy treehole_threads_insert_owner_only
on public.treehole_threads
for insert
with check (creator_id = auth.uid());

drop policy if exists treehole_threads_update_owner_only on public.treehole_threads;
create policy treehole_threads_update_owner_only
on public.treehole_threads
for update
using (creator_id = auth.uid())
with check (creator_id = auth.uid());

drop policy if exists treehole_threads_delete_owner_only on public.treehole_threads;
create policy treehole_threads_delete_owner_only
on public.treehole_threads
for delete
using (creator_id = auth.uid());

drop policy if exists treehole_posts_select_visible_thread on public.treehole_posts;
create policy treehole_posts_select_visible_thread
on public.treehole_posts
for select
using (
  exists (
    select 1
    from public.treehole_threads t
    where t.id = treehole_posts.thread_id
      and (t.visibility = 'public' or t.creator_id = auth.uid())
  )
);

drop policy if exists treehole_posts_insert_author_only on public.treehole_posts;
create policy treehole_posts_insert_author_only
on public.treehole_posts
for insert
with check (author_id = auth.uid());

drop policy if exists treehole_posts_update_author_only on public.treehole_posts;
create policy treehole_posts_update_author_only
on public.treehole_posts
for update
using (author_id = auth.uid())
with check (author_id = auth.uid());

drop policy if exists treehole_posts_delete_author_only on public.treehole_posts;
create policy treehole_posts_delete_author_only
on public.treehole_posts
for delete
using (author_id = auth.uid());

drop policy if exists treehole_replies_select_visible_thread on public.treehole_replies;
create policy treehole_replies_select_visible_thread
on public.treehole_replies
for select
using (
  exists (
    select 1
    from public.treehole_threads t
    where t.id = treehole_replies.thread_id
      and (t.visibility = 'public' or t.creator_id = auth.uid())
  )
);

drop policy if exists treehole_replies_insert_author_only on public.treehole_replies;
create policy treehole_replies_insert_author_only
on public.treehole_replies
for insert
with check (author_id = auth.uid());

drop policy if exists treehole_replies_update_author_only on public.treehole_replies;
create policy treehole_replies_update_author_only
on public.treehole_replies
for update
using (author_id = auth.uid())
with check (author_id = auth.uid());

drop policy if exists treehole_replies_delete_author_only on public.treehole_replies;
create policy treehole_replies_delete_author_only
on public.treehole_replies
for delete
using (author_id = auth.uid());

drop policy if exists treehole_favorites_select_owner_only on public.treehole_favorites;
create policy treehole_favorites_select_owner_only
on public.treehole_favorites
for select
using (user_id = auth.uid());

drop policy if exists treehole_favorites_insert_owner_only on public.treehole_favorites;
create policy treehole_favorites_insert_owner_only
on public.treehole_favorites
for insert
with check (user_id = auth.uid());

drop policy if exists treehole_favorites_delete_owner_only on public.treehole_favorites;
create policy treehole_favorites_delete_owner_only
on public.treehole_favorites
for delete
using (user_id = auth.uid());

drop policy if exists treehole_aliases_select_visible_thread on public.treehole_thread_aliases;
create policy treehole_aliases_select_visible_thread
on public.treehole_thread_aliases
for select
using (
  exists (
    select 1
    from public.treehole_threads t
    where t.id = treehole_thread_aliases.thread_id
      and (t.visibility = 'public' or t.creator_id = auth.uid())
  )
);

drop policy if exists treehole_images_select_visible_content on public.treehole_images;
create policy treehole_images_select_visible_content
on public.treehole_images
for select
using (
  exists (
    select 1
    from public.treehole_threads t
    where t.id = treehole_images.thread_id
      and (t.visibility = 'public' or t.creator_id = auth.uid())
  )
);

drop policy if exists treehole_images_insert_owner_only on public.treehole_images;
create policy treehole_images_insert_owner_only
on public.treehole_images
for insert
with check (
  owner_id = auth.uid()
  and (
    (reply_id is null and exists (
      select 1 from public.treehole_threads t
      where t.id = treehole_images.thread_id and t.creator_id = auth.uid()
    ))
    or
    (reply_id is not null and exists (
      select 1 from public.treehole_replies r
      where r.id = treehole_images.reply_id and r.author_id = auth.uid()
    ))
  )
);

drop policy if exists treehole_images_update_owner_only on public.treehole_images;
create policy treehole_images_update_owner_only
on public.treehole_images
for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists treehole_images_delete_owner_only on public.treehole_images;
create policy treehole_images_delete_owner_only
on public.treehole_images
for delete
using (owner_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'treehole-images',
  'treehole-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists treehole_storage_public_read on storage.objects;
create policy treehole_storage_public_read
on storage.objects
for select
using (bucket_id = 'treehole-images');

drop policy if exists treehole_storage_auth_insert on storage.objects;
create policy treehole_storage_auth_insert
on storage.objects
for insert
to authenticated
with check (bucket_id = 'treehole-images');

drop policy if exists treehole_storage_owner_update on storage.objects;
create policy treehole_storage_owner_update
on storage.objects
for update
to authenticated
using (bucket_id = 'treehole-images' and owner = auth.uid())
with check (bucket_id = 'treehole-images' and owner = auth.uid());

drop policy if exists treehole_storage_owner_delete on storage.objects;
create policy treehole_storage_owner_delete
on storage.objects
for delete
to authenticated
using (bucket_id = 'treehole-images' and owner = auth.uid());

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
