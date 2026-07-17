# Independent agent-change benchmark

The 0.2.7 release includes two deliberately separate measurements.

`npm run benchmark:agent` is a deterministic local routing microbenchmark. It measures whether the
task retriever selects the expected symbol, plus false-positive selections, estimated output tokens,
and local latency. It is a regression test, not evidence that an autonomous code change succeeded.

The release comparison is an independently executed, blind agent-change benchmark. The evaluator
must run the same pinned tasks and repository commits three times: with Weavatrix, with Codebase
Memory, and with Serena. The product author must not adjudicate or repair a run while it is active.

## Required task protocol

Each task must provide a repository commit, natural-language request, allowed commands, timeout, and
machine-verifiable acceptance tests. Keep task prompts and acceptance tests identical across systems;
randomize system order. Record the entire agent input/output token count and wall-clock duration.

A run is successful only when the requested behavior is implemented, all acceptance tests pass, and
the final diff stays inside the task scope. A false positive is an evidenced warning, impacted symbol,
or required edit that an evaluator confirms is unrelated to the task. Record a count, including zero;
do not silently discard noisy output.

Use a mix of at least:

- behavior changes with indirect callers;
- API route/client changes;
- refactors with a duplicate or architecture regression trap;
- changes whose nearest relevant test is not in the edited file;
- one negative task where the correct action is to refuse or return unknown.

## Result contract

Save the blind evaluator output as JSON:

```json
{
  "schemaVersion": "weavatrix.agent-change-results.v1",
  "evaluator": "independent organization or person",
  "systems": {
    "weavatrix": {"runs": [{"taskId": "change-auth", "success": true, "falsePositives": 0, "tokens": 1234, "durationMs": 4567}]},
    "codebase-memory": {"runs": [{"taskId": "change-auth", "success": true, "falsePositives": 1, "tokens": 1400, "durationMs": 5000}]},
    "serena": {"runs": [{"taskId": "change-auth", "success": false, "falsePositives": 2, "tokens": 1600, "durationMs": 7000}]}
  }
}
```

Every system must contain the same unique task IDs. Every run must report success, false positives,
tokens, and duration. Then run:

```sh
npm run benchmark:agent -- --independent-results path/to/results.json
npm run benchmark:agent:release -- --independent-results path/to/results.json
```

The first command reports change-success rate, false positives per task, median tokens, and median
duration for all three systems. The release command fails unless the independent comparison is
complete and valid. Missing or malformed competitor data is `INCOMPLETE`, never a green comparison.
