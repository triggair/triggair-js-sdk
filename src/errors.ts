// The §4 error envelope, client-side. Every SDK failure throws a TriggairError
// carrying the fields an agent needs to self-correct: `code`, `message`, the
// actionable `agentHint`, a `doc` link, and the `requestId` to quote. `retryable`
// marks the transient codes the transport backs off on (429/503-class).
export type TriggairErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "cors_forbidden"
  | "conflict"
  | "save_conflict"
  | "not_found"
  | "payload_too_large"
  | "quota_exceeded"
  | "rate_limited"
  | "internal"
  | "network";

interface Envelope {
  error?: {
    code?: string;
    message?: string;
    agent_hint?: string;
    doc?: string;
    request_id?: string;
  };
}

export class TriggairError extends Error {
  readonly code: TriggairErrorCode;
  readonly agentHint: string;
  readonly requestId: string | undefined;
  readonly doc: string | undefined;
  readonly httpStatus: number;

  constructor(
    httpStatus: number,
    fields: {
      code: string;
      message: string;
      agentHint: string;
      requestId?: string | undefined;
      doc?: string | undefined;
    },
  ) {
    super(fields.message);
    this.name = "TriggairError";
    this.httpStatus = httpStatus;
    this.code = fields.code as TriggairErrorCode;
    this.agentHint = fields.agentHint;
    this.requestId = fields.requestId;
    this.doc = fields.doc;
  }

  /** Transient — the transport retries these with backoff. */
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "network" || this.httpStatus >= 500;
  }
}

/** Parse a non-2xx Response into a TriggairError, tolerating a non-envelope body. */
export async function parseError(res: Response): Promise<TriggairError> {
  let e: Envelope["error"];
  try {
    e = ((await res.json()) as Envelope).error;
  } catch {
    // non-JSON / empty body
  }
  return new TriggairError(res.status, {
    code: e?.code ?? "internal",
    message: e?.message ?? `Request failed (${res.status})`,
    agentHint:
      e?.agent_hint ??
      "The API returned an unexpected response — retry; if it persists, report it.",
    requestId: e?.request_id ?? res.headers.get("x-request-id") ?? undefined,
    doc: e?.doc,
  });
}

/** A failed fetch (offline / DNS / CORS) as a retryable network TriggairError. */
export function networkError(cause: unknown): TriggairError {
  return new TriggairError(0, {
    code: "network",
    message: cause instanceof Error ? cause.message : "Network request failed",
    agentHint:
      "The request never reached Triggair (offline, DNS, or a CORS block). If it works locally but fails when deployed, add your origin to the game's allowed_origins.",
  });
}
