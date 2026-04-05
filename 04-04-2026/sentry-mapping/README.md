# Sentry Mapping

Foam's codebases are instrumented with Sentry. Each file in this directory maps a benchmark eval to its corresponding Sentry issue data, which was provided as additional context in the benchmark prompt.

- **When a Sentry issue was available**, the recorded Sentry data (issue metadata, stacktrace, tags, breadcrumbs, etc.) was stored here.
- **When no Sentry issue was available**, equivalent data from a Foam issue was provided as a replacement.
