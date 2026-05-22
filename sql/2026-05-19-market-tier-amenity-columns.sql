-- Schema additions for market / sub-market / luxury tier / amenity capture.
-- See GitHub issue #3 (schema additions and market knowledge restructure).
--
-- All columns are nullable and added idempotently so existing code paths and
-- the 44 existing adjustment rows are untouched. No data backfill is performed.
--
-- listings already has an `amenities` jsonb column (reused as-is), so only the
-- three text columns are added there. evaluations and adjustments get all four.
--
-- Run this in the Supabase SQL Editor (dashboard). Do not run from app code.

begin;

-- listings: reuse existing amenities jsonb; add market hierarchy + tier only.
alter table public.listings
  add column if not exists market text,
  add column if not exists sub_market text,
  add column if not exists luxury_tier text;

-- evaluations: market hierarchy, tier, and structured amenity assessment.
alter table public.evaluations
  add column if not exists market text,
  add column if not exists sub_market text,
  add column if not exists luxury_tier text,
  add column if not exists amenities jsonb;

-- adjustments: same four, so corrections can be analyzed by tier/market over time.
alter table public.adjustments
  add column if not exists market text,
  add column if not exists sub_market text,
  add column if not exists luxury_tier text,
  add column if not exists amenities jsonb;

commit;
