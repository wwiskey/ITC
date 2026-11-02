// src/routes/api-router.js
const express = require("express");
const axios = require("axios");
const CONFIG = require("../config");
const ValidationUtils = require("../utils/validation-utils");

class APIRouter {
  constructor(dbManager, tradingService) {
    this.db = dbManager;
    this.trading = tradingService;
    this.KRWUtils = dbManager.KRWUtils; // 데이터베이스의 KRWUtils 사용
    this.router = express.Router();
    this.setupRoutes();
  }

  setupRoutes() {
    this.router.get("/balance", this.getBalance.bind(this));
    this.router.post("/trade", this.postTrade.bind(this));
    this.router.get("/candles", this.getCandles.bind(this));
    this.router.get("/transactions", this.getTransactions.bind(this));
    this.router.get("/pending-orders", this.getPendingOrders.bind(this));
    this.router.delete(
      "/pending-orders/:orderId",
      this.cancelPendingOrder.bind(this)
    );
  }

  async getBalance(req, res) {
    try {
      const balance = await this.db.getUserBalance(req.user.username);

      if (!balance) {
        return res.status(404).json({
          error: "사용자 잔고를 찾을 수 없습니다.",
          code: "USER_NOT_FOUND",
        });
      }

      const processedBalance = this.KRWUtils.processBalance(balance);
      res.json(processedBalance);
    } catch (err) {
      console.error("잔고 조회 오류:", err);
      res.status(500).json({
        error: "서버 오류: 잔고 조회에 실패했습니다.",
        code: "INTERNAL_ERROR",
      });
    }
  }

  async postTrade(req, res) {
    const { market, side, type, price, quantity, total } = req.body;

    // 입력값 유효성 검사
    const validation = ValidationUtils.validateTradeInput(
      market,
      side,
      type,
      price,
      quantity
    );
    if (!validation.isValid) {
      return res.status(400).json({
        error: "주문 정보가 유효하지 않습니다.",
        details: validation.errors,
        code: "INVALID_INPUT",
      });
    }

    try {
      const orderDetails = await this.trading.executeOrder(
        req.user.id,
        market,
        side,
        type,
        validation.normalizedPrice,
        validation.normalizedQuantity,
        total  // 🔧 총액 정보 전달
      );

      res.status(200).json({
        message: "주문이 성공적으로 접수되었습니다.",
        orderDetails,
      });
    } catch (error) {
      console.error("❌ 주문 처리 중 오류 발생:", error.message);
      res.status(500).json({
        error: error.message || "주문 처리 중 서버 오류가 발생했습니다.",
        code: "TRADE_PROCESSING_ERROR",
      });
    }
  }

  // 기존 async getCandles(req, res) { 메서드 전체를 다음으로 교체
  async getCandles(req, res) {
    const { unit, market, count = 200, to } = req.query;
    const requestCount = Math.min(parseInt(count), 1000); // 최대 1000개

    const validation = ValidationUtils.validateApiParams({ unit, market }, [
      "unit",
      "market",
    ]);
    if (!validation.isValid) {
      return res.status(400).json({
        error: `다음 파라미터가 필요합니다: ${validation.missing.join(", ")}`,
        code: "MISSING_PARAMETERS",
      });
    }

    try {
      const allCandles = [];
      let currentTo = to;
      let remaining = requestCount;

      while (remaining > 0) {
        const batchSize = Math.min(remaining, 200);
        let url;

        if (unit === "1D") {
          url = `https://api.upbit.com/v1/candles/days?market=${market}&count=${batchSize}`;
        } else {
          url = `https://api.upbit.com/v1/candles/minutes/${unit}?market=${market}&count=${batchSize}`;
        }

        // 🔧 to 파라미터 처리 개선
        if (currentTo && currentTo !== "undefined") {
          // URL 인코딩 처리
          const encodedTo = encodeURIComponent(currentTo);
          url += `&to=${encodedTo}`;
        }

        console.log(`📡 업비트 API 호출: ${url}`); // 디버깅용 로그

        const response = await axios.get(url, {
          headers: { "Accept-Encoding": "gzip, deflate" },
          timeout: 10000,
        });

        const data = response.data;
        if (data.length === 0) break;

        allCandles.push(...data);
        remaining -= data.length;

        // 다음 배치를 위한 to 파라미터 설정
        if (data.length < batchSize) break;
        currentTo = data[data.length - 1].candle_date_time_utc;
      }

      console.log(
        `📊 캔들 데이터 ${allCandles.length}개 반환: ${market} ${unit}`
      );
      res.json(allCandles);
    } catch (error) {
      console.error("❌ 캔들 데이터 요청 오류:", error.message);
      res.status(500).json({
        error: "캔들 데이터를 가져오는 데 실패했습니다.",
        code: "CANDLE_DATA_ERROR",
      });
    }
  }

  async getTransactions(req, res) {
    const { limit = 50, offset = 0 } = req.query;

    try {
      const userId = req.user.id;

      const transactions = await this.db.getUserTransactions(
        userId,
        limit,
        offset
      );
      // ✅ 화살표 함수를 사용하여 'this' 컨텍스트를 유지합니다.
      const processedTransactions = transactions.map((t) =>
        this.KRWUtils.processTransaction(t)
      );

      res.json(processedTransactions);
    } catch (error) {
      console.error("❌ 거래 내역 조회 오류:", error);
      res.status(500).json({
        error: "거래 내역 조회에 실패했습니다.",
        code: "TRANSACTION_HISTORY_ERROR",
      });
    }
  }
  async getPendingOrders(req, res) {
    try {
      const userId = req.user.id;

      const orders = await this.db.getUserPendingOrders(userId);
      res.json(orders);
    } catch (error) {
      console.error("대기 주문 조회 오류:", error);
      res.status(500).json({
        error: "대기 주문 조회에 실패했습니다.",
        code: "PENDING_ORDERS_ERROR",
      });
    }
  }
  async cancelPendingOrder(req, res) {
    try {
      const { orderId } = req.params;

      if (!orderId || isNaN(orderId)) {
        return res.status(400).json({
          error: "유효한 주문 ID가 필요합니다.",
          code: "INVALID_ORDER_ID",
        });
      }

      const userId = req.user.id;

      const result = await this.db.cancelPendingOrder(
        userId,
        parseInt(orderId)
      );
      res.json(result);
    } catch (error) {
      console.error("주문 취소 오류:", error);
      res.status(500).json({
        error: error.message || "주문 취소에 실패했습니다.",
        code: "CANCEL_ORDER_ERROR",
      });
    }
  }
}
module.exports = APIRouter;
