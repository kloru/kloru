/**
 * The slice of the Link SDK this package calls, typed locally.
 *
 * `@stripe/link-sdk` 0.11.0 ships declaration files that import through a `@/` path alias and
 * extensionless relative paths, so under NodeNext resolution most of its types collapse to
 * `any`. These interfaces mirror `dist/types/index.d.ts` and `dist/resources/interfaces.d.ts`
 * for the fields we read, and let tests hand in a stub client.
 */

export interface GetAccessTokenOptions {
  forceRefresh?: boolean;
}

export type AccessTokenProvider = (options?: GetAccessTokenOptions) => Promise<string> | string;

/** Options we pass to `new Link(...)`. */
export interface LinkClientOptions {
  getAccessToken: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
}

export interface BillingAddress {
  name: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country: string;
}

export interface Card {
  id: string;
  brand: string;
  exp_month: number;
  exp_year: number;
  number: string;
  cvc?: string;
  billing_address?: BillingAddress;
  valid_until?: string;
}

export type SpendRequestStatus =
  | "created"
  | "pending_approval"
  | "expired"
  | "approved"
  | "denied"
  | "submitted"
  | "succeeded"
  | "failed"
  | "canceled"
  | "requires_action"
  | (string & Record<never, never>);

export interface NextAction {
  type: string;
  resolution: "auto_resume" | "create_new_spend_request" | "create_new_spend_request_after_completion";
  display_message: string;
  action_url: string | null;
  expires_at?: number | null;
}

export interface SpendRequest {
  id: string;
  merchant_name?: string;
  merchant_url?: string;
  context?: string;
  amount?: number;
  currency?: string;
  payment_details?: string;
  credential_type?: "shared_payment_token" | "card";
  status: SpendRequestStatus;
  approval_url?: string;
  card?: Card;
  payment_status_details?: { outcome: "success" | "failure"; code?: string | null; decline_code?: string | null } | null;
  status_details?: { requires_action?: { failure_code?: string; next_action: NextAction } } | null;
  expires_at?: number;
  created_at: string;
  updated_at: string;
}

export interface RequestApprovalResponse {
  id: string;
  approval_url: string;
}

export interface CreateSpendRequestParams {
  idempotency_key?: string;
  payment_details?: string;
  credential_type?: "shared_payment_token" | "card";
  amount?: number;
  currency?: string;
  merchant_name?: string;
  merchant_url?: string;
  context: string;
  request_approval?: boolean;
  test?: boolean;
  metadata?: Record<string, string>;
}

export interface PaymentMethod {
  id: string;
  type: string;
  is_default: boolean;
  name: string;
  nickname?: string;
  card_details?: { brand: string; last4: string; exp_month: number; exp_year: number } | null;
}

export interface ApprovalPolicy {
  rules: Array<{ action: string; limits: { per_purchase: { amount: number; currency: string } }; allowed_payment_methods?: string[] }>;
}

/** What `wallet.client()` returns. A real `Link` instance satisfies it. */
export interface LinkClientLike {
  paymentMethods: {
    list(): Promise<PaymentMethod[]>;
  };
  spendRequests: {
    create(params: CreateSpendRequestParams): Promise<SpendRequest>;
    requestApproval(id: string): Promise<RequestApprovalResponse>;
    retrieve(id: string, opts?: { include?: string[] }): Promise<SpendRequest | null>;
  };
  approvalPolicy: {
    retrieve(): Promise<ApprovalPolicy>;
  };
}
