-- Open Play Game Manager saved sessions, player snapshots, and round history.

create extension if not exists pgcrypto;

create table if not exists public.open_play_game_sessions (
  id            uuid primary key default gen_random_uuid(),
  date          date not null,
  time_label    text,
  court_ids     text[] not null default '{}',
  court_names   text[] not null default '{}',
  mode          text not null default 'smart_random_mixer',
  status        text not null default 'draft'
    check (status in ('draft','active','paused','completed','cancelled')),
  current_round integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.open_play_game_players (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid not null references public.open_play_game_sessions(id) on delete cascade,
  full_name              text not null,
  source_registration_id bigint,
  status                 text not null default 'active'
    check (status in ('active','no_show','removed')),
  seed_order             integer not null default 0,
  created_at             timestamptz not null default now()
);

create table if not exists public.open_play_game_rounds (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.open_play_game_sessions(id) on delete cascade,
  round_no         integer not null,
  assignments      jsonb not null default '[]'::jsonb,
  queue_snapshot   jsonb not null default '[]'::jsonb,
  partner_history  jsonb not null default '{}'::jsonb,
  opponent_history jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index if not exists idx_op_game_sessions_date
  on public.open_play_game_sessions(date);

create index if not exists idx_op_game_players_session
  on public.open_play_game_players(session_id, seed_order);

create unique index if not exists idx_op_game_players_source
  on public.open_play_game_players(session_id, source_registration_id)
  where source_registration_id is not null;

create index if not exists idx_op_game_rounds_session
  on public.open_play_game_rounds(session_id, round_no);

drop trigger if exists trg_op_game_sessions_touch_updated_at on public.open_play_game_sessions;
create trigger trg_op_game_sessions_touch_updated_at
  before update on public.open_play_game_sessions
  for each row execute function public.touch_updated_at();

alter table public.open_play_game_sessions enable row level security;
alter table public.open_play_game_players enable row level security;
alter table public.open_play_game_rounds enable row level security;

drop policy if exists op_game_sessions_admin_all on public.open_play_game_sessions;
drop policy if exists op_game_players_admin_all on public.open_play_game_players;
drop policy if exists op_game_rounds_admin_all on public.open_play_game_rounds;

create policy op_game_sessions_admin_all
  on public.open_play_game_sessions
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy op_game_players_admin_all
  on public.open_play_game_players
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy op_game_rounds_admin_all
  on public.open_play_game_rounds
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);
