/**
 * Score a lead, and say why.
 *
 * The model used to be asked for a confidence number and a note. Both were
 * judgements it made privately and reported as a fact, and neither could be
 * checked. Everything here is arithmetic over fields a places API returns, so
 * the same inputs always produce the same score, and every point of it is
 * attributable to a line you can read.
 *
 * This is the half that was worth keeping, and it is the half that does not
 * care where the facts came from. Pure — no network, no database, no clock.
 */

import type { Discipline, DiscoveryTarget, PlaceHit, ProviderName, RankedLead } from './types';

// ---------------------------------------------------------------------------
// What kind of centre is this, judged from its name.
//
// Mirrors atlas.test_discipline, but applied to business names rather than
// test names. The distinction matters for the same reason it did in the search
// prompt: a pathology lab cannot perform an ultrasound and an imaging centre
// does not run blood panels, so a page of collection centres is the wrong
// answer to a radiology ask however good the labs are. Getting this wrong
// costs somebody a morning on the phone, which is the only real currency here.
// ---------------------------------------------------------------------------

const RADIOLOGY_RE =
  /(x-?ray|ultraso|sonograph|\bmri\b|\bct\b|ct[- ]?scan|scan\s*cent(re|er)|imaging|radiolog|doppler|mammogra|\bdexa\b|\bopg\b|fluorosco|angiograph)/i;

const CARDIO_RE =
  /(\becg\b|\bekg\b|echocardio|\btmt\b|holter|spirometr|\bpft\b|\beeg\b|\bemg\b|audiometr|cardiac\s*(care|cent|diagnos))/i;

const PATHOLOGY_RE =
  /(lab\b|labs\b|laborator|patholog|diagnostic|collection\s*cent(re|er)|blood\s*(test|bank|collection)|clinical\s*lab)/i;

/** A collection point is not a lab. It can draw blood; it cannot report on it. */
const COLLECTION_ONLY_RE = /(collection\s*cent(re|er)|sample\s*collection|collection\s*point)/i;

const HOSPITAL_RE = /(hospital|nursing\s*home|medical\s*cent(re|er)|clinic\b|polyclinic)/i;

export function inferKinds(hit: Pick<PlaceHit, 'name' | 'categories'>): Discipline[] {
  const hay = [hit.name, ...(hit.categories ?? [])].join(' ');
  const kinds: Discipline[] = [];
  if (RADIOLOGY_RE.test(hay)) kinds.push('RADIOLOGY');
  if (CARDIO_RE.test(hay)) kinds.push('CARDIO_DIAGNOSTIC');
  if (PATHOLOGY_RE.test(hay)) kinds.push('PATHOLOGY');
  // A hospital with no other signal does most things badly-labelled. Treat it
  // as pathology-capable rather than as nothing, and let the caveat say so.
  if (kinds.length === 0 && HOSPITAL_RE.test(hay)) kinds.push('PATHOLOGY');
  return kinds;
}

export function isCollectionOnly(hit: Pick<PlaceHit, 'name' | 'categories'>): boolean {
  const hay = [hit.name, ...(hit.categories ?? [])].join(' ');
  return COLLECTION_ONLY_RE.test(hay) && !/laborator|patholog/i.test(hay);
}

// ---------------------------------------------------------------------------
// Is it actually in the pincode.
//
// This is the judgement the model was really being paid for, and it turns out
// to be two cheap checks: does the published address name the pincode, and how
// far is it from the pincode's centroid. India Post gives us a centroid for
// nearly every pincode already (atlas.pincode_directory), so the second check
// costs nothing beyond a lookup we were doing anyway.
// ---------------------------------------------------------------------------

export function addressNamesPincode(address: string | null, pincode: string): boolean {
  if (!address) return false;
  // Word-boundary rather than substring: "413736" must not match inside a
  // phone number or a longer digit run.
  return new RegExp(`(^|\\D)${pincode}(\\D|$)`).test(address);
}

