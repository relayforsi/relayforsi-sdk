import { RelayForSIError } from "./core/errors";
import type { Page } from "./types";

/** Maximum page size. */
export const MAX_PAGE = 100;

/** Query for a page in `all()`. Uses the maximum page size unless `limit` is set. */
export function pageQuery<P extends { limit?: number | undefined; cursor?: string | undefined }>(
  params: P | undefined,
  cursor: string | undefined,
): P {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only limit and cursor change
  return { ...params, limit: params?.limit ?? MAX_PAGE, cursor: cursor ?? params?.cursor } as P;
}

export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* page.data;
    const next = page.next_cursor;
    if (next === null || next === undefined) return;
    if (seen.has(next)) {
      throw new RelayForSIError(
        "unexpected_response",
        "The API returned a cursor it already returned. Stopping to avoid an infinite loop.",
      );
    }
    seen.add(next);
    cursor = next;
  }
}
