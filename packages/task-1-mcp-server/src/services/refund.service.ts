import { createHash } from 'node:crypto';
import { resolveDeterministicCustomer } from '../data/mock-customers.js';
import { TriggerRefundSchema, type TriggerRefundInput } from '../schemas/refund.schema.js';

export interface SimulatedRefundResult {
  readonly simulated: true;
  readonly status: 'APPROVED' | 'REJECTED_CUSTOMER_NOT_FOUND';
  readonly refund_id: string | null;
  readonly customer_id: string;
  readonly amount_usd: number;
  readonly currency: 'USD';
  readonly reason: string;
  readonly processed_at: string;
  readonly message: string;
}

/**
 * Simulated deterministic refund service.
 * NEVER connects to or invokes any external payment gateway or processor.
 */
export class RefundService {
  private readonly fixedTimestamp: string;

  public constructor(fixedTimestamp = '2026-02-01T00:00:00.000Z') {
    this.fixedTimestamp = fixedTimestamp;
  }

  public triggerRefund(rawInput: TriggerRefundInput): SimulatedRefundResult {
    const validated = TriggerRefundSchema.parse(rawInput);
    const normalizedReason = validated.reason.trim();
    const normalizedAmount = Number(validated.amount.toFixed(2));

    const customer = resolveDeterministicCustomer(validated.customer_id);
    if (!customer) {
      return {
        simulated: true,
        status: 'REJECTED_CUSTOMER_NOT_FOUND',
        refund_id: null,
        customer_id: validated.customer_id,
        amount_usd: normalizedAmount,
        currency: 'USD',
        reason: normalizedReason,
        processed_at: this.fixedTimestamp,
        message: `Simulated refund declined: customer ${validated.customer_id} was not found.`,
      };
    }

    const digest = createHash('sha256')
      .update(`${validated.customer_id}|${normalizedAmount.toFixed(2)}|${normalizedReason}`)
      .digest('hex')
      .slice(0, 10)
      .toUpperCase();

    const refundId = `REF-${digest}`;

    return {
      simulated: true,
      status: 'APPROVED',
      refund_id: refundId,
      customer_id: validated.customer_id,
      amount_usd: normalizedAmount,
      currency: 'USD',
      reason: normalizedReason,
      processed_at: this.fixedTimestamp,
      message: `Simulated refund ${refundId} for $${normalizedAmount.toFixed(2)} USD approved for ${customer.full_name} (${validated.customer_id}).`,
    };
  }
}
