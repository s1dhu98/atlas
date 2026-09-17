/**
 * Database-level check of the discovery persistence path.
 *
 *   DISCOVERY_TEST_DATABASE_URL=postgres://… npm run labs:dbtest
 *
 * Runs the real orchestrator against a real Postgres with stub providers, so
 * every line of the persistence SQL, the flag's off-semantics, the
 * never-overwrite-a-verified-row rule, promotion and retention are exercised
 * without a credential, a network call or a rupee.
 *
 * Two safety rails, both deliberate:
 *
 *   1. It refuses to read APP_DATABASE_URL. Point it at a scratch copy on
 *      purpose or it does not run — a test that finds the production database
 *      by default is a test that eventually writes to it.
 *   2. Everything happens inside one transaction that is always rolled back.
 *      Even against a copy, it leaves nothing behind.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { runDiscovery, type Db } from '../lib/discovery/run';
import { emptyHit, type DiscoveryProvider, type DiscoveryTarget, type PlaceHit, type ProviderName } from '../lib/discovery/types';

const url = process.env.DISCOVERY_TEST_DATABASE_URL;
if (!url) {
  console.error('Set DISCOVERY_TEST_DATABASE_URL to a scratch database. This script will not ' +
                'fall back to APP_DATABASE_URL — a test that finds production by default ' +
                'eventually writes to it.');
  process.exit(1);
}

const client = new Client({ connectionString: url });
const db: Db = { query: async (t, p) => (await client.query(t, p)).rows };

let fails = 0;
const check = (what: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ok   ${what}`);
  else { fails++; console.error(`  FAIL ${what}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
};

const PIN = '999999'; // not a real pincode; rolled back anyway
const T: DiscoveryTarget = {
  pincode: PIN, city: 'Testville', state: 'Testastan',
  disciplines: ['PATHOLOGY'], lat: 19.0952, lng: 74.7496,
};

const lab = (n: string, over: Partial<PlaceHit> = {}): PlaceHit => ({ ...emptyHit(n), ...over });

function stub(name: ProviderName, hits: PlaceHit[], cost = 0): DiscoveryProvider {
  return {
    name,
    unavailable: () => null,
    costPerPincodeUsd: () => cost,
    search: async () => ({ provider: name, hits, calls: 1, costUsd: cost }),
  };
}

const LEADS = [
  lab('Testville Pathology Lab', {
    address: `Main Rd, Testville ${PIN}`, phone: '02487222333', lat: 19.095, lng: 74.749,
  }),
  lab('Jai Diagnostic Laboratory', {
    address: `Bazar Peth ${PIN}`, phone: '9876543210', lat: 19.096, lng: 74.750,
  }),
];

async function main() {
  await client.connect();
  await client.query('BEGIN');
  try {
    console.log('\nflag off: nothing is claimed, nothing is billed, nothing is written');
    process.env.DISCOVERY_ENABLED = 'false';
    process.env.DISCOVERY_PROVIDERS = 'google';
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM atlas.discovery_run_log`))[0].n;
    const off = await runDiscovery(db, T, { providers: { google: stub('google', LEADS, 0.035) } });
    const after = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM atlas.discovery_run_log`))[0].n;
    check('the run refuses', off.ok === false && /switched off/i.test(off.error ?? ''), off.error);
    check('nothing was billed', off.costUsd === 0);
    check('no run row was written', before === after, { before, after });
    check('no lead was written',
      (await db.query(`SELECT 1 FROM atlas.discovered_lab WHERE pincode = $1`, [PIN])).length === 0);

    console.log('\nflag on: the chain stops as soon as it has enough');
    process.env.DISCOVERY_ENABLED = 'true';
    process.env.DISCOVERY_PROVIDERS = 'mappls,ola,google';
    process.env.DISCOVERY_MIN_LEADS = '2';
    let metered = 0;
    const r = await runDiscovery(db, T, {
      providers: {
        mappls: stub('mappls', LEADS, 0),
        google: {
          name: 'google', unavailable: () => null, costPerPincodeUsd: () => 0.035,
          search: async () => { metered++; return { provider: 'google', hits: [], calls: 1, costUsd: 0.035 }; },
        },
      },
    });
    check('both leads kept', r.found === 2, r);
    check('the metered provider was never reached', metered === 0);

    const rows = await db.query<any>(`
      SELECT name, source, rank_score, pincode_match, reasons, caveats
        FROM atlas.discovered_lab WHERE pincode = $1 ORDER BY name`, [PIN]);
    check('every row names its source', rows.every((x) => x.source === 'mappls'));
    check('every row carries a score', rows.every((x) => Number(x.rank_score) > 0));
    check('every row explains itself', rows.every((x) => (x.reasons ?? []).length > 0));
    check('every row carries its caveats', rows.every((x) => (x.caveats ?? []).length > 0));
    check('the pincode fit is recorded', rows.every((x) => x.pincode_match === 'exact'));

    const run = (await db.query<any>(`SELECT * FROM atlas.discovery_run WHERE pincode = $1`, [PIN]))[0];
    check('the run row names the provider', run.provider === 'mappls', run.provider);
    check('and records no model, because none ran', run.model === null);
    check('the spend log was appended',
      (await db.query(`SELECT 1 FROM atlas.discovery_run_log WHERE pincode = $1`, [PIN])).length === 1);

    console.log('\na row a human has checked is never overwritten');
    await db.query(`UPDATE atlas.discovered_lab SET verified_at = now(), phone = '99999 99999'
                     WHERE pincode = $1 AND name = 'Testville Pathology Lab'`, [PIN]);
    await runDiscovery(db, T, {
      providers: { mappls: stub('mappls', [
        lab('Testville Pathology Lab', { address: `CHANGED ${PIN}`, phone: '11111 11111', lat: 19.095, lng: 74.749 }),
        LEADS[1],
      ], 0) },
    });
    check('the verified phone survives a re-run',
      (await db.query<any>(`SELECT phone FROM atlas.discovered_lab
                             WHERE pincode = $1 AND name = 'Testville Pathology Lab'`, [PIN]))[0].phone
        === '99999 99999');

    console.log('\npromotion carries the source forward');
    const who = (await db.query<any>(`SELECT id FROM atlas.users ORDER BY id LIMIT 1`))[0];
    const lead = (await db.query<any>(`SELECT id FROM atlas.discovered_lab
                                        WHERE pincode = $1 AND name = 'Jai Diagnostic Laboratory'`, [PIN]))[0];
    const crmId = (await db.query<any>(`SELECT atlas.promote_discovered_lab($1,$2) AS id`, [lead.id, who.id]))[0].id;
    const crm = (await db.query<any>(`SELECT notes FROM atlas.crm_providers WHERE id = $1`, [crmId]))[0];
    check('the CRM note names the real source', /Mappls places search/.test(crm.notes), crm.notes);
    check('and still says unverified', /UNVERIFIED at promotion/.test(crm.notes));
    check('promoting twice returns the same CRM row',
      (await db.query<any>(`SELECT atlas.promote_discovered_lab($1,$2) AS id`, [lead.id, who.id]))[0].id === crmId);

    console.log('\nretention');
    await db.query(`
      INSERT INTO atlas.discovered_lab (pincode, name, address, phone, source, retrieved_at)
      VALUES ($1,'Stale Google Row','Somewhere','9000000000','google', now() - interval '60 days')`, [PIN]);
    const purged = (await db.query<any>(`SELECT atlas.purge_expired_discovery(30) AS n`))[0];
    check('an old, unpromoted Google row is expired', purged.n >= 1, purged);
    const stale = (await db.query<any>(`SELECT name, phone FROM atlas.discovered_lab
                                         WHERE pincode = $1 AND source = 'google' AND dismissed`, [PIN]))[0];
    check('its name and phone are cleared', stale.phone === null && /Expired/.test(stale.name), stale);
    check('a promoted row is never purged',
      (await db.query<any>(`SELECT count(*)::int n FROM atlas.discovered_lab
                             WHERE crm_provider_id IS NOT NULL AND dismissed`))[0].n === 0);

    console.log(fails === 0 ? '\nAll database checks passed.' : `\n${fails} check(s) FAILED.`);
  } finally {
    // Always. Even on a failure — especially on a failure, when there is most
    // half-written state to leave behind.
    await client.query('ROLLBACK');
    console.log('Rolled back; the database is exactly as it was.\n');
    await client.end();
  }
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
