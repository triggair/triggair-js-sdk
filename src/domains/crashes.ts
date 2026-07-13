// Crash reporting (009 D9). Report an uncaught error/crash; the server fingerprints + groups it so
// a flood of stacks becomes a handful of actionable issues. Player-authed. The response returns the
// group id + status so a client can throttle re-reporting a resolved/ignored issue.
import { type Ctx, need } from "./ctx";

export interface CrashResult {
  ok: true;
  group_id: string;
  status: string;
}

export function crashes(ctx: Ctx) {
  return {
    report: (
      message: string,
      opts?: { stack?: string; platform?: string; appVersion?: string; ts?: number },
    ) =>
      need(
        ctx.request<CrashResult>({
          method: "POST",
          path: "/v1/crashes",
          auth: "player",
          body: {
            message,
            ...(opts?.stack !== undefined ? { stack: opts.stack } : {}),
            ...(opts?.platform !== undefined ? { platform: opts.platform } : {}),
            ...(opts?.appVersion !== undefined ? { app_version: opts.appVersion } : {}),
            ...(opts?.ts !== undefined ? { ts: opts.ts } : {}),
          },
        }),
      ),
  };
}
