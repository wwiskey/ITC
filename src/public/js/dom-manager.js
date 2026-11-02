// DOMManager.js - DOM 요소 관리 매니저
/**
 * 역할: HTML DOM 요소들에 대한 접근 및 조작 담당
 * 주요 기능:
 * - DOM 요소 참조 초기화 및 관리 (getElements)
 * - 주문 입력 필드 값 설정 (setOrderPrice, setOrderQuantity, setOrderTotal)
 * - 사용 가능 잔고 표시 업데이트 (updateAvailableAmount)
 * - 주문 결과 메시지 표시 (showOrderResult)
 * - 호가창 및 가격 정보 업데이트 (호가창 데이터 표시)
 * - DOM 조작을 다른 매니저에서 쉽게 사용할 수 있도록 추상화
 */

import { Utils } from "./utils.js";

export class DOMManager {
  // HTML DOM 요소 접근 및 조작 담당 클래스
  constructor() {
    this.elements = this.getElements();
    // 알림 스택 관리를 위한 배열
    this.activeToasts = [];
  }

  getElements() {
    return {
      pendingOrdersTab: document.getElementById("pending-orders-tab"),
      filledOrdersTab: document.getElementById("filled-orders-tab"),
      pendingOrdersSection: document.getElementById("pending-orders-section"),
      filledOrdersSection: document.getElementById("filled-orders-section"),
      refreshAllOrders: document.getElementById("refresh-all-orders"), // 🔄 전체 새로고침만 유지

      availableAmount: document.getElementById("available-amount"),
      orderPrice: document.getElementById("order-price"),
      orderQuantity: document.getElementById("order-quantity"),
      orderTotal: document.getElementById("order-total"), // 🔧 이제 입력 가능
      orderTotalMarket: document.getElementById("order-total-market"),
      pricePercentageDropdown: document.getElementById(
        "price-percentage-dropdown"
      ),

      // 이벤트 리스너용 (기존 요소 재사용)
      orderPriceInput: document.getElementById("order-price"),
      orderQuantityInput: document.getElementById("order-quantity"),
      orderTotalInput: document.getElementById("order-total"),
      orderTotalMarketInput: document.getElementById("order-total-market"),

      coinTabs: document.getElementById("coin-tabs"),
      coinSummary: document.getElementById("coin-summary"),
      chartCanvas: document.getElementById("coinChart"),

      generalUnifiedList: document.getElementById("general-unified-list"),
      groupedUnifiedList: document.getElementById("grouped-unified-list"),

      pendingOrdersList: document.getElementById("pending-orders-list"),
      filledOrdersList: document.getElementById("filled-orders-list"),

      tradingTabs: document.querySelector(".trading-tabs"),
      tradingTypeBtns: document.querySelectorAll(".trading-type-btn"),
      tradeButtons: document.querySelectorAll(".trade-button"),
      timeTabs: document.getElementById("time-tabs"),
      toggleGeneral: document.getElementById("toggle-general"),
      toggleGrouped: document.getElementById("toggle-grouped"),
      generalOrderbookContent: document.getElementById(
        "general-orderbook-content"
      ),
      cumulativeOrderbookContent: document.getElementById(
        "cumulative-orderbook-content"
      ),
      priceBtns: document.querySelectorAll(".price-btn"),
      quantityBtns: document.querySelectorAll(".quantity-btns button"),
    };
  }

  updateAvailableAmount(amount, unit = "KRW") {
    if (this.elements.availableAmount) {
      if (unit === "KRW") {
        this.elements.availableAmount.textContent = `${Utils.formatKRW(
          amount
        )} KRW`;
      } else {
        this.elements.availableAmount.textContent = `${Utils.formatCoinAmount(
          amount
        )} ${unit}`;
      }
    }
  }

  setOrderPrice(price) {
    if (this.elements.orderPrice) {
      this.elements.orderPrice.value = Utils.formatKRW(price);
    }
  }

  setOrderQuantity(quantity) {
    if (this.elements.orderQuantity) {
      this.elements.orderQuantity.value = Utils.formatCoinAmount(quantity);
    }
  }

  // 주문총액 설정
  setOrderTotal(total) {
    if (this.elements.orderTotal) {
      this.elements.orderTotal.value = Utils.formatKRW(total);
    }
  }

  setOrderTotalMarket(total) {
    if (this.elements.orderTotalMarket) {
      this.elements.orderTotalMarket.value = Utils.formatKRW(total);
    }
  }

  // 🔧 개선된 주문 결과 표시 (알림 스택 시스템)
  showOrderResult(message, isSuccess = true, orderType = null) {
    const toast = document.createElement("div");

    let backgroundColor, borderColor;
    if (isSuccess) {
      if (orderType === "fill") {
        backgroundColor = "linear-gradient(135deg, #00C851, #00ff88)";
        borderColor = "#00C851";
      } else {
        backgroundColor = "#00C851";
        borderColor = "#00C851";
      }
    } else {
      backgroundColor = "#C84A31";
      borderColor = "#C84A31";
    }

    // 현재 활성화된 알림들의 높이를 계산하여 위치 결정
    const topOffset = this.calculateToastPosition();

    toast.style.cssText = `
      position: fixed;
      top: ${topOffset}px;
      left: 50%;
      transform: translateX(-50%);
      background: ${backgroundColor};
      color: white;
      padding: 12px 16px;
      border-radius: 6px;
      border-left: 4px solid ${borderColor};
      font-size: 13px;
      font-weight: 500;
      z-index: 10000;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      opacity: 0;
      transition: all 0.3s ease;
      max-width: 300px;
      word-wrap: break-word;
    `;

    // 메시지에 줄바꿈이 있으면 처리
    const lines = message.split("\n");
    if (lines.length > 1) {
      toast.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
    } else {
      toast.textContent = message;
    }

    // 활성 알림 배열에 추가
    this.activeToasts.push(toast);

    document.body.appendChild(toast);

    setTimeout(() => (toast.style.opacity = "1"), 10);

    const displayDuration = isSuccess ? 3000 : 4000;

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => {
        if (document.body.contains(toast)) {
          document.body.removeChild(toast);
        }
        // 배열에서 제거
        const index = this.activeToasts.indexOf(toast);
        if (index > -1) {
          this.activeToasts.splice(index, 1);
        }
        // 남은 알림들 위치 재조정
        this.repositionToasts();
      }, 300);
    }, displayDuration);
  }

  // 새 알림의 위치 계산
  calculateToastPosition() {
    let totalHeight = 20; // 상단 여백

    this.activeToasts.forEach((toast) => {
      if (toast.offsetHeight) {
        totalHeight += toast.offsetHeight + 10; // 알림 높이 + 여백
      } else {
        totalHeight += 60; // 예상 높이 (기본값)
      }
    });

    return totalHeight;
  }

  // 기존 알림들 위치 재조정
  repositionToasts() {
    let currentTop = 20;

    this.activeToasts.forEach((toast) => {
      toast.style.top = `${currentTop}px`;
      if (toast.offsetHeight) {
        currentTop += toast.offsetHeight + 10;
      } else {
        currentTop += 60;
      }
    });
  }
}
