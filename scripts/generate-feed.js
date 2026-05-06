/**
 * Wisdom Guild フィード生成スクリプト（Bulk Operation API 版）
 *
 * Shopify Admin API の Bulk Operation で全商品データを JSONL として一括取得し、
 * Wisdom Guild 形式のテキストファイルを生成する。
 *
 * 出力フォーマット（1行 = 1バリエーション）:
 *   商品ID<>商品名 [カテゴリ名]<>商品コード<>販売価格<>在庫数<>更新日時
 *
 * 通常 GraphQL の pagination は 25,000 オブジェクト上限があるため、
 * 大規模ストア（数万件以上）では Bulk Operation が事実上必須。
 */

import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "output");
const OUTPUT_FILE = join(OUTPUT_DIR, "wisdom_guild_products.txt");
const TMP_FILE = join(OUTPUT_DIR, "wisdom_guild_products.txt.tmp");

// --- 設定 ---

const SHOPIFY_STORE_URL = normalizeStoreUrl(requiredEnv("SHOPIFY_STORE_URL"));
const SHOPIFY_ACCESS_TOKEN = requiredEnv("SHOPIFY_ACCESS_TOKEN");

// 対象商品フィルタ用メタフィールド（既定: custom.wisdomguild = true）
const FILTER_METAFIELD_NAMESPACE = validateMetafieldIdentifier(
  "FILTER_METAFIELD_NAMESPACE",
  process.env.FILTER_METAFIELD_NAMESPACE || "custom"
);
const FILTER_METAFIELD_KEY = validateMetafieldIdentifier(
  "FILTER_METAFIELD_KEY",
  process.env.FILTER_METAFIELD_KEY || "wisdomguild"
);

// 商品コードのソース:
//   - "variant_sku" (default): variant.sku を商品コードとして出力
//   - "product_metafield":     商品メタフィールド値を商品コードとして出力（同一商品の全行で同値）
const ITEMCODE_SOURCE = process.env.ITEMCODE_SOURCE || "variant_sku";
const ITEMCODE_METAFIELD_NAMESPACE = validateMetafieldIdentifier(
  "ITEMCODE_METAFIELD_NAMESPACE",
  process.env.ITEMCODE_METAFIELD_NAMESPACE || "custom"
);
const ITEMCODE_METAFIELD_KEY = validateMetafieldIdentifier(
  "ITEMCODE_METAFIELD_KEY",
  process.env.ITEMCODE_METAFIELD_KEY || "itemcode"
);

// 販売可能性の厳密フィルタ（既定: 無効）
//   true:  inventoryItem.tracked && availableForSale の両方を要求
//   false: inventoryItem.tracked のみで判定（在庫0でもバックオーダー無効でも出力）
// 元バッチは ProductClass.isVisible() のみで在庫0行も出力していたため、既定は false。
// 「Wisdom Guild には販売可能なものだけを渡す」運用に切り替えるなら true にする。
const STRICT_AVAILABILITY = process.env.STRICT_AVAILABILITY === "true";

