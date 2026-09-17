-- ============================================================================
-- atlas-db init #17: discovery gets a source.
--
-- Discovery used to have exactly one way of learning that a lab exists: a
-- language model reading the open web, at about a dollar and a half a pincode.
-- Three hundred and ten supply-gap pincodes is four hundred and sixty-five
-- dollars for one sweep, which is why the feature shipped switched off.
--
-- The facts it was buying — a name, an address, a phone number, a rating, a
-- review count — are what a places API returns in under a second for a
-- fraction of that. So the source became swappable, and this migration is the
-- storage side of that: which source produced a row, what the ranking layer
-- scored it and why, and what the whole thing has cost so far.
--
-- Idempotent. Safe to re-run on a live database; safe to run on a fresh one.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Where a lead came from, and what we made of it.
--
-- `confidence` is kept and still written (it is what the existing ORDER BY
-- reads), but it is now the ranking layer's score rather than a number a model
-- assigned to its own work. rank_score holds the same value under a name that
-- says what it is; confidence can be dropped once nothing reads it.
-- ---------------------------------------------------------------------------
ALTER TABLE atlas.discovered_lab
  ADD COLUMN IF NOT EXISTS source        text,
  ADD COLUMN IF NOT EXISTS external_id   text,
  ADD COLUMN IF NOT EXISTS rating        numeric(2,1),
  ADD COLUMN IF NOT EXISTS review_count  int,
  ADD COLUMN IF NOT EXISTS lat           double precision,
  ADD COLUMN IF NOT EXISTS lng           double precision,
  ADD COLUMN IF NOT EXISTS kinds         text[],
  ADD COLUMN IF NOT EXISTS pincode_match text,
  ADD COLUMN IF NOT EXISTS distance_km   numeric(6,1),
  ADD COLUMN IF NOT EXISTS rank_score    numeric(3,2),
  ADD COLUMN IF NOT EXISTS reasons       text[],
  ADD COLUMN IF NOT EXISTS caveats       text[];

-- Rows that predate this migration all came from the model path. Saying so is
-- better than leaving a NULL that reads as "unknown source" forever.
UPDATE atlas.discovered_lab
   SET source = 'llm'
 WHERE source IS NULL AND model IS NOT NULL;

COMMENT ON COLUMN atlas.discovered_lab.source IS
  'Which provider produced this row: mappls | ola | google | llm.';
COMMENT ON COLUMN atlas.discovered_lab.pincode_match IS
  'exact = the published address names the pincode; near = within 5 km of its '
  'centroid; far = further; unknown = the source gave us nothing to place it by.';
COMMENT ON COLUMN atlas.discovered_lab.caveats IS
  'What is wrong or missing with this lead, in words. Shown beside it, because '
  'a lead people trust without reading the caveats is worse than no lead.';

