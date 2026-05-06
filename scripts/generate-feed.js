/**
 * Wisdom Guild フィード生成スクリプト
 *
 * Shopify Admin API (GraphQL) から商品データを取得し、
 * Wisdom Guild形式のテキストファイルを生成する。
 *
 * 出力フォーマット（1行 = 1バリエーション）:
 *   商品ID<>商品名 [カテゴリ名]<>商品コード<>販売価格<>在庫数<>更新日時
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
const FILTER_METAFIELD_NAMESPACE =
  process.env.FILTER_METAFIELD_NAMESPACE || "custom";
const FILTER_METAFIELD_KEY = process.env.FILTER_METAFIELD_KEY || "wisdomguild";

// 商品コードのソース:
//   - "variant_sku" (default): variant.sku を商品コードとして出力
//   - "product_metafield":     商品メタフィールド値を商品コードとして出力（同一商品の全行で同値）
// EC-CUBE 移行元の Product.itemCode は商品単位なので、Wisdom Guild 側が
// 商品単位コードを期待する場合は "product_metafield" に切り替える。
const ITEMCODE_SOURCE = process.env.ITEMCODE_SOURCE || "variant_sku";
const ITEMCODE_METAFIELD_NAMESPACE =
  process.env.ITEMCODE_METAFIELD_NAMESPACE || "custom";
const ITEMCODE_METAFIELD_KEY =
  process.env.ITEMCODE_METAFIELD_KEY || "itemcode";

const PAGE_SIZE = 250;
const VARIANTS_PAGE_SIZE = 100;
const SHOPIFY_API_VERSION = "2025-01";
const GRAPHQL_ENDPOINT = `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// リトライ設定
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;

// --- GraphQL クエリ ---

const PRODUCTS_QUERY = `
  query GetProducts(
    $cursor: String
    $query: String!
    $itemCodeNs: String!
    $itemCodeKey: String!
  ) {
    products(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        updatedAt
        itemCodeMetafield: metafield(namespace: $itemCodeNs, key: $itemCodeKey) {
          value
        }
        variants(first: ${VARIANTS_PAGE_SIZE}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
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
`;

const PRODUCT_VARIANTS_QUERY = `
  query GetProductVariants($productId: ID!, $cursor: String) {
    product(id: $productId) {
      variants(first: ${VARIANTS_PAGE_SIZE}, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
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
`;

// --- メイン処理 ---

async function main() {
  console.log("[INFO] Wisdom Guild フィード生成を開始します");
  console.log(`[INFO] ITEMCODE_SOURCE: ${ITEMCODE_SOURCE}`);

  const query = buildProductQuery();
  console.log(`[INFO] 商品クエリ: ${query}`);

  const products = await fetchAllProducts(query);
  console.log(`[INFO] 取得商品数: ${products.length}`);

  if (products.length === 0) {
    console.error("[ERROR] 対象商品が見つかりません");
    process.exit(1);
  }

  const lines = generateFeedLines(products);
  console.log(`[INFO] 出力行数（バリエーション数）: ${lines.length}`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(TMP_FILE, lines.join("\n") + "\n", "utf-8");
  renameSync(TMP_FILE, OUTPUT_FILE);

  console.log(`[INFO] フィード生成完了: ${OUTPUT_FILE}`);
}

// --- 商品取得 ---

function buildProductQuery() {
  return `status:active AND metafields.${FILTER_METAFIELD_NAMESPACE}.${FILTER_METAFIELD_KEY}:true`;
}

async function fetchAllProducts(query) {
  const allProducts = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    console.log(`[INFO] ページ ${page} を取得中...`);

    const data = await shopifyGraphQL(PRODUCTS_QUERY, {
      cursor,
      query,
      itemCodeNs: ITEMCODE_METAFIELD_NAMESPACE,
      itemCodeKey: ITEMCODE_METAFIELD_KEY,
    });
    const { nodes, pageInfo } = data.products;

    // バリアントが VARIANTS_PAGE_SIZE を超える商品は追加取得（silent dropout 防止）
    for (const product of nodes) {
      if (product.variants.pageInfo.hasNextPage) {
        console.log(
          `[INFO] 商品 ${product.id} のバリアント追加取得（>${VARIANTS_PAGE_SIZE}件）`
        );
        const more = await fetchRemainingVariants(
          product.id,
          product.variants.pageInfo.endCursor
        );
        product.variants.nodes.push(...more);
      }
    }

    allProducts.push(...nodes);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return allProducts;
}

async function fetchRemainingVariants(productGid, initialCursor) {
  const variants = [];
  let cursor = initialCursor;

  while (true) {
    const data = await shopifyGraphQL(PRODUCT_VARIANTS_QUERY, {
      productId: productGid,
      cursor,
    });
    const { nodes, pageInfo } = data.product.variants;
    variants.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return variants;
}

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
    throw new Error(
      `GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`
    );
  }

  // 成功時のスロットルウォッチ（次リクエスト前に余裕を確保）
  if (json.extensions?.cost) {
    const { currentlyAvailable, restoreRate } =
      json.extensions.cost.throttleStatus;
    if (currentlyAvailable < 100) {
      const waitMs = Math.ceil((100 - currentlyAvailable) / restoreRate) * 1000;
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
        const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
        const delay = retryAfterMs ?? BASE_RETRY_DELAY_MS * 2 ** attempt;
        console.warn(
          `[WARN] HTTP ${response.status} — ${delay}ms 後にリトライ (${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Shopify API error: ${response.status} ${response.statusText}`
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
  throw lastError ?? new Error(`Shopify API リトライ ${MAX_RETRIES} 回失敗`);
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// --- フィード生成 ---

function generateFeedLines(products) {
  const lines = [];

  for (const product of products) {
    const productId = extractNumericId(product.id);
    const updatedAt = formatDate(product.updatedAt);
    const productMetafieldItemCode = product.itemCodeMetafield?.value ?? "";

    for (const variant of product.variants.nodes) {
      // EC-CUBE の ProductClass.isVisible() 相当の代替フィルタ:
      //   - inventoryItem.tracked === true: 在庫追跡 OFF のバリアントを除外
      //   - availableForSale === true:      販売可能なバリアントのみ
      // 注意: availableForSale は「在庫切れ + バックオーダー無効」のバリアントを除外する。
      //   元仕様は在庫0でも出力していたため、Wisdom Guild 側で在庫切れ表示が必要なら
      //   availableForSale 条件を緩める（例: 在庫追跡 ON のみで通す）ことを検討。
      if (variant.inventoryItem?.tracked !== true) continue;
      if (variant.availableForSale !== true) continue;

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