/** Great-circle kilometres. Good to a few metres at these distances. */
export function haversineKm(
  a: { lat: number; lng: number }, b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pincodeFit(
  hit: PlaceHit, t: DiscoveryTarget,
): { match: RankedLead['pincodeMatch']; distanceKm: number | null } {
  const distanceKm =
    hit.lat != null && hit.lng != null && t.lat != null && t.lng != null
      ? haversineKm({ lat: hit.lat, lng: hit.lng }, { lat: t.lat, lng: t.lng })
      : null;

  if (addressNamesPincode(hit.address, t.pincode)) return { match: 'exact', distanceKm };
  if (distanceKm == null) return { match: 'unknown', distanceKm };
  if (distanceKm <= 5) return { match: 'near', distanceKm };
  return { match: 'far', distanceKm };
}

// ---------------------------------------------------------------------------
// The score.
//
// Written as explicit additions rather than a weighted formula so that the
// reasons list and the number can never disagree: every branch that moves the
// score also writes the sentence explaining it.
// ---------------------------------------------------------------------------

const clamp = (n: number) => Math.max(0.05, Math.min(0.95, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

const DISCIPLINE_WORD: Record<Discipline, string> = {
  PATHOLOGY: 'pathology',
  RADIOLOGY: 'radiology / imaging',
  CARDIO_DIAGNOSTIC: 'cardiac & functional testing',
};

export function rankHit(hit: PlaceHit, provider: ProviderName, t: DiscoveryTarget): RankedLead {
  const reasons: string[] = [];
  const caveats: string[] = [];
  let score = 0.35;

  // --- Where it is -------------------------------------------------------
  const { match, distanceKm } = pincodeFit(hit, t);
  const km = distanceKm == null ? null : Math.round(distanceKm * 10) / 10;

  if (match === 'exact') {
    score += 0.25;
    reasons.push(`Published address names pincode ${t.pincode}.`);
    if (km != null && km > 8) {
      // Both facts are true and they disagree. Say so rather than picking one.
      caveats.push(`Address says ${t.pincode} but the map puts it ${km} km away — check which is right.`);
    }
  } else if (match === 'near') {
    score += 0.12;
    reasons.push(`${km} km from the centre of ${t.pincode}.`);
    caveats.push(`Address does not name ${t.pincode}; it is a neighbouring one. Ask whether they cover it.`);
  } else if (match === 'far') {
    // Graded, because "far" covers both the next town over and a different
    // state, and a flat penalty let a Mumbai lab survive a search for a
    // pincode two hundred kilometres away — it matched on the word "lab" and
    // nothing else disagreed loudly enough.
    const penalty = km == null ? 0.1 : km > 40 ? 0.45 : km > 15 ? 0.25 : 0.1;
    score -= penalty;
    caveats.push(
      km != null && km > 40
        ? `${km} km from ${t.pincode} — almost certainly not serving this area.`
        : `${km} km from ${t.pincode} — a branch that may or may not serve the area. Ask before promising anything.`,
    );
  } else {
    // No address we can read a pincode out of and no coordinates: the one
    // thing the search was for is the one thing this result does not say.
    score -= 0.1;
    caveats.push(`Nothing in the result places it in ${t.pincode}. Location unconfirmed.`);
  }

  // --- Can it do the work ------------------------------------------------
  const kinds = inferKinds(hit);
  const asked = t.disciplines?.length ? t.disciplines : (['PATHOLOGY'] as Discipline[]);
  const overlap = kinds.filter((k) => asked.includes(k));

  if (overlap.length > 0) {
    score += 0.1;
    reasons.push(`Name matches the ${overlap.map((k) => DISCIPLINE_WORD[k]).join(' and ')} ask.`);
  } else if (kinds.length > 0) {
    score -= 0.2;
    caveats.push(
      `Looks like ${kinds.map((k) => DISCIPLINE_WORD[k]).join(' / ')}, but this pincode needs ` +
      `${asked.map((k) => DISCIPLINE_WORD[k]).join(' and ')}. Probably the wrong kind of centre.`,
    );
  } else {
    caveats.push('Name says nothing about what it can actually test. Worth one question before anything else.');
  }

  if (isCollectionOnly(hit)) {
    score -= 0.08;
    caveats.push('Reads as a collection point rather than a lab — it can draw a sample, not report on it.');
  }

  // --- Can you ring it ---------------------------------------------------
  if (hit.phone && hit.phone.replace(/\D/g, '').length >= 10) {
    score += 0.1;
    reasons.push('Phone number published.');
  } else {
    caveats.push('No phone number from this source — somebody has to find one before this lead is callable.');
  }

  // --- Is it any good ----------------------------------------------------
  // A rating is weak evidence and a rating over three reviews is none. The
  // thresholds are deliberately blunt: this decides call order, not truth.
  if (hit.rating != null && (hit.reviewCount ?? 0) >= 20) {
    if (hit.rating >= 4) { score += 0.1; reasons.push(`${hit.rating.toFixed(1)}★ from ${hit.reviewCount} ratings.`); }
    else if (hit.rating >= 3) { score += 0.03; reasons.push(`${hit.rating.toFixed(1)}★ from ${hit.reviewCount} ratings.`); }
    else { score -= 0.05; caveats.push(`Rated ${hit.rating.toFixed(1)}★ over ${hit.reviewCount} ratings.`); }
  } else if (hit.rating != null) {
    reasons.push(`${hit.rating.toFixed(1)}★, but only ${hit.reviewCount ?? 0} rating(s) — close to no evidence.`);
  } else {
    caveats.push('No rating from this source, so nothing here says whether it is any good.');
  }

  // --- Is it still open --------------------------------------------------
  if (hit.businessStatus === 'CLOSED_PERMANENTLY') {
    score -= 0.4;
    caveats.push('The source marks it permanently closed.');
  } else if (hit.businessStatus === 'CLOSED_TEMPORARILY') {
    score -= 0.15;
    caveats.push('The source marks it temporarily closed.');
  } else if (hit.businessStatus === 'OPERATIONAL') {
    score += 0.05;
    reasons.push('Source reports it as currently operating.');
  }

  if (!hit.address) caveats.push('No address published — it cannot be visited or verified from this row alone.');

  return {
    ...hit,
    provider,
    kinds,
    pincodeMatch: match,
    distanceKm: km,
    score: round2(clamp(score)),
    reasons,
    caveats,
  };
}

// ---------------------------------------------------------------------------
// Dedupe.
//
// Two sources will hand back the same lab under slightly different names, and
// the same source will hand back a chain's two branches under identical ones.
// Matching on a normalised name alone merges the branches; matching on phone
// alone merges a shared switchboard. So: same external id, or same phone, or
// same normalised name AND within a kilometre.
// ---------------------------------------------------------------------------

export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|inc|the|and|co)\b/g, ' ')
    .replace(/\b(diagnostics?|laborator(y|ies)|labs?|centre|center|clinic|services?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function phoneKey(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

function sameLead(a: RankedLead, b: RankedLead): boolean {
  if (a.externalId && b.externalId && a.externalId === b.externalId) return true;
  const pa = phoneKey(a.phone), pb = phoneKey(b.phone);
  if (pa && pb && pa === pb) return true;
  const na = normaliseName(a.name), nb = normaliseName(b.name);
  if (!na || !nb || na !== nb) return false;
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    return haversineKm({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) <= 1;
  }
  // No coordinates on either side: an identical normalised name in one pincode
  // is the same place often enough to merge, and a wrongly-merged duplicate is
  // cheaper than two rows nobody can tell apart.
  return true;
}

/**
 * Merge b into a, preferring whichever side actually has the field. Earlier in
 * the chain wins ties, because the chain is ordered by how much we trust it.
 */
function merge(a: RankedLead, b: RankedLead): RankedLead {
  const keep = a.score >= b.score ? a : b;
  const other = keep === a ? b : a;
  return {
    ...keep,
    address: keep.address ?? other.address,
    phone: keep.phone ?? other.phone,
    lat: keep.lat ?? other.lat,
    lng: keep.lng ?? other.lng,
    rating: keep.rating ?? other.rating,
    reviewCount: keep.reviewCount ?? other.reviewCount,
    externalId: keep.externalId ?? other.externalId,
    sourceUrl: keep.sourceUrl ?? other.sourceUrl,
    note: keep.note ?? other.note,
    categories: Array.from(new Set([...keep.categories, ...other.categories])),
    // Corroboration by a second, independent source is the strongest signal we
    // get, and it is free. Say so, and nudge the score.
    reasons: Array.from(new Set([
      ...keep.reasons,
      ...(keep.provider !== other.provider ? [`Also returned by ${other.provider}.`] : []),
    ])),
    caveats: Array.from(new Set(keep.caveats)),
    score: keep.provider !== other.provider ? round2(Math.min(0.95, keep.score + 0.08)) : keep.score,
  };
}

export function dedupe(leads: RankedLead[]): RankedLead[] {
  const out: RankedLead[] = [];
  for (const lead of leads) {
    const i = out.findIndex((existing) => sameLead(existing, lead));
    if (i === -1) out.push(lead);
    else out[i] = merge(out[i], lead);
  }
  return out;
}

/** Rank a provider's raw hits, then fold them into what we already have. */
export function rankAll(
  hits: PlaceHit[], provider: ProviderName, t: DiscoveryTarget, minScore: number,
): RankedLead[] {
  return hits
    .filter((h) => h.name && h.name.trim().length > 1)
    // A business the source itself says has closed for good is not a lead with
    // a low score, it is not a lead. Scoring it down still left it on the card
    // under a heading that invites somebody to ring it.
    .filter((h) => h.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((h) => rankHit(h, provider, t))
    .filter((l) => l.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
