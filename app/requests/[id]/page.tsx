import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireView } from '@/lib/guard';
import { RoleBlocked } from '@/components/RoleBlocked';
import { FileText, ArrowLeft } from 'lucide-react';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  getRequest, getRequestItems, getCoveringLabs, getDiscoveredLabs, getPackageTests,
  getPincodeIntel,
} from '@/lib/requestQueries';
import { lastDiscoveryRun, discoveryEnabled } from '@/lib/discoverLabs';
import {
  STATE_SHORT, STATE_TONE, TONE_CHIP, BASIS_LABEL, BASIS_STRENGTH, DISCIPLINE_LABEL,
} from '@/lib/requests';
import { QuoteCard } from '../QuoteCard';
import { LeadActions } from '../LeadActions';
import { PriceBreakdown } from '../PriceBreakdown';
import { FindLabs } from '../FindLabs';
import { PincodeIntel } from '../PincodeIntel';
import { BlockLab } from '../BlockLab';

export const dynamic = 'force-dynamic';

const inr = (v: string | null) =>
  v == null ? '—' : '₹' + Math.round(Number(v)).toLocaleString('en-IN');

export default async function RequestDetail({ params }: { params: { id: string } }) {
  const gate = await requireView('requests', `/requests/${params.id}`);
  if (gate.blocked) return <RoleBlocked area="Requests" detail="operations, network and admin" />;

  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const r = await getRequest(id);
  if (!r) notFound();

  const [items, labs, leads, packs, lastRun, intel] = await Promise.all([
    getRequestItems(id),
    getCoveringLabs(id),
    r.pincode ? getDiscoveredLabs(r.pincode) : Promise.resolve([]),
    getPackageTests(id),
    r.pincode ? lastDiscoveryRun(r.pincode) : Promise.resolve(null),
    r.pincode ? getPincodeIntel(r.pincode) : Promise.resolve(null),
  ]);

  // Web leads belong on a request the network cannot serve. Where a covering
  // lab exists there is a real relationship to use, and an unverified search
  // result would only compete with it.
  const noLabHere = labs.length === 0 || labs.every((l) => (l.missing ?? 1) > 0);

  // While discovery is off the card only appears where earlier searches already
  // found something. Offering a search that will refuse is worse than offering
  // nothing, and a pincode with no leads and no way to get any has nothing to
  // put on a card.
  const canSearch = discoveryEnabled();

  const tone = STATE_TONE[r.state] ?? 'ink';

  return (
    <div className="px-6 lg:px-8 py-6 max-w-[1400px] mx-auto">
      <Link href="/requests" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 mb-2">
        <ArrowLeft className="w-3 h-3" /> All requests
      </Link>

      <PageHeader
        title={`Request #${r.request_id}`}
        subtitle={[r.city, r.pincode, r.state_name].filter(Boolean).join(' · ') || 'No location on the request'}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader title="What was asked for"
              subtitle={r.items_unresolved > 0
                ? `${r.items_resolvable} identified, ${r.items_unresolved} we could not match to the catalogue`
                : `${r.items_resolvable} item${r.items_resolvable === 1 ? '' : 's'}`}
              icon={<FileText className="w-4 h-4" strokeWidth={2.25} />} />
            <CardBody className="pt-0">
              {items.length === 0 ? (
                <p className="text-xs text-ink-500">
                  Nothing identifiable — no package, no test, and no parseable note. This cannot
                  be priced, so it is not quoted.
                </p>
              ) : (
                <ul className="text-sm divide-y divide-ink-100">
                  {items.map((it, i) => (
                    <li key={i} className="py-1.5 flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-ink-400 w-14 shrink-0">
                        {it.kind === 'PACKAGE' ? 'Package' : 'Test'}
                      </span>
                      <span className={it.resolved ? 'text-ink-900' : 'text-warn-600'}>{it.label}</span>
                      {!it.resolved && (
                        <span className="text-[10px] text-warn-600">not in catalogue</span>
                      )}
                      <span className="ml-auto text-[10px] text-ink-400">
                        {it.source === 'notes' ? 'parsed from notes' : `from ${it.source}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {(r.disciplines?.length ?? 0) > 1 && (
            <Card>
              <CardBody className="pt-4">
                <div className="text-xs text-ink-600">
                  <span className="text-ink-500">This request needs more than one kind of centre — </span>
                  {r.disciplines!.map((d: string) => DISCIPLINE_LABEL[d] ?? d).join(' and ')}.
                  {' '}A pathology lab cannot take the imaging work, so the pincode may need
                  two onboardings rather than one.
                </div>
              </CardBody>
            </Card>
          )}

          {packs.length > 0 && (
            <Card>
              <CardHeader
                title="What's inside the package"
                subtitle="A package name does not tell you what is being collected — a 56-test panel and a 3-test panel are different conversations with a lab."
              />
              <CardBody className="pt-0 space-y-3">
                {packs.map((pk) => (
                  <div key={pk.package_id}>
                    <div className="text-sm font-medium text-ink-900">
                      {pk.package_name}
                      <span className="ml-2 text-[11px] font-normal text-ink-500">
                        {pk.n} test{pk.n === 1 ? '' : 's'}
                      </span>
                    </div>
                    {pk.tests.length === 0 ? (
                      <p className="text-xs text-ink-400 mt-1">
                        No composition recorded for this package at source.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {pk.tests.map((t) => (
                          <span key={t}
                                className="rounded border border-ink-200 bg-ink-100/60 px-1.5 py-0.5
                                           text-[11px] text-ink-700">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Labs that can collect here"
              subtitle={labs.length
                ? (r.items_resolvable > 0
                    ? 'What each one is missing is the negotiation.'
                    : 'These labs reach the pincode. What was requested is unknown, so we cannot say whether they can serve it.')
                : 'No lab in the network reaches this pincode for home collection.'} />
            <CardBody className="pt-0">
              {labs.length === 0 ? (
                <p className="text-xs text-ink-500">
                  {r.nearest_km
                    ? `Nearest lab of any kind is ${r.nearest_km} km away.`
                    : 'No lab located near this pincode.'}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-ink-400 border-b border-ink-200">
                      <th className="text-left font-medium py-1.5">Lab</th>
                      <th className="text-left font-medium py-1.5">Missing</th>
                      <th className="text-right font-medium py-1.5">Cost if complete</th>
                    </tr>
                  </thead>
                  <tbody>
                    {labs.map((l) => (
                      <tr key={l.lab_id} className="border-b border-ink-100 last:border-0">
                        <td className="py-1.5">
                          <Link href={`/lab/${l.lab_id}`} className="text-brand-600 hover:underline">
                            {l.lab_name}
                          </Link>
                          <span className="block text-[10px] text-ink-400">{l.city}</span>
                        </td>
                        <td className="py-1.5 text-xs">
                          {/* null means we never knew what was asked for, which
                              is not the same as "missing nothing". */}
                          {l.missing == null
                            ? <span className="text-ink-400">Unknown — nothing identifiable was requested</span>
                            : l.missing === 0
                              ? <span className="text-success-600">Nothing — can serve today</span>
                              : <span className="text-warn-600">{l.missing_items.slice(0, 3).join(', ')}
                                  {l.missing_items.length > 3 && ` +${l.missing_items.length - 3}`}</span>}
                        </td>
                        <td className="py-1.5 text-right num text-ink-700">{inr(l.cost)}</td>
                        <td className="py-1.5 text-right whitespace-nowrap pl-3">
                          {r.pincode && <BlockLab labId={l.lab_id} pincode={r.pincode} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          {((noLabHere && canSearch) || leads.length > 0) && r.pincode && (
            <Card>
              <CardHeader
                title="Labs found outside the network"
                subtitle="Unverified leads to call, not network records. Read the caveats before dialling." />
              <CardBody className="pt-0">
                <div className="mb-3">
                  <FindLabs pincode={r.pincode} city={r.city} state={r.state_name}
                            lastRun={lastRun?.ran_at ?? null} found={lastRun?.found ?? null}
                            error={lastRun?.error ?? null}
                            source={lastRun?.provider ?? null}
                            enabled={canSearch}
                            disciplines={r.disciplines} />
                  {lastRun?.error && (
                    <p className="text-[11px] text-ink-500 mt-1">
                      <span className="text-danger-500">{lastRun.error}</span>
                    </p>
                  )}
                </div>
                {leads.length === 0 && (
                  <p className="text-xs text-ink-500">
                    Nothing found yet for {r.pincode}. A lookup takes a second or two and the
                    results are stored, so it is worth doing once per pincode rather than once
                    per request.
                  </p>
                )}
                <ul className="text-sm divide-y divide-ink-100">
                  {leads.map((l) => (
                    <li key={l.id} className="py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-ink-900">{l.name}</span>
                        <span className="text-[10px] uppercase tracking-wide text-warn-600
                                         border border-warn-100 bg-warn-50 rounded px-1">
                          unverified
                        </span>
                        {l.rating && (
                          <span className="text-[11px] text-ink-600 num">
                            {Number(l.rating).toFixed(1)}★
                            {l.review_count != null && (
                              <span className="text-ink-400"> ({l.review_count})</span>
                            )}
                          </span>
                        )}
                        {l.pincode_match === 'exact' && (
                          <span className="text-[10px] text-success-600">in {r.pincode}</span>
                        )}
                        {l.pincode_match !== 'exact' && l.distance_km != null && (
                          <span className="text-[10px] text-ink-400 num">
                            {Number(l.distance_km).toFixed(1)} km away
                          </span>
                        )}
                        <span className="ml-auto">
                          <LeadActions leadId={l.id} promoted={!!l.crm_provider_id} />
                        </span>
                      </div>
                      <div className="text-xs text-ink-600">{l.address}</div>
                      {l.phone && <div className="text-xs text-ink-700 num">{l.phone}</div>}
                      {/* The caveats are the reason this row is a lead and not a
                          record. They sit above the source link rather than
                          behind a tooltip, because the cost of not reading them
                          is somebody's morning. */}
                      {l.caveats && l.caveats.length > 0 && (
                        <ul className="mt-1 text-[11px] text-warn-600 space-y-0.5">
                          {l.caveats.map((c, i) => <li key={i}>· {c}</li>)}
                        </ul>
                      )}
                      {l.reasons && l.reasons.length > 0 && (
                        <div className="mt-0.5 text-[11px] text-ink-500">
                          {l.reasons.join(' ')}
                        </div>
                      )}
                      <div className="text-[10px] text-ink-400 truncate">
                        {l.source && <span className="uppercase tracking-wide">{l.source}</span>}
                        {l.source && l.source_url && ' · '}
                        {l.source_url}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <QuoteCard row={r} />

          <PriceBreakdown row={r} />

          {intel && <PincodeIntel intel={intel} />}

          <Card>
            <CardHeader title="How this was decided" />
            <CardBody className="pt-0 text-xs space-y-2">
              <div className="flex justify-between gap-2">
                <span className="text-ink-500">State</span>
                <span className={`rounded border px-1.5 py-0.5 ${TONE_CHIP[tone]}`}>
                  {STATE_SHORT[r.state] ?? r.state}
                </span>
              </div>
              <p className="text-ink-700">{r.reason}</p>
              <div className="flex justify-between"><span className="text-ink-500">Covering labs</span>
                <b className="text-ink-900">{r.covering_labs}</b></div>
              <div className="flex justify-between"><span className="text-ink-500">Can do the whole ask</span>
                <b className="text-ink-900">{r.full_labs}</b></div>
              {r.nearest_km && (
                <div className="flex justify-between"><span className="text-ink-500">Nearest lab</span>
                  <b className="text-ink-900">{r.nearest_km} km</b></div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-ink-500">Price basis</span>
                <b className={BASIS_STRENGTH[r.price_basis] === 'strong' ? 'text-success-600'
                  : BASIS_STRENGTH[r.price_basis] === 'moderate' ? 'text-warn-600' : 'text-danger-500'}>
                  {BASIS_LABEL[r.price_basis] ?? r.price_basis}
                </b>
              </div>
              {r.markup_pct && (
                <div className="flex justify-between"><span className="text-ink-500">Markup</span>
                  <b className="text-ink-900">+{Number(r.markup_pct)}%</b></div>
              )}
              {!r.src_flag && r.state === 'SERVICEABLE' && (
                <p className="text-warn-600 pt-1 border-t border-ink-100">
                  The console has this flagged not serviceable. Atlas finds a covering lab that
                  offers everything asked for.
                </p>
              )}
            </CardBody>
          </Card>

          {r.pincode && (
            <Card>
              <CardBody className="pt-4 text-xs space-y-1.5">
                <Link href={`/pincode/${r.pincode}`} className="block text-brand-600 hover:underline">
                  Coverage in {r.pincode} →
                </Link>
                <Link href={`/commitments`} className="block text-brand-600 hover:underline">
                  Network bucket →
                </Link>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
