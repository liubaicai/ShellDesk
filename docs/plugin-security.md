# Plugin security boundary

ShellDesk does not execute third-party plugins yet. The plugin security module is the boundary that a future loader and worker runtime must use before installation or execution. Manifest review is deliberately non-capability-bearing: a successful review proves only that the manifest syntax and scopes satisfy the current policy.

## Invariants

- Access is denied unless a permission is recognized and explicitly declared.
- Unknown permissions fail manifest review. There is no forward-compatible wildcard or implicit grant.
- Permissions with reach beyond the plugin itself require scopes. Network access accepts exact HTTPS origins only; plugin storage accepts relative paths inside a plugin-private root; host and terminal permissions require exact host identifiers.
- A reviewed plugin receives an isolated namespace under `plugin-data/<plugin-id>`. Host filesystem access and inherited environment variables remain denied, and a separate worker process is required before execution support can be added.
- Manifest review never returns a token, handle, or other runtime capability.
- Security decisions are persisted to a private, bounded audit file. A successful review fails closed if the audit entry cannot be written.
- Manifest fields outside the review schema are ignored and never copied into the audit log.

## Current backend surface

The typed bridge exposes three administrative calls:

- `plugins:get-security-policy` returns the permission catalog and isolation defaults.
- `plugins:review-manifest` validates an untrusted manifest and returns the normalized decision matrix and isolation profile.
- `plugins:list-security-audit` returns the bounded review audit.

These calls do not install or run code. A future executor must keep a trusted, backend-owned registry of approved manifests and re-check the exact permission and scope at every privileged sink. Renderer-supplied review output must never be treated as authorization.

## Permission catalog

| Permission | Scope | Intended boundary |
| --- | --- | --- |
| `settings.read` | Public setting key | Only language, theme, accent color, and interface font |
| `hosts.metadata.read` | Host ID | Non-secret host metadata |
| `plugin.storage.read` | Relative plugin path | Plugin-private storage only |
| `plugin.storage.write` | Relative plugin path | Plugin-private storage only |
| `network.connect` | HTTPS origin | Exact declared origins; no URL paths, credentials, query, or fragment |
| `terminal.open` | Host ID | Future isolated terminal creation |
| `terminal.write` | Host ID | Future terminal input; classified critical |
| `clipboard.write` | None | Local clipboard write |
| `notifications.show` | None | Local notification display |

Vault secrets, arbitrary host filesystem paths, process spawning, shell commands, and unrestricted network access are intentionally absent from the catalog.
