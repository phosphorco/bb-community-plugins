# @phosphorco/bb-provider-settings changelog

## 0.1.1

- Support Plugin SDK 0.6: the peer range is now `>=0.5.29 <0.6 || ^0.6.29`.
- Fix version-only owner envelopes under Zod 4.4 and later. Zod no longer treats
  a `z.unknown()` object key as implicitly optional, so an envelope with only
  `protocol` and `versions` was reported as "could not be understood". The
  envelope's `roles` key is now explicitly optional, with a regression test.
  `negotiateVersion` still rejects a v1 envelope without roles.
- `CatalogSdk` and `OwnerSdk` now name only the four SDK methods the directory
  calls (`providers.list`/`models`, `plugins.list`/`callRpc`). This narrowing is
  a patch-level change: every SDK object accepted by 0.1.0 is still accepted,
  callers may now pass a narrowed SDK object, and later SDK releases may add
  methods to these areas without breaking consumers.

## 0.1.0

- Initial release.
