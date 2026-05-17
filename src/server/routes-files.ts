import { promises as fsp } from "node:fs";
import { resolve, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HydraRestClient } from "../hydra/client.js";
import type { ServerContext } from "./http.js";

interface ListBody {
  sessionId?: string;
  path?: string;
}

interface ReadBody {
  sessionId?: string;
  path?: string;
  maxBytes?: number;
}

export interface FileEntry {
  name: string;
  kind: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
}

// Resolve a request `path` (relative to the session's cwd) and verify it is
// inside the cwd after symlink resolution. Returns the realpath if safe,
// otherwise throws PathScopeError.
export async function resolveScopedPath(
  cwd: string,
  requested: string,
): Promise<string> {
  const cwdReal = await fsp.realpath(cwd);
  const cwdReq = requested.length === 0 ? "." : requested;
  const target = resolve(cwdReal, cwdReq);
  let real: string;
  try {
    real = await fsp.realpath(target);
  } catch {
    real = target;
  }
  const cwdWithSep = cwdReal.endsWith(sep) ? cwdReal : cwdReal + sep;
  if (real !== cwdReal && !real.startsWith(cwdWithSep)) {
    throw new PathScopeError(
      `path escapes cwd: requested=${requested} resolved=${real} cwd=${cwdReal}`,
    );
  }
  return real;
}

export class PathScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathScopeError";
  }
}

async function lookupSessionCwd(
  ctx: ServerContext,
  request: FastifyRequest,
  sessionId: string,
): Promise<string | undefined> {
  const token = request.sessionToken ?? ctx.config.hydraToken;
  const client = HydraRestClient.forRequest(ctx.config.hydraDaemonUrl, token);
  const result = await client.listSessions({ all: true });
  const match = result.sessions.find((s) => s.sessionId === sessionId);
  return match?.cwd;
}

export function registerFileRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.post("/api/files/list", async (request, reply) => {
    const body = (request.body ?? {}) as ListBody;
    if (!body.sessionId) {
      reply.code(400).send({ error: "sessionId required" });
      return;
    }
    const cwd = await lookupSessionCwd(ctx, request, body.sessionId);
    if (!cwd) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    let target: string;
    try {
      target = await resolveScopedPath(cwd, body.path ?? "");
    } catch (err) {
      if (err instanceof PathScopeError) {
        reply.code(400).send({ error: "path out of scope" });
        return;
      }
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      reply.code(404).send({ error: (err as Error).message });
      return;
    }
    if (!stat.isDirectory()) {
      reply.code(400).send({ error: "not a directory" });
      return;
    }
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      const childPath = resolve(target, d.name);
      let s;
      try {
        s = await fsp.stat(childPath);
      } catch {
        continue;
      }
      let kind: FileEntry["kind"] = "other";
      if (s.isDirectory()) {
        kind = "dir";
      } else if (s.isFile()) {
        kind = "file";
      }
      entries.push({
        name: d.name,
        kind,
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    reply.send({ cwd, path: body.path ?? "", entries });
  });

  app.post("/api/files/read", async (request, reply) => {
    const body = (request.body ?? {}) as ReadBody;
    if (!body.sessionId) {
      reply.code(400).send({ error: "sessionId required" });
      return;
    }
    if (!body.path) {
      reply.code(400).send({ error: "path required" });
      return;
    }
    const cwd = await lookupSessionCwd(ctx, request, body.sessionId);
    if (!cwd) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    let target: string;
    try {
      target = await resolveScopedPath(cwd, body.path);
    } catch (err) {
      if (err instanceof PathScopeError) {
        reply.code(400).send({ error: "path out of scope" });
        return;
      }
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      reply.code(404).send({ error: (err as Error).message });
      return;
    }
    if (!stat.isFile()) {
      reply.code(400).send({ error: "not a file" });
      return;
    }
    const max = Math.min(
      body.maxBytes ?? ctx.config.fileMaxBytes,
      ctx.config.fileMaxBytes,
    );
    if (stat.size > max) {
      reply.code(413).send({ error: `file larger than ${max} bytes` });
      return;
    }
    const buf = await fsp.readFile(target);
    if (containsBinary(buf)) {
      reply.code(415).send({ error: "binary file" });
      return;
    }
    reply.send({
      path: body.path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      content: buf.toString("utf8"),
    });
  });
}

// Heuristic: presence of a NUL byte in the first 8 KiB indicates binary.
function containsBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}
