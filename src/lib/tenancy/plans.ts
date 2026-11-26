/**
 * The plans, hardcoded. This file is pure data and helpers with no imports on purpose: scripts/tenant.mjs copies it
 * into the tenant Worker build (src/lib/tenancy/plans.ts), so the cloud app and the workspaces read one definition.
 *
 * Limits are -1 for "custom" (Enterprise is agreed with sales, then set per workspace in `workspaces.overrides`).
 * Prices and trials are what the Paymug product of the same tier is set to: the cards show them, Paymug bills them.
 * Paymug's "Professional" product is the Solo plan.
 *
 * Plans are code, not database rows: nothing in the DB holds a plan's numbers. `subscriptions.tier` and
 * `workspaces.overrides` (per-workspace operator exceptions) are the only plan state stored.
 */

export type Tier = "solo" | "starter" | "team" | "business" | "enterprise";

const GB = 2 ** 30;

/** Every self-serve plan has the same trial. Paymug's products must be set to the same number of days by hand. */
const TRIAL_DAYS = 7;

export interface Entitlements {
  /** Seats. */
  users: number;
  domains: number;
  /** Storage shared by the workspace (Drive and attachments). */
  storageBytes: number;
  /** Outbound emails each user may send per UTC day: an abuse brake, not a quota to sell. */
  emailsPerUserPerDay: number;
  bookingTier: "basic" | "full";
  sso: boolean;
  support: "community" | "email" | "priority";
}

export interface Plan {
  tier: Tier;
  name: string;
  /** USD per month, what Paymug bills (the launch price while one runs), null when sold by contact. */
  priceMonthly: number | null;
  /** USD per month after launch, shown struck through next to `priceMonthly` on the cards. Omit when there is no launch price. */
  regularPriceMonthly?: number;
  /** Length of the free trial, as configured on the Paymug product (the card only advertises it). 0 = none. */
  trialDays: number;
  /** The Paymug product sold for this tier (checkout is `<PAYMUG_URL>/p/<slug>`); null for sales-led plans. */
  paymug: { productId: string; slug: string; title: string } | null;
  entitlements: Entitlements;
}

export const PLANS: readonly Plan[] = [
  { tier: "solo", name: "Solo", priceMonthly: 4, regularPriceMonthly: 6, trialDays: TRIAL_DAYS, paymug: { productId: "56dc1353-b430-4c19-acf8-29fad92003bc", slug: "mailflare-cloud-professional", title: "Mailflare Cloud for Professional" }, entitlements: { users: 1, domains: 5, storageBytes: 50 * GB, emailsPerUserPerDay: 200, bookingTier: "full", sso: false, support: "email" } },
  // TODO: create the Starter product at Paymug (7-day trial, $16 / month), then put its id here (the webhook maps product id -> tier).
  { tier: "starter", name: "Starter", priceMonthly: 16, regularPriceMonthly: 19, trialDays: TRIAL_DAYS, paymug: { 
    productId: "4add2abf-d42e-45cb-b568-ebb808cdb947", // prod
    // productId: "6ecb7064-7ef6-40b9-9e12-a0843841992c", // testing
    slug: "mailflare-cloud-starter", title: "Mailflare Cloud for Starter" }, entitlements: { users: 5, domains: 15, storageBytes: 200 * GB, emailsPerUserPerDay: 200, bookingTier: "full", sso: false, support: "email" } },
  { tier: "team", name: "Team", priceMonthly: 34, regularPriceMonthly: 39, trialDays: TRIAL_DAYS, paymug: { productId: "890eeb32-1a92-446d-8b39-a4e39dd93c7a", slug: "mailflare-cloud-team", title: "Mailflare Cloud for Team" }, entitlements: { users: 10, domains: 30, storageBytes: 1024 * GB, emailsPerUserPerDay: 200, bookingTier: "full", sso: false, support: "email" } },
  { tier: "business", name: "Business", priceMonthly: 149, regularPriceMonthly: 199, trialDays: TRIAL_DAYS, paymug: { productId: "46ccaf45-a53f-4fbc-ba44-f639ab145ae6", slug: "mailflare-cloud-business", title: "Mailflare Cloud for Business" }, entitlements: { users: 50, domains: 100, storageBytes: 5 * 1024 * GB, emailsPerUserPerDay: 200, bookingTier: "full", sso: false, support: "priority" } },
  { tier: "enterprise", name: "Enterprise", priceMonthly: null, trialDays: 0, paymug: null, entitlements: { users: -1, domains: -1, storageBytes: -1, emailsPerUserPerDay: -1, bookingTier: "full", sso: true, support: "priority" } },
];

