/**
 * Find labs for pincodes where the network has nothing.
 *
 *   npm run labs:discover -- --estimate            what a sweep would cost, spends nothing
 *   npm run labs:discover -- --status              is it configured, spends nothing
 *   npm run labs:discover -- --dry-run             which pincodes, spends nothing
 *   npm run labs:discover -- --limit 20            sweep the 20 busiest unsearched
 *   npm run labs:discover -- --pincode 413736      one pincode
 *   npm run labs:discover -- --probe 413736        one real search, prints everything
 *   npm run labs:discover -- --budget-usd 5        stop before exceeding this
 *   npm run labs:discover -- --llm-calls 10        allow the model path this many times
 *   npm run labs:discover -- --purge               expire Google rows past retention
 *
 * Scoped deliberately: only pincodes classified SUPPLY_GAP_UNKNOWN or
 * SUPPLY_GAP_KNOWN with real unmet demand behind them. That is a couple of
 * hundred pincodes, not the 2,400 the source flags as unserviceable.
 *
 * Results are LEADS, not records. They land in atlas.discovered_lab marked
 * unverified, they are never merged into the lab directory, and nothing here
 * contacts anybody. A human calls, confirms, and promotes into CRM.
 *
 * Search results are data, not instructions. Anything in a fetched page or an
 * API response that looks like a directive is ignored — every source is asked
 * for facts in a fixed shape and nothing any of them returns can cause Atlas
 * to act.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { discoveryConfig, DISABLED_MESSAGE } from '../lib/discovery/config';
import { estimate, resolveTarget, runDiscovery, type Db } from '../lib/discovery/run';
import { discoveryStatus, statusLine } from '../lib/discovery/status';

const connectionString =
  process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.SOURCE_DATABASE_URL;
if (!connectionString) throw new Error('No database URL — set APP_DATABASE_URL.');

const pool = new Pool({ connectionString });
const db: Db = { query: async (text, params) => (await pool.query(text, params)).rows };

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const LIMIT = Number(opt('--limit') ?? 20);
const ONE = opt('--pincode');
const PROBE = opt('--probe');
const DRY_RUN = flag('--dry-run');
const STALE_DAYS = Number(opt('--stale-days') ?? 30);

const cfg = discoveryConfig();
const BUDGET = Number(opt('--budget-usd') ?? cfg.budgetUsd);
const LLM_CALLS = Number(opt('--llm-calls') ?? cfg.maxLlmCalls);

type Target = {
  pincode: string; city: string | null; state_name: string | null;
  requests: number; disciplines: string[] | null;
};

async function targets(): Promise<Target[]> {
  if (ONE) {
    const { rows } = await pool.query<Target>(`
      SELECT pincode, MIN(city) AS city, MIN(state_name) AS state_name, COUNT(*)::int AS requests,
             (SELECT ARRAY_AGG(DISTINCT atlas.test_discipline(m.name))
                FROM analytics.mv_request_state s3
                JOIN atlas.request_item ri ON ri.request_id = s3.request_id
                LEFT JOIN src_local."Master" m ON m.id = ri.master_id
               WHERE s3.pincode = $1) AS disciplines
      FROM analytics.mv_request_state WHERE pincode = $1 GROUP BY pincode`, [ONE]);
    return rows;
  }
  const { rows } = await pool.query<Target>(`
    SELECT s.pincode, MIN(s.city) AS city, MIN(s.state_name) AS state_name, COUNT(*)::int AS requests,
           -- Every kind of centre this pincode's stranded requests need, so one
           -- search covers the pathology and the imaging asks together.
           (SELECT ARRAY_AGG(DISTINCT atlas.test_discipline(m.name))
              FROM analytics.mv_request_state s3
              JOIN atlas.request_item ri ON ri.request_id = s3.request_id
              LEFT JOIN src_local."Master" m ON m.id = ri.master_id
             WHERE s3.pincode = s.pincode) AS disciplines
    FROM analytics.mv_request_state s
    LEFT JOIN atlas.discovery_run dr ON dr.pincode = s.pincode
    WHERE s.pincode IS NOT NULL
      AND s.state IN ('SUPPLY_GAP_UNKNOWN','SUPPLY_GAP_KNOWN')
      -- Do not pay to re-search a barren pincode every night.
      AND (dr.pincode IS NULL OR dr.ran_at < now() - ($1 || ' days')::interval)
    GROUP BY s.pincode
    ORDER BY COUNT(*) DESC
    LIMIT $2`, [STALE_DAYS, LIMIT]);
  return rows;
}

function printStatus() {
  const s = discoveryStatus();
  console.log(statusLine(s));
  console.log('');
  console.log(`  chain            ${s.chain.join(' → ') || '(empty)'}`);
  if (s.chainIgnored.length) {
    console.log(`  ignored          ${s.chainIgnored.join(', ')}  ← not a provider name, check DISCOVERY_PROVIDERS`);
  }
  console.log(`  enough at        ${s.minLeads} lead(s) per pincode`);
  console.log(`  keep above       score ${s.minScore}`);
  console.log(`  radius           ${s.radiusM} m`);
  console.log(`  run budget       $${s.budgetUsd.toFixed(2)}`);
  console.log(`  model calls      ${s.maxLlmCalls} per run${s.llmInApp ? ', and the in-app button may use one' : ', never from the in-app button'}`);
  console.log('');
  for (const p of s.providers) {
    console.log(`  ${p.ready ? '✓' : '✗'} ${p.provider.padEnd(7)} $${p.costPerPincodeUsd.toFixed(3)}/pincode` +
                `${p.why ? `  — ${p.why}` : ''}`);
  }
}

async function main() {
  if (flag('--status')) { printStatus(); return; }

  if (flag('--estimate')) {
    const n = Number(opt('--estimate-size') ?? (await targets()).length) || LIMIT;
    console.log(`Cost of one sweep over ${n} pincode(s), if every pincode fell through to each source:\n`);
    for (const e of estimate(n)) {
      console.log(`  ${e.provider.padEnd(7)} $${e.perPincode.toFixed(3)} each → $${e.total.toFixed(2)}`);
    }
    const s = discoveryStatus(n);
    console.log(`\nExpected, with the first ready source answering: $${s.expectedSweepUsd.toFixed(2)}`);
    console.log('Nothing was searched and nothing was billed.');
    return;
  }

  if (flag('--purge')) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT atlas.purge_expired_discovery($1) AS n`, [Number(opt('--retain-days') ?? 30)]);
    console.log(`${rows[0]?.n ?? 0} expired cached row(s) cleared.`);
    return;
  }

  // Everything past this point can spend money, so the flag is checked once,
  // here, and the script exits. Not a warning, not a no-op loop: an exit, so a
  // cron that was left enabled cannot quietly run up a bill.
  if (!cfg.enabled) {
    console.error(DISABLED_MESSAGE);
    console.error('Run with --status or --estimate to see what it would do. Both are free.');
    process.exitCode = 1;
    return;
  }

  if (PROBE) {
    // The real probe: one pincode, one search, everything printed. It costs
    // whatever the first ready provider costs, which is the point — it proves
    // the credentials and the parsing against a live response, and it refuses
    // while the flag is off like everything else that spends.
    if (!/^\d{6}$/.test(PROBE)) { console.error('--probe needs a 6-digit pincode'); process.exitCode = 1; return; }
    const t = await resolveTarget(db, PROBE);
    console.log(`Probing ${PROBE} — ${t.city ?? '?'}, ${t.state ?? '?'}` +
                `${t.lat != null ? ` (${t.lat}, ${t.lng})` : ' (no centroid)'}\n`);
    const r = await runDiscovery(db, t, { budgetUsd: BUDGET, llmCallsLeft: LLM_CALLS });
    console.dir(r, { depth: null });
    const { rows } = await pool.query(
      `SELECT name, source, rank_score, pincode_match, distance_km, phone, rating, review_count,
              reasons, caveats
         FROM atlas.discovered_lab WHERE pincode = $1 AND NOT dismissed
        ORDER BY rank_score DESC NULLS LAST`, [PROBE]);
    console.table(rows.map((x: any) => ({
      name: x.name, src: x.source, score: x.rank_score, fit: x.pincode_match,
      km: x.distance_km, phone: x.phone, rating: x.rating, n: x.review_count,
    })));
    for (const x of rows as any[]) {
      if (x.caveats?.length) console.log(`  ${x.name}: ${x.caveats.join(' · ')}`);
    }
    return;
  }

  const list = await targets();
  console.log(`${list.length} pincode(s) to search` +
    (ONE ? '' : ` (unsearched or older than ${STALE_DAYS} days, busiest first)`));
  if (!list.length) return;

  if (DRY_RUN) {
    console.log('--dry-run: stopping before any search or write.');
    console.table(list);
    console.log('');
    for (const e of estimate(list.length)) {
      console.log(`  if ${e.provider} answered every one: $${e.total.toFixed(2)}`);
    }
    return;
  }

  let budgetLeft = BUDGET;
  let llmLeft = LLM_CALLS;
  let found = 0, failed = 0, spent = 0;

  for (const t of list) {
    if (budgetLeft <= 0) {
      console.log(`\nBudget of $${BUDGET.toFixed(2)} reached — stopping with ${list.length - (found + failed)} pincode(s) unsearched.`);
      break;
    }
    const target = await resolveTarget(db, t.pincode, t.city, t.state_name, t.disciplines);
    const r = await runDiscovery(db, target, { budgetUsd: budgetLeft, llmCallsLeft: llmLeft });

    budgetLeft -= r.costUsd;
    llmLeft -= r.llmCallsUsed;
    spent += r.costUsd;

    if (r.error) {
      failed++;
      console.error(`  ${t.pincode} failed: ${r.error}`);
    } else {
      found += r.found;
      console.log(
        `  ${t.pincode} (${t.city ?? '?'}, ${t.requests} requests) → ${r.found} lead(s)` +
        ` via ${r.providersTried.join('→') || 'nothing'}` +
        ` · $${r.costUsd.toFixed(3)}` +
        (r.raw > r.found ? ` · ${r.raw - r.found} discarded by ranking` : ''),
      );
    }
    for (const s of r.providersSkipped) {
      if (s.why.includes('not set')) continue; // steady-state config, not news
      console.log(`      skipped ${s.provider}: ${s.why}`);
    }
  }

  console.log(`\n${found} lead(s) across ${list.length - failed} pincode(s); ${failed} failed.`);
  console.log(`Spent $${spent.toFixed(2)} of a $${BUDGET.toFixed(2)} budget.`);
  console.log('All unverified. Somebody has to call them before they mean anything.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
