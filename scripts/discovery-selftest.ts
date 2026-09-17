/**
 * Self-test for the parts of discovery that do not need a network or a database.
 *
 *   npm run labs:selftest
 *
 * The ranking layer is the half of this feature that is worth keeping and the
 * half nobody can see working. It decides which lead somebody calls first and
 * which caveat they read before dialling, and it does so in pure arithmetic
 * over fields, so it can be checked exactly — which is the argument for having
 * replaced a number a model reported about itself.
 *
 * Deliberately not a test-framework test: this repo has no runner, and a check
 * that needs one installed first is a check that does not get run.
 */

import {
  addressNamesPincode, dedupe, haversineKm, inferKinds, isCollectionOnly,
  normaliseName, pincodeFit, rankAll, rankHit,
} from '../lib/discovery/rank';
import { discoveryConfig, DISABLED_MESSAGE } from '../lib/discovery/config';
import { emptyHit, type DiscoveryTarget, type PlaceHit } from '../lib/discovery/types';

let failures = 0;
function check(what: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.error(`  FAIL ${what}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

// Ahmednagar, roughly. A real supply-gap pincode with a real centroid.
const TARGET: DiscoveryTarget = {
  pincode: '413736', city: 'Ahmednagar', state: 'Maharashtra',
  disciplines: ['PATHOLOGY'], lat: 19.0952, lng: 74.7496,
};

function hit(name: string, over: Partial<PlaceHit> = {}): PlaceHit {
  return { ...emptyHit(name), ...over };
}

console.log('\nkind inference');
check('a pathology lab reads as pathology',
  inferKinds(hit('Sai Pathology Laboratory')).includes('PATHOLOGY'));
check('a scan centre reads as radiology',
  inferKinds(hit('Shree CT Scan Centre')).includes('RADIOLOGY'));
check('an echo centre reads as cardiac',
  inferKinds(hit('Heart Care ECG & Echo Centre')).includes('CARDIO_DIAGNOSTIC'));
check('a collection point is flagged as one',
  isCollectionOnly(hit('Metropolis Sample Collection Centre')));
check('a full lab is not flagged as a collection point',
  !isCollectionOnly(hit('Metropolis Laboratory')));
check('a bare hospital still counts as pathology-capable',
  inferKinds(hit('Civil Hospital')).includes('PATHOLOGY'));

console.log('\nplacing a result in the pincode');
check('an address naming the pincode is exact',
  addressNamesPincode('Nagar Road, Shrigonda, 413736', '413736'));
check('the pincode inside a longer digit run does not count',
  !addressNamesPincode('call 9413736221 for details', '413736'));
check('a nearby point with no pincode in the address is "near"',
  pincodeFit(hit('X', { lat: 19.1, lng: 74.75 }), TARGET).match === 'near');
check('a far point is "far"',
  pincodeFit(hit('X', { lat: 18.52, lng: 73.86 }), TARGET).match === 'far');
check('no address and no coordinates is "unknown"',
  pincodeFit(hit('X'), TARGET).match === 'unknown');
check('haversine is sane (Pune→Mumbai ≈ 120 km)',
  Math.abs(haversineKm({ lat: 18.52, lng: 73.86 }, { lat: 19.08, lng: 72.88 }) - 120) < 15);

console.log('\nscoring');
const good = rankHit(hit('Shrigonda Pathology Lab', {
  address: 'Main Road, Shrigonda, Ahmednagar 413736',
  phone: '02487 222333', rating: 4.4, reviewCount: 132,
  businessStatus: 'OPERATIONAL', lat: 19.0952, lng: 74.7496,
}), 'google', TARGET);
const thin = rankHit(hit('Some Diagnostics', {}), 'mappls', TARGET);
check('a complete, in-pincode, well-rated lab scores high', good.score >= 0.85, good.score);
check('a bare name with nothing behind it scores low', thin.score <= 0.4, thin.score);
check('the good one explains itself', good.reasons.length >= 4, good.reasons);
check('the thin one says what is missing', thin.caveats.length >= 3, thin.caveats);
check('a missing phone is always a caveat',
  thin.caveats.some((c) => /phone/i.test(c)), thin.caveats);
check('a missing rating is always a caveat',
  thin.caveats.some((c) => /rating/i.test(c)), thin.caveats);

const wrongKind = rankHit(hit('City MRI & CT Scan Centre', {
  address: 'Station Road 413736', phone: '9876543210',
}), 'google', TARGET);
check('an imaging centre is marked down for a pathology ask',
  wrongKind.score < good.score, { wrongKind: wrongKind.score, good: good.score });
check('and says why',
  wrongKind.caveats.some((c) => /wrong kind of centre/i.test(c)), wrongKind.caveats);

const closedHit = hit('Old Lab', {
  address: '413736', phone: '9876543210', businessStatus: 'CLOSED_PERMANENTLY',
});
check('a permanently closed place is not offered as a lead at all',
  rankAll([closedHit], 'google', TARGET, 0).length === 0);
check('a temporarily closed one survives, with a caveat',
  rankHit(hit('Paused Lab', { address: '413736', businessStatus: 'CLOSED_TEMPORARILY' }), 'google', TARGET)
    .caveats.some((c) => /temporarily closed/i.test(c)));

const addressMapDisagree = rankHit(hit('Branch Lab', {
  address: 'Somewhere, 413736', lat: 18.52, lng: 73.86,
}), 'google', TARGET);
check('an address and a map that disagree produce a caveat rather than a pick',
  addressMapDisagree.caveats.some((c) => /which is right/i.test(c)),
  addressMapDisagree.caveats);

console.log('\ndedupe');
check('name normalisation strips the noise words',
  normaliseName('Sai Diagnostics Pvt. Ltd.') === normaliseName('SAI diagnostics private limited'),
  [normaliseName('Sai Diagnostics Pvt. Ltd.'), normaliseName('SAI diagnostics private limited')]);

const a = rankAll([hit('Sai Pathology Lab', {
  address: '413736', phone: '+91 98765 43210', lat: 19.095, lng: 74.749,
})], 'mappls', TARGET, 0);
const b = rankAll([hit('Sai Pathology Laboratory Pvt Ltd', {
  address: 'Main Rd, 413736', phone: '098765-43210', rating: 4.2, reviewCount: 55,
  lat: 19.0951, lng: 74.7491,
})], 'google', TARGET, 0);
const merged = dedupe([...a, ...b]);
check('the same lab from two sources collapses to one row', merged.length === 1, merged.map((m) => m.name));
check('the merge keeps the rating only one source had', merged[0]?.rating === 4.2, merged[0]?.rating);
check('and says the two sources agreed',
  merged[0]?.reasons.some((r) => /Also returned by/.test(r)), merged[0]?.reasons);
check('corroboration raises the score',
  (merged[0]?.score ?? 0) > Math.max(a[0].score, b[0].score),
  { merged: merged[0]?.score, a: a[0].score, b: b[0].score });

const twoBranches = dedupe([
  ...rankAll([hit('Metropolis Labs', { address: '413736', lat: 19.09, lng: 74.74 })], 'google', TARGET, 0),
  ...rankAll([hit('Metropolis Labs', { address: '413736', lat: 19.30, lng: 74.99 })], 'google', TARGET, 0),
]);
check('two branches of a chain 25 km apart stay two rows', twoBranches.length === 2, twoBranches.length);

const sharedSwitchboard = dedupe([
  ...rankAll([hit('Alpha Diagnostics', { phone: '02487222333' })], 'mappls', TARGET, 0),
  ...rankAll([hit('Beta Imaging', { phone: '+91 2487 222333' })], 'ola', TARGET, 0),
]);
check('one phone number on two names collapses', sharedSwitchboard.length === 1, sharedSwitchboard.length);

console.log('\nthe flag');
const off = discoveryConfig({ ...process.env, DISCOVERY_ENABLED: undefined } as NodeJS.ProcessEnv);
const on = discoveryConfig({ ...process.env, DISCOVERY_ENABLED: 'true' } as NodeJS.ProcessEnv);
check('absent means off', off.enabled === false);
check('"true" means on', on.enabled === true);
check('the model path is capped at zero by default', off.maxLlmCalls === 0);
check('and the in-app button cannot reach it by default', off.llmInApp === false);
check('the refusal says nothing was billed', /nothing was billed/i.test(DISABLED_MESSAGE));
const typo = discoveryConfig({ DISCOVERY_PROVIDERS: 'mappls,gogle,llm' } as unknown as NodeJS.ProcessEnv);
check('a typo in the chain is dropped rather than crashing',
  typo.chain.join(',') === 'mappls,llm', typo.chain);

console.log('\nranking a whole provider response');
const kept = rankAll([
  hit('Shrigonda Pathology Lab', { address: '413736', phone: '9876543210', rating: 4.4, reviewCount: 90 }),
  hit('A', {}),                                   // nothing behind it
  hit('Mumbai Central Lab', { lat: 18.96, lng: 72.82 }), // 200 km away
], 'google', TARGET, 0.25);
check('ranking keeps the plausible one and drops the rest', kept.length === 1, kept.map((k) => [k.name, k.score]));
check('and returns them best-first',
  kept.every((k, i) => i === 0 || kept[i - 1].score >= k.score));

console.log(failures === 0
  ? '\nAll checks passed.\n'
  : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
