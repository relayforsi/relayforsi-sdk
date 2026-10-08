/** Reads an environment variable. Undefined when there is no `process.env` or no permission. */
export function readEnv(name: string): string | undefined {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `process` is not in the ES or DOM libs
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const value = env?.[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    // Deno throws without --allow-env.
    return undefined;
  }
}

/** True in a browser window. Workers, Deno, Bun and Node have no `window`. */
export function isBrowser(): boolean {
  const scope = globalThis as { window?: unknown; document?: unknown };
  return typeof scope.window !== "undefined" && typeof scope.document !== "undefined";
}

/** Monotonic milliseconds. */
export function monotonicNow(): number {
  return globalThis.performance.now();
}

/** The runtime for the user agent: `node/22.20.0`, `bun/1.2.3`, `deno/2.4.0` or `workerd`. */
export function runtimeName(): string {
  const scope = globalThis as {
    Bun?: { version?: string };
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
    navigator?: { userAgent?: string };
  };
  // Bun and Deno also set process.versions.node, so check them first.
  if (scope.Bun?.version) return `bun/${scope.Bun.version}`;
  if (scope.Deno?.version?.deno) return `deno/${scope.Deno.version.deno}`;
  if (scope.process?.versions?.node) return `node/${scope.process.versions.node}`;
  if (scope.navigator?.userAgent === "Cloudflare-Workers") return "workerd";
  return "unknown";
}

/** Strips characters that are not allowed in a header value. */
export function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "").trim();
}

export function describe(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  return String(value);
}
