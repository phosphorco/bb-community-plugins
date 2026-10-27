import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { bindBbIdentity } from '@phosphorco/bb-identity/bb';
import { registerPeopleAccountsSupplier } from '@phosphorco/bb-people-accounts/bb';
import { summarizeAttribution, tokenSchema, type CredentialHealthV1, type ResolutionV1, type RosterRowV1 } from '@phosphorco/bb-people-accounts';
import { checkGitHubToken, parseRoster, tokenSlot, uncheckedHealth, type AccountFetch } from './model';
import { resolvePerson } from './resolver';
import { localContract, STATUS_CHANNEL, type PeopleStatus } from './rpc-contract';
import { runCli } from './cli';

export default async function peopleAccounts(bb: BbPluginApi, options: { fetcher?: AccountFetch } = {}) {
  const settings = bb.settings.define({
    githubOrganization: {
      type: 'string', label: 'GitHub organization',
      description: 'Set the organization that owns the repositories for your PAT setup links.',
    },
    roster: {
    type: 'string', label: 'People roster (JSON)', default: '[]', experimental_multiline: true,
    description: 'Add or update your own row, keeping teammates’ rows. Save, reload people-accounts, then paste your PAT into your secret field. Find your opaque person key in the directory below.',
  } });
  let raw = '[]';
  let readFailed = false;
  let githubOrganization: string | undefined;
  try {
    const saved = await settings.get();
    raw = saved.roster;
    githubOrganization = saved.githubOrganization?.trim();
  } catch { readFailed = true; }
  const parsed = parseRoster(raw);
  const rows: RosterRowV1[] = parsed.entries.map(entry => ({ ...entry, credential: uncheckedHealth(false) }));
  const secrets = new Map<string, () => Promise<string | null>>();
  const lifecycle = new AbortController();
  bb.onDispose(() => { lifecycle.abort(); });
  const revisions = new Map<string, number>();
  const publish = () => { if (!lifecycle.signal.aborted) bb.realtime.publish(STATUS_CHANNEL, { changed: true }); };
  const slotHealth = new Map<string, CredentialHealthV1>();
  const byBot = new Map<string, RosterRowV1[]>();
  for (const row of rows) {
    if (row.botLogin === null) continue;
    const key = row.botLogin.toLowerCase();
    const group = byBot.get(key) ?? [];
    group.push(row); byBot.set(key, group);
  }
  const refreshHealth = () => {
    for (const row of rows) row.credential = slotHealth.get(row.personKey) ?? uncheckedHealth(false);
    for (const group of byBot.values()) {
      const configured = group.map(row => slotHealth.get(row.personKey)).find(health => health && health.state !== 'missing');
      if (configured) for (const row of group) row.credential = configured;
    }
  };
  // Only factory registration defines slots: save callbacks must never redefine them.
  for (const row of rows) {
    const slot = tokenSlot(row.personKey);
    const expectedBot = row.botLogin === null ? 'bot login missing' : `@${row.botLogin}`;
    const handle = bb.settings.define({ [slot]: {
      type: 'string', label: `${row.displayName} PAT — expected ${expectedBot}`, secret: true,
      description: row.botLogin === null ? 'Fill in your bot login in your roster row and reload before creating your PAT.' :
        `Paste your PAT created while signed in as @${row.botLogin}. Use the current GitHub organization setting above as resource owner; Pull requests read/write; Contents read.`,
    } });
    const observe = (value: string | undefined) => { slotHealth.set(row.personKey, uncheckedHealth(tokenSchema.safeParse(value).success)); revisions.set(row.personKey, (revisions.get(row.personKey) ?? 0) + 1); refreshHealth(); publish(); };
    try { observe((await handle.get())[slot]); }
    catch { slotHealth.set(row.personKey, { ...uncheckedHealth(false), message: 'Stored token could not be read.' }); refreshHealth(); }
    handle.onChange((next, previous) => { if (next[slot] !== previous[slot]) observe(next[slot]); });
    secrets.set(row.personKey, async () => {
      try { const result = tokenSchema.safeParse((await handle.get())[slot]); return result.success ? result.data : null; }
      catch { return null; }
    });
  }
  let savedRaw = raw;
  settings.onChange((next, previous) => {
    const rosterChanged = next.roster !== previous.roster;
    const organizationChanged = next.githubOrganization !== previous.githubOrganization;
    if (rosterChanged) { savedRaw = next.roster; readFailed = false; }
    if (organizationChanged) githubOrganization = next.githubOrganization?.trim();
    if (rosterChanged || organizationChanged) publish();
  });
  const status = async (): Promise<PeopleStatus> => ({
    entries: rows,
    reloadRequired: savedRaw !== raw,
    diagnostics: [
      ...parsed.diagnostics,
      ...(!githubOrganization ? ['Set the GitHub organization in settings to create PAT setup links. Attribution and token checks remain available.'] : []),
      ...(readFailed ? ['Roster setting could not be read; consumers use their default account.'] : []),
      ...(savedRaw !== raw ? ['Roster changed. Reload people-accounts to activate entries and token fields.', ...parseRoster(savedRaw).diagnostics] : []),
    ],
  });
  const check = async (personKeys: readonly string[]): Promise<PeopleStatus> => {
    const requested = new Set(personKeys);
    // Each requested row checks the effective first configured slot for its bot.
    // At most 16 distinct slots per action, even for a large shared account.
    const effective = rows.filter(r => requested.has(r.personKey)).map(row =>
      row.botLogin === null ? row : byBot.get(row.botLogin.toLowerCase())?.find(other => slotHealth.get(other.personKey)?.state !== 'missing') ?? row);
    const candidates = [...new Set(effective)];
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length && !lifecycle.signal.aborted) {
        const row = candidates[cursor++]!;
        const revision = (revisions.get(row.personKey) ?? 0) + 1;
        revisions.set(row.personKey, revision);
        const token = await secrets.get(row.personKey)?.();
        const health = token ? await checkGitHubToken(token, row.botLogin, options.fetcher ?? fetch,
          lifecycle.signal) : uncheckedHealth(false);
        if (!lifecycle.signal.aborted && revision === (revisions.get(row.personKey) ?? 0)) slotHealth.set(row.personKey, health);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
    refreshHealth();
    publish();
    return status();
  };
  registerPeopleAccountsSupplier(bb, {
    listRoster: () => rows,
    resolve: input => resolvePerson(rows, input),
    credential: async botLogin => {
      // Shared bot accounts retain every human. Use first valid stored token in roster order.
      for (const row of rows) {
        if (row.botLogin?.toLowerCase() !== botLogin.toLowerCase()) continue;
        const token = await secrets.get(row.personKey)?.();
        if (token) return token;
      }
      return null;
    },
  });
  // The binding registers its own lifetime cleanup. No directory I/O during load.
  const identity = bindBbIdentity(bb);
  bb.rpc.register(localContract, {
    peopleAccountsStatus: status,
    peopleAccountsCheck: ({ personKeys }) => check(personKeys),
    async peopleAccountsDirectory({ query }) {
      const unavailable = { items: [], reason: 'Identity directory unavailable. Known opaque person keys can still be configured.', truncated: false };
      if (!identity.ok) return unavailable;
      const binding = identity.value;
      try {
        return await binding.background(async invocation => {
          const result = await binding.endpoint.search(invocation, { query, kinds: ['person'], history: 'current', limit: 50 });
          if (!result.ok) return unavailable;
          return {
            items: result.value.items.map(p => ({ personKey: p.identity.key, displayName: p.presentation.displayName, handle: p.presentation.handle })),
            reason: null, truncated: result.value.nextCursor !== null,
          };
        });
      } catch { return unavailable; }
    },
  });
  bb.cli.register({
    name: 'people-accounts', summary: 'Resolve human attribution and show roster/token health.', rendersHelp: true,
    commands: [
      { name: 'resolve', summary: 'Resolve ordered humans; JSON or pure Co-Authored-By trailers.', usage: 'resolve --for EMAIL_OR_HANDLE [--for MORE...] [--format json|trailers]' },
      { name: 'status', summary: 'Show roster, token health and configuration diagnostics.', usage: 'status [--check]'  },
    ],
    run: argv => runCli(argv, {
      status,
      async check() {
        for (let start = 0; start < rows.length; start += 16) await check(rows.slice(start, start + 16).map(row => row.personKey));
        return status();
      },
      async resolve(inputs) {
        const results: ResolutionV1[] = inputs.map(input => ({ input, ...resolvePerson(rows, input) }));
        return { version: 1, results, attribution: summarizeAttribution(results) };
      },
    }),
  });
}
