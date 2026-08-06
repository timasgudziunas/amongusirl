-- Empirical fix (2026-08-06): after 20260806000000_init.sql ran via the session
-- pooler, service_role had NO table privileges (42501 "permission denied for table
-- rooms" on every server-route query), while anon did (its criterion-2 probe
-- returned 0 rows, not an error — grants present, RLS doing the gating). Docs say
-- Supabase grants all roles by default; this project disagrees, so grant explicitly.
-- service_role bypasses RLS, so plain GRANTs are the only gate it needs opened.
-- anon is left untouched: its existing select grants stay gated by RLS policies.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
