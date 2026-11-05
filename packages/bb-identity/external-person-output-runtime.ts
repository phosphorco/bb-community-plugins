function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeExternalPersonOutput(value: unknown): unknown {
  if (!record(value) || !record(value.identity) || !record(value.presentation)) return value;
  return { identity: { kind: value.identity.kind, key: value.identity.key, issuer: value.identity.issuer, subject: value.identity.subject },
    presentation: { displayName: value.presentation.displayName, handle: value.presentation.handle, avatarUrl: value.presentation.avatarUrl },
    evidence: value.evidence };
}

export function normalizeContributionOutput(value: unknown): unknown {
  return record(value) && value.personAttribution !== undefined
    ? { ...value, personAttribution: normalizeExternalPersonOutput(value.personAttribution) } : value;
}

export function normalizeProvenanceOutput(value: unknown): unknown {
  return record(value) && Array.isArray(value.contributions)
    ? { ...value, contributions: value.contributions.map(normalizeContributionOutput) } : value;
}

export function normalizeEvidencePageOutput(value: unknown, normalize: (item: unknown) => unknown): unknown {
  return record(value) && Array.isArray(value.items) ? { ...value, items: value.items.map(normalize) } : value;
}
