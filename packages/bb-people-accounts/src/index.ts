import { z } from "zod";

/**
 * People Accounts v1: data shapes, bounds and pure functions for routing a
 * piece of work (a pull request, a commit) to the people it is done for.
 * Explicit input is trusted attribution; nothing here verifies who asked.
 * Zod only: no SDK, React, storage or I/O.
 */
export const PEOPLE_ACCOUNTS_PROTOCOL = "bb-people-accounts" as const;
export const PEOPLE_ACCOUNTS_PLUGIN_ID = "people-accounts" as const;
export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = Object.freeze({
  /** Names in one resolve request. */
  inputs: 16,
  inputBytes: 320,
  /** Thread participant labels echoed into a fallback reason. */
  participants: 32,
  participantBytes: 128,
  rosterEntries: 256,
  aliasesPerKind: 32,
  aliasBytes: 320,
  displayNameBytes: 128,
  personKeyLength: 512,
  committerNameBytes: 128,
  emailBytes: 254,
  ambiguousCandidates: 8,
  messageBytes: 512,
  scopes: 64,
  scopeBytes: 128,
  reasonBytes: 2048,
  /** Names listed in one reason clause before "and N more". */
  reasonNames: 8,
  tokenBytes: 1024,
  describeVersions: 16,
  /** Decoded canonical JSON bytes admitted from any one call. */
  responseBytes: 262_144,
  describeMs: 1_000,
  callMs: 5_000,
});

export const RPC_METHODS = Object.freeze({
  describe: "peopleAccountsDescribe",
  resolve: "peopleAccountsV1Resolve",
  roster: "peopleAccountsV1Roster",
  credential: "peopleAccountsV1Credential",
} as const);

const encoder = new TextEncoder();
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}
const CONTROL = /[\u0000-\u001f\u007f]/;
function text(maxBytes: number, label: string) {
  return z.string()
    .refine(value => value.trim().length > 0, `${label} must not be blank`)
    .refine(value => !CONTROL.test(value), `${label} must not contain control characters`)
    .refine(value => utf8ByteLength(value) <= maxBytes, `${label} is limited to ${maxBytes} UTF-8 bytes`);
}

/** GitHub user login grammar: 1–39 alphanumerics or single inner hyphens. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const githubLoginSchema = z.string().regex(GITHUB_LOGIN, "Must be a GitHub login");
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;
export const emailSchema = text(LIMITS.emailBytes, "Email").pipe(z.string().regex(EMAIL, "Must be an email address"));
/** A bb-identity `IdentityKey`, carried opaquely (same bounds as its codec). */
export const personKeySchema = z.string().min(1).max(LIMITS.personKeyLength)
  .refine(value => !CONTROL.test(value), "Person key must not contain control characters");
const committerNameSchema = text(LIMITS.committerNameBytes, "Committer name")
  .refine(value => !/[<>]/.test(value), "Committer name must not contain < or >");
export const committerSchema = z.strictObject({ name: committerNameSchema, email: emailSchema });
export type Committer = z.infer<typeof committerSchema>;

const aliasSchema = text(LIMITS.aliasBytes, "Alias");
const aliasList = <T extends z.ZodType<string>>(item: T) => z.array(item).max(LIMITS.aliasesPerKind);
export const aliasesSchema = z.strictObject({
  emails: aliasList(emailSchema),
  nicknames: aliasList(aliasSchema),
  handles: aliasList(aliasSchema),
});
export type Aliases = z.infer<typeof aliasesSchema>;

const entryShape = {
  personKey: personKeySchema,
  displayName: text(LIMITS.displayNameBytes, "Display name"),
  aliases: aliasesSchema,
  /** The human's own GitHub login, used as a pull-request assignee. */
  githubLogin: githubLoginSchema.nullable(),
  /** The bot account whose operator-scoped token opens work for this person. */
  botLogin: githubLoginSchema.nullable(),
  /** Identity for Co-Authored-By trailers. */
  committer: committerSchema.nullable(),
};
/** One roster entry as a supplier stores or edits it. Closed. */
export const rosterEntryV1Schema = z.strictObject(entryShape);
export type RosterEntryV1 = z.infer<typeof rosterEntryV1Schema>;