export const isTier = (value: unknown): value is Tier => PLANS.some((plan) => plan.tier === value);
export const getPlan = (tier: string | null | undefined): Plan | null => PLANS.find((plan) => plan.tier === tier) ?? null;

/** Plans anyone can start without talking to us. */
export const selfServePlans = (): Plan[] => PLANS.filter((plan) => plan.tier !== "enterprise");

/** Plan entitlements with the operator's per-workspace overrides (`workspaces.overrides`, JSON) on top. */
export function effectiveEntitlements(tier: string | null | undefined, overrides?: string | null): Entitlements {
  const base = (getPlan(tier) ?? PLANS[0]).entitlements;
  let extra: Partial<Entitlements> = {};
  try { extra = JSON.parse(overrides || "{}"); } catch { /* ignore a malformed override */ }
  return { ...base, ...extra };
}

/** Smallest self-serve plan whose seats cover the team. Larger teams get the biggest self-serve plan (Enterprise is sales-led). */
export function planForTeamSize(maxPeople: number): Plan {
  const plans = selfServePlans();
  return plans.find((plan) => plan.entitlements.users >= maxPeople) ?? plans[plans.length - 1];
}

/** While a workspace is in its free trial each user may send this many emails a day, and it may have this many domains: the trial is when abusers sign up. */
export const TRIAL_EMAILS_PER_USER_PER_DAY = 20;
export const TRIAL_DOMAINS = 1;
/** Seats a free trial may use, whatever the plan: send limits are per user, so seats multiply them. */
export const TRIAL_USERS = 3;
/** Recipients (to + cc + bcc) the whole workspace may mail per UTC day during the free trial. */
export const TRIAL_RECIPIENTS_PER_DAY = 50;

/**
 * What a workspace is held to (the `tenants` view hands the tenant Worker a tier, when the workspace was activated, whether it
 * ever subscribed, and the operator's overrides; it resolves them with this). A workspace that has not subscribed is on our own
 * free trial (no card): for `trialDays` after `activatedAt` the limits are the lower trial ones (daily sends, daily recipients, seats, domains),
 * each unless an operator override sets it, and `trialEndsAt` (unix seconds) says until when. When the trial is over and it still
 * has not subscribed, `trialExpired` is 1: the tenant app shows an upgrade banner, blurs inbound mail and refuses sending and adding
 * domains, users, mailboxes and files (an operator override `{"trialExpired": 0}` lifts it). A subscribed workspace has neither.
 */
export function tenantLimitsFor(tier: string | null | undefined, overrides?: Record<string, unknown>, activatedAt?: number | null, subscribed = false, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, number> {
  const { users, domains, storageBytes, emailsPerUserPerDay } = effectiveEntitlements(tier, JSON.stringify(overrides ?? {}));
  const limits: Record<string, number> = { users, domains, storageBytes, emailsPerUserPerDay };
  if (subscribed || !activatedAt) return limits;
  const trialEndsAt = activatedAt + (getPlan(tier)?.trialDays ?? 0) * 86400;
  if (trialEndsAt > nowSeconds) {
    if (overrides?.emailsPerUserPerDay === undefined) limits.emailsPerUserPerDay = emailsPerUserPerDay < 0 ? TRIAL_EMAILS_PER_USER_PER_DAY : Math.min(emailsPerUserPerDay, TRIAL_EMAILS_PER_USER_PER_DAY);
    if (overrides?.domains === undefined) limits.domains = domains < 0 ? TRIAL_DOMAINS : Math.min(domains, TRIAL_DOMAINS);
    if (overrides?.users === undefined) limits.users = users < 0 ? TRIAL_USERS : Math.min(users, TRIAL_USERS);
    limits.recipientsPerDay = Number(overrides?.recipientsPerDay ?? TRIAL_RECIPIENTS_PER_DAY);
    limits.trialEndsAt = trialEndsAt;
  } else if (overrides?.trialExpired === undefined && getPlan(tier)?.trialDays) limits.trialExpired = 1;
  return limits;
}
