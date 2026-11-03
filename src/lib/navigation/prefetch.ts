import type { useRouter } from "next/navigation";

type PrefetchOptions = Parameters<ReturnType<typeof useRouter>["prefetch"]>[1];

/** `kind: "full"` is an enum in Next's types but a string at runtime. */
export const FULL_ROUTE_PREFETCH = { kind: "full" } as PrefetchOptions;
