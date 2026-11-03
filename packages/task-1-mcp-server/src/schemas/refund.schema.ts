import { z } from 'zod';
import { CustomerIdSchema } from './customer.schema.js';

export const RefundAmountSchema = z
  .number({
    required_error: 'amount is required',
    invalid_type_error: 'amount must be a finite positive number',
  })
  .finite('amount must be a finite number')
  .positive('amount must be strictly greater than zero');

export const RefundReasonSchema = z
  .string({
    required_error: 'reason is required',
    invalid_type_error: 'reason must be a string',
  })
  .refine((value) => value.trim().length >= 10, {
    message: 'reason must contain at least 10 characters after trimming',
  });

export const TriggerRefundInputShape = {
  customer_id: CustomerIdSchema.describe(
    'Unique customer identifier matching ^CUST-[0-9]{5}$ (e.g., CUST-12345)',
  ),
  amount: RefundAmountSchema.describe('Positive finite refund amount in USD (e.g., 150.50)'),
  reason: RefundReasonSchema.describe(
    'Detailed reason for the refund (minimum 10 characters after trimming)',
  ),
} as const;

export const TriggerRefundSchema = z.object(TriggerRefundInputShape).strict();

export type TriggerRefundInput = z.infer<typeof TriggerRefundSchema>;
