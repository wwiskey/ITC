const mysql = require("mysql2/promise");
const axios = require("axios");

function toInt(v, fallback) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function makePool(dbName) {
  if (!dbName) throw new Error("makePool: database name is required");

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,

    waitForConnections: true,
    connectionLimit: toInt(process.env.DB_POOL_MAX, 10),
    queueLimit: 0,

    // 문자열로 날짜 받기(타임존/직렬화 안전)
    dateStrings: true,

    // 커넥션 유지(환경에 따라 무시될 수 있음)
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });

  // 부팅 시 간단 연결 테스트 로그
  pool.query("SELECT 1").then(
    () => console.log(`[DB] connected: ${dbName}`),
    (err) =>
      console.error(`[DB] connection failed: ${dbName}`, err?.message || err)
  );

  return pool;
}

// === 풀 3개 생성 ===
// 기존 서비스용(crypto_data) - 기본 데이터
const cryptoDbName = process.env.DB_NAME || "crypto_data";
const pool = makePool(cryptoDbName);

// 거래 전용(RT_trading_db) - pending_orders, transactions 등
const tradingDbName = process.env.TRADING_DB_NAME || "RT_trading_db";
const tradingPool = makePool(tradingDbName);

// Q&A 전용(qna)
const qnaDbName = process.env.QNA_DB_NAME || "qna";
const qnaPool = makePool(qnaDbName);

// 키클락 DB 전용
const keycloakDbName = process.env.KEYCLOAK_DB_NAME || "keycloak";
const keycloakPool = makePool(keycloakDbName);

// === 유저 캐시 ===
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5분

// === 초기 잔고 설정 ===
const INITIAL_BALANCES = {
  krw_balance: 10000000,
  btc_balance: 0.0,
  eth_balance: 0.0,
  xrp_balance: 0.0,
};

function getCachedUser(keycloak_uuid) {
  const cached = userCache.get(keycloak_uuid);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.user;
  }
  return null;
}

function setCachedUser(keycloak_uuid, user) {
  userCache.set(keycloak_uuid, {
    user,
    timestamp: Date.now(),
  });
}

// === 유틸 ===
async function healthcheck(dbPool) {
  try {
    const [rows] = await dbPool.query("SELECT 1 AS ok");
    return rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}

// === 기존 함수들 (모두 기존 'pool' = crypto_data 를 사용) ===
async function testDBConnection() {
  try {
    const conn = await pool.getConnection();
    conn.release();
    console.log("MariaDB 연결 성공");
    return true;
  } catch (err) {
    console.error("MariaDB 연결 실패:", err);
    return false;
  }
}

async function findOrCreateUser(profile) {
  const { sub: keycloak_uuid, preferred_username: username } = profile;

  try {
    // 캐시에서 먼저 확인
    const cachedUser = getCachedUser(keycloak_uuid);
    if (cachedUser) {
      return cachedUser;
    }

    // INSERT ... ON DUPLICATE KEY UPDATE로 race condition 해결
    const [result] = await pool.query(
      `
      INSERT INTO users (keycloak_uuid, username, krw_balance, btc_balance, eth_balance, xrp_balance)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE username = VALUES(username)
    `,
      [
        keycloak_uuid,
        username,
        INITIAL_BALANCES.krw_balance,
        INITIAL_BALANCES.btc_balance,
        INITIAL_BALANCES.eth_balance,
        INITIAL_BALANCES.xrp_balance,
      ]
    );

    // 사용자 정보 조회 (신규든 기존이든)
    const [userRows] = await pool.query(
      "SELECT * FROM users WHERE keycloak_uuid = ?",
      [keycloak_uuid]
    );

    const user = userRows[0];

    // 캐시에 저장
    if (user) {
      setCachedUser(keycloak_uuid, user);
    }

    return user;
  } catch (error) {
    console.error("Error in findOrCreateUser:", error);
    throw error;
  }
}

async function getUserById(keycloak_uuid) {
  if (!keycloak_uuid) return null;

  try {
    // 캐시에서 먼저 확인
    const cachedUser = getCachedUser(keycloak_uuid);
    if (cachedUser) {
      return cachedUser;
    }

    const [rows] = await pool.query(
      "SELECT * FROM users WHERE keycloak_uuid = ?",
      [keycloak_uuid]
    );

    const user = rows.length > 0 ? rows[0] : null;

    // 캐시에 저장
    if (user) {
      setCachedUser(keycloak_uuid, user);
    }

    return user;
  } catch (error) {
    console.error("Error in getUserById:", error);
    throw error;
  }
}

async function requestDeletion(userId, token) {
  const expires = new Date(Date.now() + 3600 * 1000); // 1 hour
  await pool.query(
    "UPDATE users SET deletion_token = ?, deletion_token_expires_at = ? WHERE id = ?",
    [token, expires, userId]
  );
}

async function createWithdrawalReason(userId, reason) {
  await pool.query(
    "INSERT INTO withdrawal_reasons (user_id, reason) VALUES (?, ?)",
    [userId, reason]
  );
}

async function confirmDeletion(token) {
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE deletion_token = ? AND deletion_token_expires_at > NOW()",
    [token]
  );
  if (rows.length === 0) {
    return null;
  }
  const user = rows[0];
  const scheduledDate = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 days
  await pool.query(
    "UPDATE users SET status = ?, deletion_scheduled_at = ?, deletion_token = NULL, deletion_token_expires_at = NULL WHERE id = ?",
    ["deletion_scheduled", scheduledDate, user.id]
  );
  return user;
}

