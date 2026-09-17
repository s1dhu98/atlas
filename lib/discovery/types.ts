/**
 * The shape every discovery source has to speak.
 *
 * The expensive half of discovery was never the facts — it was paying a
 * language model to read the open web for a name, an address, a phone number,
 * a rating and a review count, which is exactly what a places API returns in
 * under a second for a fraction of the price. Everything downstream of these
 * types (ranking, reasons, caveats, the card, the promote-to-CRM path) is
 * source-agnostic, so changing where the facts come from is a change to one
 * function rather than a change to the feature.
 *
 * Nothing in this file talks to a network or a database. It is the contract.
 */

export type Discipline = 'PATHOLOGY' | 'RADIOLOGY' | 'CARDIO_DIAGNOSTIC';

/** Ordered by what we reach for first. 'llm' is the old path, kept as a floor. */
export type ProviderName = 'mappls' | 'ola' | 'google' | 'llm';

export const PROVIDER_NAMES: ProviderName[] = ['mappls', 'ola', 'google', 'llm'];

export function isProviderName(s: string): s is ProviderName {
  return (PROVIDER_NAMES as string[]).includes(s);
}

/**
 * One business, as a source reported it. Deliberately all-nullable apart from
 * the name: a places API that has no rating is not a broken places API, and a
 * ranking layer that assumes every field is present will quietly score every
 * Mappls result as suspicious.
 */
export type PlaceHit = {
  name: string;
  address: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  /** 0–5. Null where the source publishes none, which is most of them. */
  rating: number | null;
  /** How many ratings that average is over. A 5.0 from one person is noise. */
  reviewCount: number | null;
  /** The source's own stable id — Google place_id, Mappls eLoc. Used for dedupe. */
  externalId: string | null;
  /** Whatever category strings the source gave us, for kind inference. */
  categories: string[];
  /** Where the facts came from. A URL for the model path, an API name otherwise. */
  sourceUrl: string | null;
  businessStatus: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | null;
  /** Free text the source volunteered. Only the model path produces this. */
  note: string | null;
};

/** A blank hit, so providers can fill in what they have and no more. */
export function emptyHit(name: string): PlaceHit {
  return {
    name, address: null, phone: null, lat: null, lng: null,
    rating: null, reviewCount: null, externalId: null, categories: [],
    sourceUrl: null, businessStatus: null, note: null,
  };
}

/** What one provider did, including what it cost, whether or not it found anything. */
export type ProviderOutcome = {
  provider: ProviderName;
  hits: PlaceHit[];
  /** Billable calls actually made. Zero on a refusal, which must not be billed. */
  calls: number;
  costUsd: number;
  /** Set when the provider failed. An empty result is not an error. */
  error?: string;
};

export type DiscoveryTarget = {
  pincode: string;
  city: string | null;
  state: string | null;
  disciplines: Discipline[] | null;
  /** Centroid from atlas.pincode_directory. Null for the ~1% we have no fix on. */
  lat: number | null;
  lng: number | null;
};

export interface DiscoveryProvider {
  readonly name: ProviderName;
  /**
   * Why this provider cannot run right now — a missing key, a missing
   * centroid — or null when it is ready. Checked before anything is spent, so
   * a misconfigured provider is skipped rather than counted as a failed search
   * and written into the run log as if the pincode were barren.
   */
  unavailable(t: DiscoveryTarget): string | null;
  /** Rough USD per pincode. Drives --estimate and the spend ledger. */
  costPerPincodeUsd(): number;
  search(t: DiscoveryTarget): Promise<ProviderOutcome>;
}

/** A hit after the ranking layer has had its say. This is what gets stored. */
export type RankedLead = PlaceHit & {
  provider: ProviderName;
  /** Which kinds of work the name and categories suggest it can actually do. */
  kinds: Discipline[];
  /** Did the source put it in the pincode we asked about, and how do we know. */
  pincodeMatch: 'exact' | 'near' | 'far' | 'unknown';
  distanceKm: number | null;
  /** 0–1. Replaces the model's self-reported confidence with arithmetic. */
  score: number;
  /** Why it scored what it scored, in words a person on the phone can use. */
  reasons: string[];
  /** What is wrong or missing. The half people skip and then regret. */
  caveats: string[];
};