export const credentialStateSchema = z.enum(["missing", "configured", "ok", "failing"]);
export type CredentialState = z.infer<typeof credentialStateSchema>;
const nullableMessage = text(LIMITS.messageBytes, "Message").nullable();
const isoTime = z.string().max(64).nullable();
/** Token health as last observed by the supplier. Never carries the token. */
export const credentialHealthV1Schema = z.object({
  state: credentialStateSchema,
  /** Login the token was observed to act as. */
  actsAs: githubLoginSchema.nullable(),
  expiresAt: isoTime,
  checkedAt: isoTime,
  message: nullableMessage,
  /**
   * Diagnostic only. Scopes GitHub advertised for the token; null when it
   * advertises none (fine-grained tokens), absent when not checked.
   */
  scopes: z.array(z.string().min(1).max(LIMITS.scopeBytes)).max(LIMITS.scopes).nullable().optional(),
});
export type CredentialHealthV1 = z.infer<typeof credentialHealthV1Schema>;

const looseCommitter = z.object({ name: committerNameSchema, email: emailSchema });
const looseAliases = z.object({ emails: aliasList(emailSchema), nicknames: aliasList(aliasSchema), handles: aliasList(aliasSchema) });
/** Roster row on the wire: entry plus credential health. Added fields are tolerated and stripped. */
export const rosterRowV1Schema = z.object({
  ...entryShape,
  aliases: looseAliases,
  committer: looseCommitter.nullable(),
  credential: credentialHealthV1Schema,
});
export type RosterRowV1 = z.infer<typeof rosterRowV1Schema>;

/** What a resolution says about one person. Secret-free. */
export const personSummaryV1Schema = z.object({
  personKey: personKeySchema,
  displayName: entryShape.displayName,
  githubLogin: githubLoginSchema.nullable(),
  botLogin: githubLoginSchema.nullable(),
  committer: looseCommitter.nullable(),
  credentialState: credentialStateSchema,
});
export type PersonSummaryV1 = z.infer<typeof personSummaryV1Schema>;

export function personSummaryOf(row: Pick<RosterRowV1, "personKey" | "displayName" | "githubLogin" | "botLogin" | "committer" | "credential">): PersonSummaryV1 {
  return {
    personKey: row.personKey, displayName: row.displayName, githubLogin: row.githubLogin,
    botLogin: row.botLogin, committer: row.committer === null ? null : { name: row.committer.name, email: row.committer.email },
    credentialState: row.credential.state,
  };
}

export const matchedBySchema = z.enum(["email", "nickname", "handle", "github-login", "bot-login", "person-key", "committer-email", "display-name"]);
export type MatchedBy = z.infer<typeof matchedBySchema>;
const inputSchema = text(LIMITS.inputBytes, "Input");

/** A supplier's answer for one input, before the input is echoed. */
export const resolutionOutcomeV1Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), person: personSummaryV1Schema, matchedBy: matchedBySchema }),
  z.object({ status: z.literal("not-found") }),
  z.object({ status: z.literal("ambiguous"), candidates: z.array(personSummaryV1Schema).min(2).max(LIMITS.ambiguousCandidates) }),
]);
export type ResolutionOutcomeV1 = z.infer<typeof resolutionOutcomeV1Schema>;

export const resolutionV1Schema = z.discriminatedUnion("status", [
  z.object({ input: z.string(), status: z.literal("resolved"), person: personSummaryV1Schema, matchedBy: matchedBySchema }),
  z.object({ input: z.string(), status: z.literal("not-found") }),
  z.object({ input: z.string(), status: z.literal("ambiguous"), candidates: z.array(personSummaryV1Schema).min(2).max(LIMITS.ambiguousCandidates) }),
]);
export type ResolutionV1 = z.infer<typeof resolutionV1Schema>;
export type ResolvedV1 = Extract<ResolutionV1, { status: "resolved" }>;
export type SkippedV1 = Exclude<ResolutionV1, { status: "resolved" }>;

const namedPerson = z.object({ input: z.string(), person: personSummaryV1Schema });
export const attributionV1Schema = z.object({
  /** First resolved input, in request order. Supplies the posting account. */
  primary: namedPerson.nullable(),
  /** Other distinct resolved people, in request order. */
  others: z.array(namedPerson).max(LIMITS.inputs),
  /** Every input that did not resolve, in request order. */
  skipped: z.array(resolutionV1Schema).max(LIMITS.inputs),
  /** Bot login to post as; null means the consumer's default account. */
  postAs: githubLoginSchema.nullable(),
  /** Human GitHub logins of every resolved person, deduplicated, in order. */
  assignees: z.array(githubLoginSchema).max(LIMITS.inputs),
  coAuthors: z.array(looseCommitter).max(LIMITS.inputs),
  /** Plain-text note when anything defaulted or was skipped; null otherwise. */
  fallbackReason: z.string().max(LIMITS.reasonBytes).nullable(),
});
export type AttributionV1 = z.infer<typeof attributionV1Schema>;

