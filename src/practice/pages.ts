import { categories, memberRoles, roleLabels, type Account, type Car } from './data';

const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function layout(title: string, content: string, account?: Account) {
  const nav = account
    ? `<a href="/account">Account</a>${account.role === 'admin' ? '<a href="/admin">Manage users</a>' : ''}
       <form method="post" action="/logout"><button class="quiet">Sign out</button></form>`
    : '<a href="/login">Sign in</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Flowstride Practice</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="topbar"><a class="brand" href="/">Flowstride Practice</a>
<nav aria-label="Main navigation"><a href="/">Catalog</a>${nav}</nav></header>
<main>${content}</main>
</body>
</html>`;
}

export function catalogPage(cars: Car[], category: string, account?: Account) {
  const options = categories.map(value =>
    `<option${value === category ? ' selected' : ''}>${value}</option>`).join('');
  const cards = cars.map(car => `<li class="car" data-sku="${car.sku}" data-price-cents="${car.finalPriceCents}">
    <div class="car-meta"><span>${car.category}</span><span>${car.sku}</span></div>
    <h2>${car.name}</h2>
    <p class="price"><span>${usd.format(car.finalPriceCents / 100)}</span>${car.discountPercent ? ` <del>${usd.format(car.priceCents / 100)}</del>` : ''}</p>
    ${car.discountPercent ? `<p class="discount">${car.discountPercent}% off</p>` : ''}
  </li>`).join('');
  return layout('Car catalog', `<h1>Car catalog</h1>
  <form class="filter" method="get" action="/">
    <label for="category">Category</label>
    <div class="inline"><select id="category" name="category"><option value="">All cars</option>${options}</select>
    <button>Filter cars</button></div>
  </form>
  <p class="count">${cars.length} cars</p><ul class="catalog" aria-label="Cars">${cards}</ul>`, account);
}

function passwordField(mode: 'login' | 'create-user') {
  const login = mode === 'login';
  const id = login ? 'login-password' : 'user-password';
  const attributes = !login
    ? 'placeholder="Create a password" autocomplete="new-password" minlength="8" maxlength="128"'
    : 'placeholder="Enter password" autocomplete="current-password"';
  return `<div class="password-field">
      <label for="${id}">${login ? 'Password' : 'Temporary password'}
        <input id="${id}" name="password" type="password" required ${attributes}>
      </label>
      <button type="button" class="password-toggle" aria-controls="${id}" aria-label="Show password" title="Show password" hidden>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7S2 12 2 12Z"/>
          <circle cx="12" cy="12" r="3"/>
          <path class="eye-slash" d="m3 3 18 18"/>
        </svg>
      </button>
    </div>
    <script src="/password-visibility.js" defer></script>`;
}

export function loginPage(error = '') {
  return layout('Sign in', `<section class="panel narrow"><h1>Sign in</h1>
  ${error ? `<p class="notice" role="alert">${escape(error)}</p>` : ''}
  <form method="post" action="/login">
    <label>Email <input id="login-email" name="email" type="email" placeholder="Enter email" autocomplete="username" required></label>
    ${passwordField('login')}
    <button>Sign in</button>
  </form></section>`);
}

export function accountPage(account: Account) {
  return layout('Your account', `<section class="panel narrow" data-user-id="${account.id}"><h1>Your account</h1>
  <p>Signed in as ${escape(account.name)}</p><dl><dt>Role</dt><dd>${roleLabels[account.role]}</dd></dl>
  ${account.role === 'approver' ? '<p class="discount">Can approve bookings</p>' : ''}
  </section>`, account);
}

export function adminPage(accounts: Account[], admin: Account, error = '') {
  const rows = accounts.filter(account => account.role !== 'admin').map(account => {
    const roles = memberRoles.map(role => `<option value="${role}"${account.role === role ? ' selected' : ''}>${roleLabels[role]}</option>`).join('');
    return `<li class="member" data-user-id="${account.id}">
      <div><strong>${escape(account.name)}</strong><p>${escape(account.email)}</p>
        <p class="saved-role">Saved role · ${roleLabels[account.role]}</p></div>
      <form method="post" action="/admin/users/${account.id}/role">
        <label for="role-${account.id}">Role for ${escape(account.name)}</label>
        <div class="inline"><select id="role-${account.id}" name="role">${roles}</select><button>Assign role</button></div>
      </form>
    </li>`;
  }).join('');
  return layout('Manage users', `<h1>Manage users</h1>
  ${error ? `<p class="notice" role="alert">${escape(error)}</p>` : ''}
  <div class="admin-layout">
    <section class="panel"><h2>Create a user</h2>
      <form method="post" action="/admin/users">
        <label>Full name <input id="user-name" name="name" placeholder="Enter full name" required maxlength="80"></label>
        <label>User email <input id="user-email" name="email" type="email" placeholder="Enter email" required maxlength="150"></label>
        ${passwordField('create-user')}
        <button>Create user</button>
      </form>
    </section>
    <section class="panel"><h2>Workspace users</h2><ul class="members">${rows}</ul></section>
  </div>`, admin);
}
