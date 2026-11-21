import type { ElementHandle, Frame, Locator, Page } from 'playwright';

type Inspection = { state?: boolean; fields?: Node[] };

// This function runs in the field's own document. Never read the password value.
function inspectControls(source: Node, options: Inspection): string | HTMLElement[] {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible';
  };
  const hasPasswordHint = (field: HTMLInputElement) => field.type === 'password' ||
    /password|passphrase|passcode|passwd|\bpwd\b/i.test([field.name, field.id, field.getAttribute('autocomplete'), field.placeholder,
      field.getAttribute('aria-label'), ...Array.from(field.labels ?? [], label => label.textContent)].join(' '));
  const controlSelector = 'button, [role="button"], [role="switch"], input[type="button"], input[type="checkbox"], [aria-controls][tabindex]';
  const eyeSelector = '[data-icon="eye" i], [data-icon="eye-off" i], [data-icon="eye-slash" i], .lucide-eye, .lucide-eye-off, .fa-eye, .fa-eye-slash, [href$="#eye"], [href$="#eye-off"], [href$="#eye-slash"]';
  // Keep the identity of revealed inputs even when the app uses a localized label
  // and type changes to text. The document owns weak references, never values.
  const historyKey = Symbol.for('flowstride.passwordFieldHistory');
  const doc = source.ownerDocument as Document & { [historyKey]?: WeakSet<HTMLInputElement> };
  const knownFields = doc[historyKey] ??= new WeakSet<HTMLInputElement>();
  const result = new Set<HTMLElement>();
  for (const field of options.fields ?? [source]) {
    if (!(field instanceof HTMLInputElement) || !['password','text'].includes(field.type) || !visible(field)) continue;
    const masked = field.type === 'password' || ['disc','circle','square'].includes(getComputedStyle(field).getPropertyValue('-webkit-text-security'));
    if (masked) knownFields.add(field);
    const identified = knownFields.has(field) || hasPasswordHint(field);
    if (options.state && identified) return masked ? 'masked' : 'revealed';

    const root = field.getRootNode() as Document | ShadowRoot;
    const recognized: HTMLElement[] = [], linked: HTMLElement[] = [], localIcons: HTMLElement[] = [];
    const explicitlyPassword = new Set<HTMLElement>();
    for (const button of root.querySelectorAll<HTMLElement>(controlSelector)) {
      if (!visible(button)) continue;
      const controls = button.getAttribute('aria-controls');
      if (controls && (!field.id || !controls.trim().split(/\s+/).includes(field.id))) continue;
      const labelledBy = (button.getAttribute('aria-labelledby') ?? '').split(/\s+/)
        .map(id => id ? root.getElementById(id)?.textContent : '').join(' ').trim();
      const name = (labelledBy || button.getAttribute('aria-label') || button.textContent?.trim() || button.title ||
        (button instanceof HTMLInputElement ? Array.from(button.labels ?? [], label => label.textContent).join(' ').trim() ||
          (button.type === 'button' ? button.value : '') : '')).trim();
      const otherAction = /(?:copy|clipboard|generate|submit|reset|delete|trash|clear|search)/i;
      if (otherAction.test(name) || otherAction.test([button.id, button.className, button.dataset.action, button.dataset.testid].join(' ')) ||
          button.querySelector('[data-icon="copy" i], [data-icon="clipboard" i], .lucide-copy, .fa-copy')) continue;
      const identity = [button.id, button.className, button.dataset.action, button.dataset.testid].join(' ');
      const explicit = /(?:password|passwd|pwd)[-_ ]?(?:toggle|visibility|reveal)|(?:toggle|show|hide|reveal)[-_ ]?(?:password|passwd|pwd)/i.test(identity)
        || /^(?=.*\b(?:show|hide|reveal|conceal|mask|unmask|toggle|visibility)\b)(?=.*\b(?:password|passphrase|passcode)\b)/i.test(name);
      const icon = button.matches(eyeSelector) || !!button.querySelector(eyeSelector);
      const action = /^(show|hide|reveal|conceal|unmask|mask|toggle visibility|visibility(?:_off)?)$/i.test(name);
      const linkedSwitch = controls && (button.hasAttribute('aria-pressed') || button.hasAttribute('aria-checked') ||
        button.matches('[role="switch"],input[type="checkbox"]'));
      if (explicit || icon || (identified && action) || linkedSwitch) {
        if (explicit) explicitlyPassword.add(button);
        recognized.push(button);
        if (controls) linked.push(button);
      } else if (identified && button.querySelector('svg,img') &&
        (button instanceof HTMLButtonElement ? button.type === 'button' || !button.form : button.getAttribute('role') === 'button')) {
        if (controls) linked.push(button);
        else localIcons.push(button);
      }
    }

    let matches = linked;
    if (!matches.length) {
      for (let wrapper = field.parentNode; wrapper instanceof Element || wrapper instanceof ShadowRoot; wrapper = wrapper.parentNode) {
        const inputs = Array.from(wrapper.querySelectorAll<HTMLInputElement>('input')).filter(input =>
          visible(input) && !['button','submit','reset','checkbox','radio','image'].includes(input.type));
        if (inputs.length > 1) {
          if (wrapper === field.form && identified && !inputs.some(input => input !== field && (knownFields.has(input) || hasPasswordHint(input)))) {
            matches = recognized.filter(button => wrapper!.contains(button) && explicitlyPassword.has(button));
          }
          break;
        }
        matches = recognized.filter(button => wrapper!.contains(button));
        if (!matches.length && wrapper !== field.form && wrapper !== field.ownerDocument.body) {
          matches = localIcons.filter(button => wrapper!.contains(button));
        }
        if (matches.length || wrapper === field.form || wrapper === field.ownerDocument.body) break;
      }
    }
    if (options.state && matches.length) return masked ? 'masked' : 'revealed';
    for (const button of matches) result.add(button);
  }
  if (options.state) throw new Error('Expected a visible password field.');
  return Array.from(result);
}

