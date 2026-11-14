import { refs, setStatus, setBadge, setAckBadge } from '../../../shared/ui/dom.js';
import * as Contacts from '../contacts-repository.js';

/**
 * createExportWord: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml.
 * Se construye una vez por dashboard.
 */
export function createExportWord(dashboardState, dashboardActions) {
async function exportContactsToWord() {
  if (!Contacts.contacts.length) {
    setStatus("No hay contactos para exportar.", true);
    return;
  }

  try {
    setStatus("Generando documento Word...", true);

    // Create HTML content that can be converted to Word
    let htmlContent = `
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Lista de Contactos</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #333; }
          table { border-collapse: collapse; width: 100%; margin-top: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; font-weight: bold; }
          .call-count { background-color: #e8f5e8; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
        </style>
      </head>
      <body>
        <h1>Lista de Contactos - ${new Date().toLocaleDateString()}</h1>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Nota</th>
              <th>Llamadas</th>
            </tr>
          </thead>
          <tbody>
    `;

    Contacts.contacts.forEach(contact => {
      const callCount = Number(Contacts.calledCounts[contact.id] || 0);
      htmlContent += `
        <tr>
          <td>${dashboardActions.escHtml(contact.name)}</td>
          <td>${dashboardActions.escHtml(contact.phone)}</td>
          <td>${dashboardActions.escHtml(contact.note || "")}</td>
          <td>${callCount > 0 ? `<span class="call-count">${callCount}</span>` : "0"}</td>
        </tr>
      `;
    });

    htmlContent += `
          </tbody>
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
          Total de contactos: ${Contacts.contacts.length} |
          Contactos llamados: ${Contacts.contacts.reduce((acc, c) => acc + (Number(Contacts.calledCounts[c.id] || 0) > 0 ? 1 : 0), 0)}
        </p>
      </body>
      </html>
    `;

    // Create a Blob with the HTML content
    const blob = new Blob([htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);

    // Create download link
    const a = document.createElement('a');
    a.href = url;
    a.download = `contactos_${new Date().toISOString().split('T')[0]}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus("Documento Word descargado.", true);
  } catch (error) {
    console.error("Error exporting to Word:", error);
    setStatus("Error al exportar a Word.", true);
  }
}
return { exportContactsToWord };
}
