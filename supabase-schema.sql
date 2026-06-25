-- ===== ML Quest Master — Supabase schema =====
-- รันใน Supabase Dashboard → SQL Editor

-- 1) ตาราง progress: เก็บเควสรายวัน
create table if not exists public.progress (
  id          bigint generated always as identity primary key,
  day         integer not null,
  phase       text,
  topic       text,
  quest_text  text,                       -- เก็บ quest JSON (title, description, objectives, ...)
  status      text not null default 'pending',  -- pending | done | skip
  xp          integer not null default 0,
  created_at  timestamptz not null default now()
);

-- 2) ตาราง chat_history: เก็บประวัติแชตกับ Quest Coach
create table if not exists public.chat_history (
  id          bigint generated always as identity primary key,
  progress_id bigint references public.progress(id) on delete cascade,
  role        text not null,              -- user | assistant
  message     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_progress_day on public.progress(day desc);
create index if not exists idx_chat_progress on public.chat_history(progress_id);

-- กันสร้างเควส day ซ้ำตอนยิงพร้อมกัน (เปิด/refresh หลายแท็บ) — backend จับ conflict นี้แล้ว reuse
create unique index if not exists uniq_progress_day on public.progress(day);

-- ===== Row Level Security =====
-- แอปนี้เป็น single-user และเข้าถึง Supabase ผ่าน Netlify Functions ด้วย anon key
-- เปิด RLS แล้วอนุญาตให้ anon ทำ CRUD ได้ (ปรับ policy ตามต้องการถ้าทำ multi-user/auth)
alter table public.progress     enable row level security;
alter table public.chat_history enable row level security;

drop policy if exists "anon full access progress" on public.progress;
create policy "anon full access progress" on public.progress
  for all to anon using (true) with check (true);

drop policy if exists "anon full access chat" on public.chat_history;
create policy "anon full access chat" on public.chat_history
  for all to anon using (true) with check (true);
