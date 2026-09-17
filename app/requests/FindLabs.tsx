'use client';

import { runAction } from './runAction';

import { useEffect, useState, useTransition } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { findLabsForPincode } from './actions';

/**
 * Look for labs, from the request the network team is looking at.
 *
 * Only shown where the network genuinely cannot reach the pincode. Everywhere
 * else there is a real lab to talk to and an unverified search result would be
 * a distraction.
 *
 * `enabled` comes from the server. When discovery is switched off the button is
 * not rendered at all rather than rendered and then refused on click: a control
 * that exists and does nothing is a worse explanation than no control and one
 * sentence saying why.
 */
export function FindLabs({
  pincode, city, state, lastRun, found, error, disciplines, enabled, source,
}: {
  pincode: string; city: string | null; state: string | null;
  disciplines?: string[] | null;
  lastRun: string | null; found: number | null; error?: string | null;
  enabled: boolean;
  /** Which source last answered for this pincode, if any. */
  source?: string | null;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  // Elapsed seconds while it runs. A spinner with no number gives no way to
  // tell "working" from "hung", which is the whole complaint. A places lookup
  // usually answers before this is legible, which is rather the point.
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    if (!pending) { setSecs(0); return; }
    const t = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [pending]);

  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });

  if (!enabled) {
    return (
      <p className="text-[11px] text-ink-500">
        Searching for new labs is switched off, so nothing is being looked up or billed.
        Leads already found are listed below and still callable.
        {lastRun && ` Last searched ${when(lastRun)}${found != null ? ` · ${found} found` : ''}.`}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          const r = await runAction(() => findLabsForPincode(pincode, city, state, disciplines));
          setMsg(r.ok
            ? ((r as { found?: number }).found
                ? `${(r as { found?: number }).found} lead(s) found` +
                  ((r as { provider?: string }).provider ? ` via ${(r as { provider?: string }).provider}` : '')
                : 'nothing found')
            : (r.error ?? 'search failed'));
        })}
        className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 dark:border-brand-100
                   bg-brand-50 text-brand-700 dark:text-brand-400 px-2.5 py-1.5 text-xs font-medium
                   hover:bg-brand-100 disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
        {pending ? `Looking… ${secs}s` : 'Find labs for this pincode'}
      </button>
      {msg && <span className="text-[11px] text-ink-600">{msg}</span>}
      {pending && secs > 20 && (
        <span className="text-[11px] text-warn-600">
          Longer than usual — a directory lookup normally answers in a second or two.
        </span>
      )}
      {!msg && lastRun && (
        <span className="text-[11px] text-ink-400">
          Last searched {when(lastRun)}
          {found != null && ` · ${found} found`}
          {source && ` · via ${source}`}
        </span>
      )}
      {/* A stored failure with no date reads as current. This one sent an
          afternoon chasing an API error that had already been fixed by adding
          credits — the search just had not been retried. */}
      {!msg && error && (
        <span className="text-[11px] text-ink-500">
          Previous attempt failed{lastRun && ` on ${when(lastRun)}`} — try again, it may be resolved.
        </span>
      )}
    </div>
  );
}
