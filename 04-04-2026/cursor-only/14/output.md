## TL;DR
Server Components on `/issues` and `/issues/[issueId]` crash with a null dereference (`user!.customerId`) when the user is unauthenticated, because there is no null-check or login redirect before accessing user properties.

## What Broke and Why
The `porygon` Next.js frontend has two Server Component pages under the `(platform)` route group that use the TypeScript non-null assertion operator (`!`) on a potentially-null `user` object returned by `getUser()`:

- **`porygon/app/(platform)/issues/page.tsx`** (lines 66–67):
  ```typescript
  const { user } = await getUser();
  // ...
  const { issues, pagination, status } = await getData(user!.customerId, params);
  const serviceOptions = await getServiceOptions(user!.customerId);
  ```

- **`porygon/app/(platform)/issues/[issueId]/page.tsx`** (line 41–43):
  ```typescript
  const { user } = await getUser();
  const { issueId } = await params;
  const { issue, status } = await getData(issueId, user!.customerId);
  ```

The `getUser()` function (`porygon/actions/auth.ts`) returns `{ isLoggedIn: false, user: null, customer: null, installationComplete: false }` in multiple scenarios: when the backend URL is not configured, when the `/auth/status` API returns an error, or when the user simply isn't authenticated. The `User` type explicitly declares `user: User | null`.

The non-null assertion operator (`!`) only suppresses TypeScript compiler warnings — at runtime, it is completely stripped away. So when `user` is `null`, accessing `null.customerId` throws:

```
TypeError: Cannot read properties of null (reading 'customerId')
```

This crash occurs inside a Server Component render. Because there is no `error.tsx` boundary in the `(platform)` route group, the error propagates to `app/global-error.tsx`. Next.js's production behavior is to send a sanitized, generic error message to the client: *"An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details."* The client-side foam SDK (initialized with `serviceName: 'porygon-browser'` in `instrumentation-client.ts`) then captures and reports this error.

There is no Next.js middleware protecting the `(platform)` routes, so any unauthenticated visitor — a user with an expired session, a bot/crawler, or a direct URL visit — can trigger this crash.

Other pages in the same codebase handle this correctly. For example, `setup/page.tsx` checks `if (!isLoggedIn || !customer?.companyName)` before proceeding, and `solves/[runId]/page.tsx` uses optional chaining (`user?.`) instead of non-null assertion.

## Fix
Add an authentication guard at the top of both affected Server Components, before accessing `user` properties. Redirect unauthenticated users to `/login`:

**`porygon/app/(platform)/issues/page.tsx`** — add guard after `getUser()`:
```typescript
const { user, isLoggedIn } = await getUser();

if (!isLoggedIn || !user) {
  return redirect('/login');
}

// Now safe to use user.customerId (no ! needed)
const { issues, pagination, status } = await getData(user.customerId, params);
const serviceOptions = await getServiceOptions(user.customerId);
```

**`porygon/app/(platform)/issues/[issueId]/page.tsx`** — add guard after `getUser()`:
```typescript
const { user, isLoggedIn } = await getUser();
const { issueId } = await params;

if (!isLoggedIn || !user) {
  return redirect('/login');
}

const { issue, status } = await getData(issueId, user.customerId);
```

This matches the pattern already used by `setup/page.tsx`, `setup/[companyName]/page.tsx`, and `installation/page.tsx` which all properly guard against null user before accessing properties.
