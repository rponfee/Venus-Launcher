// Cuando sacar a un miembro de la lista de la sala. La presencia (quien esta) viene del principal o de los avisos del
// respaldo; si esos avisos faltan porque se cayo la señalizacion, eso NO quiere decir que la persona se fue: su audio
// puede seguir llegando directo por WebRTC. Regla: una llamada en curso no se corta porque falle la señalizacion.
export const ROSTER = {
  AWAY_GRACE_MS: 15000, // sin presencia, pero con conexion directa viva: se espera esto antes de sacarlo
  BLACKOUT_GRACE_MS: 60000, // sin señalizacion y con la conexion directa caida: se espera esto
};

// m: { away, awaySince }. peerState: estado de la conexion directa ('connected', 'reconnecting', 'failed', 'closed'...) o null
// trusted: la presencia de esta persona es confiable ahora (el principal anda, o la oimos por el respaldo)
export function shouldDropMember({ now, awaySince, peerState, trusted }) {
  if (!peerState || peerState === 'failed' || peerState === 'closed') return true; // sin conexion directa no hay nada que cuidar
  const away = now - (awaySince || now);
  if (trusted) return peerState !== 'connected' || away >= ROSTER.AWAY_GRACE_MS;
  // Presencia desconocida: mientras el audio llegue, se queda; si tambien se cayo la conexion, se espera un poco mas
  return peerState !== 'connected' && away >= ROSTER.BLACKOUT_GRACE_MS;
}
