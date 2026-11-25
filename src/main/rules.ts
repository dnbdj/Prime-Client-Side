export type Rule = {
  action: 'allow' | 'disallow';
  os?: { name?: string; version?: string; arch?: string };
  features?: Record<string, boolean>;
};

export type OsKey = 'windows' | 'osx' | 'linux';

export function osKey(): OsKey {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    default:
      return 'linux';
  }
}

function archName(): string {
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'x64') return 'x86_64';
  return process.arch;
}

function ruleMatches(rule: Rule, features: Record<string, boolean>): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osKey()) return false;
    if (rule.os.arch && rule.os.arch !== archName()) return false;
    // Exact OS-version matching is only used for very old macOS/Linux builds;
    // treat an unparsable version requirement as satisfied.
  }
  if (rule.features) {
    for (const [name, required] of Object.entries(rule.features)) {
      if ((features[name] ?? false) !== required) return false;
    }
  }
  return true;
}

/**
 * Vanilla semantics: no rules means allowed; otherwise the last matching rule wins.
 */
export function rulesAllow(
  rules: Rule[] | undefined,
  features: Record<string, boolean> = {},
): boolean {
  if (!rules || rules.length === 0) return true;
  let allow = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, features)) continue;
    allow = rule.action === 'allow';
  }
  return allow;
}
