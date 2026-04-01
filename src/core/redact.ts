const SENSITIVE_RE =
  /(?:sshpass\s+-p\s*'[^']*'|sshpass\s+-p\s*"[^"]*"|sshpass\s+-p\s*\S+|password[=:]\s*\S+|api[_-]?key[=:]\s*\S+|secret[=:]\s*\S+|token[=:]\s*[A-Za-z0-9_\-\.]{8,}|-i\s+\S+\.pem\b)/gi;

export const redact = (text: string): string =>
  text.replace(SENSITIVE_RE, (m) => {
    const prefix = m.split(/[=:\s]+/)[0];
    return `${prefix} [REDACTED]`;
  });
