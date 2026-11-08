'use strict';
module.exports = {
  "errNoCloud": "Der Launcher ist nicht mit seinem Server verbunden (Einstellungen > Konto und Cloud).",
  "errSignIn": "Melde dich mit deinem Venus-Konto an (Einstellungen > Konto und Cloud), um die Administration zu nutzen.",
  "errSession": "Deine Venus-Sitzung ist abgelaufen. Melde dich unter Einstellungen > Konto und Cloud erneut an.",
  "errForbidden": "Dein Konto hat keinen Zugriff auf die Administration.",
  "errUnconfirmed": "Bestätige die E-Mail-Adresse deines Venus-Kontos, um die Administration zu nutzen.",
  "errNotFound": "Der Eintrag existiert nicht oder wurde bereits gelöscht.",
  "errUnavailable": "Auf dem Launcher-Server fehlt die Administration (die Funktion „admin“ wurde nicht bereitgestellt).",
  "errBackendNotReady": "Auf dem Server fehlt die Datenbankmigration für die Administration (0012_admin.sql).",
  "errStripeNotConfigured": "Stripe ist auf dem Server nicht eingerichtet (STRIPE_SECRET_KEY fehlt).",
  "errStripe": "Stripe hat die Anfrage abgelehnt oder nicht geantwortet. Versuche es später erneut.",
  "errPromoTaken": "Ein aktiver Aktionscode mit diesem Text existiert bereits.",
  "errConflict": "Aktion fehlgeschlagen: Der Zustand hat sich geändert. Lade neu und versuche es erneut.",
  "errRequest": "Der Server hat die Anfrage abgelehnt.",
  "errRequestStatus": "Der Server hat die Anfrage abgelehnt ({status}).",
  "errServer": "Der Administrationsserver hat nicht korrekt geantwortet. Versuche es später erneut.",
  "errNetwork": "Keine Verbindung zum Launcher-Server. Prüfe deine Internetverbindung.",
  "errAction": "Ungültige Administrationsaktion."
};
