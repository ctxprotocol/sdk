/**
 * Wallet context types for portfolio tracking.
 *
 * These types represent wallet and token holdings that can be
 * injected into MCP tools for personalized analysis.
 *
 * @packageDocumentation
 */

/**
 * Base wallet context - address and chain info
 */
export interface WalletContext {
  /** Wallet address (checksummed) */
  address: string;
  /** Chain ID (137 for Polygon, 1 for Ethereum, etc.) */
  chainId: number;
  /** Native token balance in wei (string for precision) */
  nativeBalance?: string;
}

/**
 * ERC20 token holdings
 */
export interface ERC20TokenBalance {
  /** Token contract address */
  address: string;
  /** Token symbol (e.g., "USDC") */
  symbol: string;
  /** Token decimals */
  decimals: number;
  /** Balance in smallest unit (string for precision) */
  balance: string;
}

/**
 * Collection of ERC20 token balances
 */
export interface ERC20Context {
  /** Array of token balances */
  tokens: ERC20TokenBalance[];
}
