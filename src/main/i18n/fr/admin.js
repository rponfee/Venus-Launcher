'use strict';
module.exports = {
  "errNoCloud": "Le launcher n’est pas connecté à son serveur (Paramètres > Compte et cloud).",
  "errSignIn": "Connectez-vous à votre compte Venus (Paramètres > Compte et cloud) pour utiliser le panneau d’administration.",
  "errSession": "Votre session Venus a expiré. Reconnectez-vous dans Paramètres > Compte et cloud.",
  "errForbidden": "Votre compte n’a pas accès au panneau d’administration.",
  "errUnconfirmed": "Confirmez l’adresse e-mail de votre compte Venus pour utiliser le panneau d’administration.",
  "errNotFound": "Cet élément n’existe pas ou a déjà été supprimé.",
  "errUnavailable": "Le serveur du launcher ne dispose pas du panneau d’administration (la fonction « admin » n’est pas déployée).",
  "errBackendNotReady": "La migration du panneau d’administration manque sur le serveur (0012_admin.sql).",
  "errStripeNotConfigured": "Stripe n’est pas configuré sur le serveur (secret STRIPE_SECRET_KEY manquant).",
  "errStripe": "Stripe a refusé la demande ou n’a pas répondu. Réessayez plus tard.",
  "errPromoTaken": "Un code promotionnel actif avec ce texte existe déjà.",
  "errConflict": "Action impossible : l’état a changé. Rechargez et réessayez.",
  "errRequest": "Le serveur a refusé la demande.",
  "errRequestStatus": "Le serveur a refusé la demande ({status}).",
  "errServer": "Le serveur du panneau n’a pas répondu correctement. Réessayez plus tard.",
  "errNetwork": "Impossible de se connecter au serveur du launcher. Vérifiez votre connexion Internet.",
  "errAction": "Action du panneau d’administration invalide."
};
