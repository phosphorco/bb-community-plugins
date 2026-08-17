# Support image icons in plugin mention providers

## Concrete need

Plugin mention providers can represent people, repositories, services, and
other entities whose most recognizable compact identity is an image. BB owns
the mention menu, composer pill, queued-message UI, and conversation timeline,
so an individual plugin cannot add an image consistently across those host
surfaces.

BB should let a mention provider supply an HTTPS image URL as declarative row
metadata while retaining the existing named-icon fallback.

## Concrete example

A directory plugin searches a company directory after the user types `@ex`.
It returns this public SDK value:

```ts
{
  id: "person_123",
  title: "Example User",
  subtitle: "person@example.test",
  icon: "User",
  iconUrl: "https://images.example.test/profiles/person_123.png",
}
```

Success is observable when the profile image appears in the matching mention
menu row, remains visible in the selected composer pill and sent message, and
falls back to the `User` icon if the URL is unavailable. The image URL is UI
metadata and does not appear in content delivered to the agent.

## Current limitation

The public [`PluginMentionItem`](https://github.com/get-bb/bb/blob/main/packages/plugin-sdk/src/backend-contract.ts)
contract has `icon?: string`, but no image field. The server's mention search
normalizer carries that value as a string in
[`plugin-service.ts`](https://github.com/get-bb/bb/blob/main/apps/server/src/services/plugins/plugin-service.ts),
and the app maps it into a mention suggestion in
[`pluginMentionSuggestions.ts`](https://github.com/get-bb/bb/blob/main/apps/app/src/hooks/pluginMentionSuggestions.ts).

For plugin mentions, the host ultimately renders
[`PluginIcon`](https://github.com/get-bb/bb/blob/main/apps/app/src/components/plugin/PluginIcon.tsx).
That component treats contribution-level `icon` as a named shared-UI icon
hint; an unknown string falls back to plugin branding or `Zap`. Passing an
image URL in `icon` therefore cannot render an image. Overloading `icon` to
sometimes mean a name and sometimes mean a URL would also make validation and
fallback behavior ambiguous.

The host is the correct owner because the same selected mention is rendered
in multiple host-owned lifecycle states. A plugin-local component or DOM
mutation could affect only one transient surface and would bypass BB's
accessibility, persistence, security, and error-containment rules.

## Recommended design

Add a separate optional `iconUrl` field without changing the meaning of
`icon`:

```ts
export interface PluginMentionItem {
  id: string;
  title: string;
  subtitle?: string;

  /** Named shared-UI icon used as a fallback. */
  icon?: string;

  /** HTTPS image displayed in the host-owned mention icon box. */
  iconUrl?: string;
}
```

Use this rendering precedence:

1. A valid and loadable `iconUrl`.
2. The contribution's recognized named `icon`.
3. The owning plugin's compact branding.
4. BB's generic plugin icon.

`iconUrl` should travel through mention search and BB's UI-side mention model.
BB should retain enough presentation metadata to restore drafts and render
persisted messages, while omitting `icon` and `iconUrl` from the normalized
agent-bound representation. An avatar URL can contain identity details or
signed query parameters; the model does not need either field to resolve the
mention.

The initial stored representation could remain additive:

```ts
{
  kind: "plugin",
  pluginId: "directory-plugin",
  itemId: "person:person_123",
  label: "Example User",
  icon: "User",
  iconUrl: "https://images.example.test/profiles/person_123.png",
}
```

Before provider input is constructed, BB should project that value to the
machine and display fields that the agent actually needs:

```ts
{
  kind: "plugin",
  pluginId: "directory-plugin",
  itemId: "person:person_123",
  label: "Example User",
}
```

This separation would also make the existing named `icon` explicitly
presentation-only.

## Ownership, trust, and lifecycle

Mention providers are installed code, but their returned URLs are still
untrusted input to a frequently rendered host surface. BB, rather than the
plugin, should create the image element and enforce the following boundary:

- Accept only absolute `https:` URLs in the first version.
- Reject credentials embedded in the URL and impose a documented length
  limit.
- Do not accept `data:`, `blob:`, `file:`, `javascript:`, or CSS image values.
- Render with an empty alt value and `aria-hidden` because the adjacent title
  supplies the accessible name.
- Use `loading="lazy"`, `decoding="async"`, and
  `referrerPolicy="no-referrer"`.
- Constrain the image to the existing icon box and use `object-fit: cover` so
  dimensions cannot change row or pill layout.
- Contain decode and network failures locally and immediately render the
  normal icon fallback.

A persisted URL is a snapshot and may expire. That is acceptable when failure
falls back cleanly. BB should avoid initiating new requests for a persisted
plugin image after the owning plugin is removed. Disabling behavior should be
chosen explicitly and tested; the conservative default is to fall back while
the plugin is disabled.

No plugin callback should run during timeline rendering. Mention search
already supplies the declarative URL, and historical rendering should remain
fast and deterministic apart from the browser's normal image fetch.

## Important implementation requirements

- Validate and normalize `iconUrl` alongside `icon` when provider search
  results cross the server boundary. A malformed optional URL should become
  `null` or reject that provider result according to the existing malformed
  result policy; it must not break other providers' search groups.
- Add `iconUrl` to the server search result, the app's runtime validator, the
  plugin mention suggestion variant, and the persisted plugin mention schema.
- Preserve the field through editor serialization, clipboard round-trips,
  draft restoration, queued messages, and timeline data.
- Extend one shared prompt-mention visual component and use it from both the
  menu and persisted mention renderers. Do not implement separate image rules
  for each surface.
- Reset image failure state when a recycled menu row receives a different URL.
- Keep image loading out of keyboard-navigation and suggestion-ranking logic.
- Sanitize presentation fields at the provider/agent input boundary, not at
  storage time, so the host can still render historical messages.
- Preserve old messages where `icon` and `iconUrl` are absent and old providers
  that return only `icon`.

## Suggested initial scope

The first useful release should support one optional absolute HTTPS raster or
SVG URL per plugin mention item, displayed inside the existing icon box with a
named-icon fallback. It should cover the mention menu, composer pill, queued
message presentation, and conversation timeline.

The URL can be treated as a snapshot selected at mention insertion time. BB
does not need a new provider callback or a live avatar refresh mechanism for
the initial version.

## Deferred or non-goals

- Uploading or managing avatar assets on behalf of plugins.
- Refreshing expired or changed avatars in historical messages.
- Authenticated image requests with plugin-specific headers.
- Per-item image shapes, badges, presence indicators, or arbitrary React
  renderers.
- Generalizing all plugin contribution icons into a new visual descriptor in
  the same change.
- Proxying and caching remote images. BB can add that later if product privacy
  requirements should prevent clients from contacting image hosts directly.

## Likely BB implementation surfaces

The current public source suggests these implementation areas:

- `packages/plugin-sdk/src/backend-contract.ts`: public
  `PluginMentionItem` contract and documentation.
- `apps/server/src/services/plugins/plugin-service.ts` and
  `plugin-service-internal.ts`: result validation and normalized search item.
- `apps/app/src/hooks/queries/plugin-contribution-queries.ts` and
  `apps/app/src/hooks/pluginMentionSuggestions.ts`: wire validation and app
  mapping.
- `apps/app/src/components/promptbox/mentions/types.ts`: suggestion model.
- `packages/domain/src/shared-types.ts`: persisted plugin mention resource.
- `apps/app/src/components/promptbox/editor/prompt-editor-serialization.ts`:
  selected suggestion and editor round-trip.
- `apps/app/src/components/promptbox/mentions/PromptMentionIcon.tsx` and
  `MentionMenu.tsx`: shared image rendering and menu reuse.
- Provider adapter or prompt-normalization code: remove presentation-only
  fields before constructing agent-visible input.

These are likely surfaces, not a requirement to preserve the current internal
file organization.

## Acceptance criteria

1. A plugin mention provider can return a valid `iconUrl` and named `icon`
   fallback through the public SDK.
2. The image renders in the provider's mention-menu row, selected composer
   pill, queued-message UI, and persisted conversation timeline.
3. An invalid, blocked, expired, or failed image renders the documented
   fallback without layout shift, broken-image chrome, or an unhandled error.
4. Existing icon-only providers and historical plugin mentions render exactly
   as before.
5. Draft, editor, clipboard, queue, send, reload, and timeline serialization
   preserve the UI presentation where applicable.
6. Neither `icon` nor `iconUrl` appears in the agent-visible prompt payload.
7. A removed plugin causes its persisted remote mention images to fall back
   without issuing new image requests.
8. Search latency, ranking, keyboard navigation, and other providers' results
   are unaffected by image loading or failure.
9. Server, SDK public-type, app mapping, serialization, renderer, failure, and
   agent-boundary tests cover the new behavior.

## References

- [BB plugin SDK mention-provider contract](https://github.com/get-bb/bb/blob/main/packages/plugin-sdk/src/backend-contract.ts)
- [BB plugin mention server normalization](https://github.com/get-bb/bb/blob/main/apps/server/src/services/plugins/plugin-service.ts)
- [BB plugin mention suggestion mapping](https://github.com/get-bb/bb/blob/main/apps/app/src/hooks/pluginMentionSuggestions.ts)
- [BB plugin mention resource schema](https://github.com/get-bb/bb/blob/main/packages/domain/src/shared-types.ts)
- [BB prompt mention renderer](https://github.com/get-bb/bb/blob/main/apps/app/src/components/promptbox/mentions/PromptMentionIcon.tsx)
- [MDN: `<img>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img)
- [MDN: `Referrer-Policy`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
