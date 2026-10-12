# Server performance checks

All checks use synthetic data in this worktree. They do not use an installed app or a user database.

## Activity fingerprints

The activity fingerprint now stores a SHA-256 hex digest of the same serialization of `kind`, `summary`, `payload`, and `turnId`. Live duplicate checks and durable replay call the same helper. The cache size and lifetime do not change.

A Bun harness feeds 1,000 distinct tool keys with 8,000-character ASCII bodies into `providerActivityUpdateDedupeKey` and `providerActivityUpdateFingerprint`. After `Bun.gc(true)`, it totals the bytes in the retained map values. The before run uses the original helper; the after run uses the digest helper.

| Measure                          |    Before |  After |         Reduction |
| -------------------------------- | --------: | -----: | ----------------: |
| Retained entries                 |     1,000 |  1,000 |                 0 |
| Retained fingerprint UTF-8 bytes | 8,115,890 | 64,000 | 8,051,890 (99.2%) |

This saves 7.68 MiB of encoded text. It does not measure total heap or RSS. The full serialization still exists briefly during hashing. SHA-256 collisions remain a theoretical risk.

The new fixed-size test fails with the original helper and passes with the digest. Tests also check each input field and prove that changes to event identity, time, tone, and sequence do not change the fingerprint. The projection and ingestion suites pass: 243 tests, including durable duplicate recovery.
