import 'server-only';
import { query, queryOne } from './db';
import type { RequestRow, CommitmentRow } from './requests';

/**
 * Statuses that mean nobody is waiting on us. The default queue hides them,
 * because a list that mixes live work with a year of history is a list nobody
 * trusts as a to-do.
 */
const SETTLED = ['ORDERED', 'DISCHARGED', 'CANCELLED', 'DENIED', 'WRONG_NUMBER'];

export type RequestFilters = {
  state?: string;
  status?: string;
  store?: string;
  city?: string;
  pincode?: string;
  q?: string;
  /** false shows everything including settled history. */
  openOnly?: boolean;
  sort?: 'newest' | 'oldest' | 'value' | 'value_asc' | 'soonest' | 'demand';
  /** Only rows Atlas could price. */
  priced?: boolean;
  /** Only rows where the console and Atlas disagree on serviceability. */
  disputed?: boolean;
  /** Only rows with a lab already covering the pincode. */
  hasLab?: boolean;
  /** Created-date window: today | week | month | all. */
  window?: 'today' | 'week' | 'month' | 'all';
  /** Preferred appointment: today | tomorrow | soon (<=3d) | overdue | none. */
  appt?: 'today' | 'tomorrow' | 'soon' | 'overdue' | 'none';
  /** Include stores switched off in settings. Off by default. */
  includeUntracked?: boolean;
  limit?: number;
  offset?: number;
};

