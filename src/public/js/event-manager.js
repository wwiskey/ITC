// event-manager.js - 이벤트 처리 매니저
/**
 * 역할: 모든 UI 이벤트 리스너 설정 및 처리
 * 주요 기능:
 * - 버튼 클릭 이벤트 처리 (가격조정, 퍼센트, 주문버튼) (setupButtonEvents)
 * - 입력 필드 이벤트 처리 (가격, 수량, 총액) (setupInputEvents)
 * - 거래 탭 및 타입 선택 이벤트 (setupTradingEvents)
 * - 호가창 탭 전환 이벤트 (setupOrderbookEvents)
 * - 차트 시간대 및 지표 이벤트 (setupChartEvents, setupDropdownEvents)
 * - 주문 내역 탭 및 새로고침 (setupTradeHistoryTabEvents, setupOrderListButtonEvents)
 * - 이벤트 들어간 UI 업데이트 및 다른 매니저 호출
 */

import { Utils } from "./utils.js";

export class EventManager {
  // 모든 UI 이벤트 리스너 설정 및 처리 담당 클래스
  constructor(state, domManager, uiController, tradingManager, chartManager) {
    this.state = state;
    this.dom = domManager;
    this.ui = uiController;
    this.trading = tradingManager;
    this.chart = chartManager;
  }

  setupAllEventListeners() {
    this.setupOrderbookEvents();
    this.setupChartEvents();
    this.setupTradingEvents();
    this.setupInputEvents();
    this.setupButtonEvents();
    this.setupTradeHistoryTabEvents();
    this.setupOrderListButtonEvents();
    this.setupDropdownEvents();
    this.setupClearAllIndicatorsButton();
  }

  setupTradeHistoryTabEvents() {
    this.dom.elements.pendingOrdersTab?.addEventListener("click", () => {
      this.dom.elements.pendingOrdersTab.classList.add("active");
      this.dom.elements.filledOrdersTab.classList.remove("active");
      this.dom.elements.pendingOrdersSection.classList.remove("hidden");
      this.dom.elements.filledOrdersSection.classList.add("hidden");
      this.ui.showPendingOrders();
    });

    this.dom.elements.filledOrdersTab?.addEventListener("click", () => {
      this.dom.elements.filledOrdersTab.classList.add("active");
      this.dom.elements.pendingOrdersTab.classList.remove("active");
      this.dom.elements.pendingOrdersSection.classList.add("hidden");
      this.dom.elements.filledOrdersSection.classList.remove("hidden");
      this.ui.showFilledOrders();
    });
  }

  setupOrderListButtonEvents() {
    // 🔄 전체 새로고침 버튼만 유지
    this.dom.elements.refreshAllOrders?.addEventListener("click", async () => {
      this.showRefreshSpinner("all");
      try {
        await this.trading.refreshAllData();
        this.dom.showOrderResult("모든 데이터가 새로고침되었습니다.", true);
      } catch (error) {
        this.dom.showOrderResult("새로고침 중 오류가 발생했습니다.", false);
      } finally {
        this.hideRefreshSpinner("all");
      }
    });

    // 주문 취소 이벤트
    this.dom.elements.pendingOrdersList?.addEventListener(
      "click",
      async (e) => {
        const cancelBtn = e.target.closest(".cancel-btn");
        if (cancelBtn) {
          const orderId = cancelBtn.dataset.orderId;
          if (orderId) {
            // 🔧 취소 후 자동 새로고침 (cancelOrder 내부에서 처리)
            await this.trading.cancelOrder(orderId);
          }
        }
      }
    );
  }

  setupOrderbookEvents() {
    this.dom.elements.toggleGeneral?.addEventListener("click", () => {
      this.state.activeOrderbookType = "general";
      this.dom.elements.toggleGeneral.classList.add("active");
      this.dom.elements.toggleGrouped.classList.remove("active");
      this.dom.elements.generalOrderbookContent.classList.remove("hidden");
      this.dom.elements.cumulativeOrderbookContent.classList.add("hidden");
      this.ui.updateOrderbook(
        this.state.latestOrderbookData[this.state.activeCoin]?.general,
        this.dom.elements.generalUnifiedList
      );
    });

    this.dom.elements.toggleGrouped?.addEventListener("click", () => {
      this.state.activeOrderbookType = "grouped";
      this.dom.elements.toggleGeneral.classList.remove("active");
      this.dom.elements.toggleGrouped.classList.add("active");
      this.dom.elements.generalOrderbookContent.classList.add("hidden");
      this.dom.elements.cumulativeOrderbookContent.classList.remove("hidden");

      // 누적 호가창 업데이트
      this.updateCumulativeOrderbook();
    });
  }

