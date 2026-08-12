-- Sabotage room pool, per-trigger random target, and universal cooldown state.
alter table rooms add column sabotage_rooms text[] not null default '{}';
alter table rooms add column sabotage_target text;
alter table rooms add column sabotage_cooldown_secs int not null default 60;
alter table rooms add column sabotage_ready_at timestamptz;
alter table rooms add column sabotage_carry_secs int not null default 0;
