import {
  describeSelectedCandidatePair,
  summarizeSelectedCandidatePair,
} from '@/lib/ac2/connectionStats';

/** Build a Map-based fake `RTCStatsReport` from stat objects keyed by id. */
function createReport(stats: Record<string, any>): Map<string, any> {
  return new Map(Object.entries(stats));
}

describe('summarizeSelectedCandidatePair', () => {
  it('reports a TURN relay path from the transport-selected pair', () => {
    const report = createReport({
      transport: { type: 'transport', selectedCandidatePairId: 'pair1' },
      pair1: {
        type: 'candidate-pair',
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
        state: 'succeeded',
        nominated: true,
      },
      lc: { type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
      rc: { type: 'remote-candidate', candidateType: 'relay', protocol: 'udp' },
    });

    expect(summarizeSelectedCandidatePair(report)).toEqual({
      local: 'relay',
      remote: 'relay',
      protocol: 'udp',
      relay: true,
    });
  });

  it('reports a direct host path (no relay)', () => {
    const report = createReport({
      pair1: {
        type: 'candidate-pair',
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
        state: 'succeeded',
        nominated: true,
      },
      lc: { type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
      rc: { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    });

    expect(summarizeSelectedCandidatePair(report)).toEqual({
      local: 'host',
      remote: 'host',
      protocol: 'udp',
      relay: false,
    });
  });

  it('reports a mixed srflx/host path as non-relay', () => {
    const report = createReport({
      pair1: {
        type: 'candidate-pair',
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
        state: 'succeeded',
      },
      lc: { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
      rc: { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    });

    expect(summarizeSelectedCandidatePair(report)).toMatchObject({
      local: 'srflx',
      remote: 'host',
      relay: false,
    });
  });

  it('returns null when there is no succeeded candidate pair', () => {
    const report = createReport({
      pair1: {
        type: 'candidate-pair',
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
        state: 'in-progress',
      },
      lc: { type: 'local-candidate', candidateType: 'host' },
    });

    expect(summarizeSelectedCandidatePair(report)).toBeNull();
  });

  it('returns null for a missing or malformed report', () => {
    expect(summarizeSelectedCandidatePair(null)).toBeNull();
    expect(summarizeSelectedCandidatePair(undefined)).toBeNull();
    expect(summarizeSelectedCandidatePair({} as any)).toBeNull();
  });
});

describe('describeSelectedCandidatePair', () => {
  it('renders a relay path with the TURN marker', () => {
    expect(
      describeSelectedCandidatePair({
        local: 'relay',
        remote: 'relay',
        protocol: 'udp',
        relay: true,
      }),
    ).toBe('local=relay remote=relay proto=udp (TURN relay)');
  });

  it('renders a direct path without the marker', () => {
    expect(
      describeSelectedCandidatePair({
        local: 'host',
        remote: 'host',
        protocol: 'udp',
        relay: false,
      }),
    ).toBe('local=host remote=host proto=udp');
  });
});
