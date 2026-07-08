import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import type { ApprovalRequest, CreateSigningRequestInput, SigningRequest } from "./types.js";
import { SigningRequestStore } from "./request-store.js";
import { parseSigningResult, verifySigningResult } from "./verify-signed-xdr.js";
import { renderCompanionHtml } from "./client-html.js";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_ASSET_CANDIDATES = [
  path.join(DIST_DIR, "client", "companion.js"),
  path.join(DIST_DIR, "..", "dist", "client", "companion.js"),
];

export interface WalletBridgeOptions {
  host?: "127.0.0.1" | "localhost";
  store?: SigningRequestStore;
}

export class WalletBridge {
  private server: Server | undefined;
  private origin: string | undefined;
  private readonly host: "127.0.0.1" | "localhost";
  readonly store: SigningRequestStore;

  constructor(options: WalletBridgeOptions = {}) {
    this.host = options.host ?? "localhost";
    this.store = options.store ?? new SigningRequestStore();
  }

  async start(): Promise<string> {
    if (this.origin) return this.origin;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, this.host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("E_WALLET_BRIDGE_NO_PORT");
    this.origin = `http://${this.host}:${address.port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.origin = undefined;
  }

  async createSigningRequest(input: CreateSigningRequestInput): Promise<ApprovalRequest> {
    const origin = await this.start();
    const { request, bearer } = this.store.create(input);
    return {
      sid: request.sid,
      approval_url: `${origin}/approve/${encodeURIComponent(request.sid)}#${bearer}`,
      expires_at_ms: request.expires_at_ms,
    };
  }

  waitForResult(sid: string, timeoutMs?: number): Promise<SigningRequest> {
    return this.store.waitForResult(sid, timeoutMs);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.isTrustedRequest(req)) {
        sendText(res, 403, "forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", this.origin ?? "http://127.0.0.1");
      setSecurityHeaders(res);

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/assets/companion.js") {
        sendJs(res, await readFirstExisting(COMPANION_ASSET_CANDIDATES));
        return;
      }

      const approveMatch = /^\/approve\/([^/]+)$/u.exec(url.pathname);
      if (req.method === "GET" && approveMatch) {
        sendHtml(res, renderCompanionHtml());
        return;
      }

      const requestMatch = /^\/api\/request\/([^/]+)$/u.exec(url.pathname);
      if (req.method === "GET" && requestMatch) {
        const auth = parseAuth(req, requestMatch[1] ?? "");
        if (!auth) {
          sendText(res, 404, "not found");
          return;
        }
        const publicRequest = this.store.getPublic(auth.sid, auth.bearer);
        if (!publicRequest) {
          sendText(res, 404, "not found");
          return;
        }
        sendJson(res, 200, publicRequest);
        return;
      }

      const rejectMatch = /^\/api\/reject\/([^/]+)$/u.exec(url.pathname);
      if (req.method === "POST" && rejectMatch) {
        const auth = parseAuth(req, rejectMatch[1] ?? "");
        if (!auth || !this.store.reject(auth.sid, auth.bearer)) {
          sendText(res, 404, "not found");
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const resultMatch = /^\/api\/result\/([^/]+)$/u.exec(url.pathname);
      if (req.method === "POST" && resultMatch) {
        const auth = parseAuth(req, resultMatch[1] ?? "");
        if (!auth) {
          sendText(res, 404, "not found");
          return;
        }
        const publicRequest = this.store.getPublic(auth.sid, auth.bearer);
        if (!publicRequest) {
          sendText(res, 404, "not found");
          return;
        }
        const parsed = parseSigningResult(await readJson(req));
        if (!parsed) {
          sendJson(res, 400, { ok: false, error: "E_WALLET_BRIDGE_INVALID_RESULT" });
          return;
        }
        const verification = verifySigningResult(publicRequest.payload, parsed, publicRequest.plan_hash);
        if (!verification.ok) {
          sendJson(res, 400, verification);
          return;
        }
        const completed = this.store.complete(auth.sid, auth.bearer, parsed);
        if (!completed) {
          sendText(res, 404, "not found");
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      sendText(res, 404, "not found");
    } catch (error) {
      sendText(res, 500, error instanceof Error ? error.message : "internal error");
    }
  }

  private isTrustedRequest(req: IncomingMessage): boolean {
    if (!this.origin) return false;
    const expectedHost = this.origin.replace("http://", "");
    const host = req.headers.host;
    if (host !== expectedHost) return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === this.origin;
  }
}

function parseAuth(req: IncomingMessage, sidFromPath: string): { sid: string; bearer: string } | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length);
  const dot = token.indexOf(".");
  if (dot <= 0) return undefined;
  const sid = token.slice(0, dot);
  const bearer = token.slice(dot + 1);
  if (sid !== sidFromPath || bearer.length === 0) return undefined;
  return { sid, bearer };
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "connect-src 'self' https://soroban-testnet.stellar.org https://friendbot.stellar.org https://smart-account-indexer.sdf-ecosystem.workers.dev",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

function sendHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function sendJs(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("E_WALLET_BRIDGE_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readFirstExisting(paths: string[]): Promise<string> {
  for (const candidate of paths) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Try the next source/dist candidate.
    }
  }
  throw new Error("E_WALLET_BRIDGE_CLIENT_ASSET_MISSING");
}
