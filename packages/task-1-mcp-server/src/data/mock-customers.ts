export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'PAST_DUE';
export type AccountTier = 'STARTER' | 'GROWTH' | 'ENTERPRISE';

export interface CustomerOrderSummary {
  readonly order_id: string;
  readonly amount_usd: number;
  readonly purchased_at: string;
  readonly status: 'PAID' | 'REFUNDED';
}

export interface CustomerRecord {
  readonly customer_id: string;
  readonly full_name: string;
  readonly company: string;
  readonly email: string;
  readonly tier: AccountTier;
  readonly status: AccountStatus;
  readonly currency: 'USD';
  readonly lifetime_spend_usd: number;
  readonly refundable_balance_usd: number;
  readonly created_at: string;
  readonly recent_orders: readonly CustomerOrderSummary[];
}

export const SEEDED_MOCK_CUSTOMERS: Readonly<Record<string, CustomerRecord>> = {
  'CUST-12345': {
    customer_id: 'CUST-12345',
    full_name: 'Elena Vance',
    company: 'Northstar Logistics Inc.',
    email: 'elena.vance@example.test',
    tier: 'ENTERPRISE',
    status: 'ACTIVE',
    currency: 'USD',
    lifetime_spend_usd: 14850.0,
    refundable_balance_usd: 2450.75,
    created_at: '2024-03-14T10:15:00.000Z',
    recent_orders: [
      {
        order_id: 'ORD-90112',
        amount_usd: 150.5,
        purchased_at: '2026-01-18T14:22:00.000Z',
        status: 'PAID',
      },
      {
        order_id: 'ORD-89410',
        amount_usd: 2300.25,
        purchased_at: '2025-12-04T09:05:00.000Z',
        status: 'PAID',
      },
    ],
  },
  'CUST-10001': {
    customer_id: 'CUST-10001',
    full_name: 'Marcus Chen',
    company: 'Apex Cloud Analytics',
    email: 'marcus.chen@example.test',
    tier: 'GROWTH',
    status: 'ACTIVE',
    currency: 'USD',
    lifetime_spend_usd: 4200.0,
    refundable_balance_usd: 680.0,
    created_at: '2024-08-21T16:40:00.000Z',
    recent_orders: [
      {
        order_id: 'ORD-88201',
        amount_usd: 680.0,
        purchased_at: '2026-01-09T11:30:00.000Z',
        status: 'PAID',
      },
    ],
  },
  'CUST-54321': {
    customer_id: 'CUST-54321',
    full_name: 'Priya Nair',
    company: 'Veridian BioSystems',
    email: 'priya.nair@example.test',
    tier: 'STARTER',
    status: 'PAST_DUE',
    currency: 'USD',
    lifetime_spend_usd: 890.0,
    refundable_balance_usd: 125.0,
    created_at: '2025-05-02T08:00:00.000Z',
    recent_orders: [
      {
        order_id: 'ORD-87119',
        amount_usd: 125.0,
        purchased_at: '2025-11-29T19:10:00.000Z',
        status: 'PAID',
      },
    ],
  },
};

const SYNTHETIC_FIRST_NAMES = ['Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley'] as const;
const SYNTHETIC_LAST_NAMES = ['Hayes', 'Patel', 'Brooks', 'Kim', 'Rivera'] as const;
const SYNTHETIC_TIERS: readonly AccountTier[] = ['STARTER', 'GROWTH', 'ENTERPRISE'];

/**
 * Deterministically resolves a mock customer record.
 * - `CUST-00000` is reserved as a deterministic "not found" fixture.
 * - Pre-seeded IDs return their curated records.
 * - Any other valid `CUST-XXXXX` ID deterministically derives a stable synthetic profile.
 */
export function resolveDeterministicCustomer(customerId: string): CustomerRecord | null {
  if (customerId === 'CUST-00000') {
    return null;
  }

  const seeded = SEEDED_MOCK_CUSTOMERS[customerId];
  if (seeded) {
    return seeded;
  }

  const numericPart = Number.parseInt(customerId.slice(5), 10);
  const firstName = SYNTHETIC_FIRST_NAMES[numericPart % SYNTHETIC_FIRST_NAMES.length] ?? 'Jordan';
  const lastName =
    SYNTHETIC_LAST_NAMES[Math.floor(numericPart / 7) % SYNTHETIC_LAST_NAMES.length] ?? 'Hayes';
  const tier = SYNTHETIC_TIERS[numericPart % SYNTHETIC_TIERS.length] ?? 'STARTER';
  const refundableBalance = Number(((numericPart % 900) + 100.25).toFixed(2));
  const lifetimeSpend = Number((refundableBalance * 4).toFixed(2));

  return {
    customer_id: customerId,
    full_name: `${firstName} ${lastName}`,
    company: `Synthetic Account ${String(numericPart).padStart(5, '0')} LLC`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${String(numericPart).padStart(5, '0')}@example.test`,
    tier,
    status: 'ACTIVE',
    currency: 'USD',
    lifetime_spend_usd: lifetimeSpend,
    refundable_balance_usd: refundableBalance,
    created_at: '2025-01-15T12:00:00.000Z',
    recent_orders: [
      {
        order_id: `ORD-${String(numericPart).padStart(5, '0')}`,
        amount_usd: refundableBalance,
        purchased_at: '2026-01-10T12:00:00.000Z',
        status: 'PAID',
      },
    ],
  };
}
