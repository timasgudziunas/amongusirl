-- Host-configurable task duration and door-screen duration.
alter table rooms add column task_secs int not null default 15;
alter table rooms add column door_secs int not null default 5;
