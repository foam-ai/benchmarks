## TL;DR

The `/issues/[issueId]` Server Component crashes in production because it uses `user!.customerId` (TypeScript non-null assertion) on a value that is legitimately `null` when `getUser()` fails or the user is unauthenticated. No middleware or layout-level auth guard exists to prevent unauthenticated requests from reaching the page, so the `TypeError` propagates as a scrubbed Next.js production error. The fix is to add an auth guard in the `(platform)/layout.tsx` that redirects to `/login` when `user` is null.

## What Broke and Why

The error originates on the **issues detail page** at `https://sdk.foam.ai/issues/9972d813-73ee-4012-acb3-89a41b081a07`, corresponding to the route `app/(platform)/issues/[issueId]/page.tsx`.

**Step 1 — `getUser()` returns `{user: null}`:**  
In `porygon/actions/auth.ts`, the `getUser()` function returns `{ user: null }` in three legitimate scenarios: when `NEXT_PUBLIC_BACKEND_URL` is not set, when the auth backend returns a non-OK HTTP response, or when auth data parsing fails:

```typescript
if (!response.ok) {
  return { isLoggedIn: false, user: null, customer: null, installationComplete: false };
}
```

The return type `AuthStatus` explicitly declares `user: User | null`, making null a valid return value.

**Step 2 — Non-null assertion crashes at render time:**  
The issue detail page destructures `user` and immediately dereferences it with a `!` assertion:

```typescript
const { user } = await getUser();
const { issue, status } = await getData(issueId, user!.customerId);  // 💥 TypeError
```

When `user` is `null`, `user!.customerId` throws `TypeError: Cannot read properties of null (reading 'customerId')` during the React Server Component render.

**Step 3 — No safety net catches or prevents the crash:**  
- **No middleware** (`middleware.ts` does not exist) — unauthenticated requests reach Server Components unimpeded.
- **No layout-level auth guard** — `(platform)/layout.tsx` only renders `<MiniHeader>` and `<Footer>` with no auth check.
- **No route-level error boundary** — no `error.tsx` exists for the `(platform)` route group, so the error propagates to `global-error.tsx`.
- **The client-side `authenticate` HOC** runs in `useEffect` *after* the server render, so it cannot prevent the server-side crash.

**Step 4 — Next.js scrubs the error in production:**  
The `TypeError` is caught by Next.js's production error handling, which strips the message to avoid leaking sensitive details, producing the observed: `"An error occurred in the Server Components render. The specific message is omitted in production builds..."`. The telemetry span (`1d6f235aca85fb07`) shows this browser-captured error from `porygon-browser` with `exception.tags` confirming `"environment":"production"` and `"handled":true`.

**Scope:** The same vulnerability exists in `app/(platform)/issues/page.tsx` (issues list page), which has two `user!.customerId` dereferences. Other `(platform)` pages (solves, setup) safely use optional chaining (`user?.`) and explicit `isLoggedIn` guards.

**Alternative hypothesis considered:** The error could originate from a data-fetching failure within `getData()` itself (e.g., a 404 for a non-existent issue). However, the `getData()` function is never reached when `user` is null — the crash occurs before the API call — and the existing code already handles `status === 401` responses from `getData()` with a redirect. The null-user crash preempts all downstream error handling.

## Fix

**Add an auth guard in `porygon/app/(platform)/layout.tsx`** that redirects to `/login` when the user is not authenticated:

```typescript
// porygon/app/(platform)/layout.tsx
import { getUser } from '@/actions/auth';
import { redirect } from 'next/navigation';

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoggedIn } = await getUser();
  if (!isLoggedIn || !user) {
    redirect('/login');
  }
  return (
    <main className="bg-gray-100">
      <MiniHeader />
      <div className="pb-10 min-h-screen w-full">{children}</div>
      <Footer />
    </main>
  );
}
```

Then remove the `!` non-null assertions from the two affected issue pages:

```diff
- const { issue, status } = await getData(issueId, user!.customerId);
+ const { issue, status } = await getData(issueId, user.customerId);
```

**Why this fix breaks the causal chain:** The layout renders *before* any child page. When `user` is null, the redirect fires immediately, and the child Server Component never executes — so `user!.customerId` is never evaluated with a null `user`. Thanks to Next.js's `react/cache` deduplication, the `getUser()` call in the layout is deduplicated with calls in child pages, incurring no additional network cost. This pattern already exists in the setup pages (which check `isLoggedIn` and redirect), making it a consistent, systemic fix that also protects any future `(platform)` pages.

---