function build(f: RequestFilters) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  if (f.openOnly !== false) {
    where.push(`NOT is_converted AND status <> ALL($${params.push(SETTLED)})`);
  }
  if (f.state)   add('state = ?', f.state);
  if (f.status)  add('status = ?', f.status);
  if (f.store)   add('store_id = ?', Number(f.store));
  if (f.city)    add('lower(city) = lower(?)', f.city);
  if (f.pincode) add('pincode = ?', f.pincode);
  // Rolling windows, not calendar ones.
  //
  // date_trunc('week') resets on Monday, so a queue defaulting to "this week"
  // was empty every Monday morning until the first request of the week landed
  // — which is exactly when someone opens it. "Last 7 days" is what an ops
  // person means by the phrase anyway.
  if (f.window === 'today') where.push('created_at >= atlas.ist_midnight()');
  if (f.window === 'week')  where.push("created_at >= now() - interval '7 days'");
  if (f.window === 'month') where.push("created_at >= now() - interval '30 days'");

  // What the store asked for, which is the real clock on a request — a
  // collection wanted tomorrow cannot wait behind one wanted next week.
  //
  // IST, not CURRENT_DATE: the container runs UTC, so "tomorrow" changed over
  // at half past five in the morning India time.
  if (f.appt === 'today')    where.push('preferred_at::date = atlas.ist_today()');
  if (f.appt === 'tomorrow') where.push('preferred_at::date = atlas.ist_today() + 1');
  if (f.appt === 'soon')     where.push('preferred_at::date BETWEEN atlas.ist_today() AND atlas.ist_today() + 3');
  if (f.appt === 'overdue')  where.push('preferred_at::date < atlas.ist_today()');
  if (f.appt === 'none')     where.push('preferred_at IS NULL');

  // Stores the team has switched off. Absent means tracked, so a new partner
  // shows up without anyone configuring it.
  if (f.includeUntracked !== true) {
    where.push('(store_id IS NULL OR atlas.store_is_tracked(store_id))');
  }
  if (f.priced) where.push('quote_price IS NOT NULL');
  if (f.hasLab) where.push('covering_labs > 0');
  // The console flag disagreeing with Atlas is worth filtering on directly:
  // these are requests someone may have already turned away.
  if (f.disputed) where.push("NOT src_flag AND state = 'SERVICEABLE'");
  if (f.q) {
    // "#28785" and "28785" are the same search. Ops copy ids straight out of
    // the console, hash and all.
    const q = f.q.trim().replace(/^#/, '');

    // A bare number is almost always a request id or a pincode, and matching
    // it as a substring against everything buries the exact row among
    // coincidences — "509125" appearing inside a longer id, say. Exact first.
    if (/^\d+$/.test(q)) {
      // Exact only. A substring match on a number is almost always wrong:
      // searching "121" for request #121 also matched pincodes 121001 and
      // 412105 and returned 543 rows with the one wanted row buried. Nobody
      // searches a number hoping for things that merely contain it.
      params.push(Number(q) <= 2147483647 ? Number(q) : 0);
      const idParam = params.length;
      params.push(q);
      const pinParam = params.length;
      where.push(`(request_id = $${idParam} OR pincode = $${pinParam})`);
    } else {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`(city ILIKE $${i} OR store_name ILIKE $${i}
                   OR pincode ILIKE $${i}
                   OR array_to_string(item_names, ' ') ILIKE $${i})`);
    }
  }
  return { params, clause: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

/**
 * The ops queue. Sorted so the top of the list is the right thing to work on
 * next — with no assignment model, sort order is the whole prioritisation
 * system, so it is not an afterthought.
 */
export async function getRequests(f: RequestFilters = {}) {
  const { params, clause } = build(f);
  // Newest first by default: with no assignment, the queue is worked from the
  // top, and a request that arrived today is the one a store is waiting on.
  const order =
    f.sort === 'oldest'    ? 'created_at ASC'
    : f.sort === 'value'     ? 'quote_price DESC NULLS LAST, created_at DESC'
    : f.sort === 'value_asc' ? 'quote_price ASC NULLS LAST, created_at DESC'
    : f.sort === 'soonest'   ? 'promised_date ASC NULLS LAST, created_at DESC'
    // Demand: pincodes we keep failing in, so repeated failures surface as a
    // block rather than scattered through a year of rows.
    : f.sort === 'demand'
      ? `(SELECT COUNT(*) FROM analytics.mv_request_state s2
           WHERE s2.pincode = analytics.v_request_quote.pincode
             AND s2.state <> 'SERVICEABLE') DESC NULLS LAST, created_at DESC`
    : 'created_at DESC';
  const limit = Math.min(f.limit ?? 100, 500);
  params.push(limit, f.offset ?? 0);
  return query<RequestRow>(`
    SELECT * FROM analytics.v_request_quote
    ${clause}
    ORDER BY ${order}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
}

export async function countRequests(f: RequestFilters = {}) {
  const { params, clause } = build(f);
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM analytics.v_request_quote ${clause}`, params);
  return row?.n ?? 0;
}

/** Summary strip: the shape of the queue, not just its length. */
export async function getRequestSummary(f: RequestFilters = {}) {
  const { params, clause } = build(f);
  return query<{ state: string; n: number; quoted: number; dated: number }>(`
    SELECT state, COUNT(*)::int AS n,
           COUNT(quote_price)::int AS quoted,
           COUNT(promised_date)::int AS dated
    FROM analytics.v_request_quote ${clause}
    GROUP BY 1 ORDER BY 2 DESC
  `, params);
}

/**
 * The funnel, for a window of arrivals.
 *
 * Stages are cumulative and monotonic — each is a subset of the one above — so
 * the drop between two bars is a real loss rather than an artefact of two
 * unrelated counts sitting next to each other.
 *
 * Deliberately scoped to a window. "11,396 open requests" is a fact about a
 * year of history and tells nobody what to do this morning; "of the 84 that
 * arrived today, 61 have a price and 12 became orders" does.
 */
export async function getRequestFunnel(f: RequestFilters = {}) {
  const { params, clause } = build({ ...f, state: undefined, openOnly: false });
  const row = await queryOne<{
    received: number; answerable: number; priced: number;
    quoted: number; ordered: number; sourced: number;
    no_ask: number; no_pincode: number; supply_gap: number; awaiting: number;
  }>(`
    SELECT
      COUNT(*)::int AS received,
      COUNT(*) FILTER (WHERE state NOT IN ('NO_ITEMS','NO_PINCODE'))::int AS answerable,
      COUNT(*) FILTER (WHERE state = 'SERVICEABLE' OR quote_price IS NOT NULL)::int AS priced,
      COUNT(*) FILTER (WHERE src_quoted_price IS NOT NULL OR is_converted)::int AS quoted,
      COUNT(*) FILTER (WHERE is_converted)::int AS ordered,
      -- Sourced = ordered and not still waiting on a lab. An order booked
      -- straight onto a real lab never needed securing, so counting only
      -- closed commitments read as a total loss of every order ever placed.
      COUNT(*) FILTER (WHERE is_converted
                         AND (commitment_id IS NULL OR closed_at IS NOT NULL))::int AS sourced,
      COUNT(*) FILTER (WHERE state = 'NO_ITEMS')::int   AS no_ask,
      COUNT(*) FILTER (WHERE state = 'NO_PINCODE')::int AS no_pincode,
      COUNT(*) FILTER (WHERE state LIKE 'SUPPLY_GAP%')::int AS supply_gap,
      COUNT(*) FILTER (WHERE commitment_id IS NOT NULL AND closed_at IS NULL)::int AS awaiting
    FROM analytics.v_request_quote ${clause}
  `, params);
  return row ?? {
    received: 0, answerable: 0, priced: 0, quoted: 0, ordered: 0, sourced: 0,
    no_ask: 0, no_pincode: 0, supply_gap: 0, awaiting: 0,
  };
}

/**
 * How current the request snapshot is.
 *
 * An empty window has two very different causes — genuinely nothing arrived,
 * or the nightly refresh has not run and Atlas is looking at old data. The
 * page cannot tell them apart without this, and the second one is a broken
 * pipeline masquerading as a quiet day.
 */
export async function getRequestFreshness() {
  return queryOne<{ newest: string | null; age_hours: number | null; total: number }>(`
    SELECT MAX(created_at) AS newest,
           ROUND(EXTRACT(epoch FROM (now() - MAX(created_at))) / 3600)::int AS age_hours,
           COUNT(*)::int AS total
    FROM analytics.mv_request_state
  `);
}

/**
 * How many open requests are hidden because their store is switched off.
 *
 * Shown wherever the filter is applied. A queue that quietly drops work is
 * worse than a long one, and the number is the prompt to revisit settings.
 */
export async function getUntrackedCount(f: RequestFilters = {}) {
  const { params, clause } = build({ ...f, store: undefined, includeUntracked: true });
  const row = await queryOne<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM analytics.v_request_quote ${clause}
    ${clause ? 'AND' : 'WHERE'} store_id IS NOT NULL AND NOT atlas.store_is_tracked(store_id)
  `, params);
  return row?.n ?? 0;
}

/** Every store that has ever sent a request, with its tracking state. */
export async function getStoreSettings() {
  return query<{
    store_id: number; name: string; requests: number; open_requests: number;
    tracked: boolean; note: string | null; last_request: string | null;
  }>(`
    SELECT s.store_id,
           COALESCE(st."storeName", 'Store ' || s.store_id) AS name,
           COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE NOT s.is_converted
             AND s.status <> ALL($1))::int AS open_requests,
           atlas.store_is_tracked(s.store_id) AS tracked,
           (SELECT note FROM atlas.store_tracking t WHERE t.store_id = s.store_id) AS note,
           MAX(s.created_at)::text AS last_request
    FROM analytics.mv_request_state s
    LEFT JOIN src_local."Store" st ON st.id = s.store_id
    WHERE s.store_id IS NOT NULL
    GROUP BY s.store_id, st."storeName"
    ORDER BY COUNT(*) DESC
  `, [SETTLED]);
}

export async function getRequest(id: number) {
  return queryOne<RequestRow>(
    `SELECT * FROM analytics.v_request_quote WHERE request_id = $1`, [id]);
}

/** What was asked for, and whether we could name it canonically. */
export async function getRequestItems(id: number) {
  return query<{ kind: string; label: string; source: string; resolved: boolean }>(`
    SELECT ri.kind,
           COALESCE(p."packageName", m.name, ri.raw_text, '(unnamed)') AS label,
           ri.source,
           (ri.package_id IS NOT NULL OR ri.master_id IS NOT NULL) AS resolved
    FROM atlas.request_item ri
    LEFT JOIN src_local."Package" p ON p.id = ri.package_id
    LEFT JOIN src_local."Master"  m ON m.id = ri.master_id
    WHERE ri.request_id = $1
    ORDER BY ri.kind, label
  `, [id]);
}

/**
 * Labs that can collect in this pincode, and what each is missing.
 *
 * The missing list is the negotiation: "activate these three tests at this
 * lab" is actionable in a way "package gap" is not.
 */
export async function getCoveringLabs(id: number) {
  return query<{
    lab_id: number; lab_name: string; city: string | null;
    missing: number | null; missing_items: string[]; cost: string | null;
  }>(`
    WITH want AS (
      SELECT DISTINCT kind, COALESCE(package_id, master_id) AS item_id
      FROM atlas.request_item
      WHERE request_id = $1 AND (package_id IS NOT NULL OR master_id IS NOT NULL)
    ),
    labs AS (
      -- Only labs this request's store is contracted with. The console will
      -- not offer any other, so neither should we.
      SELECT DISTINCT lph.lab_id
      FROM analytics.mv_request_state s
      JOIN analytics.mv_lab_pincode_home lph ON lph.pincode = s.pincode
      WHERE s.request_id = $1
        AND (s.store_id IS NULL
             OR NOT atlas.store_lab_gate_active()
             OR EXISTS (SELECT 1 FROM src_local."LabsOnStore" los
                         WHERE los."storeId" = s.store_id AND los."labId" = lph.lab_id))
    )
    SELECT l.lab_id, lb."labName" AS lab_name, lb.city,
           -- NULL, not 0, when nothing identifiable was requested: we cannot
           -- say a lab is missing something when we do not know what was
           -- asked for, and 0 would read as "can serve this today".
           CASE WHEN COUNT(w.item_id) = 0 THEN NULL
                ELSE COUNT(*) FILTER (WHERE w.item_id IS NOT NULL AND lo.lab_id IS NULL)::int
           END AS missing,
           ARRAY_REMOVE(ARRAY_AGG(
             CASE WHEN w.item_id IS NOT NULL AND lo.lab_id IS NULL
                  THEN COALESCE(p."packageName", m.name, '#' || w.item_id) END), NULL) AS missing_items,
           ROUND(SUM(lo.cost)::numeric, 2) AS cost
    FROM labs l
    -- LEFT, not CROSS. A request with no identifiable items has an empty
    -- want-list, and a cross join against it returned no labs at all -- so the
    -- page said "no lab reaches this pincode" while the sidebar, reading the
    -- same data a different way, said seven do.
    LEFT JOIN want w ON true
    LEFT JOIN analytics.mv_lab_offering lo
           ON lo.lab_id = l.lab_id AND lo.kind = w.kind AND lo.item_id = w.item_id
    LEFT JOIN src_local."Package" p ON w.kind = 'PACKAGE' AND p.id = w.item_id
    LEFT JOIN src_local."Master"  m ON w.kind = 'TEST'    AND m.id = w.item_id
    JOIN src_local."Lab" lb ON lb.id = l.lab_id
    GROUP BY l.lab_id, lb."labName", lb.city
    -- Fewest missing items first, then cheapest. Order history is deliberately
    -- not a factor: serviceability is the lab's mapped pincode list, and
    -- ranking by past collections implied otherwise on the page.
    ORDER BY missing ASC, cost ASC NULLS LAST
    LIMIT 12
  `, [id]);
}

/**
 * The tests inside each requested package.
 *
 * A package name alone tells ops nothing about what is being collected — and a
 * 56-test panel and a 3-test panel are very different conversations with a lab.
 */
export async function getPackageTests(id: number) {
  return query<{ package_id: number; package_name: string; tests: string[]; n: number }>(`
    SELECT p.id AS package_id, p."packageName" AS package_name,
           ARRAY_REMOVE(ARRAY_AGG(m.name ORDER BY m.name), NULL) AS tests,
           COUNT(m.id)::int AS n
    FROM atlas.request_item ri
    JOIN src_local."Package" p ON p.id = ri.package_id
    LEFT JOIN src_local."_MasterToPackage" mp ON mp."B" = p.id
    LEFT JOIN src_local."Master" m ON m.id = mp."A"
    WHERE ri.request_id = $1 AND ri.package_id IS NOT NULL
    GROUP BY p.id, p."packageName"
    ORDER BY p."packageName"
  `, [id]);
}

/**
 * What Atlas knows about the pincode itself.
 *
 * A supply gap is a decision about a place, and "533220" is not a place anyone
 * can picture. Area, district and tier turn it into somewhere the network team
 * can reason about — and the demand figures answer the question that actually
 * decides it: is this one stranded request, or somewhere we keep failing?
 */
export async function getPincodeIntel(pincode: string) {
  return queryOne<{
    pincode: string; area: string | null; city: string | null; district: string | null;
    state: string | null; tier: string | null; tier_rationale: string | null;
    labs_local: number | null; providers_total: number | null;
    orders_all_time: number | null; orders_l90d: number | null;
    requests_total: number; requests_unserved: number; open_commitments: number;
    nearest_lab_km: string | null; nearest_lab_name: string | null;
  }>(`
    WITH d AS (
      -- One row per delivery office; the largest is the recognisable name.
      SELECT MIN(office_name) AS area, MIN(city) AS city,
             MIN(district) AS district, MIN(state) AS state,
             MIN(latitude) AS lat, MIN(longitude) AS lng
      FROM atlas.pincode_directory WHERE pincode = $1
    ),
    r AS (
      SELECT COUNT(*)::int AS requests_total,
             COUNT(*) FILTER (WHERE state <> 'SERVICEABLE')::int AS requests_unserved
      FROM analytics.mv_request_state WHERE pincode = $1
    ),
    c AS (
      SELECT COUNT(*)::int AS open_commitments
      FROM analytics.v_commitment_queue WHERE pincode = $1
    ),
    n AS (
      SELECT l."labName" AS nearest_lab_name,
             ROUND((6371 * acos(GREATEST(-1, LEAST(1,
               cos(radians(d.lat)) * cos(radians(pu.latitude)) *
               cos(radians(pu.longitude) - radians(d.lng)) +
               sin(radians(d.lat)) * sin(radians(pu.latitude))))))::numeric, 1) AS nearest_lab_km
      FROM d
      JOIN analytics.mv_provider_unified pu
        ON pu.kind IN ('LAB','HOSPITAL') AND pu.latitude IS NOT NULL
       AND pu.latitude BETWEEN d.lat - 1.5 AND d.lat + 1.5
       AND pu.longitude BETWEEN d.lng - 1.5 AND d.lng + 1.5
      JOIN src_local."Lab" l ON l.id = pu.source_id
      WHERE d.lat IS NOT NULL
      ORDER BY 2 ASC LIMIT 1
    )
    SELECT $1::text AS pincode, d.area, d.city, d.district, d.state,
           ct.tier, ct.rationale AS tier_rationale,
           ps.labs_local, ps.providers_total, ps.orders_all_time, ps.orders_l90d,
           r.requests_total, r.requests_unserved, c.open_commitments,
           n.nearest_lab_km, n.nearest_lab_name
    FROM d
    CROSS JOIN r CROSS JOIN c
    LEFT JOIN n ON true
    LEFT JOIN analytics.mv_pincode_summary ps ON ps.pincode = $1
    LEFT JOIN atlas.city_tier ct ON ct.city_key = atlas.city_key(d.city)
  `, [pincode]);
}

/**
 * Unverified leads for a pincode. Never mixed into the lab list above.
 *
 * Carries the ranking layer's working alongside each row — which source found
 * it, whether the address actually names the pincode, how far off the centroid
 * it is, and the caveats. A lead is a request that somebody spend a morning on
 * the phone, and the difference between a good morning and a wasted one is
 * whether they could see what was wrong with it before they dialled.
 */
export async function getDiscoveredLabs(pincode: string) {
  return query<{
    id: number; name: string; address: string | null; phone: string | null;
    source_url: string | null; retrieved_at: string; crm_provider_id: number | null;
    source: string | null; rating: string | null; review_count: number | null;
    rank_score: string | null; pincode_match: string | null; distance_km: string | null;
    kinds: string[] | null; reasons: string[] | null; caveats: string[] | null;
  }>(`
    SELECT id, name, address, phone, source_url, retrieved_at, crm_provider_id,
           source, rating, review_count, rank_score, pincode_match, distance_km,
           kinds, reasons, caveats
    FROM atlas.discovered_lab
    WHERE pincode = $1 AND NOT dismissed
    -- rank_score is the new name for the same number; COALESCE keeps rows that
    -- predate the source migration in a sensible place rather than at the end.
    ORDER BY COALESCE(rank_score, confidence) DESC NULLS LAST, name
  `, [pincode]);
}

export async function getCommitments(opts: { includeClosed?: boolean } = {}) {
  if (opts.includeClosed) {
    return query<CommitmentRow>(`
      SELECT * FROM analytics.v_commitment_queue ORDER BY days_left ASC NULLS LAST`);
  }
  return query<CommitmentRow>(
    `SELECT * FROM analytics.v_commitment_queue ORDER BY breached DESC, days_left ASC NULLS LAST`);
}

export async function getCommitmentStats() {
  return queryOne<{
    open: number; breached: number; due_3d: number;
    closed: number; allocated: number; kept: number;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE closed_at IS NULL)::int AS open,
      COUNT(*) FILTER (WHERE closed_at IS NULL AND promised_date < CURRENT_DATE)::int AS breached,
      COUNT(*) FILTER (WHERE closed_at IS NULL AND promised_date <= CURRENT_DATE + 3)::int AS due_3d,
      COUNT(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed,
      COUNT(*) FILTER (WHERE outcome = 'allocated')::int AS allocated,
      -- Kept: allocated on or before the date we promised. The metric the
      -- whole process is judged on, computed from the ledger rather than
      -- reported by anyone.
      COUNT(*) FILTER (WHERE outcome = 'allocated'
                         AND closed_at::date <= promised_date)::int AS kept
    FROM atlas.commitment
  `);
}

