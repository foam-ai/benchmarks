[Foam Trace ID: 0809c31a2222addd46342ad858a10279] ## TL;DR

The `/issues/[issueId]` Server Component crashes during render because it uses a TypeScript non-null assertion (`user!.customerId`) on the result of `getUser()`, which returns `{ user: null }` when the user's session is expired or authentication fails. The resulting `TypeError: Cannot read properties of null (reading 'customerId')` is redacted by Next.js in production, producing the generic "An error occurred in the Server Components render" message. The fix is to add a null check on `user` before accessing its properties and redirect unauthenticated users.

## What Broke and Why

The error occurred when a user navigated to `https://sdk.foam.ai/issues/9972d813-73ee-4012-acb3-89a41b081a07`, which maps to the Next.js App Router page at `porygon/app/(platform)/issues/[issueId]/page.tsx`.

The `IssuePage` async Server Component performs two sequential data fetches:

```typescript
const { user } = await getUser();
const { issueId } = await params;
const { issue, status } = await getData(issueId, user!.customerId);  // CRASH SITE
```

The `getUser()` function calls `GET {BACKEND_URL}/auth/status` with session cookies and returns `{ user: null }` in multiple legitimate scenarios:
- The user's session has expired or their token was revoked
- The `/auth/status` backend endpoint returns a non-2xx response
- The `NEXT_PUBLIC_BACKEND_URL` environment variable is undefined

When `user` is `null`, the TypeScript non-null assertion operator (`!`) provides zero runtime protection — `user!.customerId` evaluates as `null.customerId`, throwing:

> `TypeError: Cannot read properties of null (reading 'customerId')`

This TypeError is thrown during the Server Component render phase. In Next.js production builds, the actual error message is redacted for security, producing the generic message observed in telemetry:

> "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details."

The telemetry confirms this was instantaneous (0ms duration span on `porygon-browser` at `2026-01-03 22:47:02.496`), consistent with a null dereference early in the render before any network call to fetch issue data.

Three compounding factors allowed this to surface as a production error:
1. **No middleware or layout-level auth guard** — The `(platform)` layout does not verify authentication, so unauthenticated requests reach the page component unimpeded.
2. **No route-level error boundary** — There is no `error.tsx` at `(platform)/issues/[issueId]/`, `(platform)/issues/`, or `(platform)/`, so the error propagates to the global error handler.
3. **Other pages handle this correctly** — Sibling pages in the `(platform)` directory properly null-check `user` before accessing properties and redirect to login, confirming this is a bug specific to the IssuePage, not a systemic design decision.

**Alternative hypothesis considered and eliminated**: A network-level failure in the `getData()` fetch was considered, but the 0ms span duration rules this out — the crash occurs at the `user!.customerId` dereference *before* `getData()` is ever called.

## Fix

Add a null check on `user` before accessing `.customerId`, redirecting unauthenticated users to a login page:

```typescript
import { redirect } from 'next/navigation';

// In IssuePage:
const { user } = await getUser();
if (!user) {
  redirect('/login');
}
const { issueId } = await params;
const { issue, status } = await getData(issueId, user.customerId);
```

**Why this breaks the causal chain**: The crash occurs because `user` is `null` and code dereferences it without checking. The null check intercepts this exact condition — when `getUser()` returns a null user (expired session, auth failure, etc.), the `redirect('/login')` fires before execution ever reaches `user.customerId`, preventing the TypeError entirely. The `!` non-null assertion is also removed, restoring TypeScript's type safety for `user`.

**Recommended secondary improvements** (not the root cause fix, but defense-in-depth):
1. Add an `error.tsx` error boundary at `(platform)/issues/[issueId]/` or `(platform)/` to gracefully handle any remaining SSR errors.
2. Consider adding authentication middleware for all `(platform)` routes to catch unauthenticated access before any page component renders, matching the pattern used by other pages.

---
