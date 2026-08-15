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
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

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
      // No pooling: a keep-alive connection to a restarted daemon's stale
      // socket would EPIPE; each call opens a fresh connection.
      agent: false,
    },
    (res) => {
      readBody(res)
        .then((body) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
        .catch(reject);
    },
  );
  if (opts.timeoutMs) {
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`request timed out: ${opts.path}`)));
  }
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
