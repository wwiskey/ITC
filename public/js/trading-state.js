// trading-state.js
import { MARKET_CODES } from "./constants.js";

export class TradingState {
  constructor() {
    this.latestTickerData = {};
    this.latestOrderbookData = {};
    this.activeCoin = "KRW-BTC";
    this.activeUnit = "60";
    this.lastUpdateTime = null;
    this.activeOrderbookType = "general";
    this.activeTradingSide = "bid";
    this.activeTradingType = "limit";
    this.userKRWBalance = 0;
    this.userCoinBalance = { "KRW-BTC": 0, "KRW-ETH": 0, "KRW-XRP": 0 };
    this.pendingOrders = [];
    this.mainChart = null;

    this.currentUser = null;
    this.isAuthenticated = false;

    // 🔧 기술지표 상태 관리 추가
    this.activeIndicators = {
      movingAverages: new Set(), // MA5, MA10, MA20, MA50, MA100, MA200
      technicalIndicators: new Set(), // RSI, MACD, BB
    };

    this.initializeData();
  }

  setUser(user) {
    this.currentUser = user;
    this.isAuthenticated = !!user;
  }

  // 🔧 새로 추가: 현재 사용자 정보 반환
  getCurrentUser() {
    return this.currentUser;
  }

  initializeData() {
    MARKET_CODES.forEach((code) => {
      this.latestTickerData[code] = {
        trade_price: 0,
        change_rate: 0,
        signed_change_price: 0,
        acc_trade_price_24h: 0,
        high_price: 0,
        low_price: 0,
        prev_closing_price: 0,
      };
      this.latestOrderbookData[code] = {
        general: null,
        grouped: null,
      };
    });
  }
}
