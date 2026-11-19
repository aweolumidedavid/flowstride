import { randomBytes } from 'node:crypto';
import type { FixtureContext } from 'flowstride';

export function preparePracticeUser({ baseURL, defer, attempt }: FixtureContext, handoff?: string) {
  const origin = new URL(baseURL || 'about:blank');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) {
    throw new Error('Run this example against the bundled practice app.');
  }

  const suffix = randomBytes(8).toString('hex');
  const prefix = handoff && attempt === 1 ? 'retry-approver-' : 'approver-';
  const email = prefix + suffix + '@example.test';

  // Defer all administrative API work until cleanup, even if creating the user fails.
  defer(async signal => {
    const session = await fetch(new URL('/api/session', origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, redirect: 'error',
      body: JSON.stringify({ email: 'admin@example.test', password: 'practice-admin' }),
    });
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    if (!session.ok || !cookie) throw new Error('Could not open the practice cleanup session.');
    const headers = { Cookie: cookie };
    try {
      const usersUrl = new URL('/api/admin/users', origin);
      const list = await fetch(usersUrl, { headers, signal, redirect: 'error' });
      if (!list.ok) throw new Error('Could not locate the practice user for cleanup.');
      const { users } = await list.json() as { users: { id: string; email: string }[] };
      const user = users.find(item => item.email === email);
      if (user) {
        const url = new URL('/api/admin/users/' + encodeURIComponent(user.id), origin);
        const deleted = await fetch(url, { method: 'DELETE', headers, signal, redirect: 'error' });
        if (!deleted.ok && deleted.status !== 404) throw new Error('Could not remove the practice user.');
      }
    } finally {
      const logout = await fetch(new URL('/logout', origin), { method: 'POST', headers, signal, redirect: 'manual' });
      if (logout.status !== 303) throw new Error('Could not close the practice cleanup session.');
    }
  }, handoff ? { handoff } : undefined);

  return { name: 'Practice Approver ' + suffix, email, password: 'practice-private-' + randomBytes(12).toString('hex') };
}
