-- Phase 0: initial schema. Two tiers: public (client-readable, RLS anon_read) and
-- secret (RLS enabled, no policies, server-only via service role).

-- ==========================================================================
-- PUBLIC TABLES
-- ==========================================================================

create table rooms (
  code                 text primary key,
  phase                text not null,
  round                int not null default 0,
  meeting_no           int not null default 0,
  phase_ends_at        timestamptz,
  tasks_done           int not null default 0,
  tasks_total          int not null default 0,
  here_count           int not null default 0,
  expected_here        int not null default 0,
  votes_cast           int not null default 0,
  last_result          jsonb,
  winner               text,
  meeting_reason       text,
  reported_body_name   text,
  imposter_count       int not null default 2,
  task_capacity        int not null default 2,
  tasks_per_player     int,
  anonymous_voting     boolean not null default true,
  show_task_bar        boolean not null default true,
  imposter_tasks_count boolean not null default false,
  ghost_tasks          boolean not null default false,
  gathering_secs       int not null default 90,
  meeting_secs         int not null default 90,
  voting_secs          int not null default 30,
  results_secs         int not null default 15,
  created_at           timestamptz not null default now()
);

create table players (
  id                 uuid primary key default gen_random_uuid(),
  room_code          text not null references rooms(code) on delete cascade,
  name               text not null,
  has_called_meeting boolean not null default false,
  is_host            boolean not null default false,
  joined_at          timestamptz not null default now()
);

-- expressions can't live in a table UNIQUE constraint; use a unique index instead
create unique index players_room_name_uidx on players (room_code, lower(name));

create table tasks (
  id           uuid primary key default gen_random_uuid(),
  room_code    text not null references rooms(code) on delete cascade,
  order_index  int not null,
  name         text not null,
  location     text not null,
  description  text
);

create table task_occupancy (
  room_code    text not null references rooms(code) on delete cascade,
  task_id      uuid not null references tasks(id) on delete cascade,
  occupied     int not null default 0,
  primary key (room_code, task_id)
);

-- ==========================================================================
-- SECRET TABLES
-- ==========================================================================

create table room_secrets (
  room_code text primary key references rooms(code) on delete cascade,
  host_pin  text not null
);

create table player_secrets (
  player_id uuid primary key references players(id) on delete cascade,
  token     uuid unique not null,
  is_alive  boolean not null default true,
  is_here   boolean not null default false,
  reported  boolean not null default false
);

create table player_roles (
  player_id uuid references players(id) on delete cascade,
  round     int not null,
  role      text not null,
  primary key (player_id, round)
);

create table player_tasks (
  player_id    uuid references players(id) on delete cascade,
  task_id      uuid references tasks(id) on delete cascade,
  round        int not null,
  completed_at timestamptz,
  reveal_at    timestamptz,
  primary key (player_id, task_id, round)
);

create table task_claims (
  room_code  text not null references rooms(code) on delete cascade,
  task_id    uuid not null references tasks(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (room_code, task_id, player_id)
);

create table votes (
  room_code  text not null references rooms(code) on delete cascade,
  round      int not null,
  meeting_no int not null,
  voter_id   uuid not null references players(id) on delete cascade,
  target_id  uuid references players(id) on delete cascade,
  primary key (room_code, round, meeting_no, voter_id)
);

-- ==========================================================================
-- RLS
-- ==========================================================================

alter table rooms enable row level security;
alter table players enable row level security;
alter table tasks enable row level security;
alter table task_occupancy enable row level security;
create policy anon_read on rooms for select to anon using (true);
create policy anon_read on players for select to anon using (true);
create policy anon_read on tasks for select to anon using (true);
create policy anon_read on task_occupancy for select to anon using (true);
-- no insert/update/delete policies for anon anywhere

alter table room_secrets enable row level security;
alter table player_secrets enable row level security;
alter table player_roles enable row level security;
alter table player_tasks enable row level security;
alter table task_claims enable row level security;
alter table votes enable row level security;
-- deliberately NO policies at all: anon is locked out entirely,
-- service_role bypasses RLS

-- ==========================================================================
-- REALTIME
-- ==========================================================================

alter publication supabase_realtime add table rooms, players, tasks, task_occupancy;
