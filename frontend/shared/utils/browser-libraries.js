const LIBRARIES = {
  xlsx: {
    src: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    ready: () => window.XLSX
  },
  mammoth: {
    src: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
    ready: () => window.mammoth
  },
  jspdf: {
    src: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
    ready: () => window.jspdf?.jsPDF
  }
};

const pending = new Map();

export function loadBrowserLibrary(name) {
  const library = LIBRARIES[name];
  if (!library) return Promise.reject(new Error(`Librería desconocida: ${name}`));
  const existing = library.ready();
  if (existing) return Promise.resolve(existing);
  if (pending.has(name)) return pending.get(name);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = library.src;
    script.async = true;
    script.onload = () => {
      const value = library.ready();
      if (value) resolve(value);
      else reject(new Error(`No se pudo inicializar ${name}.`));
    };
    script.onerror = () => reject(new Error(`No se pudo descargar ${name}.`));
    document.head.appendChild(script);
  }).catch((error) => {
    pending.delete(name);
    throw error;
  });
  pending.set(name, promise);
  return promise;
}
