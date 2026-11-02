// src/managers/websocket-manager.js - 개선된 버전
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const CONFIG = require("../config");
const OrderMatchingEngine = require("../services/order-matching-engine");

class WebSocketManager {
  constructor(clientWebSocketServer, dbManager) {
    this.upbitWs = null;
    this.clientWss = clientWebSocketServer;
    this.currentMarketPrices = {};
    this.dbManager = dbManager;
    this.KRWUtils = dbManager.KRWUtils; // 데이터베이스의 KRWUtils 사용

    // 🔧 주문 매칭 엔진 초기화 및 WebSocket 매니저 연결
    this.matchingEngine = new OrderMatchingEngine(dbManager);
    this.matchingEngine.setWebSocketManager(this); // 체결 알림을 위해 자신을 주입

    // 호가창 데이터 저장 (체결 검사용)
    this.latestOrderbooks = {};

    // 🔧 연결 상태 관리
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.heartbeatInterval = null;
  }

  connect() {
    this.upbitWs = new WebSocket(CONFIG.UPBIT_WS_URL);

    this.upbitWs.onopen = () => {
      console.log("✅ 업비트 웹소켓 서버에 연결되었습니다.");
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.sendSubscriptionRequest();
      this.startHeartbeat();
    };

    this.upbitWs.onmessage = (event) => {
      this.handleMessage(event);
    };

    this.upbitWs.onclose = (event) => {
      console.log(
        `⚠️ 업비트 웹소켓 연결이 끊어졌습니다. 코드: ${event.code}, 이유: ${event.reason}`
      );
      this.isConnected = false;
      this.stopHeartbeat();
      this.handleReconnection();
    };

    this.upbitWs.onerror = (error) => {
      console.error("❌ 업비트 웹소켓 오류:", error);
      this.isConnected = false;
    };
  }

  // 🔧 재연결 로직 개선
  handleReconnection() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // 최대 30초

      console.log(
        `재연결 시도 ${this.reconnectAttempts}/${this.maxReconnectAttempts} (${
          delay / 1000
        }초 후)`
      );

