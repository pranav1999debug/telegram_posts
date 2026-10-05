-- Run this in Supabase SQL Editor once.
-- Existing columns are preserved; missing bot columns are added safely.
alter table if exists public.posts
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists hashtags text,
  add column if not exists cover_url text,
  add column if not exists content_urls jsonb default '[]'::jsonb,
  add column if not exists free_link text,
  add column if not exists premium_link text,
  add column if not exists direct_link text,
  add column if not exists telegram_message_ids jsonb default '{}'::jsonb,
  add column if not exists status text default 'published',
  add column if not exists source text default 'telegram_bot',
  add column if not exists created_at timestamptz default now();

-- If your existing table has no primary key or insert-required columns,
-- keep those existing constraints and adapt the insert in src/index.ts.
