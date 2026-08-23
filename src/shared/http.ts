import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Read a request/response body fully as a UTF-8 string. */
export function readBody(stream: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      reject(new Error(`body exceeds ${maxBytes} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  stream.on("error", reject);
  return promise;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export type RequestOptions = {
  method?: string;
  path: string;
  /** Unix domain socket target; mutually exclusive with host/port. */
  socketPath?: string;
  host?: string;
  port?: number;
  /** Extra headers merged into the request; caller keys win. */
  headers?: Record<string, string>;
  body?: string;
  /** Socket-level timeout; defaults to DEFAULT_TIMEOUT_MS so a call cannot hang forever. */
  timeoutMs?: number;
  /** Called once per complete NDJSON line as chunks arrive (streaming reads). */
  onLine?: (line: string) => void;
  /** Abort the call, closing the socket. */
  signal?: AbortSignal;
};

/** Applied when a caller passes no timeoutMs: long polls fit, hangs do not. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export type HttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/**
 * Minimal HTTP client that works over unix domain sockets as well as TCP
 * (global fetch cannot target socketPath). Shared by CLI, tests, and the
 * daemon's outbound calls.
 */
export function request(opts: RequestOptions): Promise<HttpResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResponse>();
  const req = http.request(
    {
      method: opts.method ?? "GET",
      path: opts.path,
      socketPath: opts.socketPath,
      host: opts.socketPath ? undefined : (opts.host ?? "127.0.0.1"),
      port: opts.socketPath ? undefined : opts.port,
      headers: opts.headers,
      signal: opts.signal,
      // No pooling: a keep-alive connection to a restarted daemon's stale
      // socket would EPIPE; each call opens a fresh connection.
      agent: false,
    },
    (res) => {
      if (!opts.onLine) {
        readBody(res)
          .then((body) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
          .catch(reject);
        return;
      }
      // Streaming mode: hand each complete NDJSON line to the caller as it
      // arrives, and still resolve with the full body once the response ends.
      let full = "";
      let pending = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        full += chunk;
        pending += chunk;
        let nl = pending.indexOf("\n");
        while (nl !== -1) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (line !== "") opts.onLine(line);
          nl = pending.indexOf("\n");
        }
      });
      res.on("end", () => {
        const tail = pending.trim();
        if (tail !== "") opts.onLine(tail);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: full });
      });
      res.on("error", reject);
    },
  );
  req.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, () =>
    req.destroy(new Error(`request timed out: ${opts.path}`)),
  );
  req.on("error", reject);
  req.end(opts.body ?? undefined);
  return promise;
}

/** `request` + JSON body/headers both ways. `json` is null when the body is not JSON. */
export async function requestJson(
  opts: Omit<RequestOptions, "body"> & { body?: unknown },
): Promise<HttpResponse & { json: unknown }> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers = { ...opts.headers };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await request({ ...opts, headers, body });
  let json: unknown = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    // non-JSON body (e.g. ndjson dump); caller reads res.body directly
  }
  return { ...res, json };
}
