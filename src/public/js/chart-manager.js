// chart-manager.js - 차트 관리 매니저
/**
 * 역할: TradingView Lightweight Charts를 이용한 차트 생성 및 관리
 * 주요 기능:
 * - 캠들 차트 생성 및 데이터 렌더링 (fetchAndRender, processAndRenderData)
 * - 차트 초기화 및 설정 (initializeCharts, createChart)
 * - 보조지표 추가/제거 (addIndicator, removeIndicator, addMovingAverage)
 * - 시간대 및 코인 변경에 따른 차트 업데이트 (checkAutoUpdate)
 * - 차트 뷰포트 보존/복원 (preserveCurrentViewport, restorePreservedViewport)
 * - 캠들 데이터 캠시 관리 및 최적화 (CacheManager 연동)
 * - 대량 데이터 비동기 처리 및 성능 최적화
 */
import { COIN_NAMES } from "./constants.js";
import { CacheManager } from "./cache-manager.js";

export class ChartManager {
  // TradingView 차트 생성 및 관리 담당 클래스
  constructor(state) {
    this.state = state;
    this.priceChart = null; // 메인 차트 인스턴스
    this.volumeChart = null; // 볼륨 차트 인스턴스
    this.rsiChart = null;
    this.macdChart = null;
    this.priceSeries = null;
    this.volumeSeries = null;
    this.rsiSeries = null;
    this.macdSeries = null;
    this.macdSignalSeries = null;
    this.macdHistogramSeries = null;
    this.bbUpperSeries = null;
    this.bbLowerSeries = null;
    this.bbMiddleSeries = null;
    this.indicatorSeries = {}; // 지표 시리즈를 관리할 객체
    this.cacheManager = new CacheManager();
    this.allCandleData = []; // 전체 캔들 데이터 저장
    this.isLoadingMore = false;
    this._syncing = false;
    this._crosshairSyncing = false;
    this._preservedViewport = null;
    this._isIndicatorCreating = false;
    this._chartCreationQueue = [];

    // 보조지표 상태 추적을 위한 속성 추가
    this._activeIndicators = {
      RSI: false,
      MACD: false,
      BB: false
    };

    // 이동평균선 상태 추적을 위한 속성 추가
    this._activeMovingAverages = new Set(); // 활성화된 이동평균선 기간 저장 (예: 5, 20, 50)

  }



  // 🔧 새로운 비동기 헬퍼 메서드들
  async waitForChartReady(chart, maxWait = 2000) {
    return new Promise((resolve) => {
      if (!chart) {
        resolve(false);
        return;
      }

      const startTime = Date.now();
      const checkReady = () => {
        try {
          const timeScale = chart.timeScale();
          const priceScale = chart.priceScale();

          if (timeScale && priceScale) {
            resolve(true);
          } else if (Date.now() - startTime > maxWait) {
            resolve(false);
          } else {
            setTimeout(checkReady, 50);
          }
        } catch (error) {
          if (Date.now() - startTime > maxWait) {
            resolve(false);
          } else {
            setTimeout(checkReady, 50);
          }
        }
      };
      checkReady();
    });
  }

  async waitForDataSet(series, data, maxWait = 1000) {
    return new Promise((resolve) => {
      if (!series || !data) {
        resolve(false);
        return;
      }

      try {
        series.setData(data);
        setTimeout(() => resolve(true), 100);
      } catch (error) {
        resolve(false);
      }
    });
  }

  preserveCurrentViewport() {
    if (this.priceChart) {
      try {
        this._preservedViewport = {
          logicalRange: this.priceChart.timeScale().getVisibleLogicalRange(),
          barSpacing: this.priceChart.timeScale().options().barSpacing,
          timestamp: Date.now(),
        };
      } catch (error) {
      }
    }
  }

  // 🎯 로지컬 기반 동기화 메서드 (안정적)
  forceSyncAllViewports() {
    if (!this.priceChart) return;

    try {
      const mainLogicalRange = this.priceChart.timeScale().getVisibleLogicalRange();
      const mainBarSpacing = this.priceChart.timeScale().options().barSpacing;

      if (!mainLogicalRange) return;


      // 모든 차트를 메인 차트와 동일한 로지컬 범위로 동기화
      if (this.rsiChart) {
        this.rsiChart.timeScale().setVisibleLogicalRange(mainLogicalRange);
        this.rsiChart.timeScale().applyOptions({ barSpacing: mainBarSpacing });
      }

      if (this.macdChart) {
        this.macdChart.timeScale().setVisibleLogicalRange(mainLogicalRange);
        this.macdChart.timeScale().applyOptions({ barSpacing: mainBarSpacing });
      }

      if (this.volumeChart) {
        this.volumeChart.timeScale().setVisibleLogicalRange(mainLogicalRange);
        this.volumeChart.timeScale().applyOptions({ barSpacing: mainBarSpacing });
      }

    } catch (error) {
    }
  }

  // 폴백용 로지컬 동기화
  fallbackLogicalSync() {
    const mainRange = this.priceChart.timeScale().getVisibleLogicalRange();
    if (!mainRange) return;

    // RSI 차트 동기화 (RSI는 14개 인덱스부터 시작)
    if (this.rsiChart) {
      this.rsiChart.timeScale().setVisibleLogicalRange(mainRange);
    }

    // MACD 차트 동기화 (MACD는 26개 인덱스부터 시작)
    if (this.macdChart) {
      this.macdChart.timeScale().setVisibleLogicalRange(mainRange);
    }

    // 볼륨 차트 동기화
    if (this.volumeChart) {
      this.volumeChart.timeScale().setVisibleLogicalRange(mainRange);
    }
  }

  async restorePreservedViewport(targetChart) {
    if (!this._preservedViewport || !targetChart) return false;

    try {
      // 더 긴 대기시간으로 차트 안정화
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 메인 차트와 완전히 동일한 뷰포트 적용
      if (this.priceChart && this._preservedViewport.logicalRange) {
        const currentMainRange = this.priceChart.timeScale().getVisibleLogicalRange();
        const currentMainBarSpacing = this.priceChart.timeScale().options().barSpacing;

        // 현재 메인 차트의 실제 뷰포트 사용 (더 정확함)
        if (currentMainRange) {
          targetChart.timeScale().setVisibleLogicalRange(currentMainRange);
        } else {
          targetChart.timeScale().setVisibleLogicalRange(this._preservedViewport.logicalRange);
        }

        // barSpacing 동기화
        targetChart.timeScale().applyOptions({
          barSpacing: currentMainBarSpacing || this._preservedViewport.barSpacing || 6,
        });
      }

      // 추가 검증: 복원이 제대로 되었는지 확인
      await new Promise((resolve) => setTimeout(resolve, 100));

      const finalRange = targetChart.timeScale().getVisibleLogicalRange();
      const mainRange = this.priceChart?.timeScale().getVisibleLogicalRange();

      return true;
    } catch (error) {
      return false;
    }
  }

  async fetchAndRender() {
    if (!this.state.activeCoin || !this.state.activeUnit) return;

    // 캐시 확인
    const cachedData = this.cacheManager.get(
      this.state.activeCoin,
      this.state.activeUnit,
      null
    );
    if (cachedData) {
      this.processAndRenderData(cachedData);
      return;
    }

    try {
      const response = await fetch(
        `/api/candles?unit=${this.state.activeUnit}&market=${this.state.activeCoin}&count=100`
      );
      const data = await response.json();

      if (!data || data.length === 0) {
        return;
      }

      // 캐시 저장
      this.cacheManager.set(this.state.activeCoin, this.state.activeUnit, data);
      this.processAndRenderData(data);
    } catch (error) {
    }
  }