  updateCumulativeOrderbook() {
    const data = this.state.latestOrderbookData[this.state.activeCoin]?.general;
    if (!data?.orderbook_units) return;

    const listElement = document.getElementById('cumulative-orderbook-list');
    if (!listElement) return;

    // 현재가 정보 가져오기
    const currentPrice = this.state.latestTickerData[this.state.activeCoin]?.trade_price;
    const prevClosingPrice = this.state.latestTickerData[this.state.activeCoin]?.prev_closing_price;

    // 매도/매수 데이터 정리 - 일반 호가창과 동일하게 20개씩
    const asks = data.orderbook_units
      .filter(unit => unit.ask_price > 0 && unit.ask_size > 0)
      .sort((a, b) => a.ask_price - b.ask_price)
      .slice(0, 20);
    const bids = data.orderbook_units
      .filter(unit => unit.bid_price > 0 && unit.bid_size > 0)
      .sort((a, b) => b.bid_price - a.bid_price)
      .slice(0, 20);

    // 누적 계산
    let askCumulative = 0;
    let bidCumulative = 0;

    // 누적량 기준 막대를 위해 먼저 모든 누적량 계산
    let tempAskCumulative = 0;
    let tempBidCumulative = 0;

    // 임시로 누적량들 계산해서 최대값 구하기
    const askCumulatives = asks.map(unit => tempAskCumulative += unit.ask_size);
    const bidCumulatives = bids.map(unit => tempBidCumulative += unit.bid_size);

    // 최대 누적량 계산 (막대 길이 기준)
    const maxCumulative = Math.max(...askCumulatives, ...bidCumulatives);

    const askItems = asks.map(unit => {
      askCumulative += unit.ask_size;
      const changeRate = prevClosingPrice ? ((unit.ask_price - prevClosingPrice) / prevClosingPrice) * 100 : 0;
      return {
        price: unit.ask_price,
        change: changeRate,
        size: unit.ask_size,
        amount: unit.ask_price * unit.ask_size,
        cumulative: askCumulative,
        volumeRatio: (askCumulative / maxCumulative) * 100,
        type: 'ask'
      };
    });

    const bidItems = bids.map(unit => {
      bidCumulative += unit.bid_size;
      const changeRate = prevClosingPrice ? ((unit.bid_price - prevClosingPrice) / prevClosingPrice) * 100 : 0;
      return {
        price: unit.bid_price,
        change: changeRate,
        size: unit.bid_size,
        amount: unit.bid_price * unit.bid_size,
        cumulative: bidCumulative,
        volumeRatio: (bidCumulative / maxCumulative) * 100,
        type: 'bid'
      };
    });

    // 현재가 하이라이트를 위한 가격 단위 계산
    const priceStep = Utils.getPriceStep ? Utils.getPriceStep(currentPrice, this.state.activeCoin) :
                      (this.state.activeCoin === 'KRW-XRP' ? 1 : 1000);

    // 전체 아이템 배열 (매도는 뒤집어서 표시)
    const allItems = [...askItems.reverse(), ...bidItems];
    const totalItems = allItems.length;

    // DOM 요소 캐시 - 한 번만 생성하고 재사용
    if (!listElement._cumulativeItems) {
      listElement._cumulativeItems = [];
      // 필요한 만큼 DOM 요소 미리 생성
      for (let i = 0; i < 40; i++) { // 매도 20개 + 매수 20개 최대
        const div = document.createElement("div");
        div.className = "orderbook-unit cumulative-grid";

        // 5개 열에 해당하는 div들 생성
        div.innerHTML = `
          <div class="orderbook-price"></div>
          <div class="change-item"></div>
          <div class="size-item"></div>
          <div class="amount-item"></div>
          <div class="cumulative-item"></div>
        `;

        listElement.appendChild(div);
        listElement._cumulativeItems.push(div);
      }
    }

    const items = listElement._cumulativeItems;

    // 기존 아이템들 숨기기
    for (let i = 0; i < items.length; i++) {
      if (i >= totalItems) {
        items[i].style.display = 'none';
      } else {
        items[i].style.display = '';
      }
    }

    // 각 아이템 업데이트
    allItems.forEach((item, index) => {
      if (index >= items.length) return;

      const element = items[index];
      const isCurrentPrice = Math.abs(item.price - currentPrice) < priceStep;

      // 클래스 설정
      element.className = `orderbook-unit cumulative-grid ${item.type === 'ask' ? 'ask-item' : 'bid-item'}`;
      if (isCurrentPrice) {
        element.classList.add('current-price-highlight');
      }

      // CSS 변수 설정 (볼륨 막대용)
      element.style.setProperty('--volume-ratio', `${item.volumeRatio}%`);
      element.style.position = 'relative';

      // 각 컬럼 업데이트
      const priceDiv = element.children[0];
      const changeDiv = element.children[1];
      const sizeDiv = element.children[2];
      const amountDiv = element.children[3];
      const cumulativeDiv = element.children[4];

      priceDiv.textContent = item.price.toLocaleString();
      priceDiv.style.color = item.type === 'ask' ? '#1763b6' : '#e12343';
      priceDiv.style.fontWeight = 'bold';

      changeDiv.textContent = `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`;
      changeDiv.style.textAlign = 'center';
      changeDiv.style.color = item.change >= 0 ? '#e12343' : '#1763b6';

      sizeDiv.textContent = item.size.toFixed(4);
      sizeDiv.style.textAlign = 'right';

      amountDiv.textContent = `${(item.amount / 1000).toFixed(0)}K`;
      amountDiv.style.textAlign = 'right';

      cumulativeDiv.textContent = `${(item.cumulative * item.price / 1000000).toFixed(1)}M`;
      cumulativeDiv.style.textAlign = 'right';
      cumulativeDiv.style.fontWeight = 'bold';
    });

    // 체결강도 업데이트도 함께 수행
    this.ui.updateMarketPressure(asks, bids);
  }

