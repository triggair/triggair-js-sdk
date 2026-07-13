// Compliance / age-gate (BD-04, design-doc 013 §6). One neutral age screen placed
// before first play (the scaffold's CLAUDE.md instructs this), plus the gated map so
// the UI can pre-disable what a player can't use. Enforcement is server-side — a
// regulated call (loot box, IAP, open chat, public UGC) fails closed regardless; these
// methods just tidy the UI and establish the age signal.
import { type Ctx, need } from "./ctx";

export type Bracket = "unknown" | "under13" | "13_15" | "16_17" | "adult";
export type Feature =
  | "lootbox"
  | "real_money_iap"
  | "open_chat"
  | "public_ugc"
  | "behavioral_push"
  | "friend_from_stranger";
export type ConsentState = "not_required" | "pending" | "granted" | "denied";

export interface ComplianceView {
  bracket: Bracket;
  jurisdiction: string | null;
  consent_state: ConsentState;
  gated: Record<Feature, boolean>;
}
export interface GatePolicy {
  gates: Record<Feature, { min_bracket: Bracket; consent_floor: Bracket | null }>;
  coppa_mode: boolean;
  default_jurisdiction: string | null;
}
export interface ConsentPending {
  id: string | null;
  state: string;
  expires_at: string | null;
}
export interface ConsentRecord {
  id: string;
  state: string;
  scope?: string[];
  expires_at: string;
  decided_at?: string | null;
}

export function compliance(ctx: Ctx) {
  return {
    /** Submit the neutral age screen once, early. Accepts a bracket OR a birth year
     *  (mapped to a bracket and discarded — no DOB is stored). Returns the gated map. */
    setAge: (input: { bracket: Bracket } | { birthYear: number }): Promise<ComplianceView> =>
      need(
        ctx.request<ComplianceView>({
          method: "POST",
          path: "/v1/players/me/age",
          auth: "player",
          body: "bracket" in input ? { bracket: input.bracket } : { birth_year: input.birthYear },
        }),
      ),
    /** This player's bracket, consent state, and gated feature map (to pre-disable UI). */
    status: (): Promise<ComplianceView> =>
      need(
        ctx.request<ComplianceView>({
          method: "GET",
          path: "/v1/players/me/compliance",
          auth: "player",
        }),
      ),
    /** The game's effective gates (pk-only) — known before a player token exists. */
    policy: (): Promise<GatePolicy> =>
      need(ctx.request<GatePolicy>({ method: "GET", path: "/v1/compliance/policy", auth: "pk" })),
    /** Start verifiable parental consent for a minor — a parent is emailed a decision
     *  link (the child never receives it). Returns the pending consent, idempotently. */
    requestConsent: (parentEmail: string): Promise<ConsentPending> =>
      need(
        ctx.request<ConsentPending>({
          method: "POST",
          path: "/v1/players/me/consent/request",
          auth: "player",
          body: { parent_email: parentEmail },
        }),
      ),
    /** This player's latest consent record (state/scope), or null if none. */
    consent: (): Promise<{ consent: ConsentRecord | null }> =>
      need(
        ctx.request<{ consent: ConsentRecord | null }>({
          method: "GET",
          path: "/v1/players/me/consent",
          auth: "player",
        }),
      ),
  };
}
