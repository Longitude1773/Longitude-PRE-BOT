-- Hardening for private bot tables in the public schema.
-- Keep RLS enabled and use a backend-only key from server-side scripts.
-- Do not add anon/authenticated policies for these tables unless you
-- intentionally want browser or client access.

begin;

alter table if exists public.listings enable row level security;
alter table if exists public.evaluations enable row level security;
alter table if exists public.monthly_projections enable row level security;
alter table if exists public.comparables enable row level security;
alter table if exists public.adjustments enable row level security;
alter table if exists public.on_demand_requests enable row level security;

commit;