export async function passwordDisplayState(field: Locator): Promise<string> {
  return await field.evaluate(inspectControls, { state: true }) as string;
}

// Only retry discovery across a navigation. An actual click is dispatched once.
async function collectButtons(scope: Frame | Page, label: string, buttons: ElementHandle[]) {
  const inputs = scope.locator('input[type="password" i],input[type="text" i],input:not([type])');
  const candidates = label
    ? scope.getByLabel(label, { exact: true }).or(scope.getByPlaceholder(label, { exact: true })).and(inputs)
    : inputs;
  const fields = await candidates.filter({ visible: true }).elementHandles();
  try {
    if (!fields.length) return;
    const list = await fields[0].evaluateHandle(inspectControls, { fields });
    try {
      for (const value of (await list.getProperties()).values()) {
        const button = value.asElement();
        if (button) buttons.push(button);
        else await value.dispose();
      }
    } finally { await list.dispose(); }
  } finally { await Promise.all(fields.map(field => field.dispose())); }
}

export async function clickPasswordToggle(scopes: () => (Frame | Page)[], label: string, index: number | undefined, timeout: number) {
  const deadline = Date.now() + timeout;
  let count = 0;
  do {
    const buttons: ElementHandle[] = [];
    try {
      try {
        for (const scope of scopes()) await collectButtons(scope, label, buttons);
      } catch (error) {
        if (!/frame was detached|execution context was destroyed|cannot find context/i.test(String(error))) throw error;
        continue;
      }
      count = buttons.length;
      if (index === undefined && count > 1) {
        const forField = label ? ' for ' + JSON.stringify(label) : '';
        throw new Error(`Found more than one password toggle${forField} (${count} matches). Use zero-based indexing to target the intended control. First match: flow.click passToggle[0]${forField}; Last match: flow.click passToggle[${count - 1}]${forField};`);
      }
      const selected = buttons[index ?? 0];
      if (selected) {
        await selected.click({ timeout: Math.max(1, deadline - Date.now()) });
        return;
      }
    } finally { await Promise.all(buttons.map(button => button.dispose())); }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error(`Could not select passToggle${index === undefined ? '' : '[' + index + ']'}${label ? ' for "' + label + '"' : ''}. Found ${count} matching controls.`);
}
