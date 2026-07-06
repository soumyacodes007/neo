import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CreateSigningRequestInput,
  PublicSigningRequest,
  SigningRequest,
  SigningResult,
} from "./types.js";

export interface CreatedRequest {
  request: SigningRequest;
  bearer: string;
}

export class SigningRequestStore {
  private readonly requests = new Map<string, SigningRequest>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly defaultTtlMs = 10 * 60 * 1000,
    private readonly maxPending = 3,
  ) {}

  create(input: CreateSigningRequestInput): CreatedRequest {
    this.expireOld();
    const pending = [...this.requests.values()].filter((request) => request.status === "pending");
    if (pending.length >= this.maxPending) {
      throw new Error("E_WALLET_BRIDGE_TOO_MANY_PENDING");
    }

    const sid = randomUUID();
    const bearer = base64Url(randomBytes(32));
    const createdAt = this.now();
    const ttl = input.ttl_ms ?? this.defaultTtlMs;
    const request: SigningRequest = {
      sid,
      bearer_hash: hashBearer(bearer),
      kind: input.kind,
      network: input.network,
      created_at_ms: createdAt,
      expires_at_ms: createdAt + ttl,
      status: "pending",
      payload: input.payload,
      ...(input.plan_hash !== undefined ? { plan_hash: input.plan_hash } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
    };
    this.requests.set(sid, request);
    return { request, bearer };
  }

  getPublic(sid: string, bearer: string): PublicSigningRequest | undefined {
    const request = this.getPendingAuthenticated(sid, bearer);
    if (!request) return undefined;
    return publicRequest(request);
  }

  complete(sid: string, bearer: string, result: SigningResult): SigningRequest | undefined {
    const request = this.getPendingAuthenticated(sid, bearer);
    if (!request) return undefined;
    request.status = "completed";
    request.result = result;
    return request;
  }

  reject(sid: string, bearer: string): SigningRequest | undefined {
    const request = this.getPendingAuthenticated(sid, bearer);
    if (!request) return undefined;
    request.status = "rejected";
    return request;
  }

  get(sid: string): SigningRequest | undefined {
    const request = this.requests.get(sid);
    if (!request) return undefined;
    if (request.status === "pending" && request.expires_at_ms <= this.now()) {
      request.status = "expired";
    }
    return request;
  }

  waitForResult(sid: string, timeoutMs = 10 * 60 * 1000): Promise<SigningRequest> {
    const started = this.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const request = this.get(sid);
        if (!request) {
          reject(new Error("E_WALLET_BRIDGE_UNKNOWN_REQUEST"));
          return;
        }
        if (request.status === "completed" || request.status === "rejected" || request.status === "expired") {
          resolve(request);
          return;
        }
        if (this.now() - started > timeoutMs) {
          reject(new Error("E_WALLET_BRIDGE_AWAIT_TIMEOUT"));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  private getPendingAuthenticated(sid: string, bearer: string): SigningRequest | undefined {
    const request = this.get(sid);
    if (!request || request.status !== "pending") return undefined;
    if (!constantTimeEqual(request.bearer_hash, hashBearer(bearer))) return undefined;
    return request;
  }

  private expireOld(): void {
    for (const request of this.requests.values()) {
      if (request.status === "pending" && request.expires_at_ms <= this.now()) {
        request.status = "expired";
      }
    }
  }
}

function publicRequest(request: SigningRequest): PublicSigningRequest {
  return {
    sid: request.sid,
    kind: request.kind,
    network: request.network,
    expires_at_ms: request.expires_at_ms,
    payload: request.payload,
    ...(request.plan_hash !== undefined ? { plan_hash: request.plan_hash } : {}),
    ...(request.account !== undefined ? { account: request.account } : {}),
  };
}

export function hashBearer(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
