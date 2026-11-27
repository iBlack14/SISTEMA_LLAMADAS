const SOUND_PATHS = {
  messageSent: "/shared/assets/sounds/mensaje-enviado.mp3",
  call: "/shared/assets/sounds/notificacion-llamada.mp3",
  blocked: "/shared/assets/sounds/numero-bloqueado.mp3",
  reservationSaved: "/shared/assets/sounds/reserva-contacto.mp3",
  reservationDue: "/shared/assets/sounds/reservas-total.mp3",
  dataUploaded: "/shared/assets/sounds/subido-datos.mp3"
};

const lastPlayedAt = new Map();
const audioCache = new Map();

export function playSystemSound(key, { cooldownMs = 800, volume = 0.7 } = {}) {
  if (typeof Audio !== "function") return;
  const path = SOUND_PATHS[key];
  if (!path) return;
  const now = Date.now();
  if (now - (lastPlayedAt.get(key) || 0) < cooldownMs) return;
  lastPlayedAt.set(key, now);
  try {
    let audio = audioCache.get(key);
    if (!audio) {
      audio = new Audio(path);
      audio.preload = "auto";
      audioCache.set(key, audio);
    }
    audio.volume = volume;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch { /* Ignorar si el navegador bloquea autoplay sin interacción previa. */ }
}
