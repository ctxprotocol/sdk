/**
 * Polymarket context types for portfolio tracking.
 *
 * These types represent Polymarket positions and orders that can be
 * injected into MCP tools for personalized portfolio analysis.
 *
 * @packageDocumentation
 */

/**
 * A single Polymarket position
 */
export interface PolymarketPosition {
  /** The market's condition ID */
  conditionId: string;
  /** The specific outcome token ID */
  tokenId: string;
  /** Which outcome this position is for */
  outcome: "YES" | "NO";
  /** Number of shares held */
  shares: number;
  /** Average entry price (0-1 scale) */
  avgEntryPrice: number;
  /** Market question/title for display */
  marketTitle?: string;
}

/**
 * An open order on Polymarket
 */
export interface PolymarketOrder {
  /** Order ID */
  orderId: string;
  /** The market's condition ID */
  conditionId: string;
  /** Order side */
  side: "BUY" | "SELL";
  /** Which outcome this order is for */
  outcome: "YES" | "NO";
  /** Limit price (0-1 scale) */
  price: number;
  /** Order size in shares */
  size: number;
  /** Amount already filled */
  filled: number;
}

/**
 * Complete Polymarket portfolio context.
 * This is what gets passed to MCP tools for personalized analysis.
 */
export interface PolymarketContext {
  /** The wallet address this context is for */
  walletAddress: string;
  /** All open positions */
  positions: PolymarketPosition[];
  /** All open orders */
  openOrders: PolymarketOrder[];
  /** Total portfolio value in USD (sum of position values) */
  totalValue?: number;
  /** When this context was fetched (ISO 8601 string) */
  fetchedAt: string;
}
