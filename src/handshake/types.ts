/**
 * Handshake Types for MCP Tool Developers
 *
 * Use these types when your tool needs to request user interaction
 * before completing an action (signatures, transactions, OAuth).
 *
 * @see https://docs.ctxprotocol.com/guides/handshake-architecture
 *
 * ## Usage Pattern
 *
 * Tools return handshake actions in the `_meta.handshakeAction` field
 * of their MCP response. The Context platform intercepts these and
 * presents the appropriate UI to the user.
 *
 * ## Action Types
 *
 * - `signature_request`: For EIP-712 signatures (Hyperliquid, Polymarket, etc.)
 * - `transaction_proposal`: For direct on-chain transactions (Uniswap, NFT mints)
 * - `auth_required`: For OAuth flows (Discord, Twitter, etc.)
 */

// === Shared Meta Type ===

export type HandshakeMeta = {
  /** Human-readable description of the action */
  description: string;
  /** Protocol name (e.g., "Hyperliquid", "Polymarket") */
  protocol?: string;
  /** Action verb (e.g., "Place Order", "Place Bid") */
  action?: string;
  /** Token symbol if relevant */
  tokenSymbol?: string;
  /** Human-readable token amount */
  tokenAmount?: string;
  /** UI warning level */
  warningLevel?: "info" | "caution" | "danger";
  /** Custom title for the signature card (marketplace-friendly, overrides action-based title) */
  title?: string;
  /** Custom subtitle for the signature card (overrides tool name display) */
  subtitle?: string;
};

// === Web3: Signature Requests (for proxy wallet platforms) ===

export type EIP712Domain = {
  /** Domain name (e.g., "Hyperliquid", "ClobAuthDomain") */
  name: string;
  /** Domain version */
  version: string;
  /** Chain ID (informational - signing is chain-agnostic) */
  chainId: number;
  /** Optional verifying contract address */
  verifyingContract?: `0x${string}`;
};

export type EIP712TypeField = {
  name: string;
  type: string;
};

/**
 * Signature Request
 *
 * Use this for platforms with proxy wallets (Hyperliquid, Polymarket, dYdX).
 *
 * Benefits:
 * - No gas required (user signs a message, not a transaction)
 * - No network switching needed (signing is chain-agnostic)
 * - Works with Privy embedded wallets on any chain
 *
 * @example
 * ```typescript
 * return {
 *   structuredContent: {
 *     _meta: {
 *       handshakeAction: createSignatureRequest({
 *         domain: { name: "Hyperliquid", version: "1", chainId: 42161 },
 *         types: { Order: [...] },
 *         primaryType: "Order",
 *         message: { asset: 4, isBuy: true, ... },
 *         meta: { description: "Place Long ETH order", protocol: "Hyperliquid" }
 *       })
 *     }
 *   }
 * };
 * ```
 */
export type SignatureRequest = {
  _action: "signature_request";
  /** EIP-712 domain separator */
  domain: EIP712Domain;
  /** EIP-712 type definitions */
  types: Record<string, EIP712TypeField[]>;
  /** The primary type being signed */
  primaryType: string;
  /** The message data to sign */
  message: Record<string, unknown>;
  /** UI metadata for the approval card */
  meta?: HandshakeMeta;
  /**
   * Optional: Tool name to call with the signature result.
   * If provided, the platform will call this tool with { signature, originalParams }
   * after the user signs.
   */
  callbackToolName?: string;
};

// === Web3: Transaction Proposals (for direct on-chain actions) ===

export type TransactionProposalMeta = HandshakeMeta & {
  /** Estimated gas cost (informational - Context may sponsor) */
  estimatedGas?: string;
  /** Link to contract on block explorer */
  explorerUrl?: string;
};

/**
 * Transaction Proposal
 *
 * Use this for protocols without proxy wallets (Uniswap, NFT mints, etc.).
 *
 * Note: May require network switching and gas fees.
 *
 * @example
 * ```typescript
 * return {
 *   structuredContent: {
 *     _meta: {
 *       handshakeAction: createTransactionProposal({
 *         chainId: 8453,
 *         to: "0x...",
 *         data: "0x...",
 *         meta: { description: "Swap 100 USDC for ETH", protocol: "Uniswap" }
 *       })
 *     }
 *   }
 * };
 * ```
 */
export type TransactionProposal = {
  _action: "transaction_proposal";
  /** EVM chain ID (e.g., 137 for Polygon, 8453 for Base) */
  chainId: number;
  /** Target contract address */
  to: `0x${string}`;
  /** Encoded calldata */
  data: `0x${string}`;
  /** Wei to send (as string, default "0") */
  value?: string;
  /** UI metadata for the approval card */
  meta?: TransactionProposalMeta;
};

