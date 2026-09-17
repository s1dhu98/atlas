# Discovery — finding labs where the network has none

## What changed, and why

Discovery worked. A search for 413736 came back with three real, callable labs.
It cost about **$1.50 a pincode**, because what it did was ask a language model
to read the open web for a name, an address, a phone number, a rating and a
review count — which is exactly what a places API returns, in under a second,
for roughly a fiftieth of that, with no tool budget to exhaust and no turn to
resume.

There are **310 supply-gap pincodes**. Ten dollars against four hundred and
sixty-five. That is the whole argument, and it is why the feature shipped with
`DISCOVERY_ENABLED` off.

The half worth keeping was always source-agnostic: the ranking, the reasons and
caveats, the card, the claim, the storage, the promote-to-CRM path. So changing
where the facts come from is a change to one function. That change is what this
document describes.

## The chain

`DISCOVERY_PROVIDERS` is an ordered list. Each pincode walks it until
`DISCOVERY_MIN_LEADS` usable leads are in hand, then stops. A pincode a free
Indian directory can answer never reaches a metered provider.

| Source | ~USD/pincode | Ratings | Retention | Why it sits where it does |
|---|---|---|---|---|
| `mappls` | 0 (free tier) | no | unrestricted | Indian directory of Indian businesses; best small-town coverage per rupee |
| `ola` | ~0.002 | rarely | unrestricted | a second, independent Indian source — corroboration is the strongest cheap signal there is |
| `google` | ~0.035 | **yes** | **~30 days for cached content** | best coverage and the only ratings, but its terms are why it is not first |
| `llm` | ~1.50 | no | n/a | the original path; reads district directories and municipal listings nothing else indexes |

Order is not arbitrary. Google's Places terms permit keeping the place id
indefinitely and treat name, address and phone as cached content with an
expiry — and promoting a lead into CRM **is** that indefinite retention. So
Google fills gaps rather than leading, its rows are marked with their source,
and `atlas.purge_expired_discovery()` clears unpromoted Google rows on the
window. A lead somebody has called, confirmed and promoted has stopped being a
cached search result and become our own record of our own relationship, which
is a different thing; those are left alone.

The model path stays in the tree because the pincodes it can answer and a
directory cannot are precisely the ones the feature exists for. It is simply no
longer the first thing tried. It is capped by `DISCOVERY_MAX_LLM_CALLS` (0 by
default) and, separately, by `DISCOVERY_LLM_IN_APP` (false) — a nightly sweep
spending $1.50 on a stranded pincode is a decision somebody made; a click doing
the same silently is not.

## Off still means off

`DISCOVERY_ENABLED` keeps exactly the meaning it had. While it is off:

- the server action refuses before it touches the database;
- the batch script **exits** — not a warning, not a no-op loop, so a cron left
  enabled cannot quietly run up a bill;
- the real probe (`--probe`) refuses, because it performs a real search;
- the card disappears from requests with no leads;
- where earlier searches did find leads they are **still listed and still
  callable**, with one line saying searching is switched off.

Nothing claims a pincode, nothing reaches any API, nothing is billed, and no row
is written to either table. Nothing is deleted.

Two things are new and free, and work identically with the flag on or off:

```
npm run labs:status      # is it configured — which keys, which chain, what is ready
npm run labs:estimate    # what a sweep would cost, before spending any of it
GET /api/health/discovery  # the same, as JSON, for the network or admin role
```

The old probe could only answer by running a real search, which made the one
command for "is this wired up correctly" also a command that spent money and was
therefore refused while the flag was off — precisely when you want to check.

## Applying the migration

`sql/init/` runs once, on a database's first boot, so a fresh stack picks up
`17_discovery_sources.sql` on its own. An existing atlas-db does not — apply it
by hand, once:

```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/init/17_discovery_sources.sql
```

It is idempotent and safe to re-run: every `ADD COLUMN` and `CREATE` is guarded,
and the only `UPDATE` backfills `source = 'llm'` on rows that predate it, which
is true of every row that exists today.

Retention wants a nightly caller. `npm run labs:purge` is the whole of it; hang
it off the same schedule as the refresh.

## Ranking

The model used to report its own `confidence` and a free-text `note`. Both were
private judgements presented as facts. They are replaced by arithmetic over
fields, in `lib/discovery/rank.ts`, so every point of a score is attributable to
a line you can read, and a lead from Mappls is comparable with a lead from
Google:

- **Where it is.** Does the published address name the pincode (`exact`), or is
  it within 5 km of the India Post centroid (`near`), or further (`far`,
  penalised by distance), or is there nothing to place it by (`unknown`)?
- **Can it do the work.** Business names are classified the same way
  `atlas.test_discipline` classifies test names. An imaging centre offered for a
  pathology ask is marked down and says so — a page of collection centres is the
  wrong answer to a radiology request however good the labs are.
- **Can you ring it.** No phone is always a caveat.
- **Is it any good.** A rating over fewer than 20 reviews is close to no
  evidence and is described that way. No rating at all is a caveat, not a
  silence.
- **Is it still open.** A source that says permanently closed removes the lead
  entirely rather than lowering it — a low score still leaves it on a card under
  a heading that invites somebody to ring it.
- **Did two sources agree.** Independent corroboration raises the score and is
  named in the reasons.

Every lead therefore arrives with `reasons` and `caveats` stored beside it, and
the card shows the caveats **above** the source link rather than behind a
tooltip. The cost of not reading them is somebody's morning.

## Running it

```
npm run labs:status                        # free
npm run labs:estimate                      # free
npm run labs:discover -- --dry-run         # free; which pincodes, and what they would cost
npm run labs:discover -- --limit 20        # sweep, stops at DISCOVERY_BUDGET_USD
npm run labs:discover -- --pincode 413736  # one
npm run labs:discover -- --probe 413736    # one real search, everything printed
npm run labs:discover -- --budget-usd 5    # a tighter ceiling for this run
npm run labs:discover -- --llm-calls 10    # let the model path run, this many times
npm run labs:discover -- --purge           # expire cached rows past retention
```

What it has cost, by day and source:

```sql
SELECT * FROM atlas.v_discovery_spend;
```

`atlas.discovery_run` holds the latest attempt per pincode and is upserted, so it
can say when we last looked but never what it has cost. That second question is
the one that switched the feature off, so it now has its own append-only table,
`atlas.discovery_run_log`.

## Checks

```
npm run labs:selftest    # pure; no network, no database, no credentials
DISCOVERY_TEST_DATABASE_URL=… npm run labs:dbtest
```

`labs:selftest` covers kind inference, pincode fitting, scoring, dedupe and the
flag's defaults. `labs:dbtest` runs the real orchestrator against a real
Postgres with stub providers — every line of the persistence SQL, the
off-semantics, the never-overwrite-a-verified-row rule, promotion and retention
— inside a transaction it always rolls back. It refuses to fall back to
`APP_DATABASE_URL`: a test that finds production by default eventually writes to
it.

## Adding a source

Implement `DiscoveryProvider` (four members), register it in
`lib/discovery/providers/index.ts`, add its name to `ProviderName`, and put it
in the chain. Nothing else changes — the ranking, the card, the claim, the
storage and the promote-to-CRM path never learn that it exists.
