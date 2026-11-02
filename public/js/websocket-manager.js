// public/js/websocket-manager.js - 웹소켓 매니저
/**
 * 역할: 실시간 데이터 수신 및 처리 (업비트 웹소켓 연결)
 * 주요 기능:
 * - 서버 웹소켓 연결 및 재연결 처리 (connect, handleReconnection)
 * - 실시간 티커/호가창 데이터 수신 및 파싱 (handleTickerData, handleOrderbookData)
 * - 클라이언트에게 데이터 브로드캐스트 (broadcastToClients)
 * - 주문 체결 알림 처리 및 이팩트 (handleOrderFillNotification)
 * - 체결 사운드 및 애니메이션 효과 (playFillSound, showFillAnimation)
 * - 연결 상태 모니터링 및 관리 (isConnected, forceReconnect)
 */
import { MARKET_CODES } from "./constants.js";
import { Utils } from "./utils.js";

export class WebSocketManager {
  // 실시간 데이터 수신 및 처리 담당 클래스
  constructor(state, uiController, tradingManager) {
    this.state = state;
    this.ui = uiController;
    this.trading = tradingManager;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // 호가창 업데이트 디바운싱을 위한 타이머
    this.orderbookUpdateTimers = {};
  }

  connect() {
    // 배포 환경에 맞는 WebSocket URL 동적 생성
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = () => this.handleMessage(reader.result);
        reader.readAsText(event.data);
      } else {
        this.handleMessage(event.data);
      }
    };

    this.ws.onerror = (error) => {
    };

    this.ws.onclose = () => {
      this.handleReconnection();
    };

    this.ws.onopen = () => {
      this.reconnectAttempts = 0; // 연결 성공 시 재시도 횟수 리셋

      // 사용자 인증 정보 전송 (현재 로그인한 사용자 ID)
      this.sendUserAuth();
    };
  }

  // 사용자 인증 정보 전송
  async sendUserAuth() {
    try {
      // 현재 로그인한 사용자 정보 가져오기
      const response = await fetch('/api/user');
      if (response.ok) {
        const user = await response.json();

        // 서버에 사용자 ID 전송
        this.ws.send(JSON.stringify({
          type: 'auth',
          userId: user.id
        }));

      } else {
      }
    } catch (error) {
    }
  }

  handleReconnection() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);


      setTimeout(() => this.connect(), delay);
    } else {
      if (this.ui?.dom?.showOrderResult) {
        this.ui.dom.showOrderResult(
          "실시간 데이터 연결이 끊어졌습니다.",
          false
        );
      }
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);

      // 주문 체결 알림 처리
      if (message.type === "order_filled") {
        this.handleOrderFillNotification(message.data);
        return;
      }

      // 기존 업비트 데이터 처리
      if (message.type === "ticker") {
        this.handleTickerData(message);
      } else if (message.type === "orderbook") {
        this.handleOrderbookData(message);
      }
    } catch (error) {
    }
  }

  // 주문 체결 알림 처리
  async handleOrderFillNotification(orderData) {

    // 체결 타입에 따른 다른 메시지
    let message;
    const coinSymbol = orderData.market ? orderData.market.split("-")[1] : "";
    const sideText = orderData.side === "bid" ? "매수" : "매도";
    const executedQuantityText = Utils.formatCoinAmount(
      orderData.executedQuantity || 0,
      4
    );

    if (orderData.status === "filled") {
      message = `${coinSymbol} ${sideText} 주문이 완전체결되었습니다! 💰\n체결가: ${Utils.formatKRW(
        orderData.executionPrice
      )}원`;
    } else if (orderData.status === "partial") {
      message = `${coinSymbol} ${sideText} 주문이 부분체결되었습니다! ⚡\n체결가: ${Utils.formatKRW(
        orderData.executionPrice
      )}원\n체결량: ${executedQuantityText}개`;
    } else if (orderData.status === "market") {
      message = `${coinSymbol} ${sideText} 주문이 체결되었습니다! 💰\n체결가: ${Utils.formatKRW(
        orderData.executionPrice
      )}원`;
    } else {
      message = `${coinSymbol} ${sideText} 주문이 체결되었습니다!\n체결가: ${Utils.formatKRW(
        orderData.executionPrice
      )}원`;
    }

    // 체결 알림을 우상단에 표시
    if (this.ui?.dom?.showOrderResult) {
      this.ui.dom.showOrderResult(message, true);
    }

    // 체결 사운드 효과 재생
    this.playFillSound(orderData.status);

    // 관련 데이터 새로고침
    setTimeout(async () => {
      await this.trading.fetchUserBalance();
      const pendingOrders = await this.trading.fetchPendingOrders();
      const filledOrders = await this.trading.fetchFilledOrders();

      this.ui.updatePendingOrdersList(pendingOrders);
      this.ui.updateFilledOrdersList(filledOrders);
      this.ui.updateTradingPanel();
    }, 500);
  }

  // 🔧 체결 사운드 효과
  playFillSound(status = "filled") {
    try {
      const audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();

      if (status === "filled" || status === "market") {
        // 완전체결 및 시장가 - 높은 음의 2음
        this.playTone(audioContext, 880, 0.1, 0.3); // 높은 도
        setTimeout(() => {
          this.playTone(audioContext, 1108, 0.1, 0.3); // 높은 레
        }, 150);
      } else {
        // 부분체결 - 낮은 음 1개
        this.playTone(audioContext, 660, 0.15, 0.2); // 미
      }
    } catch (error) {
    }
  }

  playTone(audioContext, frequency, duration, volume) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
    oscillator.type = "sine";

    gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.01,
      audioContext.currentTime + duration
    );

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
  }

  // 🔧 체결 애니메이션 효과
  showFillAnimation(orderData) {
    // 화면 상단에 체결 알림 애니메이션 표시
    const notification = document.createElement("div");
    notification.className = "fill-notification";
    notification.style.cssText = `
      position: fixed;
      top: -100px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #00C851, #00ff88);
      color: white;
      padding: 15px 25px;
      border-radius: 25px;
      font-size: 14px;
      font-weight: bold;
      z-index: 10001;
      box-shadow: 0 8px 32px rgba(0, 200, 81, 0.3);
      transition: all 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55);
      white-space: nowrap;
    `;

    const coinSymbol = orderData.market ? orderData.market.split("-")[1] : "";
    const sideText = orderData.side === "bid" ? "매수" : "매도";

    notification.innerHTML = `
      🎉 ${coinSymbol} ${sideText} 체결! ${Utils.formatKRW(
      orderData.executionPrice
    )}원
    `;

    document.body.appendChild(notification);

    // 애니메이션 실행
    setTimeout(() => {
      notification.style.top = "20px";
    }, 100);

    // 3초 후 제거
    setTimeout(() => {
      notification.style.top = "-100px";
      notification.style.opacity = "0";

      setTimeout(() => {
        if (document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      }, 500);
    }, 3000);
  }

  handleTickerData(data) {
    const code = data.code;
    if (!MARKET_CODES.includes(code)) return;

    const previousPrice = this.state.latestTickerData[code]?.trade_price;
    const currentPrice = data.trade_price;

    this.state.latestTickerData[code] = {
      trade_price: data.trade_price,
      change_rate: data.change_rate || 0,
      signed_change_price: data.signed_change_price || 0,
      acc_trade_price_24h: data.acc_trade_price_24h || 0,
      trade_timestamp: data.trade_timestamp,
      high_price: data.high_price,
      low_price: data.low_price,
      prev_closing_price: data.prev_closing_price,
    };

    if (code === this.state.activeCoin) {
      this.ui.updateCoinSummary();
    }

    // 가격 변동시 UI 업데이트 (체결된 주문이 있을 수 있음)
    if (previousPrice !== currentPrice) {
      setTimeout(async () => {
        await this.trading.fetchUserBalance();
        const pendingOrders = await this.trading.fetchPendingOrders();
        this.ui.updatePendingOrdersList(pendingOrders);
      }, 1000);
    }
  }

  handleOrderbookData(data) {
    const code = data.code;
    if (!MARKET_CODES.includes(code)) return;

    // 일반 호가 데이터만 저장 (level은 항상 0)
    this.state.latestOrderbookData[code].general = data;

    if (code === this.state.activeCoin) {
      if (this.state.activeOrderbookType === "general") {
        this.debouncedUpdateOrderbook(
          "general",
          data,
          document.getElementById("general-unified-list")
        );
      } else if (this.state.activeOrderbookType === "grouped") {
        // 누적 호가창 실시간 업데이트
        this.debouncedUpdateCumulativeOrderbook(data);
      }
    }
  }

  // 호가창 업데이트 디바운싱 (30ms 지연으로 빠른 반응성과 안정성 균형)
  debouncedUpdateOrderbook(type, data, unifiedListElement) {
    const key = `${this.state.activeCoin}-${type}`;

    // 기존 타이머가 있으면 취소
    if (this.orderbookUpdateTimers[key]) {
      clearTimeout(this.orderbookUpdateTimers[key]);
    }

    // 새로운 타이머 설정 - requestAnimationFrame으로 렌더링 최적화
    this.orderbookUpdateTimers[key] = setTimeout(() => {
      requestAnimationFrame(() => {
        this.ui.updateOrderbook(data, unifiedListElement);
        delete this.orderbookUpdateTimers[key];
      });
    }, 30);
  }

  // 누적 호가창 업데이트 디바운싱
  debouncedUpdateCumulativeOrderbook(data) {
    const key = `${this.state.activeCoin}-cumulative`;

    // 기존 타이머가 있으면 취소
    if (this.orderbookUpdateTimers[key]) {
      clearTimeout(this.orderbookUpdateTimers[key]);
    }

    // 새로운 타이머 설정
    this.orderbookUpdateTimers[key] = setTimeout(() => {
      requestAnimationFrame(() => {
        // event-manager의 updateCumulativeOrderbook 호출
        if (window.TradingApp?.app()?.eventManager) {
          window.TradingApp.app().eventManager.updateCumulativeOrderbook();
        }
        delete this.orderbookUpdateTimers[key];
      });
    }, 30);
  }

  // 연결 상태 확인 메서드
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // 수동 재연결 메서드
  forceReconnect() {
    if (this.ws) {
      this.ws.close();
    }
    this.reconnectAttempts = 0;
    this.connect();
  }
}
