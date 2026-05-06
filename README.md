# Wisdom Guild Feed Generator for Shopify

Shopify Admin API から商品データを取得し、Wisdom Guild 向けのフィードファイルを生成・公開する。

EC-CUBE で稼働していた `WisdomGuildBatchCommand`（毎日 3:00 cron）の Shopify 移行版。

## 構成

```
GitHub Actions (毎日 JST 3:00)
  → Shopify Admin API の Bulk Operation で商品データ一括取得（JSONL）
  → ローカルで Wisdom Guild 形式のテキストファイル生成
  → GitHub Pages にデプロイ・公開
```

通常 GraphQL の pagination は 25,000 オブジェクト上限のため、本ストア規模（数十万バリエーション）では **Bulk Operation API が必須**。

## 出力フォーマット

1行 = 1バリエーション、`<>` 区切り。

```
商品ID<>商品名 [バリエーション名]<>SKU<>価格<>在庫数<>更新日時
```

| フィールド | 値 | 備考 |
|---|---|---|
| 商品ID | Shopify GID から数値部分のみ抽出 | `gid://shopify/Product/1234` → `1234` |
| 商品名 | `title` + `[selectedOptions]` | バリエーションが Default Title の場合は `title` のみ |
| 商品コード | `variant.sku` または商品メタフィールド値（`ITEMCODE_SOURCE` で切替） | 既定は `variant.sku` |
| 価格 | `Math.floor(Number(variant.price))` | 整数 |
| 在庫数 | `variant.inventoryQuantity` | 0 も出力 |
| 更新日時 | `product.updatedAt` を JST で `YYYY/MM/DD HH:mm:ss` 整形 | |

ソート順は `UPDATED_AT` 降順（移行元の `update_date DESC` と一致）。

### バリアント抽出条件

EC-CUBE 移行元の `ProductClass.isVisible()` 相当のフィルタとして、以下を AND で適用:

- `inventoryItem.tracked === true` — 在庫追跡 OFF のバリアントを除外
- `availableForSale === true` — 販売可能なバリアントのみ

> **運用上の注意**: `availableForSale` は「在庫切れ + バックオーダー無効」のバリアントを除外する。Wisdom Guild 側で在庫切れ表示が必要な場合、`scripts/generate-feed.js` の該当フィルタを緩める（在庫追跡 ON のみで通す）必要がある。

### フィールド値のサニタイズ

商品名・SKU・オプション値は出力前にサニタイズされ、区切り文字 `<>` と改行 (`\r\n`) は半角スペースに置換される（列崩れ・行注入の防止）。

## 対象商品の絞り込み

メタフィールド `custom.wisdomguild = true` が設定された **`status:active`** の商品のみを対象とする。

GraphQL クエリ:

```
status:active AND metafields.custom.wisdomguild:true
```

namespace / key は環境変数 `FILTER_METAFIELD_NAMESPACE` / `FILTER_METAFIELD_KEY` で上書き可能（既定: `custom` / `wisdomguild`）。

## セットアップ

### 1. Shopify カスタムアプリの作成

1. Shopify管理画面 > 設定 > アプリ開発 > 「開発を許可」
2. 「アプリを作成」をクリック
3. Admin API のスコープを設定:
   - `read_products`
   - `read_inventory`
4. 「インストール」してアクセストークン (`shpat_...`) を取得

### 2. Shopify メタフィールド定義の作成

1. Shopify管理画面 > 設定 > カスタムデータ > 商品 > 「定義を追加」
2. 以下で作成:
   - 名前: `Wisdom Guild 連携`
   - Namespace and key: `custom.wisdomguild`
   - 型: `True or false` (Boolean)
3. 連携対象の商品を開き、メタフィールドを `true` に設定

### 3. GitHub リポジトリの設定

#### Secrets（Settings > Secrets and variables > Actions > Secrets）