/** Pincodes ranked by unmet demand — the planning layer under both queues. */
export async function getPincodeDemand(limit = 50) {
  return query<{
    pincode: string; city: string | null; state_name: string | null;
    requests: number; open_commitments: number; nearest_km: string | null;
    states: string[]; web_leads: number;
  }>(`
    SELECT s.pincode, MIN(s.city) AS city, MIN(s.state_name) AS state_name,
           COUNT(*)::int AS requests,
           COUNT(c.id) FILTER (WHERE c.closed_at IS NULL)::int AS open_commitments,
           MIN(s.nearest_km) AS nearest_km,
           ARRAY_AGG(DISTINCT s.state) AS states,
           (SELECT COUNT(*)::int FROM atlas.discovered_lab dl
             WHERE dl.pincode = s.pincode AND NOT dl.dismissed) AS web_leads
    FROM analytics.mv_request_state s
    LEFT JOIN atlas.commitment c ON c.request_id = s.request_id
    WHERE s.pincode IS NOT NULL
      AND s.state IN ('PACKAGE_GAP','SUPPLY_GAP_KNOWN','SUPPLY_GAP_UNKNOWN')
    GROUP BY s.pincode
    ORDER BY requests DESC
    LIMIT $1
  `, [limit]);
}

/**
 * Facet counts for the filter chips, under the filters that are already on.
 *
 * These used to be all-time totals read straight from mv_request_state,
 * ignoring the window, the state, and even the settled-request exclusion. So a
 * chip could advertise "Star Health 23,435" beside a list showing zero rows,
 * and clicking it led to another empty page. A count next to a filter is a
 * promise about what that filter will return — it has to be counted the same
 * way the list is.
 *
 * Each facet excludes its own dimension, so the store counts show what
 * switching store would give rather than collapsing to the current one.
 */
