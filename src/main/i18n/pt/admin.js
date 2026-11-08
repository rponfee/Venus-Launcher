'use strict';
module.exports = {
  "errNoCloud": "O launcher não está conectado ao servidor (Configurações > Conta e nuvem).",
  "errSignIn": "Entre na sua conta Venus (Configurações > Conta e nuvem) para usar o painel de administração.",
  "errSession": "Sua sessão Venus expirou. Entre novamente em Configurações > Conta e nuvem.",
  "errForbidden": "Sua conta não tem acesso ao painel de administração.",
  "errUnconfirmed": "Confirme o e-mail da sua conta Venus para usar o painel de administração.",
  "errNotFound": "Não existe ou já foi excluído.",
  "errUnavailable": "O servidor do launcher não tem o painel de administração (a função \"admin\" não foi implantada).",
  "errBackendNotReady": "Falta a migração do painel de administração no servidor (0012_admin.sql).",
  "errStripeNotConfigured": "Stripe não está configurado no servidor (falta o segredo STRIPE_SECRET_KEY).",
  "errStripe": "Stripe recusou a solicitação ou não respondeu. Tente novamente mais tarde.",
  "errPromoTaken": "Já existe um código promocional ativo com esse texto.",
  "errConflict": "Não foi possível concluir: o estado mudou. Recarregue e tente novamente.",
  "errRequest": "O servidor recusou a solicitação.",
  "errRequestStatus": "O servidor recusou a solicitação ({status}).",
  "errServer": "O servidor do painel não respondeu corretamente. Tente novamente mais tarde.",
  "errNetwork": "Não foi possível conectar ao servidor do launcher. Verifique sua conexão com a internet.",
  "errAction": "Ação inválida no painel de administração."
};