  setupChartEvents() {
    this.dom.elements.timeTabs?.addEventListener("click", (e) => {
      const btn = e.target.closest(".time-tab");
      if (btn) {
        this.dom.elements.timeTabs
          .querySelectorAll(".time-tab")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.state.activeUnit = btn.dataset.unit;
        this.chart.fetchAndRender();
      }
    });
    // 기존 select 방식은 제거됨 - 새로운 드롭다운 방식은 setupDropdownEvents에서 처리
  }

  setupTradingEvents() {
    this.dom.elements.tradingTabs?.addEventListener("click", (e) => {
      const tab = e.target.closest(".trading-tab");
      if (tab) {
        this.dom.elements.tradingTabs
          .querySelectorAll(".trading-tab")
          .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        this.state.activeTradingSide = tab.dataset.side;
        this.ui.updateTradingPanel();
        this.trading.fetchUserBalance();
      }
    });

    this.dom.elements.tradingTypeBtns?.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("disabled")) return;

        this.dom.elements.tradingTypeBtns.forEach((b) =>
          b.classList.remove("active")
        );
        btn.classList.add("active");

        this.state.activeTradingType = btn.dataset.type;
        this.ui.updateTradingPanel();
      });
    });

    this.dom.elements.tradeButtons?.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const side = btn.classList.contains("bid-button") ? "bid" : "ask";
        const result = await this.trading.sendOrder(side);

        // 🔧 주문 성공 후 UI 자동 업데이트 (sendOrder에서 이미 처리됨)
        if (result?.success) {
          // 추가로 필요한 UI 업데이트가 있다면 여기서 처리
        }
      });
    });
  }

  // 🔧 개선된 입력 이벤트 (주문총액 입력 추가)
  setupInputEvents() {
    // 가격 입력 이벤트
    this.dom.elements.orderPriceInput?.addEventListener("input", (e) => {
      const value = Utils.parseNumber(e.target.value);
      const adjustedPrice = Utils.adjustPriceToStep(
        value,
        this.state.activeCoin
      );
      e.target.value = Utils.formatKRW(adjustedPrice);

      // 🔧 가격 변경 시 총액 업데이트 (수량이 있는 경우)
      const quantity =
        Utils.parseNumber(this.dom.elements.orderQuantity?.value) || 0;
      if (quantity > 0) {
        this.ui.updateOrderTotal();
      } else {
        // 🔧 총액이 이미 입력되어 있으면 수량 계산
        this.ui.updateQuantityFromPrice();
      }
    });

    // 수량 입력 이벤트
    this.dom.elements.orderQuantityInput?.addEventListener("input", () => {
      // 🔧 수량 변경 시 총액 업데이트
      this.ui.updateOrderTotal();
    });

    // 🔧 주문총액 입력 이벤트 (사용자 직접 입력 시에는 자유 입력)
    this.dom.elements.orderTotalInput?.addEventListener("input", (e) => {
      // 사용자가 직접 입력할 때는 단위 조정 없이 자유롭게 입력 허용
      // %버튼이나 다른 자동 계산에 의한 입력은 이미 올바른 단위로 설정됨

      // 총액 변경 시 수량 자동 계산
      this.ui.updateQuantityFromTotal();
    });

    // 시장가 주문총액 입력 이벤트 (사용자 직접 입력 시에는 자유 입력)
    this.dom.elements.orderTotalMarketInput?.addEventListener("input", (e) => {
      // 사용자가 직접 입력할 때는 단위 조정 없이 자유롭게 입력 허용
      // %버튼이나 다른 자동 계산에 의한 입력은 이미 올바른 단위로 설정됨

      this.ui.updateMarketQuantity();
    });

    // 🔧 현재가 대비 % 선택 시 코인별 호가 단위 적용
    this.dom.elements.pricePercentageDropdown?.addEventListener(
      "change",
      (e) => {
        const currentPrice =
          this.state.latestTickerData[this.state.activeCoin]?.trade_price || 0;
        const percent = parseInt(e.target.value) / 100;

        // 🔧 코인별 호가 단위를 적용한 가격 계산
        const newPrice = Utils.calculatePriceWithPercentage(
          currentPrice,
          percent * 100,
          this.state.activeCoin
        );

        if (this.dom.elements.orderPrice) {
          this.dom.elements.orderPrice.value = Utils.formatKRW(newPrice);

          // 🔧 가격 변경 시 수량이 있으면 총액 업데이트, 없으면 총액 기준으로 수량 계산
          const quantity =
            Utils.parseNumber(this.dom.elements.orderQuantity?.value) || 0;
          if (quantity > 0) {
            this.ui.updateOrderTotal();
          } else {
            this.ui.updateQuantityFromPrice();
          }
        }
      }
    );
  }

  // 🔧 개선된 버튼 이벤트
  setupButtonEvents() {
    // 가격 조정 버튼
    this.dom.elements.priceBtns?.forEach((btn) => {
      btn.addEventListener("click", () => {
        const direction = btn.classList.contains("minus") ? "down" : "up";
        this.trading.adjustPrice(direction);
      });
    });

    // 수량 퍼센트 버튼
    this.dom.elements.quantityBtns?.forEach((btn) => {
      btn.addEventListener("click", () => {
        const percent = parseInt(btn.dataset.percent);
        this.trading.calculatePercentageAmount(percent);
      });
    });

    // 🔧 시장가 주문총액 퍼센트 버튼 (1000원 단위 적용)
    document
      .querySelectorAll(".market-total-group .quantity-btns button")
      ?.forEach((btn) => {
        btn.addEventListener("click", () => {
          const percent = parseInt(btn.dataset.percent);
          if (
            this.state.activeTradingType === "market" &&
            this.state.activeTradingSide === "bid"
          ) {
            let totalAmount = Math.floor(
              (this.state.userKRWBalance * percent) / 100
            );

            // 🔧 비트코인/이더리움의 경우 1000원 단위로 조정
            if (
              this.state.activeCoin === "KRW-BTC" ||
              this.state.activeCoin === "KRW-ETH"
            ) {
              totalAmount = Math.floor(totalAmount / 1000) * 1000;
            }

            this.dom.setOrderTotalMarket(totalAmount);
            this.ui.updateMarketQuantity();
          }
        });
      });
  }

  // 🔧 새로운 드롭다운 이벤트 설정
  setupDropdownEvents() {
    // 이동평균선 토글
    const maToggle = document.getElementById("ma-toggle");
    const maPanel = document.getElementById("ma-panel");
    const maContainer = maToggle?.parentElement; // dropdown-container

    maToggle?.addEventListener("click", (e) => {
      e.stopPropagation(); // 이벤트 버블링 방지
      maPanel.classList.toggle("hidden");

      // 다른 드롭다운 닫기
      const techPanel = document.getElementById("technical-panel");
      if (techPanel && !techPanel.classList.contains("hidden")) {
        techPanel.classList.add("hidden");
      }
    });

    // 🔧 이동평균선 드롭다운 외부 클릭 시 닫기
    if (maContainer && maPanel) {
      this.setupDropdownAutoClose(maContainer, maPanel);
    }

    // 이동평균선 체크박스들
    maPanel?.addEventListener("change", (e) => {
      if (e.target.type === "checkbox" && e.target.dataset.ma) {
        const period = parseInt(e.target.dataset.ma);
        if (e.target.checked) {
          this.addMovingAverage(period);
        } else {
          this.removeMovingAverage(period);
        }
      }
    });

    // 보조지표 토글
    const techToggle = document.getElementById("technical-toggle");
    const techPanel = document.getElementById("technical-panel");
    const techContainer = techToggle?.parentElement; // dropdown-container

    techToggle?.addEventListener("click", (e) => {
      e.stopPropagation(); // 이벤트 버블링 방지
      techPanel.classList.toggle("hidden");

      // 다른 드롭다운 닫기
      if (maPanel && !maPanel.classList.contains("hidden")) {
        maPanel.classList.add("hidden");
      }
    });

    // 🔧 보조지표 드롭다운 외부 클릭 시 닫기
    if (techContainer && techPanel) {
      this.setupDropdownAutoClose(techContainer, techPanel);
    }

    // 보조지표 체크박스들
    techPanel?.addEventListener("change", (e) => {
      if (e.target.type === "checkbox" && e.target.dataset.indicator) {
        const indicator = e.target.dataset.indicator;
        if (e.target.checked) {
          this.showIndicatorChart(indicator);
        } else {
          this.hideIndicatorChart(indicator);
        }
      }
    });

    // 시간봉 토글
    const timeframeToggle = document.getElementById("timeframe-toggle");
    const timeframePanel = document.getElementById("timeframe-panel");
    const timeframeContainer = timeframeToggle?.parentElement; // dropdown-container

    timeframeToggle?.addEventListener("click", (e) => {
      e.stopPropagation(); // 이벤트 버블링 방지
      timeframePanel.classList.toggle("hidden");

      // 다른 드롭다운 닫기
      if (maPanel && !maPanel.classList.contains("hidden")) {
        maPanel.classList.add("hidden");
      }
      if (techPanel && !techPanel.classList.contains("hidden")) {
        techPanel.classList.add("hidden");
      }
    });

    // 🔧 시간봉 드롭다운 외부 클릭 시 닫기
    if (timeframeContainer && timeframePanel) {
      this.setupDropdownAutoClose(timeframeContainer, timeframePanel);
    }

    // 시간봉 라디오 버튼들
    timeframePanel?.addEventListener("change", (e) => {
      if (e.target.type === "radio" && e.target.name === "timeframe") {
        const selectedUnit = e.target.value;
        const selectedText = e.target.parentElement.textContent.trim();

        // 모든 라벨에서 selected 클래스 제거
        timeframePanel.querySelectorAll("label").forEach(label => {
          label.classList.remove("selected");
        });

        // 선택된 라벨에 selected 클래스 추가
        e.target.parentElement.classList.add("selected");

        // 버튼 텍스트 업데이트
        if (timeframeToggle) {
          timeframeToggle.textContent = `${selectedText} ▼`;
        }

        // 시간단위 변경
        this.state.activeUnit = selectedUnit;
        this.chart.fetchAndRender();

        // 드롭다운 닫기
        timeframePanel.classList.add("hidden");
      }
    });

    // 🔧 전체 문서 클릭 시 모든 드롭다운 닫기
    document.addEventListener("click", (e) => {
      const isDropdownClick = e.target.closest(".dropdown-container");
      if (!isDropdownClick) {
        // 모든 드롭다운 닫기
        if (maPanel) maPanel.classList.add("hidden");
        if (techPanel) techPanel.classList.add("hidden");
        if (timeframePanel) timeframePanel.classList.add("hidden");
      }
    });
  }

  // 🔧 드롭다운 자동 닫기 설정 (마우스 leave 시)
  setupDropdownAutoClose(container, panel) {
    let leaveTimeout;

    // 마우스가 컨테이너를 벗어날 때
    container.addEventListener("mouseleave", () => {
      // 약간의 지연을 두어 사용자가 실수로 마우스를 벗어났을 때를 고려
      leaveTimeout = setTimeout(() => {
        if (!panel.classList.contains("hidden")) {
          panel.classList.add("hidden");
        }
      }, 300); // 300ms 지연
    });

    // 마우스가 다시 컨테이너에 들어오면 닫기 취소
    container.addEventListener("mouseenter", () => {
      if (leaveTimeout) {
        clearTimeout(leaveTimeout);
        leaveTimeout = null;
      }
    });

    // 패널 내에서 마우스 이동 시에도 닫기 취소
    panel.addEventListener("mouseenter", () => {
      if (leaveTimeout) {
        clearTimeout(leaveTimeout);
        leaveTimeout = null;
      }
    });

    // 패널을 벗어날 때도 닫기 (더 즉각적으로)
    panel.addEventListener("mouseleave", () => {
      leaveTimeout = setTimeout(() => {
        if (!panel.classList.contains("hidden")) {
          panel.classList.add("hidden");
        }
      }, 200); // 패널에서 벗어날 때는 더 빠르게
    });
  }

  // 새 메서드 추가
  removeMovingAverage(period) {
    if (this.chart?.removeMovingAverage) {
      this.chart.removeMovingAverage(period);
      // 🔧 상태에서 이동평균선 제거
      this.state.activeIndicators.movingAverages.delete(period.toString());
    }
  }

  removeIndicator(type) {
    if (this.chart?.removeIndicator) {
      this.chart.removeIndicator(type);
    }
  }

  // 🔧 이동평균선 추가 메서드
  addMovingAverage(period) {
    if (this.chart && typeof this.chart.addMovingAverage === "function") {
      const maSeries = this.chart.addMovingAverage(period);
      if (maSeries) {
        // 🔧 상태에 이동평균선 추가 저장
        this.state.activeIndicators.movingAverages.add(period.toString());

        // 전역 currentIndicators에 추가 (HTML의 clearAllIndicators와 호환)
        if (typeof window !== "undefined" && window.currentIndicators) {
          window.currentIndicators.push({
            type: `MA${period}`,
            series: maSeries,
            period: period,
          });
        }
      }
    }
  }

  // 🔧 보조지표 추가 메서드
  // 🔧 지표 차트 표시/숨김 메서드들
  showIndicatorChart(type) {
    if (type === 'RSI') {
      const rsiContainer = document.getElementById('rsiChart');
      if (rsiContainer) {
        rsiContainer.classList.remove('hidden');
        this.chart.addIndicator('RSI');
        // 🔧 상태에 기술지표 추가 저장
        this.state.activeIndicators.technicalIndicators.add(type);
      }
    } else if (type === 'MACD') {
      const macdContainer = document.getElementById('macdChart');
      if (macdContainer) {
        macdContainer.classList.remove('hidden');
        this.chart.addIndicator('MACD');
        // 🔧 상태에 기술지표 추가 저장
        this.state.activeIndicators.technicalIndicators.add(type);
      }
    } else if (type === 'BB') {
      this.chart.addIndicator('BB');
      // 🔧 상태에 기술지표 추가 저장
      this.state.activeIndicators.technicalIndicators.add(type);
    }
  }

  hideIndicatorChart(type) {
    if (type === 'RSI') {
      const rsiContainer = document.getElementById('rsiChart');
      if (rsiContainer) {
        rsiContainer.classList.add('hidden');
        this.chart.removeIndicator('RSI');
        // 🔧 상태에서 기술지표 제거
        this.state.activeIndicators.technicalIndicators.delete(type);
      }
    } else if (type === 'MACD') {
      const macdContainer = document.getElementById('macdChart');
      if (macdContainer) {
        macdContainer.classList.add('hidden');
        this.chart.removeIndicator('MACD');
        // 🔧 상태에서 기술지표 제거
        this.state.activeIndicators.technicalIndicators.delete(type);
      }
    } else if (type === 'BB') {
      this.chart.removeIndicator('BB');
      // 🔧 상태에서 기술지표 제거
      this.state.activeIndicators.technicalIndicators.delete(type);
    }
  }

  // 🔧 차트 타입 변경 메서드
  changeChartType(chartType) {
    if (this.chart && typeof this.chart.changeChartType === "function") {
      this.chart.changeChartType(chartType);
    }
  }

  // 🔧 시간단위 변경 메서드
  changeTimeframe(unit) {
    if (this.state && this.chart) {
      this.state.activeUnit = unit;

      // 기존 시간 탭 UI도 업데이트 (있다면)
      document.querySelectorAll(".time-tab").forEach((tab) => {
        tab.classList.remove("active");
        if (tab.dataset.unit === unit) {
          tab.classList.add("active");
        }
      });

      // 드롭다운과 동기화
      const timeframeToggle = document.getElementById("timeframe-toggle");
      const timeframePanel = document.getElementById("timeframe-panel");

      if (timeframePanel) {
        // 해당 라디오 버튼 선택
        const radioButton = timeframePanel.querySelector(`input[value="${unit}"]`);
        if (radioButton) {
          radioButton.checked = true;

          // 모든 라벨에서 selected 클래스 제거
          timeframePanel.querySelectorAll("label").forEach(label => {
            label.classList.remove("selected");
          });

          // 선택된 라벨에 selected 클래스 추가
          radioButton.parentElement.classList.add("selected");

          // 버튼 텍스트 업데이트
          if (timeframeToggle) {
            const selectedText = radioButton.parentElement.textContent.trim();
            timeframeToggle.textContent = `${selectedText} ▼`;
          }
        }
      }

      this.chart.fetchAndRender();
    }
  }

  // 🔧 새로고침 스피너 표시 (전체 새로고침만)
  showRefreshSpinner(type) {
    if (type === "all") {
      const button = this.dom.elements.refreshAllOrders;
      if (button) {
        button.disabled = true;
        button.innerHTML = '<div class="loading-spinner"></div>';
      }
    }
  }

  // 🔧 새로고침 스피너 숨김 (전체 새로고침만)
  hideRefreshSpinner(type) {
    if (type === "all") {
      const button = this.dom.elements.refreshAllOrders;
      if (button) {
        button.disabled = false;
        button.innerHTML = '<img src="images/refresh.png" alt="새로고침" />';
      }
    }
  }


  // 🔧 모든 지표 끄기 버튼 이벤트 설정
  setupClearAllIndicatorsButton() {
    const clearAllBtn = document.getElementById('clear-all-indicators');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', () => {
        this.clearAllIndicators();
      });
    }
  }

  // 🔧 모든 지표 끄기 기능
  clearAllIndicators() {

    // 모든 이동평균선 제거
    const activeMA = [...this.state.activeIndicators.movingAverages];
    activeMA.forEach(period => {

      // 차트에서 제거
      if (this.chart?.removeMovingAverage) {
        this.chart.removeMovingAverage(parseInt(period));
      }

      // 체크박스 해제
      const checkbox = document.querySelector(`input[data-ma="${period}"]`);
      if (checkbox) {
        checkbox.checked = false;
      }
    });

    // 모든 기술지표 제거
    const activeTechnical = [...this.state.activeIndicators.technicalIndicators];
    activeTechnical.forEach(indicator => {

      // 차트에서 제거
      if (this.chart?.removeIndicator) {
        this.chart.removeIndicator(indicator);
      }

      // 체크박스 해제
      const checkbox = document.querySelector(`input[data-indicator="${indicator}"]`);
      if (checkbox) {
        checkbox.checked = false;
      }

      // 지표 차트 UI 숨기기
      if (indicator === "RSI") {
        const rsiChart = document.getElementById("rsiChart");
        if (rsiChart) rsiChart.classList.add("hidden");
      } else if (indicator === "MACD") {
        const macdChart = document.getElementById("macdChart");
        if (macdChart) macdChart.classList.add("hidden");
      }
    });

    // 상태 초기화
    this.state.activeIndicators.movingAverages.clear();
    this.state.activeIndicators.technicalIndicators.clear();

  }
}