// --- Wire ---------------------------------------------------------------------

export const describeInputSchema = z.null();
/** Parsed tolerantly (added fields stripped); details are decoded only under a negotiated version. */
export const describeEnvelopeSchema = z.object({
  protocol: z.literal(PEOPLE_ACCOUNTS_PROTOCOL),
  versions: z.array(z.number().int().min(1).max(1000)).min(1).max(LIMITS.describeVersions),
});
export type DescribeEnvelope = z.infer<typeof describeEnvelopeSchema>;

export const resolveInputSchema = z.strictObject({
  version: z.literal(1),
  inputs: z.array(inputSchema).max(LIMITS.inputs),
  /** Labels of thread participants, only echoed into a fallback reason. */
  participants: z.array(text(LIMITS.participantBytes, "Participant")).max(LIMITS.participants).optional(),
});
export type ResolveInput = z.infer<typeof resolveInputSchema>;
export type ResolveRequest = Omit<ResolveInput, "version">;
export const resolveResultSchema = z.object({
  version: z.literal(1),
  results: z.array(resolutionV1Schema).max(LIMITS.inputs),
  attribution: attributionV1Schema,
});
export type ResolveResult = z.infer<typeof resolveResultSchema>;

export const rosterInputSchema = z.strictObject({ version: z.literal(1) });
export const rosterResultSchema = z.object({
  version: z.literal(1),
  entries: z.array(rosterRowV1Schema).max(LIMITS.rosterEntries),
});
export type RosterResult = z.infer<typeof rosterResultSchema>;

/** Trusted backend integration: returns the operator's bot token. See CONTRACT §7. */
export const credentialInputSchema = z.strictObject({ version: z.literal(1), botLogin: githubLoginSchema });
export type CredentialInput = z.infer<typeof credentialInputSchema>;
export const tokenSchema = z.string().min(1).max(LIMITS.tokenBytes).regex(/^[\x21-\x7e]+$/, "Token must be one printable ASCII word");
export const credentialUnavailableReasonSchema = z.enum(["no-credential", "unknown-account"]);
export type CredentialUnavailableReason = z.infer<typeof credentialUnavailableReasonSchema>;
export const credentialResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), botLogin: githubLoginSchema, token: tokenSchema }),
  z.object({ status: z.literal("unavailable"), botLogin: githubLoginSchema, reason: credentialUnavailableReasonSchema }),
]);
export type CredentialResult = z.infer<typeof credentialResultSchema>;

export const peopleAccountsRpcSchemas = Object.freeze({
  [RPC_METHODS.describe]: { input: describeInputSchema, output: describeEnvelopeSchema },
  [RPC_METHODS.resolve]: { input: resolveInputSchema, output: resolveResultSchema },
  [RPC_METHODS.roster]: { input: rosterInputSchema, output: rosterResultSchema },
  [RPC_METHODS.credential]: { input: credentialInputSchema, output: credentialResultSchema },
} as const);

export type Negotiation =
  | { kind: "ok"; version: 1; versions: number[] }
  | { kind: "incompatible"; reason: "schema" | "version"; versions?: number[] };
export function negotiateVersion(envelope: unknown, supported: readonly number[] = [PROTOCOL_VERSION]): Negotiation {
  const parsed = describeEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { kind: "incompatible", reason: "schema" };
  const shared = parsed.data.versions.filter(v => supported.includes(v));
  if (!shared.includes(1)) return { kind: "incompatible", reason: "version", versions: parsed.data.versions };
  return { kind: "ok", version: 1, versions: parsed.data.versions };
}

// --- Pure functions -----------------------------------------------------------

/**
 * Canonical comparison key for names and aliases, offered so suppliers agree:
 * trim, NFC, lower-case, strip one leading "@". Matching policy beyond this
 * stays with the supplier.
 */
export function normalizeAliasKey(value: string): string {
  return value.trim().normalize("NFC").toLowerCase().replace(/^@/, "");
}

