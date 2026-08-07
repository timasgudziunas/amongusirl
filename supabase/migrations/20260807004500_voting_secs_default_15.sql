-- Voting is quick in practice; 30s of dead air kills momentum. Same pattern as the
-- task_capacity change: new default plus a catch-up for rooms still in the lobby.

alter table rooms alter column voting_secs set default 15;

update rooms set voting_secs = 15 where phase = 'lobby';
