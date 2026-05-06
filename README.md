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

EC-CUBE 移行元の `ProductClass.isVisible()` 相当のフィルタ:

| 条件 | 既定 | 備考 |
|---|---|---|
| `inventoryItem.tracked === true` | 常に適用 | 在庫追跡 OFF のバリアントを除外 |
| `availableForSale === true` | `STRICT_AVAILABILITY=true` 時のみ | 在庫切れ + バックオーダー無効のバリアントを除外 |

既定では `tracked` のみで判定し、**在庫0行も出力する**（元バッチ仕様と一致）。Wisdom Guild には販売可能なものだけを渡したい運用に切り替える場合は `STRICT_AVAILABILITY=true` に設定する。

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
| `STRICT_AVAILABILITY` | `false` | `true` で `availableForSale === true` も併用（在庫切れ行を除外）|

> **メタフィールド識別子の検証**: namespace / key は起動時に `[A-Za-z0-9_-]+` で validate される。範囲外の値が設定されているとスクリプトはエラーで終了する。

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

Node.js **20.6.0 以上**が必要（`--env-file` フラグを利用するため）。

```bash
cp .env.example .env
# .env を編集して実際の値を設定
npm run generate
```

`npm run generate` は内部で `node --env-file=.env scripts/generate-feed.js` を実行する。出力は `output/wisdom_guild_products.txt` に書き出される。

## 手動実行（GitHub Actions）

Actions タブ > 「Wisdom Guild Feed Generation」 > 「Run workflow」

## 運用メモ

- **スケジュール実行**: 毎日 JST 3:00（`cron: '0 18 * * *'` UTC）。GitHub Actions の cron は数分〜数十分の遅延が発生し得る。
- **API バージョン**: `scripts/generate-feed.js` の `SHOPIFY_API_VERSION` 定数で固定。Shopify は四半期ごとに API バージョンをリリースし約 12ヶ月後にサポート終了するため、**年 1 回程度**は [リリースカレンダー](https://shopify.dev/docs/api/usage/versioning) を確認して値を更新すること。サポート切れになると Bulk / GraphQL のフィールドが突然失敗することがある。
- **取得方式**: `bulkOperationRunQuery` で全商品を一括クエリし、`currentBulkOperation` を 10 秒間隔でポーリング。完了後に署名付き URL（GCS 等）から JSONL をストリームダウンロードして商品とバリアントを `__parentId` で紐づける。Bulk はソート不可のため、取得後にメモリ上で `updatedAt` 降順ソートする。`updatedAt` が不正な値の商品は末尾に固定し警告を出す。
- **タイムアウト**: Bulk Operation の完了待ちは既定 60 分。`BULK_TIMEOUT_MS` で上書き可能。
- **既存の Bulk Operation との競合**: 同一ストアで Bulk は同時 1 本のみ。既に実行中の場合は完了を待ってから新規発行する。発行した operation の id は `pollBulkOperation()` で照合し、別の Bulk が割り込んだ場合はエラーで停止する。
- **データ整合性**: JSONL の parse 失敗 や `__parentId` で親が見つからない variant が **1 件でも**あれば、フィード生成を中止して失敗扱いにする（壊れたフィードを公開するより停止して検知する方針）。
- **レートリミット / リトライ**:
  - GraphQL の `extensions.cost.throttleStatus` を監視し、残量が少ない場合は自動待機。
  - HTTP 429 / 5xx、ネットワーク失敗、GraphQL `THROTTLED` には指数バックオフ付きでリトライ（最大 5 回）。`Retry-After` ヘッダーがあれば優先する。
- **JSONL ダウンロード**: Bulk が返す URL は署名付きの直接ダウンロード URL のため、Shopify の認証ヘッダは付けない（付けると失敗する）。署名付き URL の query string は一時的な認可情報を含むため、ログ・例外メッセージには含めない。
- **`SHOPIFY_STORE_URL`** に `https://` や末尾スラッシュが含まれていても自動で除去する。形式が `*.myshopify.com` でない場合は警告を出す。
- **メタフィールド識別子**: 起動時に `[A-Za-z0-9_-]+` で validate。範囲外なら起動失敗。

## 帯域・配信

- 元バッチの出力ファイルは **142MB**（24 万バリエーション規模）。日次取得を前提とした場合の見積もり:

  | 取得頻度 | 月間転送量 | GitHub Pages 100GB/月 上限に対する割合 |
  |---|---|---|
  | 日次 | 約 4.3GB | 約 4% |
  | 時間ごと | 約 102GB | **上限到達** |

- Wisdom Guild 側の取得頻度を **必ず確認**し、時間単位の取得が想定されるなら GitHub Pages 以外の配信先（Cloudflare R2 / S3 + CloudFront 等）への切替を検討する。
- 失敗通知は未設定。Repository の Settings > Notifications で **Actions failure 通知の受信者**を明確にしておくこと（古い Pages ファイルが残る構成のため、外部からは異常を検知しづらい）。
