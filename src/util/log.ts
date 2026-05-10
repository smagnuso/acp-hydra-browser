type Level = "debug" | "info" | "warn" | "error";

let debugEnabled = false;

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const ts = new Date().toISOString();
  const stream =
    level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`[${ts}] ${level} [${scope}] ${formatArgs(args)}\n`);
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") {
        return a;
      }
      if (a instanceof Error) {
        return a.stack ?? a.message;
      }
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function logger(scope: string) {
  return {
    debug(...args: unknown[]): void {
      if (debugEnabled) {
        emit("debug", scope, args);
      }
    },
    info(...args: unknown[]): void {
      emit("info", scope, args);
    },
    warn(...args: unknown[]): void {
      emit("warn", scope, args);
    },
    error(...args: unknown[]): void {
      emit("error", scope, args);
    },
  };
}
