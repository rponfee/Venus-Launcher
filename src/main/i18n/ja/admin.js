'use strict';
module.exports = {
  "errNoCloud": "ランチャーがサーバーに接続されていません（設定 > アカウントとクラウド）。",
  "errSignIn": "管理パネルを使うには、Venusアカウントでログインしてください（設定 > アカウントとクラウド）。",
  "errSession": "Venusのセッションが期限切れです。設定 > アカウントとクラウドで再度ログインしてください。",
  "errForbidden": "このアカウントには管理パネルへのアクセス権がありません。",
  "errUnconfirmed": "管理パネルを使うには、Venusアカウントのメールアドレスを確認してください。",
  "errNotFound": "存在しないか、すでに削除されています。",
  "errUnavailable": "ランチャーのサーバーに管理パネルがありません（「admin」機能がデプロイされていません）。",
  "errBackendNotReady": "サーバーに管理パネルのマイグレーションがありません（0012_admin.sql）。",
  "errStripeNotConfigured": "サーバーでStripeが設定されていません（STRIPE_SECRET_KEYがありません）。",
  "errStripe": "Stripeがリクエストを拒否したか、応答しませんでした。しばらくしてから再試行してください。",
  "errPromoTaken": "同じ文字列の有効なプロモーションコードがすでにあります。",
  "errConflict": "状態が変わったため実行できませんでした。再読み込みしてから再試行してください。",
  "errRequest": "サーバーがリクエストを拒否しました。",
  "errRequestStatus": "サーバーがリクエストを拒否しました（{status}）。",
  "errServer": "管理パネルのサーバーから正しい応答がありませんでした。しばらくしてから再試行してください。",
  "errNetwork": "ランチャーのサーバーに接続できません。インターネット接続を確認してください。",
  "errAction": "管理パネルの操作が無効です。"
};
