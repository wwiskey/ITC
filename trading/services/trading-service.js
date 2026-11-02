// src/services/trading-service.js (Enhanced for Order Matching)
const CONFIG = require("../config");

class TradingService {
  constructor(dbManager, wsManager) {
    this.db = dbManager;
    this.ws = wsManager;

    console.log('🔍 TradingService 초기화 중...');
    console.log('  dbManager:', !!dbManager);
    console.log('  dbManager.KRWUtils:', !!dbManager?.KRWUtils);

    this.KRWUtils = dbManager.KRWUtils; // 데이터베이스의 KRWUtils 사용

    if (!this.KRWUtils) {
      console.error('❌ KRWUtils가 dbManager에서 사용할 수 없습니다!');
      // 임시로 로컬 KRWUtils 생성
      this.KRWUtils = {
        toInteger(amount) {
          const num = Number(amount) || 0;
          return Math.floor(Math.abs(num)) * Math.sign(num);
        },
        calculateTotal(price, quantity) {
          const total = Number(price) * Number(quantity);
          return this.toInteger(total);
        }
      };
      console.log('✅ 임시 KRWUtils 생성됨');
    } else {
      console.log('✅ KRWUtils 초기화 성공');
    }
  }

  // WebSocket 매니저 설정 (나중에 초기화된 후 호출)
  setWebSocketManager(wsManager) {
    this.ws = wsManager;
  }

  calculateTradeAmounts(
    market,
    side,
    type,
    normalizedPrice,
    normalizedQuantity,
    originalTotalAmount = null
  ) {
    let finalPrice, finalQuantity, totalAmount;

    if (type === "market") {
      const currentPrice = this.ws.getCurrentPrice(market);
      if (!currentPrice) {
        throw new Error("현재 시장가를 가져올 수 없습니다.");
      }

      if (side === "bid") {
        // 시장가 매수: 총액 기준
        totalAmount = this.KRWUtils.toInteger(normalizedPrice);
        finalPrice = this.KRWUtils.toInteger(currentPrice);
        finalQuantity = totalAmount / finalPrice;
      } else {
        // 시장가 매도: 수량 기준
        finalQuantity = normalizedQuantity;
        finalPrice = this.KRWUtils.toInteger(currentPrice);
        totalAmount = this.KRWUtils.calculateTotal(finalPrice, finalQuantity);
      }
    } else {
      // 🔧 지정가 주문: 클라이언트에서 전송한 총액 보존
      finalPrice = this.KRWUtils.toInteger(normalizedPrice);
      finalQuantity = normalizedQuantity;

      // 클라이언트에서 총액을 전송했으면 그것을 사용, 아니면 계산
      if (originalTotalAmount && originalTotalAmount > 0) {
        totalAmount = this.KRWUtils.toInteger(originalTotalAmount);
      } else {
        totalAmount = this.KRWUtils.calculateTotal(finalPrice, finalQuantity);
      }

      console.log(
        `📝 지정가 주문 접수: ${market} ${side} - 가격: ${finalPrice.toLocaleString()}, 수량: ${finalQuantity}, 총액: ${totalAmount.toLocaleString()}`
      );
    }

    return { finalPrice, finalQuantity, totalAmount };
  }

  async executeOrder(userId, market, side, type, normalizedPrice, normalizedQuantity, originalTotalAmount = null) {

    const { finalPrice, finalQuantity, totalAmount } =
      this.calculateTradeAmounts(
        market,
        side,
        type,
        normalizedPrice,
        normalizedQuantity,
        originalTotalAmount
      );

    if (type === "limit") {
      // 지정가 주문: 잔고 예약 후 대기 주문 생성
      await this.reserveBalanceForLimitOrder(
        userId,
        market,
        side,
        finalPrice,
        finalQuantity,
        totalAmount
      );

      return await this.db.createPendingOrder(
        userId,
        market,
        side,
        finalPrice,
        finalQuantity,
        totalAmount,
        type
      );
    } else {
      // 시장가 주문: 즉시 체결
      await this.db.executeTradeTransaction(
        userId,
        market,
        side,
        finalPrice,
        finalQuantity,
        totalAmount,
        type
      );

      // 🔧 시장가 주문 체결 시에도 알림 전송
      if (this.ws) {
        this.ws.broadcastOrderFillNotification(userId, {
          orderId: `market_${Date.now()}`, // 시장가는 임시 ID 생성
          market: market,
          side: side,
          executionPrice: this.KRWUtils.toInteger(finalPrice),
          executedQuantity: finalQuantity,
          remainingQuantity: 0,
          totalAmount: this.KRWUtils.toInteger(totalAmount),
          status: "market" // 시장가 체결
        });
      }

      return {
        market,
        side,
        type,
        price: this.KRWUtils.toInteger(finalPrice),
        quantity: finalQuantity,
        totalAmount: this.KRWUtils.toInteger(totalAmount),
      };
    }
  }

  /**
   * 지정가 주문을 위한 잔고 예약 처리
   */
  async reserveBalanceForLimitOrder(
    userId,
    market,
    side,
    price,
    quantity,
    totalAmount
  ) {
    const connection = await this.db.pool.getConnection();

    try {
      await connection.beginTransaction();

    if (side === "bid") {
      // 매수 주문: KRW 잔고에서 총액만큼 차감
      const requiredAmount = this.KRWUtils.toInteger(totalAmount);

      // 현재 잔고 확인
      const [balanceRows] = await connection.execute(`
        SELECT krw_balance FROM users WHERE id = ? FOR UPDATE
      `, [userId]);

      const currentBalance = this.KRWUtils.toInteger(
        balanceRows[0]?.krw_balance || 0
      );

      console.log(`💰 잔고 확인 - 사용자 ID: ${userId}`);
      console.log(`💰 현재 잔고: ${currentBalance.toLocaleString()}원`);
      console.log(`💰 필요 금액: ${requiredAmount.toLocaleString()}원`);
      console.log(`💰 잔고 데이터:`, balanceRows[0]);

      if (currentBalance < requiredAmount) {
        throw new Error(`잔액이 부족합니다. 현재 잔고: ${currentBalance.toLocaleString()}원, 필요 금액: ${requiredAmount.toLocaleString()}원`);
      }

      const newBalance = currentBalance - requiredAmount;

      await connection.execute(`
        UPDATE users SET krw_balance = ? WHERE id = ?
      `, [newBalance, userId]);

      console.log(
        `💰 매수 주문 잔고 예약: ${requiredAmount.toLocaleString()}원 차감 (잔여: ${newBalance.toLocaleString()}원)`
      );
    } else {
      // 매도 주문: 코인 잔고에서 수량만큼 차감
      const coinName = market.split("-")[1].toLowerCase();

      // 현재 코인 잔고 확인
      const [balanceRows] = await connection.execute(`
        SELECT ${coinName}_balance FROM users WHERE id = ? FOR UPDATE
      `, [userId]);

      const currentCoinBalance = balanceRows[0]?.[`${coinName}_balance`] || 0;

      if (currentCoinBalance < quantity) {
        throw new Error("보유 코인이 부족합니다.");
      }

      const newCoinBalance = currentCoinBalance - quantity;

      await connection.execute(`
        UPDATE users SET ${coinName}_balance = ? WHERE id = ?
      `, [newCoinBalance, userId]);

      console.log(
        `🪙 매도 주문 잔고 예약: ${quantity}개 ${coinName.toUpperCase()} 차감 (잔여: ${newCoinBalance}개)`
      );
    }

    await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

module.exports = TradingService;
