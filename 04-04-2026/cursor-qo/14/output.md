## TL;DR
Unauthenticated user accessing the issues page triggers a TypeError on `user!.customerId` because `getUser()` returns `null` for the user object and the Server Component uses a non-null assertion without a guard.

## What Broke and Why

The error occurs on the issue detail page at `https://sdk.foam.ai/issues/9972d813-73ee-4012-acb3-89a41b081a07` in the `porygon-browser` Next.js frontend.

**Causality chain:**

1. A user without a valid session (not logged in, or with an expired/missing session cookie) navigates to an issue detail page (`/issues/[issueId]`).
2. The Server Component `IssuePage` in `porygon/app/(platform)/issues/[issueId]/page.tsx` calls `getUser()`.
3. `getUser()` calls the backend `/auth/status` endpoint. Without valid session cookies, the response is non-OK (401), so `getUser()` returns `{ user: null, isLoggedIn: false, ... }`.
4. The page immediately accesses `user!.customerId` using TypeScript's non-null assertion operator (`!`) **without first checking if `user` is null**:
   ```typescript
   const { user } = await getUser();
   const { issueId } = await params;
   const { issue, status } = await getData(issueId, user!.customerId);
   ```
5. Since `user` is `null`, `user!.customerId` throws: **TypeError: Cannot read properties of null (reading 'customerId')**.
6. Next.js catches this Server Component error and surfaces the generic production message: *"An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details."*
7. The browser-side HyperDX RUM SDK (`@hyperdx/otel-web`) captures this exception and reports it to telemetry.

**The same bug also exists in the issues listing page** at `porygon/app/(platform)/issues/page.tsx`, which uses `user!.customerId` twice without a null check:
```typescript
const { issues, pagination, status } = await getData(user!.customerId, params);
const serviceOptions = await getServiceOptions(user!.customerId);
```

**Contrast with correctly guarded pages**: The setup page (`app/(platform)/setup/page.tsx`) correctly checks authentication before proceeding:
```typescript
const { isLoggedIn, customer } = await getUser();
if (!isLoggedIn || !customer?.companyName) {
    return redirect(routes.login);
}
```

The issue pages lack this guard pattern entirely.

## Fix

Add a null check for the `user` object before accessing `customerId` in both issue pages. Redirect unauthenticated users to `/login`.

**Fix for `porygon/app/(platform)/issues/[issueId]/page.tsx`:**

```typescript
async function IssuePage({ params }: Props) {
  const { user } = await getUser();
  if (!user) {
    return redirect('/login');
  }
  const { issueId } = await params;
  const { issue, status } = await getData(issueId, user.customerId);
  // ... rest of the function
}
```

**Fix for `porygon/app/(platform)/issues/page.tsx`:**

```typescript
async function IssuesPage({ searchParams }: { ... }) {
  const { service, page, range } = await searchParams;
  const { user } = await getUser();
  if (!user) {
    return redirect('/login');
  }
  const params = { ... };
  const { issues, pagination, status } = await getData(user.customerId, params);
  const serviceOptions = await getServiceOptions(user.customerId);
  // ... rest of the function
}
```

Key changes:
1. Check `if (!user)` immediately after `getUser()` returns
2. Redirect to `/login` for unauthenticated users
3. Remove the non-null assertion operator (`!`) since the null check guarantees `user` is defined

---

## Metrics

**Performance:**
- Total latency: 688 seconds
- Token usage: ~25000 input tokens + ~5000 output tokens = ~30000 total tokens
- **Model used: opus-4.6** ← REQUIRED - DO NOT CHANGE

**Tool Usage:**
- Top 3 most-used tools: query-otel (8 attempts, 2 succeeded), Read (10 files), Shell/git (12 commands)
- Top 3 most USEFUL tools: query-otel (input: TraceId lookup for `1af94798049778d815120d490fc0f9a3` - revealed the error URL, service, and browser context), Read (input: `porygon/app/(platform)/issues/[issueId]/page.tsx` at deployed commit `f1756281` - revealed the `user!.customerId` non-null assertion bug), git show (input: diff between deployed commit and HEAD - confirmed the null check was missing at error time)