export async function getFacets(f: RequestFilters = {}) {
  const forStores = build({ ...f, store: undefined });
  const forCities = build({ ...f, city: undefined });
  // Stage counts ignore both the stage filter and the settled exclusion —
  // otherwise every settled stage would permanently read zero, which is the
  // opposite of informative.
  const forStages = build({ ...f, status: undefined, openOnly: false });
  // The chip list is chosen by all-time volume so it stays put as filters
  // change — a row of chips that empties out reads as a broken page. The
  // count on each chip is the filtered one, including zero, so it is a
  // truthful preview of what clicking it returns.
  const [stores, cities, stages] = await Promise.all([
    query<{ store_id: number; name: string; n: number }>(`
      WITH top AS (
        -- Every tracked store that has ever sent a request, not a fixed top
        -- few: the settings page is what keeps this list short, so the filter
        -- row should show exactly what is being tracked.
        SELECT store_id, COUNT(*) AS all_time
        FROM analytics.mv_request_state
        WHERE store_id IS NOT NULL AND atlas.store_is_tracked(store_id)
        GROUP BY 1 ORDER BY 2 DESC
      ),
      filtered AS (
        SELECT store_id, COUNT(*)::int AS n
        FROM analytics.v_request_quote ${forStores.clause}
        GROUP BY 1
      )
      SELECT t.store_id,
             COALESCE(st."storeName", 'Store ' || t.store_id) AS name,
             COALESCE(f.n, 0) AS n
      FROM top t
      LEFT JOIN filtered f ON f.store_id = t.store_id
      LEFT JOIN src_local."Store" st ON st.id = t.store_id
      ORDER BY COALESCE(f.n, 0) DESC, t.all_time DESC`, forStores.params),
    query<{ city: string; n: number }>(`
      WITH top AS (
        SELECT city, COUNT(*) AS all_time
        FROM analytics.mv_request_state
        WHERE NULLIF(TRIM(city),'') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 30
      ),
      filtered AS (
        SELECT city, COUNT(*)::int AS n
        FROM analytics.v_request_quote ${forCities.clause}
        GROUP BY 1
      )
      SELECT t.city, COALESCE(f.n, 0) AS n
      FROM top t LEFT JOIN filtered f ON lower(f.city) = lower(t.city)
      ORDER BY COALESCE(f.n, 0) DESC, t.all_time DESC`, forCities.params),
    query<{ status: string; n: number }>(`
      SELECT status, COUNT(*)::int AS n
      FROM analytics.v_request_quote ${forStages.clause}
      GROUP BY 1`, forStages.params),
  ]);
  return { stores, cities, stages };
}