// Shopify Admin API のバージョン。
// Shopify は四半期ごとに API バージョンをリリースし、約 12ヶ月後にサポート終了する。
// 年 1 回程度はリリースカレンダーを確認し、本定数の値を更新する運用が必要。
//   https://shopify.dev/docs/api/usage/versioning
const SHOPIFY_API_VERSION = "2025-01";
const GRAPHQL_ENDPOINT = `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// リトライ設定
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;

// Bulk Operation のポーリング間隔
const BULK_POLL_INTERVAL_MS = 10000;
// Bulk Operation のタイムアウト（既定 60 分）
const BULK_TIMEOUT_MS = Number(process.env.BULK_TIMEOUT_MS) || 60 * 60 * 1000;

// --- Bulk Operation クエリ ---
// 注意:
//   - Bulk クエリでは first/last/after/before/sortKey などの connection arg は使用不可
//   - ネストしたコネクション（variants など）は別行で出力され __parentId で紐づく
//   - スカラ型のリスト（selectedOptions）はバリアント行内に inline で含まれる
//   - 文字列リテラルへの埋め込みは JSON.stringify を経由してエスケープ漏れを防ぐ
//     （namespace/key は startup で validate 済みだが defense-in-depth）

const BULK_QUERY = `
  {
    products(query: ${JSON.stringify(buildBulkProductFilter())}) {
      edges {
        node {
          id
          title
          updatedAt
          itemCodeMetafield: metafield(namespace: ${JSON.stringify(ITEMCODE_METAFIELD_NAMESPACE)}, key: ${JSON.stringify(ITEMCODE_METAFIELD_KEY)}) {
            value
          }
          variants {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                availableForSale
                inventoryItem {
                  tracked
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const BULK_RUN_MUTATION = `
  mutation BulkRun($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const CURRENT_BULK_OPERATION_QUERY = `
  {
    currentBulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
    }
  }
`;

// --- メイン処理 ---

async function main() {
  console.log("[INFO] Wisdom Guild フィード生成（Bulk Operation 版）を開始します");
  console.log(`[INFO] ITEMCODE_SOURCE: ${ITEMCODE_SOURCE}`);
  console.log(`[INFO] フィルタ: ${buildBulkProductFilter()}`);

  const operation = await startBulkOperation();
  console.log(`[INFO] Bulk Operation 開始: ${operation.id}`);

  const completed = await pollBulkOperation(operation.id);
  console.log(
    `[INFO] Bulk Operation 完了: objectCount=${completed.objectCount}, fileSize=${completed.fileSize}`
  );

  if (!completed.url) {
    console.error("[ERROR] Bulk Operation の url が空（対象商品 0 件の可能性）");
    process.exit(1);
  }

  const products = await downloadAndParseJsonl(completed.url);
  console.log(`[INFO] 取得商品数: ${products.length}`);

  if (products.length === 0) {
    console.error("[ERROR] 対象商品が見つかりません");
    process.exit(1);
  }

  // 元仕様の update_date DESC と整合させる（Bulk はソート不可のためメモリ上でソート）。
  // updatedAt が不正な商品は末尾に固定し、警告ログを出す。
  // 不正件数は sort 比較関数では正しく数えられないため、事前に Date.parse の結果をキャッシュする。
  const productSortKeys = products.map((p) => Date.parse(p.updatedAt));
  const invalidDateCount = productSortKeys.filter((t) => Number.isNaN(t)).length;
  if (invalidDateCount > 0) {
    console.warn(
      `[WARN] updatedAt が不正な商品が ${invalidDateCount} 件ありました（末尾固定）`
    );
  }
  const productsWithKey = products.map((p, i) => ({ p, t: productSortKeys[i] }));
  productsWithKey.sort((a, b) => {
    const aInvalid = Number.isNaN(a.t);
    const bInvalid = Number.isNaN(b.t);
    if (aInvalid && bInvalid) return 0;
    if (aInvalid) return 1;
    if (bInvalid) return -1;
    return b.t - a.t;
  });
  const sortedProducts = productsWithKey.map((x) => x.p);

  const lines = generateFeedLines(sortedProducts);
  console.log(`[INFO] 出力行数（バリエーション数）: ${lines.length}`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(TMP_FILE, lines.join("\n") + "\n", "utf-8");
  renameSync(TMP_FILE, OUTPUT_FILE);

  console.log(`[INFO] フィード生成完了: ${OUTPUT_FILE}`);
}

// --- Bulk Operation 制御 ---

function buildBulkProductFilter() {
  // 注意: Bulk クエリ内で文字列リテラルとして埋め込むため、
  // namespace / key にダブルクォートが含まれないことを確認しておく。
  return `status:active AND metafields.${FILTER_METAFIELD_NAMESPACE}.${FILTER_METAFIELD_KEY}:true`;
}

async function startBulkOperation() {
  const result = await runBulkOperationRunQuery();
  const userErrors = result.userErrors ?? [];

  if (userErrors.length > 0) {
    const inProgress = userErrors.some(
      (e) => e.code === "OPERATION_IN_PROGRESS"
    );
    if (inProgress) {
      console.warn("[WARN] 既存の Bulk Operation が実行中。完了を待機して再試行します");
      // 既存 op の id は不明なので expectedId なしでポーリング
      await pollBulkOperation(null);
      const retry = await runBulkOperationRunQuery();
      if ((retry.userErrors ?? []).length > 0) {
        throw new Error(
          `bulkOperationRunQuery failed after wait: ${JSON.stringify(retry.userErrors)}`
        );
      }
      return retry.bulkOperation;
    }
    throw new Error(`bulkOperationRunQuery failed: ${JSON.stringify(userErrors)}`);
  }

  return result.bulkOperation;
}

async function runBulkOperationRunQuery() {
  const data = await shopifyGraphQL(BULK_RUN_MUTATION, { query: BULK_QUERY });
  return data.bulkOperationRunQuery;
}

async function pollBulkOperation(expectedId) {
  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > BULK_TIMEOUT_MS) {
      throw new Error(
        `Bulk Operation が ${Math.floor(BULK_TIMEOUT_MS / 1000)}s 以内に完了しませんでした`
      );
    }

    const data = await shopifyGraphQL(CURRENT_BULK_OPERATION_QUERY, {});
    const op = data.currentBulkOperation;
    if (!op) {
      throw new Error("currentBulkOperation が null です");
    }

    if (expectedId && op.id !== expectedId) {
      throw new Error(
        `currentBulkOperation.id ${op.id} が期待値 ${expectedId} と一致しません。別の Bulk Operation が割り込んだ可能性があります`
      );
    }

    console.log(
      `[INFO] Bulk Operation status: ${op.status} (objects: ${op.objectCount ?? 0})`
    );

    switch (op.status) {
      case "COMPLETED":
        return op;
      case "FAILED":
      case "CANCELED":
      case "EXPIRED":
        throw new Error(
          `Bulk Operation ${op.status}: errorCode=${op.errorCode ?? "(none)"}`
        );
      case "CREATED":
      case "RUNNING":
      case "CANCELING":
        await sleep(BULK_POLL_INTERVAL_MS);
        break;
      default:
        await sleep(BULK_POLL_INTERVAL_MS);
    }
  }
}

// --- JSONL ダウンロードとパース ---

async function downloadAndParseJsonl(url) {
  console.log(`[INFO] JSONL をダウンロード中: ${safeUrl(url)}`);
  // Bulk の url は GCS 等の署名付きで、Shopify 認証ヘッダは不要（むしろ付けると失敗する）
  const response = await fetchWithRetry(url, { method: "GET" });

  if (!response.body) {
    throw new Error("レスポンスボディが取得できませんでした");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // 親が後続行に来るケースは Bulk の出力仕様上想定されないが、防御的に
  // バリアントを一時バッファに退避してから親に紐づける。
  const products = new Map();
  const orphanVariants = [];

  let processedLines = 0;
  let parseErrors = 0;

  const processLine = (line) => {
    if (line.length === 0) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      parseErrors++;
      // 行頭だけログに出して全文ログ汚染を避ける
      const head = line.slice(0, 80).replace(/\s+/g, " ");
      console.warn(
        `[WARN] JSONL パース失敗 (#${parseErrors}): ${err.message} -- "${head}..."`
      );
      return;
    }

    if (obj.__parentId) {
      // バリアント行
      const parent = products.get(obj.__parentId);
      if (parent) {
        parent.variants.push(toVariant(obj));
      } else {
        orphanVariants.push(obj);
      }
    } else if (obj.id?.includes("/Product/")) {
      // 商品行
      products.set(obj.id, {
        id: obj.id,
        title: obj.title,
        updatedAt: obj.updatedAt,
        itemCodeMetafield: obj.itemCodeMetafield ?? null,
        variants: [],
      });
    }
    // それ以外（例: 子コネクションが将来増えた場合）は無視
    processedLines++;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
    }
  }
  // 残りバッファ（末尾改行なしのケース）
  if (buffer.trim().length > 0) {
    processLine(buffer.trim());
  }

  // orphan を再紐づけ（親が後ろに来た場合に備える）
  let unresolvedOrphans = 0;
  for (const v of orphanVariants) {
    const parent = products.get(v.__parentId);
    if (parent) {
      parent.variants.push(toVariant(v));
    } else {
      unresolvedOrphans++;
    }
  }

  console.log(`[INFO] JSONL 処理行数: ${processedLines}`);

  // 不整合は黙って公開せず失敗扱いにする（壊れたフィードを成功扱いにしない）
  if (parseErrors > 0) {
    throw new Error(
      `JSONL parse error が ${parseErrors} 件発生しました（フィード生成を中止）`
    );
  }
  if (unresolvedOrphans > 0) {
    throw new Error(
      `親商品が見つからない variant が ${unresolvedOrphans} 件あります（フィード生成を中止）`
    );
  }

  return Array.from(products.values());
}

function toVariant(obj) {
  return {
    id: obj.id,
    title: obj.title,
    sku: obj.sku,
    price: obj.price,
    inventoryQuantity: obj.inventoryQuantity,
    availableForSale: obj.availableForSale,
    inventoryItem: obj.inventoryItem ?? null,
    selectedOptions: obj.selectedOptions ?? [],
  };
}

// --- フィード生成 ---

function generateFeedLines(products) {
  const lines = [];

  for (const product of products) {
    const productId = extractNumericId(product.id);
    const updatedAt = formatDate(product.updatedAt);
    const productMetafieldItemCode = product.itemCodeMetafield?.value ?? "";

    for (const variant of product.variants) {
      // EC-CUBE の ProductClass.isVisible() 相当の代替フィルタ:
      //   - inventoryItem.tracked === true: 在庫追跡 OFF のバリアントを除外（既定）
      //   - availableForSale === true:      販売可能なバリアントのみ（STRICT_AVAILABILITY=true 時）
      // 元バッチは isVisible() のみで在庫0行も出力していたため availableForSale は opt-in。
      // 在庫切れ行も Wisdom Guild に渡したい運用が既定。
      if (variant.inventoryItem?.tracked !== true) continue;
      if (STRICT_AVAILABILITY && variant.availableForSale !== true) continue;

      const name = sanitizeField(buildProductName(product.title, variant));
      const itemCode = sanitizeField(
        ITEMCODE_SOURCE === "product_metafield"
          ? productMetafieldItemCode
          : variant.sku ?? ""
      );
      const price = Math.floor(Number(variant.price));
      const stock = variant.inventoryQuantity ?? 0;

      lines.push(
        [productId, name, itemCode, price, stock, updatedAt].join("<>")
      );
    }
  }

  return lines;
}

function buildProductName(title, variant) {
  // バリエーションが "Default Title" の場合はカテゴリなし
  if (
    variant.title === "Default Title" ||
    variant.selectedOptions.length === 0
  ) {
    return title;
  }

  // selectedOptions の value を結合してカテゴリ名とする
  const optionValues = variant.selectedOptions
    .map((opt) => opt.value)
    .filter((v) => v !== "Default Title");

  if (optionValues.length === 0) return title;

  return `${title} [${optionValues.join(" / ")}]`;
}

function extractNumericId(gid) {
  // "gid://shopify/Product/1234567890" → "1234567890"
  const match = gid.match(/\/(\d+)$/);
  return match ? match[1] : gid;
}

function formatDate(isoDate) {
  const d = new Date(isoDate);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

// --- Shopify GraphQL（リトライ・スロットリング対応） ---

async function shopifyGraphQL(query, variables, attempt = 0) {
  const response = await fetchWithRetry(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  // GraphQL THROTTLED は指数バックオフで再実行（HTTP 200 で返ってくる）
  if (json.errors) {
    const isThrottled = json.errors.some(
      (e) => e.extensions?.code === "THROTTLED"
    );
    if (isThrottled && attempt < MAX_RETRIES) {
      const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
      console.warn(
        `[WARN] GraphQL THROTTLED — ${delay}ms 後にリトライ (${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(delay);
      return shopifyGraphQL(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }

  // 成功時のスロットルウォッチ（次リクエスト前に余裕を確保）
  if (json.extensions?.cost) {
    const { currentlyAvailable, restoreRate } =
      json.extensions.cost.throttleStatus;
    if (currentlyAvailable < 100) {
      const waitMs =
        Math.ceil((100 - currentlyAvailable) / restoreRate) * 1000;
      console.log(
        `[INFO] レートリミット残り ${currentlyAvailable} — ${waitMs}ms 待機`
      );
      await sleep(waitMs);
    }
  }

  return json.data;
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      // 429 / 5xx は指数バックオフでリトライ
      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = parseRetryAfter(
          response.headers.get("Retry-After")
        );
        const delay = retryAfterMs ?? BASE_RETRY_DELAY_MS * 2 ** attempt;
        console.warn(
          `[WARN] HTTP ${response.status} — ${delay}ms 後にリトライ (${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        // Bulk JSONL 用の署名付き URL は query string に一時認可情報を含むため、
        // ログ・例外メッセージには含めず origin+pathname だけを残す。
        throw new Error(
          `HTTP error: ${response.status} ${response.statusText} (${safeUrl(url)})`
        );
      }

      return response;
    } catch (err) {
      // ネットワーク失敗は指数バックオフでリトライ
      lastError = err;
      const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
      console.warn(
        `[WARN] ネットワーク失敗: ${err.message} — ${delay}ms 後にリトライ (${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(delay);
    }
  }
  throw lastError ?? new Error(`HTTP リトライ ${MAX_RETRIES} 回失敗 (${url})`);
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// --- ユーティリティ ---

function sanitizeField(value) {
  // 区切り文字 "<>" や改行が含まれると列崩れ・行注入の原因になるため空白に置換
  if (value == null) return "";
  return String(value)
    .replace(/<>/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStoreUrl(url) {
  // "https://your-store.myshopify.com/" → "your-store.myshopify.com"
  let normalized = url.trim();
  normalized = normalized.replace(/^https?:\/\//i, "");
  normalized = normalized.replace(/\/+$/, "");
  if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(normalized)) {
    console.warn(
      `[WARN] SHOPIFY_STORE_URL の形式が想定外です: "${normalized}"。期待形式: "your-store.myshopify.com"`
    );
  }
  return normalized;
}

function validateMetafieldIdentifier(name, value) {
  // Shopify のメタフィールド namespace/key は [A-Za-z0-9_-] の範囲に限定。
  // GraphQL 文字列リテラルへの埋め込みを安全にするため、起動時に検証する。
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    console.error(
      `[ERROR] 環境変数 ${name} の値 "${value}" が不正です。[A-Za-z0-9_-] のみ許可されます`
    );
    process.exit(1);
  }
  return value;
}

function safeUrl(url) {
  // 署名付き URL の query string は一時的な認可情報を含むため、
  // ログ・例外メッセージには query を含めない origin+pathname を返す。
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[ERROR] 環境変数 ${name} が設定されていません`);
    process.exit(1);
  }
  return value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- 実行 ---

main().catch((err) => {
  console.error("[ERROR] フィード生成に失敗しました:", err.message);
  process.exit(1);
});
