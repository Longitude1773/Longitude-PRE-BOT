-- HubSpot write-back columns on evaluations.
--
-- Phase 2 of PRE Bot -> HubSpot: when an evaluation is approved, the bot upserts
-- the listing agent as a HubSpot contact and creates a reminder task. It records
-- the resulting HubSpot ids here so the approve path is idempotent (skip if a
-- task already exists for the row) and so the CRM link is auditable from the DB.
--
-- All columns nullable and added idempotently so existing rows and code paths are
-- untouched. No backfill.
--
-- Run this in the Supabase SQL Editor (dashboard). Do not run from app code.

begin;

alter table public.evaluations
  add column if not exists hubspot_contact_id      text,
  add column if not exists hubspot_task_id         text,
  add column if not exists hubspot_task_created_at timestamptz;

commit;
