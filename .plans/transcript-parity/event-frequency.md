# Provider event frequency (real Synara usage)

Sources: `~/.synara/userdata/state.sqlite` (+WAL), raw-copied to a temp dir (sqlite `.backup` hit "database is locked" because the app was running; plain `cp` of db+wal used), queried only the copy, copy deleted. Provider per thread from `orchestration_events` `thread.created` `modelSelection.provider` (all 447 threads mapped; 0 unknown).
Tables: `projection_thread_activities` (125,560 rows, the full activity history), `provider_runtime_events` (1,331 rows, claudeAgent only, small retained buffer with raw SDK message types). `~/.synara/*/logs/provider` is empty (no NDJSON logs). The `dev` DB was not analysed.

Tool-name column: `data.toolName`, else `data.item.type`, else `data.kind` (ACP kind). Blank = payload had none of these.

## Activities per provider
| provider | activities |
|---|---|
| codex | 99953 |
| claudeAgent | 16751 |
| grok | 6166 |
| devin | 1665 |
| antigravity | 693 |
| opencode | 320 |
| pi | 12 |

## Activity kind by provider (top 60)
| provider | kind | count |
|---|---|---|
| codex | tool.started | 24573 |
| codex | tool.completed | 24554 |
| codex | task.progress | 20528 |
| codex | tool.output.delta | 14608 |
| codex | context-window.updated | 10634 |
| claudeAgent | context-window.updated | 5254 |
| claudeAgent | tool.updated | 3142 |
| grok | tool.started | 2845 |
| claudeAgent | tool.started | 2355 |
| claudeAgent | tool.completed | 2342 |
| claudeAgent | task.progress | 2079 |
| codex | runtime.warning | 1844 |
| grok | tool.updated | 1675 |
| codex | provider.event.unmapped | 1608 |
| grok | tool.completed | 1433 |
| codex | account.rate-limits.updated | 823 |
| devin | tool.updated | 810 |
| claudeAgent | task.started | 444 |
| claudeAgent | task.completed | 428 |
| antigravity | tool.started | 324 |
| antigravity | tool.completed | 316 |
| codex | context-compaction | 314 |
| opencode | context-window.updated | 299 |
| devin | context-window.updated | 280 |
| devin | tool.completed | 277 |
| devin | tool.started | 277 |
| claudeAgent | account.rate-limits.updated | 217 |
| claudeAgent | turn.completed | 156 |
| claudeAgent | runtime.warning | 116 |
| codex | mcp.status.updated | 114 |
| codex | turn.completed | 101 |
| claudeAgent | checkpoint.captured | 89 |
| claudeAgent | task.updated | 85 |
| codex | checkpoint.captured | 83 |
| grok | account.rate-limits.updated | 71 |
| grok | turn.completed | 58 |
| codex | provider.runtime.reconciled | 52 |
| grok | checkpoint.captured | 39 |
| codex | runtime.error | 30 |
| claudeAgent | context-window.configured | 27 |
| codex | turn.tasks.updated | 25 |
| grok | turn.tasks.updated | 24 |
| opencode | account.rate-limits.updated | 21 |
| codex | provider.turn.start.failed | 19 |
| antigravity | task.completed | 15 |
| antigravity | task.started | 15 |
| codex | provider.turn.interrupt.failed | 13 |
| antigravity | checkpoint.captured | 11 |
| antigravity | turn.completed | 11 |
| grok | user-input.requested | 9 |
| grok | user-input.resolved | 9 |
| devin | checkpoint.captured | 7 |
| devin | turn.completed | 7 |
| claudeAgent | provider.turn.start.failed | 6 |
| codex | provider.approval.respond.failed | 6 |
| claudeAgent | provider.runtime.reconciled | 5 |
| codex | checkpoint.capture.failed | 5 |
| codex | subagent.materialization.capped | 4 |
| codex | turn.plan.updated | 4 |
| pi | context-window.updated | 4 |