  processAndRenderData(data) {
    this.allCandleData = [...data];

    // 캔들 데이터를 캐시에 등록
    this.cacheManager.addCandles(
      this.state.activeCoin,
      this.state.activeUnit,
      data
    );

    const sortedData = data.reverse();

    // 데이터 검증 및 변환
    const candleData = [];
    const volumeData = [];

    for (let i = 0; i < sortedData.length; i++) {
      const d = sortedData[i];

      // 필수 필드 존재 확인
      if (!d || !d.candle_date_time_kst) {
        continue;
      }

      // KST 시간 처리
      let timeValue;
      try {
        const kstTimeString = d.candle_date_time_kst;
        const kstDate = new Date(kstTimeString);
        timeValue = kstDate.getTime();

        if (isNaN(timeValue)) {
          continue;
        }
      } catch (error) {
        continue;
      }

      const time = Math.floor(timeValue / 1000);

      // 시간 값 유효성 검사
      const currentTime = Math.floor(Date.now() / 1000);
      const oneYearAgo = currentTime - 365 * 24 * 60 * 60;
      const oneYearLater = currentTime + 365 * 24 * 60 * 60;

      if (time < oneYearAgo || time > oneYearLater) {
        continue;
      }

      // OHLC 값 변환 및 검증
      const open = parseFloat(d.opening_price);
      const high = parseFloat(d.high_price);
      const low = parseFloat(d.low_price);
      const close = parseFloat(d.trade_price);
      const volume = parseFloat(d.candle_acc_trade_volume) || 0;

      // 값 유효성 검사
      if (
        isNaN(open) ||
        isNaN(high) ||
        isNaN(low) ||
        isNaN(close) ||
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0
      ) {
        continue;
      }

      // OHLC 논리 검증
      if (high < Math.max(open, close) || low > Math.min(open, close)) {
        continue;
      }

      // 유효한 데이터만 추가
      candleData.push({ time, open, high, low, close });
      volumeData.push({
        time,
        value: Math.max(0, volume),
        color:
          close >= open ? "rgba(225, 35, 67, 0.5)" : "rgba(23, 99, 182, 0.5)",
      });
    }


    // 시간 순 정렬
    candleData.sort((a, b) => a.time - b.time);
    volumeData.sort((a, b) => a.time - b.time);

    // 최소 데이터 개수 확인
    if (candleData.length < 5) {
      return;
    }

    // MA 계산
    const ma5Data = this.calculateSafeMA(candleData, 5);
    const ma20Data = this.calculateSafeMA(candleData, 20);

    this.renderCharts(candleData, volumeData);
  }

  calculateSafeMA(candleData, period) {
    const result = [];

    for (let i = 0; i < candleData.length; i++) {
      if (i < period - 1) {
        continue;
      }

      let sum = 0;
      let validCount = 0;

      for (let j = 0; j < period; j++) {
        const candle = candleData[i - j];
        if (
          candle &&
          typeof candle.close === "number" &&
          !isNaN(candle.close)
        ) {
          sum += candle.close;
          validCount++;
        }
      }

      if (validCount === period) {
        result.push({
          time: candleData[i].time,
          value: sum / period,
        });
      }
    }

    return result;
  }