| Secret名 | 値 |
|---|---|
| `SHOPIFY_STORE_URL` | `your-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | `shpat_xxxxxxxxxxxxxxxxxxxxx` |

#### Variables（Settings > Secrets and variables > Actions > Variables）（任意）

既定値から変更したい場合のみ設定する。

| Variable名 | デフォルト値 | 説明 |
|---|---|---|
| `FILTER_METAFIELD_NAMESPACE` | `custom` | 対象商品判定用メタフィールドの namespace |
| `FILTER_METAFIELD_KEY` | `wisdomguild` | 対象商品判定用メタフィールドの key |
| `ITEMCODE_SOURCE` | `variant_sku` | 商品コードのソース。`variant_sku` または `product_metafield` |
| `ITEMCODE_METAFIELD_NAMESPACE` | `custom` | `ITEMCODE_SOURCE=product_metafield` 時の namespace |
| `ITEMCODE_METAFIELD_KEY` | `itemcode` | `ITEMCODE_SOURCE=product_metafield` 時の key |

> **商品コードの選択**: 移行元 EC-CUBE の `Product.itemCode` は商品単位コードのため、Wisdom Guild 側が商品単位コードを期待している場合は `ITEMCODE_SOURCE=product_metafield` に切り替え、商品メタフィールド `custom.itemcode` に旧 itemCode を保持する運用とする。バリアント単位の SKU で問題なければ既定の `variant_sku` のまま。

### 4. GitHub Pages の有効化

1. Settings > Pages
2. Source: 「GitHub Actions」を選択

## フィードURL

デプロイ後、以下のURLでフィードにアクセスできる:

```
https://<owner>.github.io/<repository>/wisdom_guild_products.txt
```

カスタムドメイン運用も可能（GitHub Pages の標準機能）。

## ローカル実行

```bash
cp .env.example .env
# .env を編集して実際の値を設定
npm run generate
```

出力は `output/wisdom_guild_products.txt` に書き出される。

## 手動実行（GitHub Actions）

Actions タブ > 「Wisdom Guild Feed Generation」 > 「Run workflow」

## 運用メモ

- **スケジュール実行**: 毎日 JST 3:00（`cron: '0 18 * * *'` UTC）。GitHub Actions の cron は数分〜数十分の遅延が発生し得る。
- **API バージョン**: `2025-01` をハードコード。Shopify の四半期リリースに合わせて定期更新が必要。
- **取得方式**: `bulkOperationRunQuery` で全商品を一括クエリし、`currentBulkOperation` を 10 秒間隔でポーリング。完了後に署名付き URL（GCS 等）から JSONL をストリームダウンロードして商品とバリアントを `__parentId` で紐づける。Bulk はソート不可のため、取得後にメモリ上で `updatedAt` 降順ソートする。
- **タイムアウト**: Bulk Operation の完了待ちは既定 60 分。`BULK_TIMEOUT_MS` で上書き可能。
- **既存の Bulk Operation との競合**: 同一ストアで Bulk は同時 1 本のみ。既に実行中の場合は完了を待ってから新規発行する。
- **レートリミット / リトライ**:
  - GraphQL の `extensions.cost.throttleStatus` を監視し、残量が少ない場合は自動待機。
  - HTTP 429 / 5xx、ネットワーク失敗、GraphQL `THROTTLED` には指数バックオフ付きでリトライ（最大 5 回）。`Retry-After` ヘッダーがあれば優先する。
- **JSONL ダウンロード**: Bulk が返す URL は署名付きの直接ダウンロード URL のため、Shopify の認証ヘッダは付けない（付けると失敗する）。
- **`SHOPIFY_STORE_URL`** に `https://` や末尾スラッシュが含まれていても自動で除去する。形式が `*.myshopify.com` でない場合は警告を出す。
- **失敗通知**: 標準では未設定（運用判断で見送り）。必要に応じて GitHub Actions の通知や Slack 連携を追加する。
