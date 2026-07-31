# WebDAV sync reliability

ShellDesk treats a successful WebDAV `PUT` as provisional. The local sync baseline advances only after a subsequent authenticated `GET` returns the exact encrypted bytes that were uploaded.

## Write sequence

1. Read and decrypt the current remote document.
2. Merge it with the current local Vault snapshot.
3. Upload an encrypted package with `If-Match` or `If-None-Match` when the server provides enough state for a conditional write.
4. Read the same path back, with three short attempts for servers whose read visibility lags behind their write response.
5. Compare the exact bytes and SHA-256 digest, and prefer the ETag from the verified `GET`.
6. Re-check the local Vault footprint. If local content changed during the operation, merge and upload again.
7. Apply the verified merged document and persist `lastRecords`, tombstones, sync time, and ETag.

Any read-back mismatch, oversized response, unsupported document, concurrent ETag change, or decryption failure stops before steps 6–7. The previous baseline remains intact.

## Format and migration invariants

- Local sync settings with `format: shelldesk-sync-settings` must use version 1.
- Encrypted packages must use version 1, AES-256-GCM, PBKDF2-SHA256, and an iteration count inside the supported bound.
- Current remote documents must use `format: shelldesk-sync-webdav`, version 1, object-shaped device/record/tombstone maps, matching map keys and record IDs, supported record types, SHA-256 hashes, and RFC 3339 timestamps.
- Future versions and unknown named formats are rejected instead of being reinterpreted as legacy data.
- Legacy migration is allowed only for an unversioned, recognizable Vault snapshot containing both `hosts` and `settings`.

These invariants are covered by unit tests and generated property cases for valid document normalization and content-idempotent merge behavior.
