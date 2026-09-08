Source: https://docs.temporal.io/design-patterns/error-handling-patterns
Title: Error Handling & Retry Patterns | Temporal Documentation
Fetched: 2026-09-08T16:20:45.126Z

[Skip to main content](https://temporal.io/comms#main-content)

sessionId: 1788884443054

userId:

deviceId: 0540fe79-919d-48a7-a26f-25fb95aa3d11

UpdateResetUpdate User IDUpdate Device ID

[Skip to main content](https://docs.temporal.io/design-patterns/error-handling-patterns#__docusaurus_skipToContent_fallback)

On this page

For the complete documentation index, see [/llms.txt](https://docs.temporal.io/llms.txt).This page is also available as raw Markdown at [/design-patterns/error-handling-patterns.md](https://docs.temporal.io/design-patterns/error-handling-patterns.md). Append`.md` to any page URL to fetch its Markdown.

These patterns control how Temporal retries Activities, surfaces persistent failures, and recovers from errors that require human intervention.

## Patterns in this section [​](https://docs.temporal.io/design-patterns/error-handling-patterns\#patterns-in-this-section "Direct link to Patterns in this section")

[![Fixed Count of Retries](https://docs.temporal.io/img/design-patterns/icons/fixed-count-retries-icon.svg)**Fixed Count of Retries**\\
\\
Caps the number of Activity retry attempts to control cost when each attempt consumes a paid or limited resource.](https://docs.temporal.io/design-patterns/fixed-count-retries) [![Fixed Wall-Time Retries](https://docs.temporal.io/img/design-patterns/icons/fixed-wall-time-retries-icon.svg)**Fixed Wall-Time Retries**\\
\\
Bounds the total elapsed time across all retry attempts to enforce a business SLA, regardless of how many attempts occur.](https://docs.temporal.io/design-patterns/fixed-wall-time-retries) [![Non-Retryable Errors](https://docs.temporal.io/img/design-patterns/icons/non-retryable-errors-icon.svg)**Non-Retryable Errors**\\
\\
Marks error types that will never succeed — such as validation failures or missing records — so Temporal fails fast instead of retrying.](https://docs.temporal.io/design-patterns/non-retryable-errors) [![Delayed Retry](https://docs.temporal.io/img/design-patterns/icons/delayed-retry-icon.svg)**Delayed Retry**\\
\\
Override the next retry interval for a specific failure using nextRetryDelay on ApplicationFailure. Use when an error carries information about how long to wait before retrying.](https://docs.temporal.io/design-patterns/delayed-retry) [![Fast/Slow Retries](https://docs.temporal.io/img/design-patterns/icons/fast-slow-retries-icon.svg)**Fast/Slow Retries**\\
\\
Retries aggressively with a short interval first, then shifts to a long interval when fast retries are exhausted, keeping the Workflow alive until the downstream system recovers.](https://docs.temporal.io/design-patterns/fast-slow-retries) [![Retry Alerting via Metrics](https://docs.temporal.io/img/design-patterns/icons/retry-metrics-icon.svg)**Retry Alerting via Metrics**\\
\\
Emits a custom metric from inside the Activity when the attempt count crosses a threshold, surfacing silent persistent failures to on-call teams before an SLA breach.](https://docs.temporal.io/design-patterns/retry-metrics) [![Resumable Activity](https://docs.temporal.io/img/design-patterns/icons/resumable-activity-icon.svg)**Resumable Activity**\\
\\
Parks the Workflow after retries are exhausted and waits for a human to correct the data or approve continuing, then resumes from where it left off.](https://docs.temporal.io/design-patterns/resumable-activity)

## Choosing a pattern [​](https://docs.temporal.io/design-patterns/error-handling-patterns\#choosing-a-pattern "Direct link to Choosing a pattern")

The following decision tree helps you select the appropriate retry strategy for your use case.

Yes

No

No

Yes

No

Yes

Yes

No

Yes

No

Yes

No

Activity failing

Each attempt

costs money or

consumes quota?

Fixed Count of Retries

Cap MaximumAttempts

Will this error

ever succeed

automatically?

Can a human

correct and retry?

Resumable Activity

Park and await signal

Non-Retryable Errors

Fail fast

Downstream has

a predictable

unavailability window?

Delayed Retry

Fixed interval backoff

Must resolve

within a

time budget?

Fixed Wall-Time Retries

ScheduleToCloseTimeout

Want aggressive

initial retries then

patient recovery?

Fast/Slow Retries

Two-phase retry policy

Retry Alerting via Metrics

Emit metrics at attempt threshold

The following describes each decision point:

1. If each attempt consumes a paid API call, a rate-limited token, or another scarce resource, use **Fixed Count of Retries** to cap total consumption.
2. If the error is structural — a missing record, invalid input, or authorization failure — and cannot be corrected automatically, ask whether a human can fix it: if so, use **Resumable Activity** to park the Workflow and await a correction signal; otherwise use **Non-Retryable Errors** to fail fast.
3. If the downstream system has a scheduled maintenance window and you know approximately how long it will be unavailable, use **Delayed Retry** with a fixed interval.
4. If the process must resolve (one way or another) within a business SLA window such as 24 hours, use **Fixed Wall-Time Retries** with `ScheduleToCloseTimeout`.
5. If you want to recover from transient errors quickly but also wait indefinitely for the downstream system to come back, use **Fast/Slow Retries**.
6. For any long-running retry scenario, add **Retry Alerting via Metrics** to surface persistent failures before they breach an SLA.

## How Temporal retries work [​](https://docs.temporal.io/design-patterns/error-handling-patterns\#how-temporal-retries-work "Direct link to How Temporal retries work")

Temporal's default `RetryPolicy` retries Activities indefinitely with exponential backoff.
Unless you configure a policy, a failing Activity will keep retrying until the `ScheduleToCloseTimeout` or the Workflow itself completes.

The key `RetryPolicy` fields are:

| Field | Default | Effect |
| --- | --- | --- |
| `MaximumAttempts` | 0 (unlimited) | Caps total attempts including the first |
| `InitialInterval` | 1 second | Delay before the first retry |
| `BackoffCoefficient` | 2.0 | Multiplier applied after each retry |
| `MaximumInterval` | 100× InitialInterval | Upper bound on the backoff delay |
| `NonRetryableErrorTypes` | `[]` | Error types that skip retries entirely |

`ScheduleToCloseTimeout` is set on the Activity call options, not in `RetryPolicy`.
It caps the total wall-clock time from when the Activity is first scheduled to when it must complete — across all retry attempts.

## Related sections [​](https://docs.temporal.io/design-patterns/error-handling-patterns\#related-sections "Direct link to Related sections")

- [External Interaction Patterns](https://docs.temporal.io/design-patterns/external-interaction-patterns) — heartbeating, polling, and approval gates for the external calls that fail
- [Distributed Transaction Patterns](https://docs.temporal.io/design-patterns/distributed-transaction-patterns) — compensate completed steps when retries finally give up
- [Performance & Latency Patterns](https://docs.temporal.io/design-patterns/performance-latency-patterns) — where retry configuration fits in the latency budget

## References [​](https://docs.temporal.io/design-patterns/error-handling-patterns\#references "Direct link to References")

- [Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)
- [Understanding Workflow Retries and Failures](https://community.temporal.io/t/understanding-workflow-retries-and-failures/122)
- [Failure Handling in Practice](https://temporal.io/blog/failure-handling-in-practice)

- [Patterns in this section](https://docs.temporal.io/design-patterns/error-handling-patterns#patterns-in-this-section)
- [Choosing a pattern](https://docs.temporal.io/design-patterns/error-handling-patterns#choosing-a-pattern)
- [How Temporal retries work](https://docs.temporal.io/design-patterns/error-handling-patterns#how-temporal-retries-work)
- [Related sections](https://docs.temporal.io/design-patterns/error-handling-patterns#related-sections)
- [References](https://docs.temporal.io/design-patterns/error-handling-patterns#references)

Feedback