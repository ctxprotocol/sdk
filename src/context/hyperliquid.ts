/**
 * Hyperliquid context types for portfolio tracking.
 *
 * These types represent Hyperliquid perpetual positions, orders, and account
 * data that can be injected into MCP tools for personalized portfolio analysis.
 *
 * @packageDocumentation
 */

/**
 * Hyperliquid Perpetual Position
 */
export interface HyperliquidPerpPosition {
  /** Asset symbol (e.g., "ETH", "BTC") */
  coin: string;
  /** Position size (positive = long, negative = short) */
  size: number;
  /** Entry price */
  entryPrice: number;
  /** Current mark price */
  markPrice?: number;
  /** Unrealized PnL in USD */
  unrealizedPnl: number;
  /** Liquidation price */
  liquidationPrice: number;
  /** Position value in USD */
  positionValue: number;
  /** Leverage info */
  leverage: {
    type: "cross" | "isolated";
    value: number;
  };
  /** Margin used for this position */
  marginUsed: number;
  /** Return on equity percentage */
  returnOnEquity: number;
  /** Cumulative funding paid/received */
  cumFunding: {
    allTime: number;
    sinceOpen: number;
  };
}

/**
 * Hyperliquid Open Order
 */
export interface HyperliquidOrder {
  /** Order ID */
  oid: number;
  /** Asset symbol */
  coin: string;
  /** Order side: "B" = Buy, "A" = Ask/Sell */
  side: "B" | "A";
  /** Limit price */
  limitPrice: number;
  /** Order size */
  size: number;
  /** Original order size */
  originalSize: number;
  /** Order type */
  orderType: "Limit" | "Market" | "Stop" | "TakeProfit";
  /** Is reduce-only order */
  reduceOnly: boolean;
  /** Is trigger order */
  isTrigger: boolean;
  /** Trigger price (if trigger order) */
  triggerPrice?: number;
  /** Order timestamp */
  timestamp: number;
}

/**
 * Hyperliquid Spot Balance
 */
export interface HyperliquidSpotBalance {
  /** Token symbol */
  token: string;
  /** Token balance */
  balance: number;
  /** USD value */
  usdValue?: number;
}

/**
 * Hyperliquid Account Summary
 */
export interface HyperliquidAccountSummary {
  /** Total account value in USD */
  accountValue: number;
  /** Total margin used */
  totalMarginUsed: number;
  /** Total notional position value */
  totalNotionalPosition: number;
  /** Withdrawable amount */
  withdrawable: number;
  /** Cross margin summary */
  crossMargin: {
    accountValue: number;
    totalMarginUsed: number;
  };
}

/**
 * Complete Hyperliquid portfolio context.
 * This is what gets passed to MCP tools for personalized analysis.
 */
export interface HyperliquidContext {
  /** The wallet address this context is for */
  walletAddress: string;
  /** Perpetual positions */
  perpPositions: HyperliquidPerpPosition[];
  /** Open orders */
  openOrders: HyperliquidOrder[];
  /** Spot balances */
  spotBalances: HyperliquidSpotBalance[];
  /** Account summary */
  accountSummary: HyperliquidAccountSummary;
  /** When this context was fetched (ISO 8601 string) */
  fetchedAt: string;
}



