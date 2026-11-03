import type { useRouter } from "next/navigation";

type PrefetchOptions = Parameters<ReturnType<typeof useRouter>["prefetch"]>[1];

/**
 * Next types prefetch kinds as an enum, while the vinext runtime reads the
 * string value. Keep the cast in one place so callers pass a typed option.
 */
export const FULL_ROUTE_PREFETCH = { kind: "full" } as PrefetchOptions;