async function cancelDeletion(userId) {
  await pool.query(
    "UPDATE users SET status = 'active', deletion_scheduled_at = NULL, deletion_token = NULL, deletion_token_expires_at = NULL WHERE id = ?",
    [userId]
  );
}

async function findUsersToDelete() {
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE status = 'deletion_scheduled' AND deletion_scheduled_at < NOW()"
  );
  return rows;
}

async function deleteUser(userId) {
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
}

async function scheduleDeletionImmediately(userId) {
  const scheduledDate = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 days
  await pool.query(
    "UPDATE users SET status = ?, deletion_scheduled_at = ? WHERE id = ?",
    ["deletion_scheduled", scheduledDate, userId]
  );
}

// 신규: 사용자 인구통계 업데이트 (age, gender, city)
async function updateUserDemographicsIfNull(keycloak_uuid, { age, gender, city } = {}) {
  // 세 값이 모두 제공되어야 업데이트 수행
  if (age == null || gender == null || city == null) {
    return { updated: false, reason: "missing-values" };
  }
  try {
    const [rows] = await pool.query(
      "SELECT age, gender, city FROM users WHERE keycloak_uuid = ?",
      [keycloak_uuid]
    );
    if (rows.length === 0) return { updated: false, reason: "user-not-found" };

    const row = rows[0];
    if (row.age == null || row.gender == null || row.city == null) {
      await pool.query(
        "UPDATE users SET age = ?, gender = ?, city = ?, updated_at = NOW() WHERE keycloak_uuid = ?",
        [age, gender, city, keycloak_uuid]
      );
      // 캐시 갱신
      const [fresh] = await pool.query(
        "SELECT * FROM users WHERE keycloak_uuid = ?",
        [keycloak_uuid]
      );
      if (fresh[0]) setCachedUser(keycloak_uuid, fresh[0]);
      return { updated: true };
    }
    return { updated: false, reason: "already-filled" };
  } catch (err) {
    // 컬럼이 없는 경우를 대비한 안전 처리
    if (err && (err.code === "ER_BAD_FIELD_ERROR" || /Unknown column/.test(String(err.message)))) {
      console.warn("[DB] users 테이블에 age/gender/city 컬럼이 없어 인구통계 업데이트를 건너뜁니다.");
      return { updated: false, reason: "columns-missing" };
    }
    console.error("updateUserDemographicsIfNull 오류:", err);
    throw err;
  }
}

// === 내보내기 ===
// - 기존 서버 코드 호환: pool 그대로 export
// - Q&A 전용 풀 추가: qnaPool
module.exports = {
  pool, // 기존(crypto_data)
  qnaPool, // 신규(qna)
  tradingPool,
  testDBConnection,
  findOrCreateUser,
  getUserById,
  requestDeletion,
  createWithdrawalReason,
  confirmDeletion,
  cancelDeletion,
  findUsersToDelete,
  deleteUser,
  scheduleDeletionImmediately,
  // 유틸
  healthcheck,
  updateUserDemographicsIfNull,
};

// ============== 거래 관련 기능 추가 ===============

