create extension if not exists pgcrypto;

create table if not exists public.on_demand_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null,
  source_url text not null,
  command_type text not null check (command_type in ('scrape_zillow_listing', 'scrape_mls_listing')),
  channel text not null,
  thread_ts text,
  listing_id text,
  listing_url text,
  eval_id text,
  version integer,
  command_id text,
  status text not null default 'queued' check (status in ('queued', 'scraping', 'evaluating', 'posted', 'failed')),
  event_path text,
  error text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists on_demand_requests_request_key_idx
  on public.on_demand_requests (request_key);

create index if not exists on_demand_requests_status_idx
  on public.on_demand_requests (status);

create index if not exists on_demand_requests_lease_expires_at_idx
  on public.on_demand_requests (lease_expires_at);

alter table public.on_demand_requests enable row level security;
