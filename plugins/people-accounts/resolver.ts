import { LIMITS, normalizeAliasKey, personSummaryOf, type MatchedBy, type ResolutionOutcomeV1, type RosterRowV1 } from '@phosphorco/bb-people-accounts';

export function resolvePerson(rows: readonly RosterRowV1[], input: string): ResolutionOutcomeV1 {
  const exact = rows.filter(row => row.personKey === input);
  if (exact.length === 1) return { status: 'resolved', person: personSummaryOf(exact[0]!), matchedBy: 'person-key' };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, LIMITS.ambiguousCandidates).map(personSummaryOf) };
  const key = normalizeAliasKey(input);
  const hits = rows.flatMap(row => {
    const aliases: [string, MatchedBy][] = [
      ...row.aliases.emails.map(v => [v, 'email'] as [string, MatchedBy]),
      ...row.aliases.nicknames.map(v => [v, 'nickname'] as [string, MatchedBy]),
      ...row.aliases.handles.map(v => [v, 'handle'] as [string, MatchedBy]),
      ...(row.githubLogin ? [[row.githubLogin, 'github-login'] as [string, MatchedBy]] : []),
      ...(row.botLogin ? [[row.botLogin, 'bot-login'] as [string, MatchedBy]] : []),
      ...(row.committer ? [[row.committer.email, 'committer-email'] as [string, MatchedBy]] : []),
      [row.displayName, 'display-name'],
    ];
    const match = aliases.find(([alias]) => normalizeAliasKey(alias) === key);
    return match ? [{ person: personSummaryOf(row), matchedBy: match[1] }] : [];
  });
  if (hits.length === 0) return { status: 'not-found' };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits.slice(0, LIMITS.ambiguousCandidates).map(h => h.person) };
  return { status: 'resolved', ...hits[0]! };
}
