/**
 * Gemeinsamer Laufzeit-State für Supabase-Client und angemeldeten Nutzer.
 * Ein Objekt, damit Zuweisungen in allen importierenden Modulen dieselbe Referenz nutzen.
 */
export const appSession = {
  sb: null,
  currentUser: null,
  currentProfile: null,
  isReadOnly: false,
};
