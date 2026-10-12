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

## Receipt sequence index

Migration 135 drops only `idx_orch_command_receipts_sequence` with `DROP INDEX IF EXISTS`. It keeps the primary-key and aggregate indexes and all receipt rows. It has no additive-only marker, so the normal migration backup applies. It leaves migration 002 unchanged.

A repository-wide SQL search and TypeScript syntax-tree scan found 32 SQL statements that name the receipt table, including tests and schema changes. `EXPLAIN QUERY PLAN` ran on each statement before and after the drop. The two historical column additions used a pre-column schema; other statements used the schema through migration 134. No plan uses the sequence index. DDL and insert plans have no read-plan rows.

| Runtime source                                       | SQL lines                                   | Receipt access                                                               |
| ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| `persistence/Layers/OrchestrationCommandReceipts.ts` | 22, 55                                      | Insert; command-ID primary-key lookup                                        |
| `persistence/projectImportRepository.ts`             | 96                                          | Command-ID primary-key lookup                                                |
| `orchestration/Layers/CheckpointReactor.ts`          | 359, 411, 882, 1413, 2404, 2532, 2762, 2776 | Command-ID primary-key lookup; the two-command OR uses that same index twice |

The write harness uses the actual receipt insert SQL, plus one synthetic 100-character assistant-delta event per receipt. Each of 16,015 pairs commits in its own transaction. It uses WAL, `synchronous=NORMAL`, and no automatic checkpoint. It takes five trials per variant in alternating order. Python SQLite 3.53.4 reports these medians:

| Measure                                 |      Before |       After |                Reduction |
| --------------------------------------- | ----------: | ----------: | -----------------------: |
| Append CPU time                         | 2,707.55 ms | 2,581.04 ms |                     4.7% |
| WAL bytes                               | 747,697,632 | 677,163,232 |                     9.4% |
| Receipt-sequence index pages            |          46 |           0 |                       46 |
| Receipt-sequence index bytes            |     188,416 |           0 |                  184 KiB |
| Receipt insert `IdxInsert` instructions |           3 |           2 | One per accepted receipt |

These results measure isolated SQLite writes, not full server throughput. Space becomes reusable; the migration does not shrink the database file. The two migration tests fail before registration and pass afterward. They cover upgrade, row preservation, retained indexes, repeated execution, and fresh databases. A future query that filters on receipt sequence could need a new index.