/** Byte budgets per reason clause, so a long clause never crowds out another. */
const REASON_BUDGET = Object.freeze({ name: 96, outcome: 384, skipped: 1024, named: 512, participants: 512 });
function clipBytes(value: string, max: number): string {
  if (utf8ByteLength(value) <= max) return value;
  let out = value;
  while (out.length && utf8ByteLength(out + "…") > max) out = out.slice(0, -1);
  // Never end on a lone high surrogate.
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out + "…";
}
const shortName = (value: string) => clipBytes(value, REASON_BUDGET.name);
function namesClause(names: readonly string[]): string {
  const shown = names.slice(0, LIMITS.reasonNames);
  const more = names.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}
function describeSkipped(skipped: SkippedV1): string {
  return skipped.status === "not-found"
    ? `"${shortName(skipped.input)}" (not in the roster)`
    : `"${shortName(skipped.input)}" (ambiguous: ${namesClause(skipped.candidates.map(c => shortName(c.displayName)))})`;
}
function participantsClause(participants: readonly string[] | undefined): string {
  if (participants === undefined) return "";
  return clipBytes(`Thread participants seen: ${participants.length ? namesClause(participants.map(shortName)) : "none"}.`, REASON_BUDGET.participants);
}
function joinClauses(clauses: readonly string[]): string {
  return clauses.filter(Boolean).join(" ");
}

/**
 * Deterministic attribution: the first resolved input is primary and supplies
 * the posting account; every resolved person's GitHub login is an assignee;
 * repeated people collapse to their first mention; ambiguous inputs never pick.
 */
export function summarizeAttribution(results: readonly ResolutionV1[], participants?: readonly string[]): AttributionV1 {
  const seen = new Set<string>();
  const people: { input: string; person: PersonSummaryV1 }[] = [];
  const skipped: SkippedV1[] = [];
  for (const result of results) {
    if (result.status !== "resolved") { skipped.push(result); continue; }
    if (seen.has(result.person.personKey)) continue;
    seen.add(result.person.personKey);
    people.push({ input: result.input, person: result.person });
  }
  const primary = people[0] ?? null;
  const postAs = primary?.person.botLogin && primary.person.credentialState !== "missing" ? primary.person.botLogin : null;
  const assignees = [...new Set(people.flatMap(p => p.person.githubLogin === null ? [] : [p.person.githubLogin]))];
  const emails = new Set<string>();
  const coAuthors = people.flatMap(({ person: { committer } }) => {
    if (committer === null || emails.has(committer.email.toLowerCase())) return [];
    emails.add(committer.email.toLowerCase());
    return [{ name: committer.name, email: committer.email }];
  });
  let outcome = "";
  if (results.length === 0) outcome = "No people were named, so authorship defaulted to the default account.";
  else if (primary === null) outcome = "Nobody named matched the roster, so authorship defaulted to the default account.";
  else if (postAs === null) {
    const why = primary.person.botLogin === null ? "has no bot account" : `has no token configured for ${primary.person.botLogin}`;
    outcome = `${shortName(primary.person.displayName)} ${why}, so authorship defaulted to the default account.`;
  }
  const skippedClause = skipped.length ? clipBytes(`Skipped: ${namesClause(skipped.map(describeSkipped))}.`, REASON_BUDGET.skipped) : "";
  const fallbackReason = outcome || skippedClause
    ? joinClauses([clipBytes(outcome, REASON_BUDGET.outcome), skippedClause, participantsClause(participants)])
    : null;
  return { primary, others: people.slice(1), skipped, postAs, assignees, coAuthors, fallbackReason };
}

/** Reason for a consumer whose supplier could not be reached at all. */
export function unavailableReason(kind: string, inputs: readonly string[], participants?: readonly string[]): string {
  const named = inputs.length ? clipBytes(`Named: ${namesClause(inputs.map(i => `"${shortName(i)}"`))}.`, REASON_BUDGET.named) : "";
  return joinClauses([clipBytes(`People accounts were unavailable (${shortName(kind)}), so authorship defaulted to the default account.`, REASON_BUDGET.outcome), named, participantsClause(participants)]);
}

/** Attribution for an unreachable supplier: nobody resolved, reason set. */
export function unavailableAttribution(kind: string, request: ResolveRequest): AttributionV1 {
  return { primary: null, others: [], skipped: [], postAs: null, assignees: [], coAuthors: [], fallbackReason: unavailableReason(kind, request.inputs, request.participants) };
}

/** Co-Authored-By trailer lines, one per co-author, in attribution order. */
export function coAuthorTrailers(attribution: Pick<AttributionV1, "coAuthors">): string[] {
  return attribution.coAuthors.map(({ name, email }) => `Co-Authored-By: ${name} <${email}>`);
}
