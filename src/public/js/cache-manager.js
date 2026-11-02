// public/js/cache-manager.js - 캐시 관리 매니저
/**
 * 역할: 차트 데이터 캐싱 및 성능 최적화
 * 주요 기능:
 * - 일반 API 데이터 캐싱 (get, set, isValid)
 * - 캔들 데이터 스마트 캐싱 (addCandles, getCachedCandles, hasCandle)
 * - 캔들 데이터 중복 방지 및 효율적 저장 (getMissingTimestamps)
 * - 캐시 크기 제한 및 자동 정리 (limitCandleCache, cleanupCache)
 * - 히스토리 데이터 지능형 처리 (getHistoryDataSmart)
 * - 캐시 통계 및 디버깅 지원 (getStats, debugCandleCache)
 * - 메모리 사용량 최적화 및 성능 향상
 */
export class CacheManager {
  // 차트 데이터 캐싱 및 성능 최적화 담당 클래스
  constructor() {
    this.cacheTimeout = 60000; // 1분
    this.cache = new Map(); // 일반 차트 데이터 캐싱
    this.loadedCandles = new Map(); // 🔧 개별 캔들 추적 (market-unit → Set<timestamp>)
    this.candleData = new Map(); // 🔧 실제 캔들 데이터 저장 (timestamp → candleObject)
    this.maxSize = 50;
    this.maxAge = 300000; // 5분
    this.candleMaxAge = 1800000; // 30분 (캔들 데이터용)

    // 주기적 캐시 정리
    setInterval(() => {
      this.cleanupCache();
    }, 600000);
  }

  // 일반 캐시 키 생성
  getCacheKey(market, unit, to = null) {
    if (to) {
      return `${market}-${unit}-${to}`;
    }
    return `${market}-${unit}`;
  }

  // 🔧 캔들 맵 키 생성
  getCandleMapKey(market, unit) {
    return `${market}-${unit}`;
  }

  // 🔧 타임스탬프 변환 유틸리티
  parseTimeToTimestamp(timeString) {
    try {
      return Math.floor(new Date(timeString).getTime() / 1000);
    } catch (error) {
      return null;
    }
  }

  // 🔧 특정 캔들이 이미 로드되었는지 확인
  hasCandle(market, unit, timestamp) {
    const key = this.getCandleMapKey(market, unit);
    const candleSet = this.loadedCandles.get(key);
    return candleSet ? candleSet.has(timestamp) : false;
  }

  // 🔧 여러 캔들들이 로드되었는지 확인
  getLoadedCandles(market, unit, timestamps) {
    const key = this.getCandleMapKey(market, unit);
    const candleSet = this.loadedCandles.get(key);

    if (!candleSet) return [];

    return timestamps.filter((ts) => candleSet.has(ts));
  }

  // 🔧 로드되지 않은 타임스탬프들 찾기
  getMissingTimestamps(market, unit, requestedTimestamps) {
    const key = this.getCandleMapKey(market, unit);
    const candleSet = this.loadedCandles.get(key);

    if (!candleSet) return requestedTimestamps;

    return requestedTimestamps.filter((ts) => !candleSet.has(ts));
  }

  // 🔧 캔들 데이터 추가
  addCandles(market, unit, candleArray) {
    if (!candleArray || candleArray.length === 0) return;

    const key = this.getCandleMapKey(market, unit);

    // 타임스탬프 집합 초기화 또는 가져오기
    if (!this.loadedCandles.has(key)) {
      this.loadedCandles.set(key, new Set());
    }
    const candleSet = this.loadedCandles.get(key);

    let addedCount = 0;

    candleArray.forEach((candle) => {
      const timestamp = this.parseTimeToTimestamp(candle.candle_date_time_utc);
      if (timestamp && !candleSet.has(timestamp)) {
        candleSet.add(timestamp);

        // 실제 캔들 데이터 저장 (키: 마켓-유닛-타임스탬프)
        const candleKey = `${key}-${timestamp}`;
        this.candleData.set(candleKey, {
          data: candle,
          timestamp: Date.now(), // 캐시 시간
        });

        addedCount++;
      }
    });

    if (addedCount > 0) {
    }

    // 캐시 크기 제한
    this.limitCandleCache();
  }

  // 🔧 캐시된 캔들 데이터 조회
  getCachedCandles(market, unit, requestedTimestamps) {
    const key = this.getCandleMapKey(market, unit);
    const availableTimestamps = this.getLoadedCandles(
      market,
      unit,
      requestedTimestamps
    );

    if (availableTimestamps.length === 0) return [];

    const cachedCandles = [];

    availableTimestamps.forEach((timestamp) => {
      const candleKey = `${key}-${timestamp}`;
      const cachedItem = this.candleData.get(candleKey);

      if (cachedItem && this.isCandleValid(cachedItem)) {
        cachedCandles.push(cachedItem.data);
      }
    });

    if (cachedCandles.length > 0) {
    }

    return cachedCandles;
  }