  renderCharts(candleData, volumeData) {
    // 데이터 유효성 최종 검사
    if (!Array.isArray(candleData) || candleData.length === 0) {
      return;
    }

    if (!Array.isArray(volumeData) || volumeData.length === 0) {
      return;
    }

    // 기존 차트 제거
    this.destroy();

    const priceContainer = document.getElementById("priceChart");
    const volumeContainer = document.getElementById("volumeChart");

    if (!priceContainer || !volumeContainer) {
      return;
    }

    // 공통 차트 설정
    const commonChartConfig = {
      width: priceContainer.clientWidth,
      layout: {
        background: { type: "solid", color: "#1a1a1a" },
        textColor: "#e0e0e0",
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.1)" },
        horzLines: { color: "rgba(255, 255, 255, 0.1)" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal, // 🔧 하이브리드 모드
        vertLine: {
          color: "transparent", // 🔧 세로선 투명 (커스텀이 담당)
          width: 0,
          style: LightweightCharts.LineStyle.Solid,
          labelVisible: false, // 세로선 라벨 숨김
        },
        horzLine: {
          color: "#6A7985", // 🔧 가로선 표시 (TradingView 담당)
          width: 1,
          style: LightweightCharts.LineStyle.Dashed,
          labelBackgroundColor: "rgba(0, 0, 0, 0.8)",
          labelVisible: true, // Y축 값 표시
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
      },
    };

    // 1. 가격 차트 생성 (X축 틱 제거)
    this.priceChart = LightweightCharts.createChart(priceContainer, {
      ...commonChartConfig,
      height: 280,
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        textColor: "#e0e0e0",
        visible: false, // X축 틱 완전 제거
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        textColor: "#e0e0e0",
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
        entireTextOnly: true,
        minimumWidth: 80,
      },
    });

    this.priceSeries = this.priceChart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#e12343",
      downColor: "#1763b6",
      borderVisible: false,
      wickUpColor: "#e12343",
      wickDownColor: "#1763b6",
      priceFormat: {
        type: "price",
        precision: 0,
        minMove: 1,
      },
      lastValueVisible: false, // 마지막 가격 숨김
      priceLineVisible: false, // 가격선 숨김
    });
    this.priceSeries.setData(candleData);

    // 2. 볼륨 차트 생성 (X축 틱만 표시)
    this.volumeChart = LightweightCharts.createChart(volumeContainer, {
      ...commonChartConfig,
      height: 120,
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        textColor: "#e0e0e0",
        visible: true,
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time) => {
          const date = new Date(time * 1000);

          // 시간단위에 따른 포맷 변경
          if (this.state.activeUnit === "1D") {
            // 일봉: 6일 간격으로 표시, 달 바뀌는 곳에 영문월
            const day = date.getDate();
            const isMonthBoundary = day <= 6; // 월 초인지 확인

            if (isMonthBoundary) {
              return date.toLocaleDateString("en-US", {
                timeZone: "Asia/Seoul",
                month: "short", // Sep, Oct, Nov
                day: "numeric",
              });
            } else {
              return day.toString(); // 10, 16, 22, 28
            }
          } else if (this.state.activeUnit === "240") {
            // 4시간봉: 2일 간격으로 표시, 달 바뀌는 곳에 영문월
            const day = date.getDate();
            const isMonthBoundary = day <= 2; // 월 초 2일 이내

            if (isMonthBoundary) {
              return date.toLocaleDateString("en-US", {
                timeZone: "Asia/Seoul",
                month: "short", // Sep, Oct
                day: "numeric",
              });
            } else {
              return day.toString(); // 10, 12, 14, 16
            }
          } else {
            // 분봉: 기존대로 시:분
            return date.toLocaleTimeString("ko-KR", {
              timeZone: "Asia/Seoul",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });
          }
        },
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        textColor: "#e0e0e0",
        scaleMargins: {
          top: 0.1,
          bottom: 0,
        },
        entireTextOnly: true,
        minimumWidth: 80,
      },
      localization: {
        // 크로스헤어 라벨 포맷 변경 (yy.mm.dd.hh:mm)
        timeFormatter: (time) => {
          const date = new Date(time * 1000);
          return date
            .toLocaleDateString("ko-KR", {
              timeZone: "Asia/Seoul",
              year: "2-digit",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
            .replace(/\//g, ".")
            .replace(", ", ".");
        },
        dateFormatter: (time) => {
          const date = new Date(time * 1000);
          return date.toLocaleDateString("ko-KR", {
            timeZone: "Asia/Seoul",
            month: "short",
            day: "numeric",
          });
        },
      },
    });

    this.volumeSeries = this.volumeChart.addSeries(LightweightCharts.HistogramSeries, {
      color: "#e12343",
      priceFormat: {
        type: "volume",
        formatter: (volume) => {
          if (volume >= 1000000) {
            return (volume / 1000000).toFixed(1) + "M";
          } else if (volume >= 1000) {
            return (volume / 1000).toFixed(1) + "K";
          }
          return Math.round(volume).toString();
        },
      },
    });
    this.volumeSeries.setData(volumeData);

    // 시간단위별 틱 간격 조정
    if (this.state.activeUnit === "240") {
      // 4시간봉
      this.volumeChart.timeScale().applyOptions({
        barSpacing: 12, // 틱 간격 늘리기 (2일씩)
      });
    } else if (this.state.activeUnit === "1D") {
      // 1일봉
      this.volumeChart.timeScale().applyOptions({
        barSpacing: 18, // 틱 간격 더 늘리기 (6일씩)
      });
    }

    // 🎯 완전히 새로운 시간 기반 동기화
    const syncTimeScale = (logicalRange, source = "price") => {
      if (!logicalRange) return;

      // 순환 참조 방지를 위한 플래그
      if (this._syncing) return;
      this._syncing = true;

      try {
        // 로지컬 범위 기반 동기화 (v5.0에서도 이 방식이 더 안정적)
        if (source !== "volume" && this.volumeChart) {
          this.volumeChart.timeScale().setVisibleLogicalRange(logicalRange);
        }
        if (source !== "price" && this.priceChart) {
          this.priceChart.timeScale().setVisibleLogicalRange(logicalRange);
        }
        if (this.rsiChart) {
          this.rsiChart.timeScale().setVisibleLogicalRange(logicalRange);
        }
        if (this.macdChart) {
          this.macdChart.timeScale().setVisibleLogicalRange(logicalRange);
        }
      } catch (error) {
      } finally {
        this._syncing = false;
      }
    };

    this.priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      syncTimeScale(range, "price");
    });
    this.volumeChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      syncTimeScale(range, "volume");
    });

    // 4. 개선된 크로스헤어 동기화 - 하이브리드 모드 (가로선은 활성 차트에만)
    const syncCrosshair = (param, source = "price") => {
      if (this._crosshairSyncing) return;
      this._crosshairSyncing = true;

      try {
        if (param.point) {
          const x = param.point.x;

          // 🔧 다른 차트들은 가로선 없이 X좌표만 동기화 (투명 크로스헤어)
          if (source !== "price" && this.priceChart) {
            this.priceChart.setCrosshairPosition(x, priceContainer.clientHeight / 2);
          }
          if (source !== "volume" && this.volumeChart) {
            this.volumeChart.setCrosshairPosition(x, volumeContainer.clientHeight / 2);
          }
          if (source !== "rsi" && this.rsiChart) {
            const rsiContainer = document.querySelector("#rsiChart .chart-content");
            if (rsiContainer) {
              this.rsiChart.setCrosshairPosition(x, rsiContainer.clientHeight / 2);
            }
          }
          if (source !== "macd" && this.macdChart) {
            const macdContainer = document.querySelector("#macdChart .chart-content");
            if (macdContainer) {
              this.macdChart.setCrosshairPosition(x, macdContainer.clientHeight / 2);
            }
          }

          // 🔧 마우스 오버된 차트만 가로선 표시, 나머지는 투명처리
          this.updateCrosshairVisibility(source);

        } else {
          // 모든 차트에서 크로스헤어 제거
          if (source !== "price" && this.priceChart)
            this.priceChart.clearCrosshairPosition();
          if (source !== "volume" && this.volumeChart)
            this.volumeChart.clearCrosshairPosition();
          if (this.rsiChart) this.rsiChart.clearCrosshairPosition();
          if (this.macdChart) this.macdChart.clearCrosshairPosition();

          // 🔧 모든 차트의 가로선 숨김
          this.updateCrosshairVisibility(null);
        }
      } catch (error) {
      } finally {
        this._crosshairSyncing = false;
      }
    };

    this.priceChart.subscribeCrosshairMove((param) => {
      syncCrosshair(param, "price");
    });

    this.volumeChart.subscribeCrosshairMove((param) => {
      syncCrosshair(param, "volume");
    });

    // 5. 초기 차트 뷰 설정 (실제 데이터 길이 기반으로 동적 계산)
    const dataLength = candleData.length;
    const visibleCount = Math.min(50, dataLength); // 최대 50개 캔들 표시
    const startIndex = Math.max(0, dataLength - visibleCount);

    this.priceChart.timeScale().setVisibleLogicalRange({
      from: startIndex,
      to: dataLength - 1,
    });
    this.volumeChart.timeScale().setVisibleLogicalRange({
      from: startIndex,
      to: dataLength - 1,
    });

    // 🔧 커스텀 크로스헤어 초기화 (하이브리드 모드)
    this.initializeCustomCrosshair();

    // 반응형 처리 및 무한스크롤 설정
    this.setupResponsive();
    this.setupInfiniteScroll();
    this.lastCandleData = candleData;
    this.lastVolumeData = volumeData;

    // 이전에 활성화된 보조지표들 자동 복원
    this.restoreActiveIndicators();
  }

  // 🔧 보조지표 계산 메서드들
  calculateBollingerBands(candleData, period = 20, multiplier = 2) {
    const result = { upper: [], middle: [], lower: [] };

    for (let i = period - 1; i < candleData.length; i++) {
      const slice = candleData.slice(i - period + 1, i + 1);
      const closes = slice.map((c) => c.close);
      const sma = closes.reduce((sum, close) => sum + close, 0) / period;

      const variance =
        closes.reduce((sum, close) => sum + Math.pow(close - sma, 2), 0) /
        period;
      const stdDev = Math.sqrt(variance);

      result.middle.push({ time: candleData[i].time, value: sma });
      result.upper.push({
        time: candleData[i].time,
        value: sma + stdDev * multiplier,
      });
      result.lower.push({
        time: candleData[i].time,
        value: sma - stdDev * multiplier,
      });
    }

    return result;
  }

  calculateRSI(candleData, period = 14) {
    const result = [];

    if (candleData.length < period + 1) {
      return result;
    }

    // 🎯 앞부분을 null로 패딩하여 메인 차트와 인덱스 일치시키기
    for (let i = 0; i < period; i++) {
      result.push({ time: candleData[i].time, value: null });
    }

    // 모든 변화량 미리 계산
    const changes = [];
    for (let i = 1; i < candleData.length; i++) {
      changes.push(candleData[i].close - candleData[i - 1].close);
    }

    // 처음 period 구간의 평균 gain/loss 계산
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) {
        avgGain += changes[i];
      } else {
        avgLoss += Math.abs(changes[i]);
      }
    }

    avgGain /= period;
    avgLoss /= period;

    // 첫 번째 RSI 값 계산 (period 번째 인덱스)
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    let rsi = 100 - 100 / (1 + rs);
    result.push({ time: candleData[period].time, value: rsi });

    // 나머지 RSI 값들을 Wilder의 smoothing method로 계산
    for (let i = period; i < changes.length; i++) {
      const gain = changes[i] > 0 ? changes[i] : 0;
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;

      // Wilder's smoothing
      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;

      rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi = 100 - 100 / (1 + rs);

      result.push({ time: candleData[i + 1].time, value: rsi });
    }

    return result;
  }

  calculateMACD(
    candleData,
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9
  ) {
    // 🔧 디버깅: 입력 데이터 검증

    // EMA 계산 함수 - 🔧 null 체크 강화
    const calculateEMA = (data, period) => {
      const ema = new Array(data.length); // 🔧 전체 길이로 초기화
      const multiplier = 2 / (period + 1);

      // 🔧 첫 번째 유효한 값 찾기
      let firstValidIndex = 0;
      while (
        firstValidIndex < data.length &&
        (data[firstValidIndex] == null || isNaN(data[firstValidIndex]))
      ) {
        firstValidIndex++;
      }

      if (firstValidIndex >= data.length) return [];

      // 🔧 초기값들을 모두 첫 번째 유효값으로 채움
      for (let i = 0; i <= firstValidIndex; i++) {
        ema[i] = data[firstValidIndex];
      }

      // 🔧 EMA 계산
      for (let i = firstValidIndex + 1; i < data.length; i++) {
        if (data[i] != null && !isNaN(data[i])) {
          ema[i] = data[i] * multiplier + ema[i - 1] * (1 - multiplier);
        } else {
          ema[i] = ema[i - 1];
        }
      }

      return ema;
    };

    const closes = candleData.map((c) => c.close);
    const fastEMA = calculateEMA(closes, fastPeriod);
    const slowEMA = calculateEMA(closes, slowPeriod);

    // 🔧 EMA 결과 검증

    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
      if (
        fastEMA[i] != null &&
        slowEMA[i] != null &&
        !isNaN(fastEMA[i]) &&
        !isNaN(slowEMA[i])
      ) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
      } else {
        macdLine.push(0); // 🔧 null 대신 0으로 처리
      }
    }

    const signalLine = calculateEMA(macdLine, signalPeriod);

    const result = {
      macd: [],
      signal: [],
      histogram: [],
    };

    // 🎯 앞부분을 null로 패딩하여 메인 차트와 인덱스 일치시키기
    const paddingLength = slowPeriod + signalPeriod - 1; // 26 + 9 - 1 = 34
    for (let i = 0; i < paddingLength; i++) {
      result.macd.push({ time: candleData[i].time, value: null });
      result.signal.push({ time: candleData[i].time, value: null });
      result.histogram.push({ time: candleData[i].time, value: null });
    }

    // 🔧 Signal period 이후부터 실제 MACD 값 설정
    for (let i = paddingLength; i < candleData.length; i++) {
      const time = candleData[i].time;
      const macdValue = macdLine[i];
      const signalValue = signalLine[i];

      // 🔧 유효한 값만 설정 (중복 추가 방지)
      if (
        macdValue != null &&
        signalValue != null &&
        !isNaN(macdValue) &&
        !isNaN(signalValue)
      ) {
        result.macd.push({ time, value: macdValue });
        result.signal.push({ time, value: signalValue });

        const histogramValue = macdValue - signalValue;
        result.histogram.push({
          time,
          value: histogramValue,
          color: histogramValue >= 0 ? "#e12343" : "#1763b6",
        });
      } else {
        // null 값도 추가하여 인덱스 일치 유지
        result.macd.push({ time, value: null });
        result.signal.push({ time, value: null });
        result.histogram.push({ time, value: null });
      }
    }

    // 🔧 최종 검증

    return result;
  }

  // 🔧 보조지표 차트 생성 메서드들
  async createRSIChart() {
    const container = document.querySelector("#rsiChart .chart-content");
    if (!container) return null;

    this._isIndicatorCreating = true;

    // CSS transition 비활성화
    const rsiChartElement = document.getElementById("rsiChart");
    rsiChartElement.classList.add("creating");
    rsiChartElement.classList.remove("hidden");

    this.preserveCurrentViewport();

    try {
      this.rsiChart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 120, // 🔧 컨테이너 높이와 동일하게 설정
        layout: {
          background: { type: "solid", color: "#1a1a1a" },
          textColor: "#e0e0e0",
        },
        grid: {
          vertLines: { color: "rgba(255, 255, 255, 0.1)" },
          horzLines: { color: "rgba(255, 255, 255, 0.1)" },
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal, // 🔧 하이브리드 모드
          vertLine: {
            color: "transparent", // 🔧 세로선 투명 (커스텀이 담당)
            width: 0,
            style: LightweightCharts.LineStyle.Solid,
            labelVisible: false, // 세로선 라벨 숨김
          },
          horzLine: {
            color: "#6A7985", // 🔧 가로선 표시 (TradingView 담당)
            width: 1,
            style: LightweightCharts.LineStyle.Dashed,
            labelBackgroundColor: "rgba(0, 0, 0, 0.8)",
            labelVisible: true, // Y축 값 표시
          },
        },
        timeScale: {
          visible: false,
          fixLeftEdge: true,
          fixRightEdge: true,
          barSpacing: this.priceChart
            ? this.priceChart.timeScale().options().barSpacing
            : 6,
        },
        rightPriceScale: {
          borderColor: "rgba(255, 255, 255, 0.1)",
          textColor: "#e0e0e0",
          scaleMargins: { top: 0.1, bottom: 0.1 },
          entireTextOnly: true,
          minimumWidth: 80,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
      });

      const isChartReady = await this.waitForChartReady(this.rsiChart);
      if (!isChartReady) return null;

      this.rsiSeries = this.rsiChart.addSeries(LightweightCharts.LineSeries, {
        color: "#FFA500",
        lineWidth: 2,
      });

      let rsiData = [];
      if (this.lastCandleData && this.lastCandleData.length >= 15) {
        rsiData = this.calculateRSI(this.lastCandleData, 14);
        await this.waitForDataSet(this.rsiSeries, rsiData);
      }

      // RSI 차트를 메인 차트와 같은 뷰포트로 동기화
      if (rsiData.length > 0 && this.priceChart) {
        try {
          const mainLogicalRange = this.priceChart.timeScale().getVisibleLogicalRange();
          if (mainLogicalRange) {
            this.rsiChart.timeScale().setVisibleLogicalRange(mainLogicalRange);
          }
        } catch (error) {
        }
      }

      this.setupRSIEventListeners();

      // CSS transition 재활성화
      const rsiChartElement = document.getElementById("rsiChart");
      rsiChartElement.classList.remove("creating");

      // 🔧 차트 크기 강제 재조정
      setTimeout(() => {
        if (this.rsiChart && container) {
          this.rsiChart.resize(container.clientWidth, 120);
        }
      }, 50);

      return this.rsiChart;
    } catch (error) {
      return null;
    } finally {
      this._isIndicatorCreating = false;
    }
  }

  setupRSIEventListeners() {
    if (!this.rsiChart) return;

    this.rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this._syncing || this._isIndicatorCreating) return;

      this._syncing = true;
      try {
        if (this.priceChart)
          this.priceChart.timeScale().setVisibleLogicalRange(range);
        if (this.volumeChart)
          this.volumeChart.timeScale().setVisibleLogicalRange(range);
        if (this.macdChart)
          this.macdChart.timeScale().setVisibleLogicalRange(range);
      } finally {
        this._syncing = false;
      }
    });

    this.rsiChart.subscribeCrosshairMove((param) => {
      if (this._crosshairSyncing) return;

      this._crosshairSyncing = true;
      try {
        if (param.point && this.priceChart) {
          this.priceChart.setCrosshairPosition(
            param.point.x,
            document.getElementById("priceChart").clientHeight / 2
          );
          this.volumeChart?.setCrosshairPosition(
            param.point.x,
            document.getElementById("volumeChart").clientHeight / 2
          );
          if (this.macdChart) {
            const macdContainer = document.querySelector(
              "#macdChart .chart-content"
            );
            if (macdContainer) {
              this.macdChart.setCrosshairPosition(
                param.point.x,
                macdContainer.clientHeight / 2
              );
            }
          }
        } else if (!param.point) {
          this.priceChart?.clearCrosshairPosition();
          this.volumeChart?.clearCrosshairPosition();
          this.macdChart?.clearCrosshairPosition();
        }
      } finally {
        this._crosshairSyncing = false;
      }
    });

    // 🔧 커스텀 크로스헤어 이벤트 재연결
    this.attachCustomCrosshairEvents();
  }

  async createMACDChart() {
    const container = document.querySelector("#macdChart .chart-content");
    if (!container) return null;

    this._isIndicatorCreating = true;

    // CSS transition 비활성화
    const macdChartElement = document.getElementById("macdChart");
    macdChartElement.classList.add("creating");
    macdChartElement.classList.remove("hidden");

    this.preserveCurrentViewport();

    try {
      this.macdChart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 120, // 🔧 컨테이너 높이와 동일하게 설정
        layout: {
          background: { type: "solid", color: "#1a1a1a" },
          textColor: "#e0e0e0",
        },
        grid: {
          vertLines: { color: "rgba(255, 255, 255, 0.1)" },
          horzLines: { color: "rgba(255, 255, 255, 0.1)" },
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal, // 🔧 하이브리드 모드
          vertLine: {
            color: "transparent", // 🔧 세로선 투명 (커스텀이 담당)
            width: 0,
            style: LightweightCharts.LineStyle.Solid,
            labelVisible: false, // 세로선 라벨 숨김
          },
          horzLine: {
            color: "#6A7985", // 🔧 가로선 표시 (TradingView 담당)
            width: 1,
            style: LightweightCharts.LineStyle.Dashed,
            labelBackgroundColor: "rgba(0, 0, 0, 0.8)",
            labelVisible: true, // Y축 값 표시
          },
        },
        timeScale: {
          visible: false,
          fixLeftEdge: true,
          fixRightEdge: true,
          barSpacing: this.priceChart
            ? this.priceChart.timeScale().options().barSpacing
            : 6,
        },
        rightPriceScale: {
          borderColor: "rgba(255, 255, 255, 0.1)",
          textColor: "#e0e0e0",
          scaleMargins: { top: 0.1, bottom: 0.1 },
          entireTextOnly: true,
          minimumWidth: 80,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
      });

      const isChartReady = await this.waitForChartReady(this.macdChart);
      if (!isChartReady) return null;

      this.macdSeries = this.macdChart.addSeries(LightweightCharts.LineSeries, {
        color: "#2196F3",
        lineWidth: 2,
        priceFormat: { type: "price", precision: 0, minMove: 1 },
      });

      this.macdSignalSeries = this.macdChart.addSeries(LightweightCharts.LineSeries, {
        color: "#FF9800",
        lineWidth: 2,
      });

      this.macdHistogramSeries = this.macdChart.addSeries(LightweightCharts.HistogramSeries, {
        color: "#e12343",
      });

      if (this.lastCandleData && this.lastCandleData.length >= 35) {
        const macdData = this.calculateMACD(this.lastCandleData);

        await this.waitForDataSet(this.macdSeries, macdData.macd);
        await this.waitForDataSet(this.macdSignalSeries, macdData.signal);
        await this.waitForDataSet(this.macdHistogramSeries, macdData.histogram);

        // MACD 차트를 메인 차트와 같은 뷰포트로 동기화
        if (macdData.macd.length > 0 && this.priceChart) {
          try {
            const mainLogicalRange = this.priceChart.timeScale().getVisibleLogicalRange();
            if (mainLogicalRange) {
              this.macdChart.timeScale().setVisibleLogicalRange(mainLogicalRange);
            }
          } catch (error) {
          }
        }
      } else {
      }

      this.setupMACDEventListeners();

      // CSS transition 재활성화
      const macdChartElement = document.getElementById("macdChart");
      macdChartElement.classList.remove("creating");

      // 🔧 차트 크기 강제 재조정
      setTimeout(() => {
        if (this.macdChart && container) {
          this.macdChart.resize(container.clientWidth, 120);
        }
      }, 50);

      // 추가: 강제 동기화로 확실히 보장
      setTimeout(() => {
        this.forceSyncAllViewports();
      }, 100);

      return this.macdChart;
    } catch (error) {
      return null;
    } finally {
      this._isIndicatorCreating = false;
    }
  }

  setupMACDEventListeners() {
    if (!this.macdChart) return;

    this.macdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this._syncing || this._isIndicatorCreating) return;

      this._syncing = true;
      try {
        if (this.priceChart)
          this.priceChart.timeScale().setVisibleLogicalRange(range);
        if (this.volumeChart)
          this.volumeChart.timeScale().setVisibleLogicalRange(range);
        if (this.rsiChart)
          this.rsiChart.timeScale().setVisibleLogicalRange(range);
      } finally {
        this._syncing = false;
      }
    });

    this.macdChart.subscribeCrosshairMove((param) => {
      if (this._crosshairSyncing) return;

      this._crosshairSyncing = true;
      try {
        if (param.point && this.priceChart) {
          this.priceChart.setCrosshairPosition(
            param.point.x,
            document.getElementById("priceChart").clientHeight / 2
          );
          this.volumeChart?.setCrosshairPosition(
            param.point.x,
            document.getElementById("volumeChart").clientHeight / 2
          );
          if (this.rsiChart) {
            const rsiContainer = document.querySelector(
              "#rsiChart .chart-content"
            );
            if (rsiContainer) {
              this.rsiChart.setCrosshairPosition(
                param.point.x,
                rsiContainer.clientHeight / 2
              );
            }
          }
        } else if (!param.point) {
          this.priceChart?.clearCrosshairPosition();
          this.volumeChart?.clearCrosshairPosition();
          this.rsiChart?.clearCrosshairPosition();
        }
      } finally {
        this._crosshairSyncing = false;
      }
    });

    // 🔧 커스텀 크로스헤어 이벤트 재연결
    this.attachCustomCrosshairEvents();
  }

  addIndicatorToMainChart(ma5Data, ma20Data) {
    if (!this.priceChart) {
      return;
    }

    // MA5 추가
    if (Array.isArray(ma5Data) && ma5Data.length > 0) {
      this.indicatorSeries.ma5 = this.priceChart.addSeries(LightweightCharts.LineSeries, {
        color: "#FF0000",
        lineWidth: 1,
        title: "MA5",
        lastValueVisible: true,
      });
      this.indicatorSeries.ma5.setData(ma5Data);
    }

    // MA20 추가
    if (Array.isArray(ma20Data) && ma20Data.length > 0) {
      this.indicatorSeries.ma20 = this.priceChart.addSeries(LightweightCharts.LineSeries, {
        color: "#00FF00",
        lineWidth: 1,
        title: "MA20",
        lastValueVisible: true,
      });
      this.indicatorSeries.ma20.setData(ma20Data);
    }
  }

  updateRealtime(newCandle) {
    if (!this.priceSeries) return;

    const formattedCandle = {
      time: Math.floor(
        new Date(newCandle.candle_date_time_kst).getTime() / 1000
      ),
      open: Number(newCandle.opening_price),
      high: Number(newCandle.high_price),
      low: Number(newCandle.low_price),
      close: Number(newCandle.trade_price),
    };
    this.priceSeries.update(formattedCandle);
  }

  setupResponsive() {
    const priceContainer = document.getElementById("priceChart");
    const volumeContainer = document.getElementById("volumeChart");

    if (
      !this.priceChart ||
      !this.volumeChart ||
      !priceContainer ||
      !volumeContainer
    )
      return;

    const resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const { width, height } = entry.contentRect;

        if (entry.target === priceContainer && this.priceChart) {
          this.priceChart.applyOptions({
            width: Math.max(width, 300),
            height: Math.max(height, 200),
          });
        }

        if (entry.target === volumeContainer && this.volumeChart) {
          this.volumeChart.applyOptions({
            width: Math.max(width, 300),
            height: Math.max(height, 80),
          });
        }
      });
    });

    resizeObserver.observe(priceContainer);
    resizeObserver.observe(volumeContainer);
    this.resizeObserver = resizeObserver;
  }

  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.priceChart) {
      this.priceChart.remove();
      this.priceChart = null;
    }
    if (this.volumeChart) {
      this.volumeChart.remove();
      this.volumeChart = null;
    }
    // 시리즈 초기화
    this.priceSeries = null;
    this.volumeSeries = null;
    this.indicatorSeries = {};
    // 🔧 보조지표 차트들 정리
    if (this.rsiChart) {
      this.rsiChart.remove();
      this.rsiChart = null;
      this.rsiSeries = null;
    }
    if (this.macdChart) {
      this.macdChart.remove();
      this.macdChart = null;
      this.macdSeries = null;
      this.macdSignalSeries = null;
      this.macdHistogramSeries = null;
    }

    // 볼린저밴드 시리즈 정리
    this.bbUpperSeries = null;
    this.bbLowerSeries = null;
    this.bbMiddleSeries = null;
  }

  checkAutoUpdate() {
    const now = new Date();
    const currentMinute = now.getMinutes();
    const currentHour = now.getHours();
    let shouldUpdate = false;

    if (this.state.activeUnit === "1D") {
      if (
        currentHour === 0 &&
        currentMinute === 0 &&
        this.state.lastUpdateTime !== "1D-updated"
      ) {
        shouldUpdate = true;
        this.state.lastUpdateTime = "1D-updated";
      } else if (currentHour !== 0 || currentMinute !== 0) {
        this.state.lastUpdateTime = null;
      }
    } else {
      const unitInMinutes = parseInt(this.state.activeUnit);
      if (unitInMinutes && currentMinute % unitInMinutes === 0) {
        const lastUpdateString = `${this.state.activeUnit}-${currentHour}:${currentMinute}`;
        if (this.state.lastUpdateTime !== lastUpdateString) {
          shouldUpdate = true;
          this.state.lastUpdateTime = lastUpdateString;
        }
      }
    }

    if (shouldUpdate) {
      this.fetchAndRender();
    }
  }

  setupInfiniteScroll() {
    if (!this.priceChart) return;

    let scrollTimeout;

    this.priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || this.isLoadingMore || range.from > 80) return;

      clearTimeout(scrollTimeout);

      scrollTimeout = setTimeout(() => {
        this.loadMoreHistoricalData()
          .then((success) => {
            if (success) {
            } else {
            }
          })
          .catch((error) => {
          });
      }, 400);
    });
  }

  async loadMoreHistoricalData() {
    if (this.isLoadingMore || this.allCandleData.length === 0) return false;

    this.isLoadingMore = true;

    try {
      const to = this.calculateNonOverlappingTime(this.allCandleData);

      if (!to) {
        return false;
      }


      const response = await fetch(
        `/api/candles?unit=${this.state.activeUnit}&market=${
          this.state.activeCoin
        }&count=100&to=${encodeURIComponent(to)}`
      );

      if (!response.ok) {
        if (response.status === 500) {
          return false;
        }
        return false;
      }

      const apiData = await response.json();

      if (!apiData || apiData.length === 0) {
        return false;
      }

      const smartResult = this.cacheManager.getHistoryDataSmart(
        this.state.activeCoin,
        this.state.activeUnit,
        apiData
      );

      let finalData = [];

      if (smartResult.cached.length > 0) {
        finalData.push(...smartResult.cached);
      }

      if (smartResult.missing.length > 0) {
        finalData.push(...smartResult.missing);

        this.cacheManager.addCandles(
          this.state.activeCoin,
          this.state.activeUnit,
          smartResult.missing
        );
      }

      if (
        smartResult.missing.length === 0 &&
        smartResult.cached.length === apiData.length
      ) {
      }

      const filteredNewData = finalData.filter(
        (newCandle) =>
          !this.allCandleData.find(
            (existingCandle) =>
              existingCandle.candle_date_time_utc ===
              newCandle.candle_date_time_utc
          )
      );

      if (filteredNewData.length > 0) {
        this.allCandleData.push(...filteredNewData);
        this.appendHistoricalData(filteredNewData);
        return true;
      } else {
        return false;
      }
    } catch (error) {
      return false;
    } finally {
      this.isLoadingMore = false;
    }
  }

  appendHistoricalData(newData) {

    const sortedNewData = newData.reverse();
    const newCandleData = [];
    const newVolumeData = [];


    for (let i = 0; i < sortedNewData.length; i++) {
      const d = sortedNewData[i];

      if (!d || !d.candle_date_time_kst) continue;

      let timeValue;
      try {
        const kstTimeString = d.candle_date_time_kst;
        const kstDate = new Date(kstTimeString);
        timeValue = kstDate.getTime();
        if (isNaN(timeValue)) continue;
      } catch (error) {
        continue;
      }

      const time = Math.floor(timeValue / 1000);
      const open = parseFloat(d.opening_price);
      const high = parseFloat(d.high_price);
      const low = parseFloat(d.low_price);
      const close = parseFloat(d.trade_price);
      const volume = parseFloat(d.candle_acc_trade_volume) || 0;

      if (
        isNaN(open) ||
        isNaN(high) ||
        isNaN(low) ||
        isNaN(close) ||
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0
      )
        continue;

      if (high < Math.max(open, close) || low > Math.min(open, close)) continue;

      newCandleData.push({ time, open, high, low, close });
      newVolumeData.push({
        time,
        value: Math.max(0, volume),
        color:
          close >= open ? "rgba(225, 35, 67, 0.5)" : "rgba(23, 99, 182, 0.5)",
      });
    }


    newCandleData.sort((a, b) => a.time - b.time);
    newVolumeData.sort((a, b) => a.time - b.time);

    if (this.priceSeries && newCandleData.length > 0) {
      const existingData = this.lastCandleData || [];
      const combinedData = [...newCandleData, ...existingData];
      this.priceSeries.setData(combinedData);
      this.lastCandleData = combinedData;
    }

    if (this.volumeSeries && newVolumeData.length > 0) {
      this.volumeSeries.setData([
        ...newVolumeData,
        ...(this.lastVolumeData || []),
      ]);
      this.lastVolumeData = [...newVolumeData, ...(this.lastVolumeData || [])];
    }

    // RSI/MACD 차트 업데이트 추가
    if (newCandleData.length > 0) {
      const allCandleData = [...newCandleData, ...this.lastCandleData];

      // 🔧 중복 제거 - 시간 기준으로 유니크하게
      const uniqueCandleData = allCandleData
        .reduce((acc, current) => {
          const existing = acc.find((item) => item.time === current.time);
          if (!existing) {
            acc.push(current);
          }
          return acc;
        }, [])
        .sort((a, b) => a.time - b.time);


      // RSI 업데이트 - 전체 데이터로 다시 계산하여 완전한 지표 생성
      if (this.rsiSeries && uniqueCandleData.length >= 15) { // RSI 계산 최소 요구 데이터
        const rsiData = this.calculateRSI(uniqueCandleData, 14);

        if (rsiData.length > 0) {
          this.rsiSeries.setData(rsiData);
        }
      }

      // MACD 업데이트 - 전체 데이터로 다시 계산하여 완전한 지표 생성
      if (
        this.macdSeries &&
        this.macdSignalSeries &&
        this.macdHistogramSeries &&
        uniqueCandleData.length >= 35 // MACD 계산 최소 요구 데이터 (26 + 9)
      ) {
        const macdData = this.calculateMACD(uniqueCandleData);

        if (macdData.macd.length > 0) {
          this.macdSeries.setData(macdData.macd);
          this.macdSignalSeries.setData(macdData.signal);
          this.macdHistogramSeries.setData(macdData.histogram);
        }
      }
    }

    // 히스토리 데이터 추가 후 뷰포트 동기화 보장
    setTimeout(() => {
      this.forceSyncAllViewports();
    }, 200);

  }

  calculateNonOverlappingTime(allCandleData) {
    if (!allCandleData || allCandleData.length === 0) return null;

    const oldestCandle = allCandleData[allCandleData.length - 1];
    if (!oldestCandle?.candle_date_time_utc) return null;

    try {
      const oldestTime = new Date(oldestCandle.candle_date_time_utc);

      let targetTime;

      if (this.state.activeUnit === "1D") {
        targetTime = new Date(oldestTime.getTime() - 24 * 60 * 60 * 1000);
      } else {
        const minutes = parseInt(this.state.activeUnit);
        targetTime = new Date(oldestTime.getTime() - minutes * 60 * 1000);
      }

      return targetTime.toISOString();
    } catch (error) {
      return oldestCandle.candle_date_time_utc;
    }
  }

  addMovingAverage(period) {
    if (!this.priceChart || !this.lastCandleData) {
      return null;
    }

    const key = `ma${period}`;

    if (this.indicatorSeries[key]) {
      this.priceChart.removeSeries(this.indicatorSeries[key]);
    }

    const colors = {
      5: "#FF6B6B",
      10: "#4ECDC4",
      20: "#45B7D1",
      50: "#96CEB4",
      100: "#FFEAA7",
      200: "#DDA0DD",
    };

    const maSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
      color: colors[period] || "#FFFFFF",
      lineWidth: 2,
      title: `MA${period}`,
      lastValueVisible: true,
    });

    const maData = this.calculateSafeMA(this.lastCandleData, period);
    if (maData.length > 0) {
      maSeries.setData(maData);
    }

    this.indicatorSeries[key] = maSeries;
    this._activeMovingAverages.add(period); // 상태 추적
    return maSeries;
  }

  removeMovingAverage(period) {
    const key = `ma${period}`;
    if (this.indicatorSeries[key]) {
      this.priceChart.removeSeries(this.indicatorSeries[key]);
      delete this.indicatorSeries[key];
      this._activeMovingAverages.delete(period); // 상태 업데이트
      return true;
    }
    return false;
  }

  async addIndicator(type) {
    if (!this.priceChart || !this.lastCandleData) {
      return null;
    }

    try {
      if (type === "RSI") {
        if (!this.rsiChart) {
          this._activeIndicators.RSI = true; // 상태 추적
          await this.createRSIChart();
          return this.rsiSeries;
        }
      } else if (type === "MACD") {
        if (!this.macdChart) {
          this._activeIndicators.MACD = true; // 상태 추적
          await this.createMACDChart();
          return {
            macd: this.macdSeries,
            signal: this.macdSignalSeries,
            histogram: this.macdHistogramSeries,
          };
        }
      } else if (type === "BB") {
        this._activeIndicators.BB = true; // 상태 추적
        this.preserveCurrentViewport();

        const bbData = this.calculateBollingerBands(this.lastCandleData, 20, 2);

        this.bbUpperSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
          color: "rgba(255, 255, 255, 0.5)",
          lineWidth: 1,
          title: "BB Upper",
        });

        this.bbMiddleSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
          color: "rgba(255, 255, 255, 0.3)",
          lineWidth: 1,
          title: "BB Middle",
        });

        this.bbLowerSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
          color: "rgba(255, 255, 255, 0.5)",
          lineWidth: 1,
          title: "BB Lower",
        });

        this.bbUpperSeries.setData(bbData.upper);
        this.bbMiddleSeries.setData(bbData.middle);
        this.bbLowerSeries.setData(bbData.lower);

        this.indicatorSeries["BB"] = {
          upper: this.bbUpperSeries,
          middle: this.bbMiddleSeries,
          lower: this.bbLowerSeries,
        };

        if (this._preservedViewport?.logicalRange) {
          this.priceChart
            .timeScale()
            .setVisibleLogicalRange(this._preservedViewport.logicalRange);
        }

        return this.indicatorSeries["BB"];
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  removeIndicator(type) {
    if (type === "RSI" && this.rsiChart) {
      this._activeIndicators.RSI = false; // 상태 업데이트
      this.rsiChart.remove();
      this.rsiChart = null;
      this.rsiSeries = null;
      return true;
    } else if (type === "MACD" && this.macdChart) {
      this._activeIndicators.MACD = false; // 상태 업데이트
      this.macdChart.remove();
      this.macdChart = null;
      this.macdSeries = null;
      this.macdSignalSeries = null;
      this.macdHistogramSeries = null;
      return true;
    } else if (type === "BB" && this.indicatorSeries["BB"]) {
      this._activeIndicators.BB = false; // 상태 업데이트
      const bb = this.indicatorSeries["BB"];
      this.priceChart.removeSeries(bb.upper);
      this.priceChart.removeSeries(bb.middle);
      this.priceChart.removeSeries(bb.lower);
      delete this.indicatorSeries["BB"];
      this.bbUpperSeries = null;
      this.bbMiddleSeries = null;
      this.bbLowerSeries = null;
      return true;
    }

    return false;
  }

  clearAllIndicators() {
    Object.keys(this.indicatorSeries).forEach((key) => {
      if (this.indicatorSeries[key]) {
        this.priceChart.removeSeries(this.indicatorSeries[key]);
        delete this.indicatorSeries[key];
      }
    });

    // 상태 초기화
    this._activeMovingAverages.clear();
    this._activeIndicators.RSI = false;
    this._activeIndicators.MACD = false;
    this._activeIndicators.BB = false;

  }

  // 🔧 커스텀 크로스헤어 초기화 (하이브리드 모드)
  initializeCustomCrosshair() {
    // 기존 커스텀 크로스헤어 제거
    this.removeCustomCrosshair();

    // 커스텀 크로스헤어 컨테이너 생성
    this.customCrosshair = {
      container: null,
      verticalLine: null,
      timeLabel: null,
      isVisible: false
    };

    // 메인 차트 컨테이너 찾기
    const chartWrapper = document.querySelector('.chart-container');
    if (!chartWrapper) {
      return;
    }

    // 차트 컨테이너를 relative로 설정
    chartWrapper.style.position = 'relative';

    // 커스텀 크로스헤어 컨테이너 생성
    this.customCrosshair.container = document.createElement('div');
    this.customCrosshair.container.className = 'custom-crosshair-overlay';
    this.customCrosshair.container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 10;
      opacity: 0;
      transition: opacity 0.15s ease-out;
      overflow: hidden;
    `;

    // 세로선 생성 (TradingView 스타일)
    this.customCrosshair.verticalLine = document.createElement('div');
    this.customCrosshair.verticalLine.className = 'custom-vertical-line';
    this.customCrosshair.verticalLine.style.cssText = `
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: repeating-linear-gradient(
        to bottom,
        #7F7F7F 0px,
        #7F7F7F 2px,
        transparent 2px,
        transparent 4px
      );
      opacity: 0.7;
      transform: translateX(-50%);
      pointer-events: none;
    `;

    // 시간 라벨 생성 (TradingView 스타일)
    this.customCrosshair.timeLabel = document.createElement('div');
    this.customCrosshair.timeLabel.className = 'custom-time-label';
    this.customCrosshair.timeLabel.style.cssText = `
      position: absolute;
      bottom: 2px;
      background: #000000;
      color: #d1d4dc;
      padding: 2px 6px;
      border-radius: 2px;
      font-size: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-weight: 400;
      white-space: nowrap;
      transform: translateX(-50%);
      border: 1px solid #4a4a4a;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      z-index: 15;
      pointer-events: none;
      line-height: 1.2;
    `;

    // DOM에 추가
    this.customCrosshair.container.appendChild(this.customCrosshair.verticalLine);
    this.customCrosshair.container.appendChild(this.customCrosshair.timeLabel);
    chartWrapper.appendChild(this.customCrosshair.container);

    // TradingView 차트들에 마우스 이벤트 리스너 추가
    this.attachCustomCrosshairEvents();

  }

  // 커스텀 크로스헤어 이벤트 연결
  attachCustomCrosshairEvents() {
    if (!this.priceChart || !this.volumeChart) return;

    // 프라이스 차트 이벤트
    this.priceChart.subscribeCrosshairMove((param) => {
      this.updateCustomCrosshair(param, 'price');
    });

    // 볼륨 차트 이벤트
    this.volumeChart.subscribeCrosshairMove((param) => {
      this.updateCustomCrosshair(param, 'volume');
    });

    // RSI 차트 이벤트 (있는 경우)
    if (this.rsiChart) {
      this.rsiChart.subscribeCrosshairMove((param) => {
        this.updateCustomCrosshair(param, 'rsi');
      });
    }

    // MACD 차트 이벤트 (있는 경우)
    if (this.macdChart) {
      this.macdChart.subscribeCrosshairMove((param) => {
        this.updateCustomCrosshair(param, 'macd');
      });
    }
  }

  // 커스텀 크로스헤어 업데이트
  updateCustomCrosshair(param, source) {
    if (!this.customCrosshair?.container) return;

    if (param.point && param.time) {
      // 크로스헤어 표시
      this.customCrosshair.container.style.opacity = '1';
      this.customCrosshair.isVisible = true;

      // X 좌표 설정
      const x = param.point.x;
      this.customCrosshair.verticalLine.style.left = `${x}px`;
      this.customCrosshair.timeLabel.style.left = `${x}px`;

      // 시간 라벨 텍스트 설정
      const timeText = this.formatTimeLabel(param.time);
      this.customCrosshair.timeLabel.textContent = timeText;

      // 🔧 가로선 가시성 업데이트
      this.updateCrosshairVisibility(source);

    } else {
      // 크로스헤어 숨김
      this.customCrosshair.container.style.opacity = '0';
      this.customCrosshair.isVisible = false;

      // 🔧 모든 차트의 가로선 숨김
      this.updateCrosshairVisibility(null);
    }
  }

  // 시간 라벨 포맷
  formatTimeLabel(time) {
    const date = new Date(time * 1000);

    // 시간 단위에 따른 다른 포맷
    if (this.state.activeUnit === "1D") {
      return date.toLocaleDateString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit"
      }).replace(/\//g, ".");
    } else if (this.state.activeUnit === "240") {
      return date.toLocaleDateString("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit"
      }).replace(/\//g, ".").replace(", ", ".");
    } else {
      return date.toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).replace(/\//g, ".").replace(", ", ".");
    }
  }

  // 🔧 크로스헤어 가시성 업데이트 (활성 차트만 가로선 표시)
  updateCrosshairVisibility(activeChart) {
    const charts = [
      { chart: this.priceChart, name: 'price' },
      { chart: this.volumeChart, name: 'volume' },
      { chart: this.rsiChart, name: 'rsi' },
      { chart: this.macdChart, name: 'macd' }
    ];

    charts.forEach(({ chart, name }) => {
      if (!chart) return;

      try {
        if (name === activeChart) {
          // 활성 차트: 가로선 표시
          chart.applyOptions({
            crosshair: {
              horzLine: {
                color: "#6A7985",
                width: 1,
                style: LightweightCharts.LineStyle.Dashed,
                labelBackgroundColor: "rgba(0, 0, 0, 0.8)",
                labelVisible: true,
              }
            }
          });
        } else {
          // 비활성 차트: 가로선 투명
          chart.applyOptions({
            crosshair: {
              horzLine: {
                color: "transparent",
                width: 0,
                labelVisible: false,
              }
            }
          });
        }
      } catch (error) {
      }
    });
  }

  // 커스텀 크로스헤어 제거
  removeCustomCrosshair() {
    if (this.customCrosshair?.container) {
      this.customCrosshair.container.remove();
      this.customCrosshair = null;
    }
  }

  // 활성화된 보조지표들을 자동으로 복원하는 메서드
  async restoreActiveIndicators() {

    const promises = [];

    // RSI가 활성화되어 있었다면 다시 생성
    if (this._activeIndicators.RSI && !this.rsiChart) {
      promises.push(this.createRSIChart());

      // UI 체크박스 상태 동기화
      const rsiCheckbox = document.querySelector('input[data-indicator="RSI"]');
      if (rsiCheckbox) rsiCheckbox.checked = true;

      // RSI 차트 컨테이너 표시
      const rsiChartElement = document.getElementById("rsiChart");
      if (rsiChartElement) rsiChartElement.classList.remove("hidden");
    }

    // MACD가 활성화되어 있었다면 다시 생성
    if (this._activeIndicators.MACD && !this.macdChart) {
      promises.push(this.createMACDChart());

      // UI 체크박스 상태 동기화
      const macdCheckbox = document.querySelector('input[data-indicator="MACD"]');
      if (macdCheckbox) macdCheckbox.checked = true;

      // MACD 차트 컨테이너 표시
      const macdChartElement = document.getElementById("macdChart");
      if (macdChartElement) macdChartElement.classList.remove("hidden");
    }

    // BB가 활성화되어 있었다면 다시 생성
    if (this._activeIndicators.BB && !this.indicatorSeries["BB"]) {
      promises.push(this.restoreBollingerBands());

      // UI 체크박스 상태 동기화
      const bbCheckbox = document.querySelector('input[data-indicator="BB"]');
      if (bbCheckbox) bbCheckbox.checked = true;
    }

    // 이동평균선들을 복원
    if (this._activeMovingAverages.size > 0) {

      // 복원할 이동평균선 복사 (복원 중 수정되지 않도록)
      const periodsToRestore = Array.from(this._activeMovingAverages);

      for (const period of periodsToRestore) {
        const key = `ma${period}`;
        // 이미 존재하지 않는 경우에만 다시 생성
        if (!this.indicatorSeries[key]) {
          try {
            this.restoreMovingAverage(period);

            // UI 체크박스 상태 동기화
            const maCheckbox = document.querySelector(`input[data-ma="${period}"]`);
            if (maCheckbox) maCheckbox.checked = true;

          } catch (error) {
          }
        }
      }
    }

    // 모든 보조지표 복원을 병렬로 처리
    if (promises.length > 0) {
      try {
        await Promise.all(promises);

        // 복원 후 뷰포트 동기화
        setTimeout(() => {
          this.forceSyncAllViewports();
        }, 200);
      } catch (error) {
      }
    } else {
    }
  }

  // 볼린저밴드 복원을 위한 별도 메서드
  async restoreBollingerBands() {
    if (!this.priceChart || !this.lastCandleData) return;

    try {
      this.preserveCurrentViewport();

      const bbData = this.calculateBollingerBands(this.lastCandleData, 20, 2);

      this.bbUpperSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
        color: "rgba(255, 255, 255, 0.5)",
        lineWidth: 1,
        title: "BB Upper",
      });

      this.bbMiddleSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
        color: "rgba(255, 255, 255, 0.3)",
        lineWidth: 1,
        title: "BB Middle",
      });

      this.bbLowerSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
        color: "rgba(255, 255, 255, 0.5)",
        lineWidth: 1,
        title: "BB Lower",
      });

      this.bbUpperSeries.setData(bbData.upper);
      this.bbMiddleSeries.setData(bbData.middle);
      this.bbLowerSeries.setData(bbData.lower);

      this.indicatorSeries["BB"] = {
        upper: this.bbUpperSeries,
        middle: this.bbMiddleSeries,
        lower: this.bbLowerSeries,
      };

      if (this._preservedViewport?.logicalRange) {
        this.priceChart
          .timeScale()
          .setVisibleLogicalRange(this._preservedViewport.logicalRange);
      }

    } catch (error) {
    }
  }

  // 이동평균선 복원을 위한 별도 메서드 (상태 중복 추가 방지)
  restoreMovingAverage(period) {
    if (!this.priceChart || !this.lastCandleData) {
      return null;
    }

    const key = `ma${period}`;

    if (this.indicatorSeries[key]) {
      this.priceChart.removeSeries(this.indicatorSeries[key]);
    }

    const colors = {
      5: "#FF6B6B",
      10: "#4ECDC4",
      20: "#45B7D1",
      50: "#96CEB4",
      100: "#FFEAA7",
      200: "#DDA0DD",
    };

    const maSeries = this.priceChart.addSeries(LightweightCharts.LineSeries, {
      color: colors[period] || "#FFFFFF",
      lineWidth: 2,
      title: `MA${period}`,
      lastValueVisible: true,
    });

    const maData = this.calculateSafeMA(this.lastCandleData, period);
    if (maData.length > 0) {
      maSeries.setData(maData);
    }

    this.indicatorSeries[key] = maSeries;
    // 복원 시에는 이미 _activeMovingAverages에 있으므로 다시 추가하지 않음
    return maSeries;
  }
}
