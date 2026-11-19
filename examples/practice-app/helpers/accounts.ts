import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { FixtureContext } from 'flowstride';

const handoff = 'practiceBookingApprover';
const administrator = { email: 'admin@example.test', password: 'practice-admin' };

export async function createBookingApprover({ baseURL, signal, defer, attempt }: FixtureContext) {
  const origin = new URL(baseURL || 'about:blank');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) {
    throw new Error('Run this example against the bundled practice app.');
  }

  const session = await fetch(new URL('/api/session', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(administrator),
    signal,
    redirect: 'error',
  });
  const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
  if (!session.ok || !cookie) throw new Error('Could not open the practice admin session.');
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  defer(async cleanupSignal => {
    const response = await fetch(new URL('/logout', origin), {
      method: 'POST', headers, signal: cleanupSignal, redirect: 'manual',
    });
    if (response.status !== 303) throw new Error('Could not close the practice admin session.');
  }, { handoff });

  const idSuffix = randomBytes(8).toString('hex');
  const email = 'approver-' + idSuffix + '@example.test';
  const password = 'practice-private-' + randomBytes(12).toString('hex');
  const usersUrl = new URL('/api/admin/users', origin);
  let userId: string | undefined;
  defer(async cleanupSignal => {
    // The create request can complete on the server before its response reaches this fixture.
    if (!userId) {
      const list = await fetch(usersUrl, { headers, signal: cleanupSignal, redirect: 'error' });
      if (!list.ok) throw new Error('Could not check for a partially created practice user.');
      const { users } = await list.json() as { users: { id: string; email: string }[] };
      userId = users.find(user => user.email === email)?.id;
    }
    if (!userId) return;
    const userUrl = new URL('/api/admin/users/' + encodeURIComponent(userId), origin);
    const response = await fetch(userUrl, { method: 'DELETE', headers, signal: cleanupSignal, redirect: 'error' });
    if (!response.ok && response.status !== 404) throw new Error('Could not remove the practice user.');
  }, { handoff });

  const created = await fetch(usersUrl, {
    method: 'POST', headers, signal, redirect: 'error',
    body: JSON.stringify({ name: 'Practice Approver ' + idSuffix, email, password }),
  });
  if (created.status !== 201) throw new Error('Could not create the practice user.');
  const { id } = await created.json() as { id: string };
  userId = id;
  return { id, email, password, attempt };
}

export async function grantBookingApproval(page: Page, id: string) {
  const form = page.locator('form[action="/admin/users/' + encodeURIComponent(id) + '/role"]');
  await form.locator('select').selectOption('approver');
  await form.getByRole('button', { name: 'Assign role' }).click();
  const response = await page.request.get(new URL('/api/admin/users', page.url()).href, { maxRedirects: 0 });
  if (!response.ok()) throw new Error('Could not verify the role through the practice API.');
  const { users } = await response.json() as { users: { id: string; role: string }[] };
  if (users.find(user => user.id === id)?.role !== 'approver') {
    throw new Error('The practice user did not receive booking approval.');
  }
}

export function confirmReadiness(attempt: number) {
  // The first attempt reaches this check after the handoff data has been staged.
  if (attempt === 1) throw new Error('Practice readiness is deliberately pending on attempt one.');
}

export async function signedInUserId(page: Page): Promise<string> {
  const response = await page.request.get(new URL('/api/account', page.url()).href, { maxRedirects: 0 });
  if (!response.ok()) throw new Error('The approved user is not signed in.');
  const { id } = await response.json() as { id: string };
  return id;
}
