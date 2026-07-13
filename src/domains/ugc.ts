// User-generated content (BD-08, design-doc 007) — players author content (levels, decks,
// tracks…), keep it as a private draft, then submit it for publication (moderated by trust &
// safety). Only public items are discoverable via browse(). Payload is structured JSON (≤256
// KB). Rate/play the content, or remix a public item into your own draft. File attachments
// are a later slice.
import { type Ctx, need } from "./ctx";

export interface UgcItem {
  id: string;
  author_id: string;
  type: string;
  title: string;
  description: string;
  payload: unknown;
  tags: string[];
  state: "draft" | "submitted" | "public" | "rejected" | "unlisted" | "removed";
  moderation_state: "pending" | "approved" | "rejected";
  play_count: number;
  like_count: number;
  rating_count: number;
  allow_remix: boolean;
  published_at: string | null;
}
export interface UgcInput {
  title?: string;
  description?: string;
  payload?: unknown;
  tags?: string[];
  allow_remix?: boolean;
}
const enc = (s: string) => encodeURIComponent(s);

export function ugc(ctx: Ctx) {
  return {
    /** Create a private draft of a `type` (level/deck/…). Submit it later to publish. */
    create: (type: string, input: UgcInput = {}): Promise<{ item: UgcItem }> =>
      need(
        ctx.request<{ item: UgcItem }>({
          method: "POST",
          path: "/v1/ugc",
          auth: "player",
          body: { type, ...input },
        }),
      ),
    /** One item — public, or the caller's own draft. */
    get: (id: string): Promise<{ item: UgcItem }> =>
      need(
        ctx.request<{ item: UgcItem }>({
          method: "GET",
          path: `/v1/ugc/${enc(id)}`,
          auth: "player",
        }),
      ),
    /** Edit a draft (resets it to draft — re-submit to publish). */
    update: (id: string, patch: UgcInput): Promise<{ item: UgcItem }> =>
      need(
        ctx.request<{ item: UgcItem }>({
          method: "PATCH",
          path: `/v1/ugc/${enc(id)}`,
          auth: "player",
          body: patch,
        }),
      ),
    delete: (id: string): Promise<{ deleted: boolean }> =>
      need(
        ctx.request<{ deleted: boolean }>({
          method: "DELETE",
          path: `/v1/ugc/${enc(id)}`,
          auth: "player",
        }),
      ),
    /** Submit a draft for publication → runs moderation. Returns the resulting state. */
    submit: (id: string): Promise<{ state: string; moderation_state: string }> =>
      need(
        ctx.request<{ state: string; moderation_state: string }>({
          method: "POST",
          path: `/v1/ugc/${enc(id)}/submit`,
          auth: "player",
        }),
      ),
    /** The caller's items (all states). */
    mine: async (): Promise<UgcItem[]> =>
      (
        await need(
          ctx.request<{ items: UgcItem[] }>({
            method: "GET",
            path: "/v1/ugc/mine",
            auth: "player",
          }),
        )
      ).items,
    /** Fork a public, remix-allowed item into a new draft of yours (with attribution lineage). */
    remix: (id: string): Promise<{ item: UgcItem }> =>
      need(
        ctx.request<{ item: UgcItem }>({
          method: "POST",
          path: `/v1/ugc/${enc(id)}/remix`,
          auth: "player",
        }),
      ),
    /** An item's lineage: its parent (`remix_of`), the lineage `root_id`, and its remixes. */
    lineage: (
      id: string,
    ): Promise<{
      id: string;
      remix_of: string | null;
      root_id: string;
      remixes: { id: string; author_id: string; title: string }[];
    }> => need(ctx.request({ method: "GET", path: `/v1/ugc/${enc(id)}/lineage`, auth: "pk" })),
    /** Record a play (debounced) — also unlocks rating (you must play before you rate). */
    play: (id: string): Promise<{ played: boolean; counted: boolean }> =>
      need(
        ctx.request<{ played: boolean; counted: boolean }>({
          method: "POST",
          path: `/v1/ugc/${enc(id)}/play`,
          auth: "player",
        }),
      ),
    /** Rate a public item 1–5 (one vote per player, upsert). Can't rate your own. */
    rate: (id: string, value: number): Promise<{ rated: boolean; value: number }> =>
      need(
        ctx.request<{ rated: boolean; value: number }>({
          method: "POST",
          path: `/v1/ugc/${enc(id)}/rate`,
          auth: "player",
          body: { value },
        }),
      ),
    /** Like a public item (one per player, idempotent). Can't like your own. */
    like: (id: string): Promise<{ liked: boolean; like_count: number }> =>
      need(
        ctx.request<{ liked: boolean; like_count: number }>({
          method: "POST",
          path: `/v1/ugc/${enc(id)}/like`,
          auth: "player",
        }),
      ),
    /** Remove your like (idempotent). */
    unlike: (id: string): Promise<{ liked: boolean; like_count: number }> =>
      need(
        ctx.request<{ liked: boolean; like_count: number }>({
          method: "DELETE",
          path: `/v1/ugc/${enc(id)}/like`,
          auth: "player",
        }),
      ),
    /** Browse public items (pk). `sort`: new (default) | top | popular. */
    browse: async (
      opts: { type?: string; sort?: "new" | "top" | "popular"; limit?: number } = {},
    ): Promise<UgcItem[]> => {
      const q = new URLSearchParams();
      if (opts.type) q.set("type", opts.type);
      if (opts.sort) q.set("sort", opts.sort);
      if (opts.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return (
        await need(
          ctx.request<{ items: UgcItem[] }>({
            method: "GET",
            path: `/v1/ugc${qs ? `?${qs}` : ""}`,
            auth: "pk",
          }),
        )
      ).items;
    },
  };
}
