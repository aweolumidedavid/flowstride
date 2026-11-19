import { isSensitiveField, redactText } from '../security/sensitiveFields';

export function reportText(root: string, extraKeys: readonly string[] = []) {
  const knownKeys = new Set(extraKeys);
  const secrets = Object.entries(process.env)
    .filter(([key]) => isSensitiveField(key) || knownKeys.has(key))
    .flatMap(([, value]) => value ? [value] : []);
  return {
    secrets,
    clean(value: string, limit = 12000): string {
      return redactText(value, secrets)
        .split(root + '/').join('')
        .split(root + '\\').join('')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .slice(0, limit);
    },
  };
}