## Tool activities: provider, kind, itemType, tool (top 60, excl. tool.output.delta)
| provider | kind | itemType | tool | count |
|---|---|---|---|---|
| codex | tool.started | command_execution | commandExecution | 17791 |
| codex | tool.completed | command_execution | commandExecution | 17776 |
| codex | tool.completed | command_execution | (none) | 2927 |
| codex | tool.started | command_execution | (none) | 2927 |
| claudeAgent | tool.updated | command_execution | Bash | 2314 |
| claudeAgent | tool.started | command_execution | Bash | 1930 |
| claudeAgent | tool.completed | command_execution | Bash | 1924 |
| codex | tool.completed | file_change | fileChange | 1878 |
| codex | tool.started | file_change | fileChange | 1878 |
| grok | tool.started | dynamic_tool_call | (none) | 1423 |
| grok | tool.updated | command_execution | execute | 1377 |
| codex | tool.started | collab_agent_tool_call | collabAgentToolCall | 868 |
| codex | tool.completed | collab_agent_tool_call | collabAgentToolCall | 865 |
| devin | tool.updated | command_execution | execute | 616 |
| grok | tool.completed | dynamic_tool_call | read | 450 |
| grok | tool.started | dynamic_tool_call | read | 450 |
| codex | tool.completed | mcp_tool_call | mcpToolCall | 382 |
| codex | tool.started | mcp_tool_call | mcpToolCall | 382 |
| codex | tool.completed | collab_agent_tool_call | (none) | 313 |
| codex | tool.started | collab_agent_tool_call | (none) | 313 |
| grok | tool.started | command_execution | execute | 299 |
| grok | tool.completed | command_execution | execute | 297 |
| grok | tool.updated | dynamic_tool_call | (none) | 283 |
| grok | tool.completed | dynamic_tool_call | search | 269 |
| grok | tool.started | dynamic_tool_call | search | 255 |
| grok | tool.completed | file_change | edit | 246 |
| grok | tool.started | file_change | edit | 246 |
| codex | tool.completed | file_change | (none) | 221 |
| codex | tool.started | file_change | (none) | 221 |
| claudeAgent | tool.updated | mcp_tool_call | Agent | 209 |
| claudeAgent | tool.updated | dynamic_tool_call | Read | 179 |
| claudeAgent | tool.completed | dynamic_tool_call | Read | 162 |
| claudeAgent | tool.started | dynamic_tool_call | Read | 162 |
| claudeAgent | tool.updated | file_change | Edit | 157 |
| devin | tool.completed | command_execution | execute | 151 |
| devin | tool.started | command_execution | execute | 151 |
| codex | tool.started | web_search | webSearch | 147 |
| codex | tool.completed | web_search | webSearch | 146 |
| claudeAgent | tool.completed | file_change | Edit | 144 |
| claudeAgent | tool.started | file_change | Edit | 144 |
| grok | tool.started | dynamic_tool_call | other | 130 |
| grok | tool.completed | dynamic_tool_call | other | 129 |
| antigravity | tool.started | dynamic_tool_call | view_file | 114 |
| antigravity | tool.completed | dynamic_tool_call | view_file | 112 |
| devin | tool.updated | file_change | edit | 112 |
| claudeAgent | tool.updated | mcp_tool_call | Bash | 105 |
| antigravity | tool.completed | dynamic_tool_call | manage_task | 98 |
| antigravity | tool.started | dynamic_tool_call | manage_task | 98 |
| antigravity | tool.started | command_execution | run_command | 96 |
| claudeAgent | tool.updated | collab_agent_tool_call | Agent | 93 |
| antigravity | tool.completed | command_execution | run_command | 90 |
| devin | tool.completed | file_change | edit | 57 |
| devin | tool.started | file_change | edit | 57 |
| claudeAgent | tool.started | collab_agent_tool_call | Agent | 50 |
| claudeAgent | tool.completed | collab_agent_tool_call | Agent | 46 |
| devin | tool.completed | dynamic_tool_call | read | 42 |
| devin | tool.started | dynamic_tool_call | read | 42 |
| devin | tool.updated | dynamic_tool_call | read | 42 |
| codex | tool.completed | image_generation | codex.generated_image | 32 |
| codex | tool.started | image_generation | codex.generated_image | 32 |

## Unmapped / warning activities by native event type
| provider | kind | nativeEventType | count |
|---|---|---|---|
| codex | runtime.warning | (none) | 1844 |
| codex | provider.event.unmapped | skills/changed | 260 |
| codex | provider.event.unmapped | warning | 248 |
| codex | provider.event.unmapped | hook/completed | 242 |
| codex | provider.event.unmapped | hook/started | 242 |
| codex | provider.event.unmapped | mcpServer/startupStatus/updated | 153 |
| codex | provider.event.unmapped | session/threadOpenResolved | 150 |
| codex | provider.event.unmapped | thread/goal/cleared | 126 |
| codex | provider.event.unmapped | thread/settings/updated | 116 |
| claudeAgent | runtime.warning | background_tasks_changed | 76 |
| claudeAgent | runtime.warning | (none) | 40 |
| codex | provider.event.unmapped | remoteControl/status/changed | 35 |
| codex | provider.event.unmapped | session/threadOpenRequested | 35 |
| codex | provider.unhandled | (none) | 2 |
| pi | runtime.warning | (none) | 2 |
| codex | provider.event.unmapped | model/safetyBuffering/updated | 1 |

## Codex MCP tools (tool.started, top)
synara browser_run 179, browser_open 24, browser_snapshot 22, browser_reload 21, synara_set_thread_pull_request 19, browser_screenshot 15, browser_logs 14, browser_navigate 12; codex_apps datadog.search_datadog_logs 23.
Claude mcp_tool_call-typed updates: Agent 209, Bash 105 (item type mislabel, not real MCP), ctx_execute 2, ctx_batch_execute 1.

## Claude raw SDK message types (provider_runtime_events, n=1,331 total, claude only)
Top by raw method: claude/assistant-usage 280, claude/system/task_progress 218 (as token-usage + task.progress), claude/assistant 168, claude/user 570 (item.completed/updated + content.delta), stream_event/content_block_delta 70, claude/tool_progress 49, system/task_started 17, system/task_notification 9, system/hook_started 8, system/hook_response 8, synthetic-turn-start 8, content_block_start 7, input_json_delta 7, system/status 5, rate_limit_event 4, system/init 2, task_updated 2, thread/started 1.
Runtime event types: thread.token-usage.updated 436, content.delta 216, item.completed 168, item.started 162, item.updated 159, task.progress 65, tool.progress 49.

## Other
- `thread.provider-item-upserted` 133 orchestration events; `projection_thread_provider_items` 62 rows.
- Codex tool.completed status: completed 23,923; failed 1,528; none 3,471.