-- Dedupe across sources: the same place from two providers shares an id.
CREATE INDEX IF NOT EXISTS idx_discovered_external
  ON atlas.discovered_lab (source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovered_source ON atlas.discovered_lab (source);

-- ---------------------------------------------------------------------------
-- The run row learns what it cost.
-- ---------------------------------------------------------------------------
ALTER TABLE atlas.discovery_run
  ADD COLUMN IF NOT EXISTS provider        text,
  ADD COLUMN IF NOT EXISTS providers_tried text[],
  ADD COLUMN IF NOT EXISTS calls           int,
  ADD COLUMN IF NOT EXISTS cost_usd        numeric(10,4);

-- ---------------------------------------------------------------------------
-- Append-only spend log.
--
-- discovery_run holds one row per pincode and is upserted, so it can answer
-- "when did we last look" but never "what has this cost us". That second
-- question is the one that switched the feature off, so it now has a table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atlas.discovery_run_log (
  id              bigserial PRIMARY KEY,
  pincode         text NOT NULL,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  providers_tried text[],
  calls           int NOT NULL DEFAULT 0,
  cost_usd        numeric(10,4) NOT NULL DEFAULT 0,
  found           int NOT NULL DEFAULT 0,
  error           text
);
CREATE INDEX IF NOT EXISTS idx_discovery_log_at ON atlas.discovery_run_log (ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_log_pin ON atlas.discovery_run_log (pincode);

-- What discovery has cost, by day and by source. The number nobody had.
CREATE OR REPLACE VIEW atlas.v_discovery_spend AS
SELECT (ran_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
       COALESCE(p.provider, 'none')               AS provider,
       COUNT(*)::int                              AS runs,
       SUM(l.calls)::int                          AS calls,
       SUM(l.cost_usd)::numeric(10,4)             AS cost_usd,
       SUM(l.found)::int                          AS leads,
       COUNT(*) FILTER (WHERE l.error IS NOT NULL)::int AS failures
FROM atlas.discovery_run_log l
LEFT JOIN LATERAL unnest(COALESCE(l.providers_tried, ARRAY[]::text[])) AS p(provider) ON true
GROUP BY 1, 2
ORDER BY 1 DESC, 5 DESC;

COMMENT ON VIEW atlas.v_discovery_spend IS
  'Discovery spend by day and source. A run that tried two providers appears '
  'under both, so runs sums higher than the number of searches — the cost '
  'column is the one to read.';

-- ---------------------------------------------------------------------------
-- Retention, because one of the sources has terms.
--
-- Google's Places terms permit keeping the place id indefinitely and treat the
-- rest — name, address, phone — as cached content with an expiry. A lead
-- somebody has called, confirmed and promoted into CRM has stopped being a
-- cached search result and become our own record of our own relationship, so
-- those are left alone. Everything else Google-sourced, unverified and older
-- than the window is reduced to the identifier it is allowed to keep.
--
-- Mappls and Ola are not subject to this, which is most of why they are first
-- in the chain. Call it from the nightly refresh; it is cheap and idempotent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION atlas.purge_expired_discovery(retain_days int DEFAULT 30)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  WITH expired AS (
    UPDATE atlas.discovered_lab
       SET name       = 'Expired Google Places result',
           address    = NULL,
           phone      = NULL,
           rating     = NULL,
           review_count = NULL,
           reasons    = NULL,
           caveats    = ARRAY['Cached search result expired under the source''s retention terms. Re-run discovery for this pincode.'],
           dismissed  = true
     WHERE source = 'google'
       AND verified_at IS NULL
       AND crm_provider_id IS NULL
       AND NOT dismissed
       AND retrieved_at < now() - make_interval(days => retain_days)
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO n FROM expired;
  RETURN n;
END$$;

-- ---------------------------------------------------------------------------
-- Promotion carries the source forward.
--
-- The note used to say "Found by web search" whatever had actually found it.
-- Once there are four possible sources with four different reliabilities, the
-- person reading the CRM record in three months needs to know which one it was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION atlas.promote_discovered_lab(lead_id int, by_user int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE new_id int; d record; src text;
BEGIN
  SELECT * INTO d FROM atlas.discovered_lab WHERE id = lead_id;
  IF d IS NULL THEN RAISE EXCEPTION 'No discovered lab %', lead_id; END IF;
  IF d.crm_provider_id IS NOT NULL THEN RETURN d.crm_provider_id; END IF;

  src := CASE d.source
           WHEN 'mappls' THEN 'Mappls places search'
           WHEN 'ola'    THEN 'Ola Maps places search'
           WHEN 'google' THEN 'Google Places search'
           WHEN 'llm'    THEN 'model-assisted web search'
           ELSE 'web search'
         END;

  INSERT INTO atlas.crm_providers
    (name, kind, city, state, pincode, phone, source, created_by, notes)
  VALUES (d.name, 'LAB', d.city, d.state, d.pincode, d.phone,
          'discovered', by_user,
          'Found by ' || src || ' on ' || d.retrieved_at::date ||
          COALESCE(' · ' || d.source_url, '') ||
          COALESCE(' · ' || array_to_string(d.caveats, ' · '), '') ||
          ' · UNVERIFIED at promotion — confirm before relying on it')
  RETURNING id INTO new_id;

  UPDATE atlas.discovered_lab
     SET crm_provider_id = new_id, verified_by = by_user, verified_at = now()
   WHERE id = lead_id;

  RETURN new_id;
END$$;
