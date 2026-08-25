# Plugin-contributed syntax highlighting

## Concrete need

Allow a bb plugin to add syntax support to the host-owned Markdown renderer,
including conversation timeline messages and the SDK `Markdown` component.

Highlighting is currently built into bb core. Fence names are extracted from
`language-*` classes and a private Sugar High registry selects from a small
set of presets. The public `Markdown` component accepts only `content` and
`className`, so plugins cannot register languages, aliases, or grammars.

This means a plugin for a language or DSL can render highlighted code inside
its own custom UI, but cannot make ordinary fenced code render correctly in bb
chat.

## Concrete example

A Typst plugin should be able to bundle a TextMate grammar and declare:

```json
{
  "bb": {
    "languages": [
      {
        "id": "typst",
        "name": "Typst",
        "fenceAliases": ["typst", "typ"]
      }
    ],
    "grammars": [
      {
        "language": "typst",
        "scopeName": "source.typst",
        "path": "./syntaxes/typst.tmLanguage.json"
      }
    ]
  }
}
```

After installation, this fence should highlight everywhere bb renders
Markdown:

````markdown
```typ
#set page(width: 10cm)
Hello, world!
```
````

Disabling or removing the plugin should safely return the block to escaped,
plain code.

## Recommended design

Follow VS Code's declarative language-extension model:

- Plugins contribute language metadata, aliases, and TextMate grammar assets
  through `package.json`.
- bb validates and loads those assets.
- bb owns tokenization, rendering, escaping, themes, controls, caching, and
  failure handling.
- Plugin code does not execute in the streaming Markdown render path and does
  not return highlighted HTML.

Keep `languages` and `grammars` separate:

- Languages establish global canonical IDs and fence aliases.
- Grammars bind a language ID to a plugin-relative TextMate file.
- Grammars emit standard TextMate scopes.
- The active bb code theme assigns colors to those scopes. Language plugins do
  not provide a palette.

Shiki is a natural host tokenizer because it supports VS Code/TextMate
grammars, dynamically loaded custom languages and aliases, and VS Code themes.

The rendering path should be:

```text
Fence label
  -> canonical language resolution
  -> grammar resolution
  -> host highlighting worker
  -> token ranges
  -> host-rendered spans
  -> active bb code theme
```

The worker should return tokens rather than HTML. bb should continue to own the
`<pre>` and `<code>` DOM, source escaping, copy button, wrap control,
accessibility, and streaming lifecycle.

## Important implementation requirements

### One host pipeline

Prefer one highlighting engine for built-in and contributed languages. Migrate
the existing Sugar High languages to the same Shiki pipeline rather than
permanently maintaining two rendering and theming models.

The host `Markdown` capability remains the owner. This is a manifest
contribution, not an `app.tsx` rendering slot.

### Identity and conflicts

Language IDs must remain global because Markdown uses `typst`, not a
plugin-qualified identifier.

- Namespace grammar contribution identities internally by plugin.
- Built-in canonical language IDs win and cannot be shadowed.
- Do not silently resolve duplicate plugin language IDs or aliases by load
  timing.
- Report rejected or ambiguous contributions in plugin status/details.
- An alias cannot shadow a canonical ID.
- A missing or ambiguous grammar falls back to escaped plain code.

### Loading, streaming, and caching

Use a long-lived host highlighting worker with:

- lazy grammar loading;
- a cache keyed by grammar hash, theme ID, language, and source hash;
- cancellation or stale-result rejection as assistant content streams;
- a short debounce for the currently streaming fence;
- immediate plain-code rendering while a grammar loads;
- source and grammar size limits; and
- worker termination and restart if tokenization exceeds a time budget.

Plugin disable or reload must atomically remove the old grammar generation,
invalidate affected cache entries, and re-highlight visible blocks or fall back
to plain code.

### Safety and provenance

TextMate grammars are declarative data, but their regular expressions can
still consume excessive CPU.

- Resolve grammar paths within the plugin directory and reject symlink escapes.
- Validate grammar JSON and cap its size during installation or activation.
- Tokenize outside the main thread with a recoverable time limit.
- Restrict external grammar includes to built-in scopes or explicitly declared
  dependencies.
- Require plugins to preserve the grammar's license and attribution.
- Never accept arbitrary JavaScript tokenizers or raw highlighted HTML in the
  initial API.

## Suggested scope

### Initial version

- Manifest-declared languages and fence aliases.
- One TextMate grammar per contributed language.
- Shiki tokenization in a host worker.
- Host-rendered tokens using the active code theme.
- Deterministic conflict diagnostics and plain-text fallback.
- Atomic plugin load, reload, disable, and removal behavior.

### Defer until demonstrated need

- Overriding a built-in grammar.
- User-selectable competing grammars.
- Injection grammars that extend an existing language.
- Embedded-language mappings.
- Programmatic or semantic token providers.

Semantic token providers are valuable in an editor with complete documents
and a language server. Chat snippets usually lack enough project context to
justify putting programmatic providers in the streaming render path.

## Likely bb implementation surfaces

- Plugin manifest schema:
  `packages/domain/src/plugin-manifest.ts`
- Manifest asset resolution and validation:
  `apps/server/src/services/plugins/manifest.ts`
- Plugin capability and conflict reporting:
  `apps/server/src/services/plugins/plugin-service.ts`
- Host Markdown renderer:
  `apps/app/src/components/ui/markdown-preview.tsx`
- Current highlighter registry:
  `apps/app/src/components/ui/markdown-code-highlight.ts`
- Current code token palette:
  `apps/app/src/components/ui/markdown-code-highlight.css`
- A new app-side active grammar catalog and highlighting worker.
- A server/app contract for delivering active manifest contributions and
  content-addressed grammar assets to clients.

## Acceptance criteria

- A plugin grammar highlights its canonical language ID and aliases.
- The same grammar works in timeline messages and the SDK `Markdown`
  component.
- Unknown, malformed, disabled, or removed grammars render escaped plain code.
- Plugin reload replaces its grammar without stale tokens.
- Built-in IDs cannot be shadowed.
- Alias collisions are deterministic and diagnosable.
- A stale streaming result cannot replace tokens for newer source.
- Path escapes and oversized grammar assets are rejected.
- Source containing HTML cannot inject DOM.
- Light, dark, and plugin-contributed code themes style the grammar correctly.
- Existing copy and wrap behavior remains unchanged.

## References

- [VS Code syntax highlighting guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)
- [VS Code language extensions overview](https://code.visualstudio.com/api/language-extensions/overview)
- [VS Code semantic highlighting guide](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)
- [Shiki custom language loading](https://shiki.style/guide/load-lang)
- [Shiki bundles and performance](https://shiki.style/guide/bundles)
- [Current bb Markdown highlighter](https://github.com/get-bb/bb/blob/main/apps/app/src/components/ui/markdown-code-highlight.ts)
