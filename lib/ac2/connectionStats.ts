/**
 * Read-only WebRTC diagnostics. Summarises which ICE path a connection selected
 * (direct `host`, STUN `srflx`, or TURN `relay`) so connection issues can be
 * correlated with relay usage. Intentionally logs candidate *types* and the
 * transport protocol only — never IP addresses or raw candidate strings.
 */

export interface SelectedCandidatePairSummary {
  /** Local candidate type: 'host' (direct) | 'srflx' (STUN) | 'prflx' | 'relay' (TURN). */
  local: string;
  /** Remote candidate type. */
  remote: string;
  /** Transport protocol of the local candidate ('udp' | 'tcp'), when known. */
  protocol?: string;
  /** True when either side is a TURN relay candidate. */
  relay: boolean;
}

/** Minimal shape of an `RTCStatsReport` (both `Map` and the spec type expose `forEach`). */
export interface StatsReportLike {
  forEach: (callback: (value: any, key: string) => void) => void;
}

function candidateType(candidate: any): string | undefined {
  if (!candidate || typeof candidate !== 'object') return undefined;
  // Spec field is `candidateType`; guard for the odd impl that omits it.
  return typeof candidate.candidateType === 'string' ? candidate.candidateType : undefined;
}

/**
 * Extract the selected ICE candidate pair from a stats report and summarise the
 * local/remote candidate types + protocol. Returns `null` when no succeeded
 * pair (or no candidate detail) is present.
 */
export function summarizeSelectedCandidatePair(
  report: StatsReportLike | null | undefined,
): SelectedCandidatePairSummary | null {
  if (!report || typeof report.forEach !== 'function') return null;

  const byId = new Map<string, any>();
  const pairs: any[] = [];
  let transportSelectedId: string | undefined;

  report.forEach((value, key) => {
    if (!value || typeof value !== 'object') return;
    byId.set(key, value);
    if (typeof value.id === 'string') byId.set(value.id, value);
    if (value.type === 'candidate-pair') pairs.push(value);
    if (value.type === 'transport' && typeof value.selectedCandidatePairId === 'string') {
      transportSelectedId = value.selectedCandidatePairId;
    }
  });

  // Prefer the transport's explicit selected pair; otherwise the nominated,
  // succeeded pair; otherwise any succeeded pair; finally a `selected` flag
  // (older impls).
  const selected =
    (transportSelectedId ? byId.get(transportSelectedId) : undefined) ||
    pairs.find((p) => p.nominated === true && p.state === 'succeeded') ||
    pairs.find((p) => p.state === 'succeeded') ||
    pairs.find((p) => p.selected === true) ||
    null;

  if (!selected) return null;

  const localCandidate = byId.get(selected.localCandidateId);
  const remoteCandidate = byId.get(selected.remoteCandidateId);
  const local = candidateType(localCandidate);
  const remote = candidateType(remoteCandidate);
  if (!local && !remote) return null;

  const protocol =
    typeof localCandidate?.protocol === 'string' ? localCandidate.protocol : undefined;

  return {
    local: local ?? 'unknown',
    remote: remote ?? 'unknown',
    ...(protocol ? { protocol } : {}),
    relay: local === 'relay' || remote === 'relay',
  };
}

/** One-line, log-friendly rendering of a candidate-pair summary. */
export function describeSelectedCandidatePair(summary: SelectedCandidatePairSummary): string {
  const proto = summary.protocol ? ` proto=${summary.protocol}` : '';
  const relay = summary.relay ? ' (TURN relay)' : '';
  return `local=${summary.local} remote=${summary.remote}${proto}${relay}`;
}
