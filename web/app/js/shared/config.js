// Proyecto de Supabase de la app del celular: el mismo del launcher (src/main/core/cloud-defaults.js).
// La anon key es pública por diseño: lo que protege los datos son las políticas RLS. Jamás va acá una clave secreta.
(function (root) {
  'use strict';
  const url = 'https://dzchklzaxyygbvfpagvx.supabase.co';
  const config = Object.freeze({
    url,
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6Y2hrbHpheHl5Z2J2ZnBhZ3Z4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNDA2NDYsImV4cCI6MjEwODcxNjY0Nn0.OwCJ2uTTO0IXECEKhwPk3Qha-NRN7PXd_2v6VPzJyzg',
    storageKey: 'venus-auth', // la misma clave con la que supabase-js guarda la sesión en el launcher
    pushFunction: url + '/functions/v1/push-notify',
  });
  root.VenusApp = Object.assign(root.VenusApp || {}, { config });
  if (typeof module === 'object' && module.exports) module.exports = config;
})(globalThis);
