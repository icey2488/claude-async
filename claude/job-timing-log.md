# Job timing log

Tracks estimate-vs-actual for claude-async jobs, to calibrate future estimates.

| Job | Model | Estimated | Actual | Note |
| --- | --- | --- | --- | --- |
| claunker.claude-async-runner-exit-reason-20260926-xia3uxbn | Sonnet, medium | 12 to 18 min | 4m31s (05:53:18Z to 05:57:49Z) | estimate used the pre-Sep-25 table; Sep 25 line (Sonnet fixes 3 to 8 min) was right |
| claunker.claude-async-runner-exit-reason-r2-20260927-dzvdmthz | Sonnet, medium | 8 to 15 min | 6m44s (07:28:37Z to 07:35:21Z) | |
| claunker.claude-async-runner-exit-reason-packet-20260927-ih6260vw | Haiku, low | under 1 min | 32s (07:39:43Z to 07:40:15Z) | |
| claunker.claude-async-runner-exit-reason-merge-20260927 | Sonnet, medium | 4 to 8 min | (unknown, own start time not available) | squash-merge and gate job, no code written |
| guard-fileid-test-timeout (fix/guard-fileid-test-timeout, 2026-09-27) | Sonnet 5, medium | mutation phase: (8 mutations + 0 reruns) x ~10s test-file runtime = ~80s, plus edit/revert overhead, call it 5-8 min total for the mutation step | 8/8 mutations caught in ~9-10s each (startlock.test.mjs), ~2 min wall for the whole mutation phase incl. edits/reverts; full job (read protocol, fix fileId stranding in both lock+marker paths, make timeoutMs injectable, rewrite 4 real-5s-wait tests + add 2 fileId tests, update RUNBOOK, mutation-test, 2x full-suite run) | no mutation list existed for 22e1864 in claude/, RUNBOOK, or commit messages (checked all three); wrote 6 equivalent mutations myself plus 2 targeting the new Task A fileId-failure handling |
