-- Listing-agent contact capture for PREs (name / email / phone / brokerage).
-- Feeds the Slack review message today and HubSpot contact sync in Week 3.
--
-- All columns nullable and added idempotently so existing rows and code paths
-- are untouched. No backfill — older listings keep NULL agent fields.
-- The legacy `listings.agent` text column is retained; going forward it mirrors
-- listing_agent_name for backward compatibility.
--
-- Run this in the Supabase SQL Editor (dashboard). Do not run from app code.

begin;

alter table public.listings
  add column if not exists listing_agent_name  text,
  add column if not exists listing_agent_email text,
  add column if not exists listing_agent_phone text,
  add column if not exists listing_brokerage   text;

commit;
