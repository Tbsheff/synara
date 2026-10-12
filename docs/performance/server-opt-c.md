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

## Thread title-version index

Migration 136 creates a partial `(aggregate_kind, stream_id, sequence)` index. Its predicate matches the repository title-version query: thread creation, archive, deletion, or a metadata update with a text title. Non-title events do not enter this index. It uses `CREATE INDEX IF NOT EXISTS` and the existing additive-only marker. The marker test now permits pure JSON functions while still rejecting row-change statements.

The new tests capture the SQL prepared by the real event-store repository and check its query plan. They fail before migration 136 and pass after it. They cover fresh databases, upgrade, repeated execution, unchanged rows, null and numeric titles, unrelated metadata, another thread, an absent thread, explicit title regeneration, archive, and deletion.

The measurement harness copies the schema through migration 134 into memory. It loads short and long histories with one initial title and 100-character assistant deltas. The regeneration cases replace the middle event with a text-title update. A SQLite progress handler counts every VM step for one query. Timing then runs without the handler: ten warmups and the mean of 200 queries. Every before and after result matches.

| Events | Explicit regeneration | VM steps before → after | Mean µs before → after |
| ------ | --------------------- | ----------------------: | ---------------------: |
| 32     | No                    |                433 → 77 |            7.82 → 0.72 |
| 32     | Yes                   |                261 → 77 |            3.95 → 4.65 |
| 2,140  | No                    |             23,621 → 77 |          447.71 → 0.75 |
| 2,140  | Yes                   |             11,855 → 77 |          259.37 → 0.76 |
| 50,000 | No                    |            550,081 → 77 |       37,769.77 → 1.14 |
| 50,000 | Yes                   |            275,085 → 77 |       11,061.83 → 3.44 |

The query plan changes from `idx_orch_events_stream_sequence` to `idx_orch_events_thread_title_sequence`. The 2,140-event initial-title case removes 99.7% of VM steps. Timing has host noise; the short regeneration case shows no time gain in this run. The new index uses one 4,096-byte page in each case. It adds writes for title-changing events and must scan existing history once when it is built. A future query predicate change must update the index predicate too.

## Files and local evidence

| Item          | Source and tests                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprints  | `apps/server/src/orchestration/providerRuntimeActivityProjection.ts`, `providerRuntimeActivityProjection.test.ts`; existing `Layers/ProviderRuntimeIngestion.test.ts` covers recovery                                                          |
| Receipt index | `apps/server/src/persistence/Migrations/135_DropUnusedReceiptSequenceIndex.ts`, `receiptSequenceIndex.test.ts`; registration and tracker expectations in `Migrations.ts` and `Migrations.test.ts`; backup fixture in `MigrationBackup.test.ts` |
| Title index   | `apps/server/src/persistence/Migrations/136_ThreadTitleVersionIndex.ts`, `threadTitleIndex.test.ts`; registration and tracker expectations in `Migrations.ts` and `Migrations.test.ts`; marker checks in `MigrationBackup.test.ts`             |

Both migrations apply to Stable and Beta. Neither migration changes user data or app identity. The production change reuses the existing serializer, fingerprint helper, crypto import, SQL layer, and migration marker.

The ignored `.opt-c/` folder in this worktree keeps the measurement scripts, raw query plans, before and after values, and test logs. Use `bun .opt-c/fingerprint-measure.ts`, `python3 .opt-c/receipt-measure.py`, and `python3 .opt-c/title-measure.py` to repeat the current measurements. The receipt and title scripts use the isolated `.opt-c/baseline.sqlite` schema. The fingerprint script runs the current helper; the recorded before run used the original helper.

## Verification

| Check                                                                         | Result                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bun run fmt:check`                                                           | Pass                                                                                                          |
| `bun run lint`                                                                | Pass; 1,032 warnings, no errors; synchronous filesystem budget passes                                         |
| `bun run typecheck`                                                           | Pass; all eight workspace tasks pass                                                                          |
| `bun run migrations:check`                                                    | Fails only on the existing released-name conflicts for IDs 38–65; none for 135 or 136                         |
| Activity projection and ingestion                                             | 243 tests pass; projection rerun after the test type fix: 71 pass                                             |
| Migration, backup, replay, receipt, event-store, and engine durability suites | Eight files, 78 tests pass                                                                                    |
| Import history and recovery                                                   | Two files, 10 tests pass                                                                                      |
| Broad checkpoint suite                                                        | 92 pass, eight fail; group retry repeats the eight failures                                                   |
| Starting-source checkpoint comparison                                         | Four of those eight fail with the original production source and migration registry at `50bdb4681`; four pass |
| Focused checkpoint checks with the changes                                    | Three of the other four pass together; the workspace-alias case passes alone                                  |

The four failures reproduced on the starting source cover the three blocked-workspace publication cases and the peer-claim ACK case. The remaining four cases have short waits for state or Git refs and pass in focused runs. The broad checkpoint suite remains red; these runs do not prove why its result varies.

All Git test runs use `GIT_CONFIG_GLOBAL=/dev/null`. The checks use test fixtures and isolated databases. No installed Synara app, user data home, or live provider was tested. All new item tests have a recorded failure before the change and a pass afterward.
