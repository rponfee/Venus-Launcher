'use strict';
module.exports = {
  "errNoCloud": "런처가 서버에 연결되지 않았습니다(설정 > 계정 및 클라우드).",
  "errSignIn": "관리 패널을 사용하려면 Venus 계정으로 로그인하세요(설정 > 계정 및 클라우드).",
  "errSession": "Venus 세션이 만료됐습니다. 설정 > 계정 및 클라우드에서 다시 로그인하세요.",
  "errForbidden": "이 계정은 관리 패널에 접근할 수 없습니다.",
  "errUnconfirmed": "관리 패널을 사용하려면 Venus 계정의 이메일을 확인하세요.",
  "errNotFound": "존재하지 않거나 이미 삭제됐습니다.",
  "errUnavailable": "런처 서버에 관리 패널이 없습니다('admin' 함수가 배포되지 않았습니다).",
  "errBackendNotReady": "서버에 관리 패널 마이그레이션이 없습니다(0012_admin.sql).",
  "errStripeNotConfigured": "서버에 Stripe가 설정되지 않았습니다(STRIPE_SECRET_KEY가 없습니다).",
  "errStripe": "Stripe가 요청을 거부했거나 응답하지 않았습니다. 나중에 다시 시도하세요.",
  "errPromoTaken": "같은 내용의 활성 프로모션 코드가 이미 있습니다.",
  "errConflict": "상태가 변경되어 실행하지 못했습니다. 새로고침한 뒤 다시 시도하세요.",
  "errRequest": "서버가 요청을 거부했습니다.",
  "errRequestStatus": "서버가 요청을 거부했습니다({status}).",
  "errServer": "관리 패널 서버가 올바르게 응답하지 않았습니다. 나중에 다시 시도하세요.",
  "errNetwork": "런처 서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.",
  "errAction": "잘못된 관리 패널 작업입니다."
};
