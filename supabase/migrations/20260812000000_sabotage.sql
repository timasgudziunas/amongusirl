-- Sabotage: host-configurable countdown for the sabotage phase.
alter table rooms add column sabotage_secs int not null default 30;
