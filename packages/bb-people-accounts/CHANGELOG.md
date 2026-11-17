# @phosphorco/bb-people-accounts changelog

## 0.2.0-dev.0 — source candidate, unpublished

- Add explicit v2 identity-supplier/link-reader schemas, shared identity codecs
  and pure state-resource descriptor, bounded owner clients/discovery and real
  SDK-handler conformance. No link storage, account policy or credential API.
- Retain all existing v1 entries, methods, matching and credential conventions.
- Keep all plugin migrations, live mappings and package publication separate.

## 0.1.1

- Re-release of 0.1.0 through GitHub trusted publishing with provenance; no
  source changes.

## 0.1.0-attribution.0

- Initial prerelease: People Accounts wire v1 (`peopleAccountsDescribe`,
  `peopleAccountsV1Resolve`, `peopleAccountsV1Roster`,
  `peopleAccountsV1Credential`), roster and attribution DTOs, owner-bound
  client with fail-open resolution, supplier registration helper and
  conformance kit.

## 0.1.0

- Exact opaque keys take priority; roster keys and inputs share 512 UTF-8 bytes.
- One shared human summary deduplicates human logins case-insensitively and
  leaves all account/credential policy with the consumer.
- Direct fixed-v1 calls replace describe/negotiation; malformed installed
  contracts raise clear errors while absence remains fail-open.