      setTimeout(() => this.connect(), delay);
    } else {
      console.error("❌ 웹소켓 재연결 실패 - 최대 시도 횟수 초과");
    }
  }

  // 🔧 하트비트 기능 추가
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.upbitWs && this.upbitWs.readyState === WebSocket.OPEN) {
        // 연결 상태 체크용 ping
        this.upbitWs.ping();
      }
    }, 30000); // 30초마다
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  sendSubscriptionRequest() {
    const requestMessage = [
      { ticket: uuidv4() },
      { type: "ticker", codes: CONFIG.MARKET_CODES },
      { type: "orderbook", codes: CONFIG.MARKET_CODES, level: 0 },
      { format: "DEFAULT" },
    ];

    this.upbitWs.send(JSON.stringify(requestMessage));
    console.log("📡 업비트 웹소켓 구독 요청 전송 완료 (level: 0 = 30호가)");
  }

  async handleMessage(event) {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "ticker") {
        this.handleTickerData(data);
      } else if (data.type === "orderbook") {
        await this.handleOrderbookData(data);
      }

      // 연결된 모든 클라이언트에게 데이터 전송
      this.broadcastToClients(event.data);
    } catch (error) {
      console.error("웹소켓 메시지 처리 오류:", error);
    }
  }

  handleTickerData(data) {
    const code = data.code;
    if (!CONFIG.MARKET_CODES.includes(code)) return;

    // 현재 시장가 업데이트 (정수로 저장)
    this.currentMarketPrices[code] = this.KRWUtils.toInteger(data.trade_price);

    // 마지막 가격 저장
    if (!this.latestOrderbooks[code]) {
      this.latestOrderbooks[code] = {};
    }
    this.latestOrderbooks[code].lastPrice = this.currentMarketPrices[code];
  }

  async handleOrderbookData(data) {
    const code = data.code;
    if (!CONFIG.MARKET_CODES.includes(code)) return;

    // 호가창 데이터 저장
    this.latestOrderbooks[code] = {
      ...this.latestOrderbooks[code],
      data: data,
      lastUpdated: Date.now(),
    };

    // 🔥 핵심: 호가창이 업데이트될 때마다 주문 매칭 검사
    if (data.level === 0) {
      // 일반 호가창만 처리 (grouped는 제외)
      try {
        // 🔧 비동기 처리로 성능 개선
        setImmediate(async () => {
          try {
            await this.matchingEngine.processOrderbook(code, data);
          } catch (error) {
            console.error(`주문 매칭 처리 오류 (${code}):`, error);
          }
        });
      } catch (error) {
        console.error(`주문 매칭 스케줄링 오류 (${code}):`, error);
      }
    }
  }

  broadcastToClients(data) {
    const connectedClients = Array.from(this.clientWss.clients).filter(
      (client) => client.readyState === WebSocket.OPEN
    );

    if (connectedClients.length > 0) {
      connectedClients.forEach((client) => {
        try {
          client.send(data);
        } catch (error) {
          console.error("클라이언트 메시지 전송 오류:", error);
        }
      });
    }
  }

  /**
   * 주문 체결 알림을 해당 사용자에게만 전송 (접속한 계정만)
   */
  broadcastOrderFillNotification(userId, orderDetails) {
    const notification = {
      type: "order_filled",
      userId: userId,
      timestamp: Date.now(),
      data: {
        ...orderDetails,
        executionTime: new Date().toISOString(),
        marketPrice: this.currentMarketPrices[orderDetails.market],
      },
    };

    // 해당 사용자에게만 체결 알림 전송
    this.clientWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.userId === userId) {
        try {
          client.send(JSON.stringify(notification));
        } catch (error) {
          console.error("체결 알림 전송 오류:", error);
        }
      }
    });
  }

  /**
   * 🔧 시장가 조회 개선
   */
  getCurrentPrice(market) {
    const price = this.currentMarketPrices[market];
    if (!price) {
      console.warn(`⚠️ ${market}의 현재 가격 정보가 없습니다.`);
      return 0;
    }
    return price;
  }

  getIntegerPrices() {
    const integerPrices = {};
    Object.keys(this.currentMarketPrices).forEach((market) => {
      integerPrices[market] = this.KRWUtils.toInteger(
        this.currentMarketPrices[market]
      );
    });
    return integerPrices;
  }

  /**
   * 🔧 서버 상태 모니터링 정보
   */
  getServerStatus() {
    const connectedClients = Array.from(this.clientWss.clients).filter(
      (client) => client.readyState === WebSocket.OPEN
    ).length;

    return {
      upbitConnection: {
        connected: this.isConnected,
        reconnectAttempts: this.reconnectAttempts,
        lastReconnectTime: this.lastReconnectTime || null,
      },
      clients: {
        connected: connectedClients,
        total: this.clientWss.clients.size,
      },
      markets: {
        tracked: Object.keys(this.currentMarketPrices).length,
        prices: this.getIntegerPrices(),
      },
      orderMatching: this.matchingEngine.getMatchingStats(),
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      },
    };
  }

  /**
   * 🔧 수동 재연결 기능
   */
  forceReconnect() {
    console.log("🔄 수동 재연결 시도...");
    if (this.upbitWs) {
      this.upbitWs.close();
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  /**
   * 🔧 특정 마켓의 호가창 정보 조회
   */
  getOrderbookInfo(market) {
    const orderbook = this.latestOrderbooks[market];
    if (!orderbook || !orderbook.data) {
      return null;
    }

    const data = orderbook.data;
    const units = data.orderbook_units || [];

    return {
      market: market,
      timestamp: orderbook.lastUpdated,
      bestAsk: units.length > 0 ? units[0].ask_price : null,
      bestBid: units.length > 0 ? units[0].bid_price : null,
      spread: units.length > 0 ? units[0].ask_price - units[0].bid_price : null,
      totalAskSize: units.reduce((sum, unit) => sum + unit.ask_size, 0),
      totalBidSize: units.reduce((sum, unit) => sum + unit.bid_size, 0),
    };
  }

  /**
   * 🔧 성능 최적화를 위한 정리 함수
   */
  cleanup() {
    this.stopHeartbeat();

    // 오래된 호가창 데이터 정리 (1분 이상 된 데이터)
    const oneMinuteAgo = Date.now() - 60000;
    Object.keys(this.latestOrderbooks).forEach((market) => {
      if (this.latestOrderbooks[market].lastUpdated < oneMinuteAgo) {
        delete this.latestOrderbooks[market];
      }
    });
  }

  close() {
    console.log("🔌 웹소켓 매니저 종료 중...");

    this.cleanup();

    if (this.upbitWs) {
      this.upbitWs.close();
    }

    // 클라이언트 연결 종료
    this.clientWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1000, "서버 종료");
      }
    });

    console.log("✅ 웹소켓 매니저 종료 완료");
  }
}

module.exports = WebSocketManager;