// === Web2: OAuth Requests ===

export type AuthRequiredMeta = {
  /** Human-friendly service name */
  displayName?: string;
  /** Permissions being requested */
  scopes?: string[];
  /** Description of what access is needed */
  description?: string;
  /** Tool's icon URL */
  iconUrl?: string;
  /** How long authorization lasts */
  expiresIn?: string;
};

/**
 * Auth Required
 *
 * Use this when your tool needs the user to authenticate with an external service.
 *
 * @example
 * ```typescript
 * if (!hasUserToken(contextDid)) {
 *   return {
 *     structuredContent: {
 *       _meta: {
 *         handshakeAction: createAuthRequired({
 *           provider: "discord",
 *           authUrl: "https://your-server.com/oauth/discord",
 *           meta: { displayName: "Discord Bot", scopes: ["send_messages"] }
 *         })
 *       }
 *     }
 *   };
 * }
 * ```
 */
export type AuthRequired = {
  _action: "auth_required";
  /** Service identifier (e.g., "discord", "slack") */
  provider: string;
  /** Your OAuth initiation endpoint (MUST be HTTPS) */
  authUrl: string;
  /** UI metadata for the auth card */
  meta?: AuthRequiredMeta;
};

// === Union Type ===

export type HandshakeAction =
  | SignatureRequest
  | TransactionProposal
  | AuthRequired;

// === Type Guards ===

export function isHandshakeAction(value: unknown): value is HandshakeAction {
  return (
    typeof value === "object" &&
    value !== null &&
    "_action" in value &&
    ((value as { _action: string })._action === "signature_request" ||
      (value as { _action: string })._action === "transaction_proposal" ||
      (value as { _action: string })._action === "auth_required")
  );
}

export function isSignatureRequest(value: unknown): value is SignatureRequest {
  return isHandshakeAction(value) && value._action === "signature_request";
}

export function isTransactionProposal(
  value: unknown
): value is TransactionProposal {
  return isHandshakeAction(value) && value._action === "transaction_proposal";
}

export function isAuthRequired(value: unknown): value is AuthRequired {
  return isHandshakeAction(value) && value._action === "auth_required";
}

// === Helper Functions for Tool Developers ===

/**
 * Create a signature request response.
 * Return this from your tool when you need the user to sign EIP-712 typed data.
 *
 * Use this for platforms with proxy wallets (Hyperliquid, Polymarket, dYdX).
 * Benefits: No gas required, no network switching needed.
 */
export function createSignatureRequest(
  params: Omit<SignatureRequest, "_action">
): SignatureRequest {
  return {
    _action: "signature_request",
    ...params,
  };
}

/**
 * Create a transaction proposal response.
 * Return this from your tool when you need the user to sign a direct on-chain transaction.
 *
 * Use this for protocols that don't use proxy wallets (Uniswap, NFT mints, etc.).
 * Note: May require network switching and gas.
 */
export function createTransactionProposal(
  params: Omit<TransactionProposal, "_action">
): TransactionProposal {
  return {
    _action: "transaction_proposal",
    ...params,
  };
}

/**
 * Create an auth required response.
 * Return this from your tool when you need the user to authenticate via OAuth.
 */
export function createAuthRequired(
  params: Omit<AuthRequired, "_action">
): AuthRequired {
  return {
    _action: "auth_required",
    ...params,
  };
}

// === MCP Response Helper ===

/**
 * Wrap a handshake action in the proper MCP response format.
 *
 * MCP tools should return handshake actions in `_meta.handshakeAction` to prevent
 * the MCP SDK from stripping unknown fields.
 *
 * @example
 * ```typescript
 * // In your tool handler:
 * return wrapHandshakeResponse(createSignatureRequest({
 *   domain: { name: "Hyperliquid", version: "1", chainId: 42161 },
 *   types: { Order: [...] },
 *   primaryType: "Order",
 *   message: orderData,
 *   meta: { description: "Place order", protocol: "Hyperliquid" }
 * }));
 * ```
 */
export function wrapHandshakeResponse(action: HandshakeAction): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    _meta: { handshakeAction: HandshakeAction };
    status: string;
    message: string;
  };
} {
  const actionType = action._action.replace("_", " ");
  return {
    content: [
      {
        type: "text",
        text: `Handshake required: ${actionType}. Please approve in the Context app.`,
      },
    ],
    structuredContent: {
      _meta: {
        handshakeAction: action,
      },
      status: "handshake_required",
      message: action.meta?.description ?? `${actionType} required`,
    },
  };
}