// KRW 유틸리티 함수들
const KRWUtils = {
  toInteger(amount) {
    const num = Number(amount) || 0;
    return Math.floor(Math.abs(num)) * Math.sign(num);
  },

  calculateTotal(price, quantity) {
    const total = Number(price) * Number(quantity);
    return this.toInteger(total);
  },

  parseNumber(value) {
    if (typeof value === "string") {
      return Number(value.replace(/,/g, "")) || 0;
    }
    return Number(value) || 0;
  },

  processBalance(balance) {
    return {
      ...balance,
      krw_balance: this.toInteger(balance.krw_balance),
    };
  },

  processTransaction(transaction) {
    return {
      ...transaction,
      price: this.toInteger(transaction.price),
      total_amount: this.toInteger(transaction.total_amount),
    };
  },
};

// 사용자 거래 관련 함수들
async function getUserByUsername(username) {
  try {
    const [rows] = await pool.execute(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    return rows[0]?.id || null;
  } catch (error) {
    console.error("getUserByUsername 오류:", error);
    return null;
  }
}

async function getUserBalance(username) {
  try {
    const [rows] = await pool.execute(
      `
      SELECT krw_balance, btc_balance, eth_balance, xrp_balance
      FROM users
      WHERE username = ?
    `,
      [username]
    );
    return rows[0] || null;
  } catch (error) {
    console.error("getUserBalance 오류:", error);
    return null;
  }
}

async function getUserTransactions(userId, limit = 50, offset = 0) {
  try {
    const [rows] = await tradingPool.execute(
      `
      SELECT market, side, type, price, quantity, total_amount, created_at
      FROM transactions 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `,
      [userId, parseInt(limit), parseInt(offset)]
    );
    return rows;
  } catch (error) {
    console.error("getUserTransactions 오류:", error);
    return [];
  }
}

async function getUserPendingOrders(userId) {
  try {
    const [rows] = await tradingPool.execute(
      `
      SELECT id, market, side, order_type, price, quantity, remaining_quantity, 
             total_amount, status, created_at
      FROM pending_orders 
      WHERE user_id = ? AND status IN ('pending', 'partial')
      ORDER BY created_at DESC
    `,
      [userId]
    );
    return rows;
  } catch (error) {
    console.error("getUserPendingOrders 오류:", error);
    return [];
  }
}

async function getMarketPendingOrders(market) {
  try {
    const [rows] = await tradingPool.execute(
      `
      SELECT id, user_id, market, side, order_type, price, quantity,
             remaining_quantity, total_amount, status, created_at
      FROM pending_orders
      WHERE market = ? AND status IN ('pending', 'partial') AND remaining_quantity > 0
      ORDER BY
        CASE WHEN side = 'bid' THEN price END DESC,
        CASE WHEN side = 'ask' THEN price END ASC,
        created_at ASC
    `,
      [market]
    );
    return rows;
  } catch (error) {
    console.error("getMarketPendingOrders 오류:", error);
    return [];
  }
}

// 주문 체결 트랜잭션 처리
async function executeOrderFillTransaction(
  userId,
  orderId,
  market,
  side,
  executionPrice,
  executedQuantity,
  totalAmount,
  remainingQuantity
) {
  const tradingConnection = await tradingPool.getConnection();
  const cryptoConnection = await pool.getConnection();

  try {
    await tradingConnection.beginTransaction();
    await cryptoConnection.beginTransaction();

    // 1. RT_trading_db에서 pending_orders 업데이트
    const status = remainingQuantity <= 0 ? "filled" : "partial";
    await tradingConnection.execute(
      `
      UPDATE pending_orders
      SET remaining_quantity = ?, status = ?, updated_at = NOW()
      WHERE id = ?
    `,
      [remainingQuantity, status, orderId]
    );

    // 3. crypto_data에서 잔고 업데이트 (동시성 제어)
    const coinName = market.split("-")[1].toLowerCase();

    // 🔒 사용자 잔고 락 획득
    await cryptoConnection.execute(
      `
      SELECT id FROM users WHERE id = ? FOR UPDATE
    `,
      [userId]
    );

    if (side === "bid") {
      // 매수 체결: 코인 잔고 증가
      await cryptoConnection.execute(
        `
        UPDATE users
        SET ${coinName}_balance = ${coinName}_balance + ?
        WHERE id = ?
      `,
        [executedQuantity, userId]
      );
    } else {
      // 매도 체결: KRW 잔고 증가
      await cryptoConnection.execute(
        `
        UPDATE users
        SET krw_balance = krw_balance + ?
        WHERE id = ?
      `,
        [KRWUtils.toInteger(totalAmount), userId]
      );
    }

    await tradingConnection.commit();
    await cryptoConnection.commit();
  } catch (error) {
    await tradingConnection.rollback();
    await cryptoConnection.rollback();
    console.error("주문 체결 트랜잭션 오류:", error);
    throw error;
  } finally {
    tradingConnection.release();
    cryptoConnection.release();
  }
}

// 완전체결된 주문을 transactions에 저장
async function saveCompletedOrderToTransactions(userId, orderId) {
  const connection = await tradingPool.getConnection();
  try {
    // 완전체결된 주문 정보 조회
    const [orderRows] = await connection.execute(
      `
      SELECT market, side, price, quantity, total_amount
      FROM pending_orders
      WHERE id = ? AND user_id = ? AND status = 'filled'
    `,
      [orderId, userId]
    );

    if (orderRows.length === 0) {
      console.log(`⚠️ 완전체결된 주문을 찾을 수 없음: ID ${orderId}`);
      return;
    }

    const order = orderRows[0];

    // 🔧 중복 저장 방지: 이미 저장된 거래인지 확인
    const [existingRows] = await connection.execute(
      `
      SELECT id FROM transactions
      WHERE user_id = ? AND market = ? AND side = ?
        AND price = ? AND quantity = ?
        AND ABS(TIMESTAMPDIFF(SECOND, created_at, NOW())) <= 10
    `,
      [userId, order.market, order.side, order.price, order.quantity]
    );

    if (existingRows.length > 0) {
      console.log(`✅ 이미 저장된 거래 건너뜀: 주문ID ${orderId}`);
      return;
    }

    await connection.execute(
      `
      INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'limit', NOW())
    `,
      [
        userId,
        order.market,
        order.side,
        order.price,
        order.quantity,
        order.total_amount,
      ]
    );
  } catch (error) {
    console.error(`❌ 완전체결 주문 저장 실패 - 주문ID: ${orderId}:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

// 사용자 잔고 조정 (환불 등)
async function adjustUserBalance(userId, balanceType, amount) {
  const connection = await pool.getConnection();
  try {
    const adjustedAmount =
      balanceType === "krw_balance" ? KRWUtils.toInteger(amount) : amount;

    await connection.execute(
      `
      UPDATE users
      SET ${balanceType} = ${balanceType} + ?
      WHERE id = ?
    `,
      [adjustedAmount, userId]
    );

    // 잔고 조정 완료
  } catch (error) {
    console.error("잔고 조정 오류:", error);
    throw error;
  } finally {
    connection.release();
  }
}

async function createPendingOrder(
  userId,
  market,
  side,
  price,
  quantity,
  totalAmount,
  type
) {
  const connection = await tradingPool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `
      INSERT INTO pending_orders 
      (user_id, market, side, order_type, price, quantity, remaining_quantity, total_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        userId,
        market,
        side,
        type,
        KRWUtils.toInteger(price),
        quantity,
        quantity,
        KRWUtils.toInteger(totalAmount),
      ]
    );

    await connection.commit();
    console.log(
      `📝 지정가 주문 등록: ${market} ${side} ${KRWUtils.toInteger(
        price
      ).toLocaleString()}원 ${quantity}개`
    );

    return {
      orderId: result.insertId,
      status: "pending",
      message: "지정가 주문이 등록되었습니다.",
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cancelPendingOrder(userId, orderId) {
  const tradingConnection = await tradingPool.getConnection();
  const cryptoConnection = await pool.getConnection();

  try {
    await tradingConnection.beginTransaction();
    await cryptoConnection.beginTransaction();

    // 1. 주문 정보 조회 (RT_trading_db에서)
    const [orderRows] = await tradingConnection.execute(
      `
      SELECT market, side, price, quantity, remaining_quantity, total_amount, status
      FROM pending_orders
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'partial') FOR UPDATE
    `,
      [orderId, userId]
    );

    if (orderRows.length === 0) {
      throw new Error("취소할 수 있는 주문을 찾을 수 없습니다.");
    }

    const order = orderRows[0];

    // 2. 주문 상태 업데이트 (RT_trading_db에서)
    await tradingConnection.execute(
      `
      UPDATE pending_orders
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'partial')
    `,
      [orderId, userId]
    );

    // 3. 부분체결된 주문인 경우 지금까지 체결된 부분을 transactions에 저장
    if (order.status === "partial") {
      const executedQuantity = order.quantity - order.remaining_quantity;
      const executedAmount = KRWUtils.calculateTotal(
        order.price,
        executedQuantity
      );

      // 🔧 중복 저장 방지: 이미 저장된 거래인지 확인 (부분체결)
      const [existingRows] = await tradingConnection.execute(
        `
        SELECT id FROM transactions
        WHERE user_id = ? AND market = ? AND side = ?
          AND price = ? AND quantity = ?
          AND ABS(TIMESTAMPDIFF(SECOND, created_at, NOW())) <= 10
      `,
        [userId, order.market, order.side, order.price, executedQuantity]
      );

      if (existingRows.length === 0) {
        await tradingConnection.execute(
          `
          INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'limit', NOW())
        `,
          [
            userId,
            order.market,
            order.side,
            order.price,
            executedQuantity,
            executedAmount,
          ]
        );
        console.log(`✅ 부분체결 거래 저장: 주문ID ${orderId}, 실행수량 ${executedQuantity}`);
      } else {
        console.log(`✅ 이미 저장된 부분체결 거래 건너뜀: 주문ID ${orderId}`);
      }
    }

    // 4. 잔고 복구 (crypto_data에서)
    if (order.side === "bid") {
      // 매수 주문 취소: KRW 잔고 복구
      // 🔧 부분체결인 경우 남은 비율만큼만 복구
      let refundAmount;
      if (order.status === "partial") {
        const remainingRatio = order.remaining_quantity / order.quantity;
        refundAmount = Math.floor(order.total_amount * remainingRatio);
      } else {
        refundAmount = order.total_amount;
      }

      await cryptoConnection.execute(
        `
        UPDATE users
        SET krw_balance = krw_balance + ?
        WHERE id = ?
      `,
        [refundAmount, userId]
      );
    } else if (order.side === "ask") {
      // 매도 주문 취소: 코인 잔고 복구
      const coinName = order.market.split("-")[1].toLowerCase();

      await cryptoConnection.execute(
        `
        UPDATE users
        SET ${coinName}_balance = ${coinName}_balance + ?
        WHERE id = ?
      `,
        [order.remaining_quantity, userId]
      );
    }

    await tradingConnection.commit();
    await cryptoConnection.commit();

    return { message: "주문이 성공적으로 취소되었습니다." };
  } catch (error) {
    await tradingConnection.rollback();
    await cryptoConnection.rollback();
    console.error("주문 취소 처리 오류:", error);
    throw error;
  } finally {
    tradingConnection.release();
    cryptoConnection.release();
  }
}

/**
 * MySQL GET_LOCK을 이용한 분산 락 획득
 * @param {string} lockName - 락 이름
 * @param {number} timeout - 타임아웃 (초)
 * @param {object} connection - DB 연결 (선택사항)
 * @returns {boolean} - 락 획득 성공 여부
 */
async function acquireDistributedLock(lockName, timeout = 10, connection = null) {
  const conn = connection || tradingPool;

  try {
    const [result] = await conn.execute(
      'SELECT GET_LOCK(?, ?) as lock_result',
      [lockName, timeout]
    );

    const lockResult = result[0].lock_result;

    if (lockResult === 1) {
      // 성공한 락 획득은 로그 생략 (너무 빈번함)
      return true;
    } else if (lockResult === 0) {
      // 타임아웃은 정상 상황이므로 로그 생략
      return false;
    } else {
      console.error(`❌ 분산 락 오류: ${lockName}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ 분산 락 획득 실패: ${lockName}`, error);
    return false;
  }
}

/**
 * MySQL RELEASE_LOCK을 이용한 분산 락 해제
 * @param {string} lockName - 락 이름
 * @param {object} connection - DB 연결 (선택사항)
 * @returns {boolean} - 락 해제 성공 여부
 */
async function releaseDistributedLock(lockName, connection = null) {
  const conn = connection || tradingPool;

  try {
    const [result] = await conn.execute(
      'SELECT RELEASE_LOCK(?) as release_result',
      [lockName]
    );

    const releaseResult = result[0].release_result;

    if (releaseResult === 1) {
      // 성공한 락 해제는 로그 생략 (너무 빈번함)
      return true;
    } else if (releaseResult === 0) {
      // 이미 해제된 경우는 로그 생략 (정상 상황)
      return false;
    } else {
      console.error(`❌ 분산 락 해제 오류: ${lockName}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ 분산 락 해제 실패: ${lockName}`, error);
    return false;
  }
}

/**
 * 특정 마켓의 대기주문 개수만 빠르게 확인 (성능 최적화용)
 * @param {string} market - 마켓 코드 (예: KRW-BTC)
 * @returns {number} - 대기주문 개수
 */
async function getMarketPendingOrdersCount(market) {
  try {
    const [rows] = await tradingPool.execute(
      `
      SELECT COUNT(*) as count
      FROM pending_orders
      WHERE market = ? AND status IN ('pending', 'partial') AND remaining_quantity > 0
    `,
      [market]
    );
    return rows[0]?.count || 0;
  } catch (error) {
    console.error(`❌ 대기주문 개수 조회 실패: ${market}`, error);
    return 0;
  }
}

async function executeTradeTransaction(
  userId,
  market,
  side,
  finalPrice,
  finalQuantity,
  totalAmount,
  type
) {
  const connection = await tradingPool.getConnection();
  try {
    await connection.beginTransaction();

    const coinName = market.split("-")[1].toLowerCase();

    if (side === "bid") {
      await processBuyOrder(
        connection,
        userId,
        coinName,
        totalAmount,
        finalQuantity
      );
    } else {
      await processSellOrder(
        connection,
        userId,
        coinName,
        finalQuantity,
        totalAmount
      );
    }

    await connection.execute(
      `
      INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        userId,
        market,
        side,
        KRWUtils.toInteger(finalPrice),
        finalQuantity,
        KRWUtils.toInteger(totalAmount),
        type,
      ]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function processBuyOrder(
  connection,
  userId,
  coinName,
  totalAmount,
  finalQuantity
) {
  // crypto_data에서 잔고 확인 (pool 사용)
  const poolConnection = await pool.getConnection();
  try {
    const [balanceRows] = await poolConnection.execute(
      `
      SELECT krw_balance
      FROM users WHERE id = ? FOR UPDATE
    `,
      [userId]
    );

    const currentBalance = KRWUtils.toInteger(balanceRows[0]?.krw_balance || 0);
    const requiredAmount = KRWUtils.toInteger(totalAmount);

    // 시장가 매수 잔고 확인

    if (currentBalance < requiredAmount) {
      throw new Error(
        `잔액이 부족합니다. 현재 잔고: ${currentBalance.toLocaleString()}원, 필요 금액: ${requiredAmount.toLocaleString()}원`
      );
    }

    const newKrwBalance = currentBalance - requiredAmount;

    // crypto_data에서 잔고 차감
    await poolConnection.execute(
      `
      UPDATE users SET krw_balance = ? WHERE id = ?
    `,
      [newKrwBalance, userId]
    );
  } finally {
    poolConnection.release();
  }

  // crypto_data에서 코인 잔고 증가
  const cryptoConnection = await pool.getConnection();
  try {
    await cryptoConnection.execute(
      `
      UPDATE users
      SET ${coinName}_balance = ${coinName}_balance + ?
      WHERE id = ?
    `,
      [finalQuantity, userId]
    );
  } finally {
    cryptoConnection.release();
  }
}

async function processSellOrder(
  connection,
  userId,
  coinName,
  finalQuantity,
  totalAmount
) {
  // crypto_data에서 잔고 확인 및 업데이트
  const poolConnection = await pool.getConnection();
  try {
    const [balanceRows] = await poolConnection.execute(
      `
      SELECT ${coinName}_balance, krw_balance
      FROM users WHERE id = ? FOR UPDATE
    `,
      [userId]
    );

    const currentCoinBalance = balanceRows[0]?.[`${coinName}_balance`] || 0;
    const currentKrwBalance = KRWUtils.toInteger(
      balanceRows[0]?.krw_balance || 0
    );

    // 시장가 매도 잔고 확인

    if (currentCoinBalance < finalQuantity) {
      throw new Error(
        `보유 코인이 부족합니다. 현재 잔고: ${currentCoinBalance}개, 매도 수량: ${finalQuantity}개`
      );
    }

    const addAmount = KRWUtils.toInteger(totalAmount);
    const newKrwBalance = currentKrwBalance + addAmount;

    // crypto_data에서 잔고 업데이트
    await poolConnection.execute(
      `
      UPDATE users
      SET krw_balance = ?,
          ${coinName}_balance = ${coinName}_balance - ?
      WHERE id = ?
    `,
      [newKrwBalance, finalQuantity, userId]
    );
  } finally {
    poolConnection.release();
  }
}

// ============== 키클락 동기화 함수 추가 ===============

// 키클락 USER_ENTITY에서 사용자 정보 가져오기 (API 기반으로 변경)
async function getKeycloakUsers() {
  try {
    // 1. Keycloak Admin API 토큰 획득
    const tokenParams = new URLSearchParams();
    tokenParams.append("client_id", process.env.KEYCLOAK_ADMIN_CLIENT_ID);
    tokenParams.append("client_secret", process.env.KEYCLOAK_ADMIN_CLIENT_SECRET);
    tokenParams.append("grant_type", "client_credentials");

    const keycloakServerUrl = process.env.KEYCLOAK_SERVER_URL;
    const realmName = process.env.KEYCLOAK_REALM || 'itc';

    if (!keycloakServerUrl || !process.env.KEYCLOAK_ADMIN_CLIENT_ID || !process.env.KEYCLOAK_ADMIN_CLIENT_SECRET) {
      throw new Error("Keycloak Admin API 접속을 위한 환경변수가 설정되지 않았습니다.");
    }

    const { data: tokenData } = await axios.post(
      `${keycloakServerUrl}/realms/${realmName}/protocol/openid-connect/token`,
      tokenParams
    );
    const adminToken = tokenData.access_token;

    // 2. Admin API를 통해 사용자 목록 조회
    const { data: users } = await axios.get(
      `${keycloakServerUrl}/admin/realms/${realmName}/users`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        params: { max: 2000 } // 최대 2000명까지 조회, 그 이상일 경우 페이지네이션 필요
      }
    );

    // 3. API 응답을 기존 DB 쿼리 응답 형식과 유사하게 변환
    return users
      .filter(u => !(u.username || '').startsWith('service-account'))
      .map(u => ({
        ID: u.id,
        USERNAME: u.username,
        EMAIL: u.email,
        ENABLED: u.enabled,
        CREATED_TIMESTAMP: u.createdTimestamp
      }));

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error("Keycloak Admin API를 통한 사용자 조회 오류:", errorMessage);
    return []; // 오류 발생 시 빈 배열 반환
  }
}

// crypto_data.users 테이블에서 기존 키클락 사용자 확인
async function getExistingKeycloakUsers() {
  try {
    const [rows] = await pool.execute(`
      SELECT keycloak_uuid, username
      FROM users
      WHERE keycloak_uuid IS NOT NULL
    `);
    return new Set(rows.map((row) => row.keycloak_uuid));
  } catch (error) {
    console.error("기존 키클락 사용자 조회 오류:", error);
    return new Set();
  }
}

// 키클락 사용자를 crypto_data.users에 동기화
async function syncKeycloakUsers() {
  try {
    console.log("🔄 키클락 사용자 동기화 시작...");

    const keycloakUsers = await getKeycloakUsers();
    const existingUsers = await getExistingKeycloakUsers();

    console.log(`[SYNC DEBUG] Keycloak DB에서 ${keycloakUsers.length}명의 사용자를 찾았습니다.`);
    console.log(`[SYNC DEBUG] 로컬 DB에서 ${existingUsers.size}명의 사용자를 찾았습니다.`);

    let syncCount = 0;
    let updateCount = 0;
    let deactivateCount = 0;

    // 키클락 활성 사용자 처리
    for (const kcUser of keycloakUsers) {
      const isEnabled = kcUser.ENABLED === 1 || kcUser.ENABLED === true;

      if (existingUsers.has(kcUser.ID)) {
        // 기존 사용자 상태 동기화
        try {
          await pool.execute(
            `
            UPDATE users
            SET username = ?,
                status = ?,
                updated_at = NOW()
            WHERE keycloak_uuid = ?
          `,
            [kcUser.USERNAME, isEnabled ? "active" : "disabled", kcUser.ID]
          );

          updateCount++;
          console.log(
            `🔄 사용자 상태 동기화: ${kcUser.USERNAME} (${
              isEnabled ? "활성" : "비활성"
            })`
          );
        } catch (updateError) {
          console.error(
            `❌ 사용자 상태 동기화 실패: ${kcUser.USERNAME}`,
            updateError.message
          );
        }
        continue;
      }

      // 활성화된 새 사용자만 생성
      if (isEnabled) {
        try {
          const [result] = await pool.execute(
            `
            INSERT INTO users (keycloak_uuid, username, created_at, krw_balance, btc_balance, eth_balance, xrp_balance, status)
            VALUES (?, ?, NOW(), ?, ?, ?, ?, 'active')
            ON DUPLICATE KEY UPDATE
              username = VALUES(username),
              status = VALUES(status),
              updated_at = NOW()
          `,
            [
              kcUser.ID,
              kcUser.USERNAME,
              INITIAL_BALANCES.krw_balance,
              INITIAL_BALANCES.btc_balance,
              INITIAL_BALANCES.eth_balance,
              INITIAL_BALANCES.xrp_balance,
            ]
          );

          if (result.affectedRows === 1) {
            syncCount++;
            console.log(
              `✅ 새 사용자 동기화: ${kcUser.USERNAME} (${kcUser.ID})`
            );
          }
        } catch (insertError) {
          console.error(
            `❌ 사용자 동기화 실패: ${kcUser.USERNAME}`,
            insertError.message
          );
        }
      }
    }

    // 키클락에서 삭제된 사용자 비활성화
    const keycloakUserIds = new Set(keycloakUsers.map((u) => u.ID));
    const usersToDisable = [];
    for (const existingUuid of existingUsers) {
      if (!keycloakUserIds.has(existingUuid)) {
        usersToDisable.push(existingUuid);
        try {
          await pool.execute(
            `
            UPDATE users
            SET status = 'disabled', updated_at = NOW()
            WHERE keycloak_uuid = ? AND status != 'disabled'
          `,
            [existingUuid]
          );

          deactivateCount++;
          console.log(
            `⚠️ 사용자 비활성화: ${existingUuid} (키클락에서 삭제됨)`
          );
        } catch (deactivateError) {
          console.error(
            `❌ 사용자 비활성화 실패: ${existingUuid}`,
            deactivateError.message
          );
        }
      }
    }
    if (usersToDisable.length > 0) {
      console.log(`[SYNC DEBUG] 비활성화 될 사용자 목록: ${JSON.stringify(usersToDisable)}`);
    }

    console.log(
      `🎉 키클락 동기화 완료: 신규 ${syncCount}명, 업데이트 ${updateCount}명, 비활성화 ${deactivateCount}명`
    );
    return { syncCount, updateCount, deactivateCount };
  } catch (error) {
    console.error("키클락 동기화 오류:", error);
    throw error;
  }
}

// 거래 관련 함수들을 exports에 추가
module.exports = {
  ...module.exports, // 기존 exports 유지

  // DB 풀들
  pool, // crypto_data (기본)
  tradingPool, // RT_trading_db (거래 전용)
  qnaPool, // qna (Q&A 전용)
  keycloakPool, // keycloak (키클락 전용)

  // 거래 관련 함수들 추가
  KRWUtils,
  getUserByUsername,
  getUserBalance,
  getUserTransactions,
  getUserPendingOrders,
  getMarketPendingOrders,
  createPendingOrder,
  cancelPendingOrder,
  executeTradeTransaction,
  processBuyOrder,
  processSellOrder,

  // 키클락 동기화 함수들
  getKeycloakUsers,
  getExistingKeycloakUsers,
  syncKeycloakUsers,

  // 주문 매칭 관련 함수들
  executeOrderFillTransaction,
  saveCompletedOrderToTransactions,
  adjustUserBalance,

  // KRWUtils 추가
  KRWUtils,

  // 분산 락 함수들
  acquireDistributedLock,
  releaseDistributedLock,

  // 성능 최적화 함수들
  getMarketPendingOrdersCount,
};
