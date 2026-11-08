'use strict';
module.exports = {
  "errNoCloud": "启动器未连接到服务器（设置 > 账户与云端）。",
  "errSignIn": "请登录 Venus 账户（设置 > 账户与云端）以使用管理面板。",
  "errSession": "Venus 会话已过期。请在设置 > 账户与云端重新登录。",
  "errForbidden": "你的账户无权访问管理面板。",
  "errUnconfirmed": "请验证 Venus 账户的电子邮箱后再使用管理面板。",
  "errNotFound": "对象不存在或已被删除。",
  "errUnavailable": "启动器服务器没有管理面板（尚未部署“admin”函数）。",
  "errBackendNotReady": "服务器缺少管理面板迁移（0012_admin.sql）。",
  "errStripeNotConfigured": "服务器尚未配置 Stripe（缺少 STRIPE_SECRET_KEY 密钥）。",
  "errStripe": "Stripe 拒绝了请求或未响应。请稍后重试。",
  "errPromoTaken": "已有相同内容的有效促销代码。",
  "errConflict": "操作未完成：状态已变化。请刷新后重试。",
  "errRequest": "服务器拒绝了请求。",
  "errRequestStatus": "服务器拒绝了请求（{status}）。",
  "errServer": "管理面板服务器响应异常。请稍后重试。",
  "errNetwork": "无法连接到启动器服务器。请检查网络连接。",
  "errAction": "无效的管理面板操作。"
};
