# Local history and log retention

Stable and Beta apply the same limits within their own data homes.

| Store                           | Limit                                                      | What Synara keeps                                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached terminal views         | Six views, 20,000 buffer lines, ten minutes idle           | Attached views, authentication views, and output that has not finished parsing. The newest detached view survives count and line pressure until its idle expiry.                                                                                                                    |
| Inactive terminal history files | Thirty days and 64 MiB total                               | Files for resident sessions, sessions opening now, and pending writes. Synara checks at startup, after close or archive, and every ten minutes.                                                                                                                                     |
| Provider debug logs             | 10 MiB per file, ten backups, 256 MiB across the directory | The newest files within the budget. Writes use 200 ms async batches and at most 8 MiB of queued records. A full queue drops debug records and logs a warning.                                                                                                                       |
| Checkpoint restore history      | 500 checkpoint entries per thread                          | Active turns, the initial baseline, and recovery refs. Old completed restore entries expire together with their Git refs. Failed ref cleanup retries on later checkpoint events, up to 200 retired turns per pass.                                                                  |
| Automation results              | 500 recent runs per automation                             | Active runs, the latest finished run, and runs awaiting completion evaluation. Old manual rows are deleted. Old scheduled rows keep their occurrence identity and permission snapshot so a retry cannot run the same occurrence twice; their result and error payloads are cleared. |

Terminal output appends deltas to disk. Synara compacts the file when it reaches twice the configured history byte limit. Reopening applies the existing byte and line limits. Close and shutdown drain pending writes. A disk failure logs a warning; it does not stop the terminal.

Provider event logs are off by default. `--log-provider-events` or `SYNARA_LOG_PROVIDER_EVENTS=true` enables them for debugging. Native and canonical records share one write queue and retain their stream labels. Shutdown flushes the queue. If rotation fails, the sink truncates the current file or stops appending when truncation also fails; it retries rotation after thirty seconds.

Codex lifecycle events keep ordinary item data in the canonical payload. Their raw field keeps protocol metadata without a second data copy. Generated-image records keep the existing sanitized raw fields.

Checkpoint expiry removes old file restore choices. It keeps the turn lifecycle and conversation history. Git can reclaim objects after their last ref is removed during normal maintenance. Synara does not force Git garbage collection.

Settings saves compare stored secret bytes. An unrelated setting change does not rewrite unchanged provider secrets. Secret changes and removal still use the existing rollback and cleanup paths.
