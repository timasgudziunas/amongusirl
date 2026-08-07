-- One person per task station. task_capacity stays a per-room column (the API and
-- client read it dynamically); only the default changes. Existing lobby-phase rooms
-- are updated too so a room created just before this migration doesn't keep 2.

alter table rooms alter column task_capacity set default 1;

update rooms set task_capacity = 1 where phase = 'lobby';