  // 🔧 히스토리 데이터 스마트 캐싱 (메인 메서드)
  getHistoryDataSmart(market, unit, requestedData) {
    if (!requestedData || requestedData.length === 0)
      return { cached: [], missing: [] };

    // 요청된 데이터의 타임스탬프 추출
    const requestedTimestamps = requestedData
      .map((d) => this.parseTimeToTimestamp(d.candle_date_time_utc))
      .filter((ts) => ts !== null);

    if (requestedTimestamps.length === 0)
      return { cached: [], missing: requestedData };

    // 캐시된 데이터 조회
    const cachedCandles = this.getCachedCandles(
      market,
      unit,
      requestedTimestamps
    );

    // 없는 데이터 찾기
    const cachedTimestamps = new Set(
      cachedCandles.map((c) =>
        this.parseTimeToTimestamp(c.candle_date_time_utc)
      )
    );

    const missingCandles = requestedData.filter((d) => {
      const ts = this.parseTimeToTimestamp(d.candle_date_time_utc);
      return ts && !cachedTimestamps.has(ts);
    });

    return {
      cached: cachedCandles,
      missing: missingCandles,
    };
  }

  // 🔧 캔들 데이터 유효성 검사
  isCandleValid(cachedItem) {
    return Date.now() - cachedItem.timestamp < this.candleMaxAge;
  }

  // 🔧 캔들 캐시 크기 제한
  limitCandleCache() {
    // 각 마켓-유닛당 최대 1000개 캔들로 제한
    const maxCandlesPerMarket = 1000;

    for (const [key, candleSet] of this.loadedCandles.entries()) {
      if (candleSet.size > maxCandlesPerMarket) {
        // 오래된 캔들 제거 (타임스탬프 기준 정렬 후 앞쪽 제거)
        const sortedTimestamps = Array.from(candleSet).sort((a, b) => a - b);
        const toRemove = sortedTimestamps.slice(
          0,
          candleSet.size - maxCandlesPerMarket
        );

        toRemove.forEach((timestamp) => {
          candleSet.delete(timestamp);
          const candleKey = `${key}-${timestamp}`;
          this.candleData.delete(candleKey);
        });

      }
    }
  }

  // 기존 메서드들 (일반 캐싱용)
  get(market, unit, to = null) {
    const key = this.getCacheKey(market, unit, to);
    const cached = this.cache.get(key);

    if (cached && this.isValid(cached, to)) {
      return cached.data;
    }

    this.cache.delete(key);
    return null;
  }

  set(market, unit, data, to = null) {
    const key = this.getCacheKey(market, unit, to);
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });

    // 일반 캐시 크기 제한
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  isValid(cached, to = null) {
    const now = Date.now();
    const age = now - cached.timestamp;
    const maxAge = to ? this.maxAge : this.cacheTimeout;
    return age < maxAge;
  }

  clear() {
    this.cache.clear();
    this.loadedCandles.clear();
    this.candleData.clear();
  }

  // 🔧 통합된 캐시 정리 메서드
  cleanupCache() {
    const now = Date.now();

    // 일반 캐시 정리
    const keysToDelete = [];
    for (const [key, item] of this.cache.entries()) {
      const isHistoryCache = key.includes("-2025-") || key.includes("T");
      const maxAge = isHistoryCache ? this.maxAge : this.cacheTimeout;

      if (now - item.timestamp > maxAge) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.cache.delete(key));

    // 캔들 데이터 정리
    const candleKeysToDelete = [];
    for (const [key, item] of this.candleData.entries()) {
      if (now - item.timestamp > this.candleMaxAge) {
        candleKeysToDelete.push(key);
      }
    }

    // 만료된 캔들 데이터 제거
    candleKeysToDelete.forEach((candleKey) => {
      this.candleData.delete(candleKey);

      // loadedCandles에서도 제거
      const [market, unit, timestamp] = candleKey.split("-");
      const mapKey = `${market}-${unit}`;
      const candleSet = this.loadedCandles.get(mapKey);
      if (candleSet) {
        candleSet.delete(parseInt(timestamp));

        // 빈 셋이면 맵에서 제거
        if (candleSet.size === 0) {
          this.loadedCandles.delete(mapKey);
        }
      }
    });

    const totalDeleted = keysToDelete.length + candleKeysToDelete.length;
    if (totalDeleted > 0) {
    }
  }

  // 🔧 상세한 캐시 통계 조회
  getStats() {
    let currentDataCount = 0;
    let historyDataCount = 0;

    for (const [key] of this.cache.entries()) {
      if (key.includes("-2025-") || key.includes("T")) {
        historyDataCount++;
      } else {
        currentDataCount++;
      }
    }

    // 캔들 캐시 통계
    const candleStats = {};
    let totalCandles = 0;

    for (const [key, candleSet] of this.loadedCandles.entries()) {
      candleStats[key] = candleSet.size;
      totalCandles += candleSet.size;
    }

    return {
      generalCache: {
        totalItems: this.cache.size,
        currentData: currentDataCount,
        historyData: historyDataCount,
      },
      candleCache: {
        totalMarkets: this.loadedCandles.size,
        totalCandles: totalCandles,
        candleDataSize: this.candleData.size,
        byMarket: candleStats,
      },
      maxSize: this.maxSize,
    };
  }

  // 🔧 디버깅용 메서드
  debugCandleCache(market, unit) {
    const key = this.getCandleMapKey(market, unit);
    const candleSet = this.loadedCandles.get(key);

    if (!candleSet) {
      return;
    }

    const timestamps = Array.from(candleSet).sort((a, b) => a - b);
    const earliest = new Date(timestamps[0] * 1000);
    const latest = new Date(timestamps[timestamps.length - 1] * 1000);

  }
}
