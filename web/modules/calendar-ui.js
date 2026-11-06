(() => {
  const months = [
    "Enero", "Febrero", "Marzo", "Abril",
    "Mayo", "Junio", "Julio", "Agosto",
    "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ];
  const root = document.getElementById("calendarUi");
  const calls = document.getElementById("callsContent");
  const calendar = document.getElementById("annualReport");
  const openButton = document.getElementById("reportNavBtn");
  const closeButton = document.getElementById("reportBackBtn");

  if (!root || !calls || !calendar || !openButton || !closeButton) return;

  let year = new Date().getFullYear();
  let selectedDate = "";

  function render() {
    const monthCards = months.map((name, month) => {
      const firstDay = new Date(year, month, 1).getDay();
      const daysCount = new Date(year, month + 1, 0).getDate();
      const blanks = Array.from({ length: firstDay }, () => "<i></i>").join("");
      const days = Array.from({ length: daysCount }, (_, index) => {
        const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
        const selected = date === selectedDate ? " selected-date" : "";
        return `<button type="button" class="calendar-day${selected}" data-date="${date}" aria-pressed="${date === selectedDate}">${index + 1}</button>`;
      }).join("");

      return `
        <article class="report-month">
          <h3>${name}</h3>
          <div class="report-days">
            ${["D", "L", "M", "M", "J", "V", "S"].map((day) => `<b>${day}</b>`).join("")}
            ${blanks}
            ${days}
          </div>
        </article>
      `;
    }).join("");

    const selectedLabel = selectedDate
      ? new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeZone: "UTC" })
        .format(new Date(`${selectedDate}T00:00:00Z`))
      : "Selecciona un día";

    root.innerHTML = `
      <div class="report-heading">
        <h2>CALENDARIO ANUAL</h2>
        <div>
          <button id="calendarPrevYear" class="secondary" type="button" aria-label="Año anterior">‹</button>
          <strong>${year}</strong>
          <button id="calendarNextYear" class="secondary" type="button" aria-label="Año siguiente">›</button>
        </div>
      </div>
      <p class="calendar-selection" aria-live="polite">${selectedLabel}</p>
      <div class="months-grid">${monthCards}</div>
    `;

    root.querySelector("#calendarPrevYear").addEventListener("click", () => {
      year -= 1;
      render();
    });
    root.querySelector("#calendarNextYear").addEventListener("click", () => {
      year += 1;
      render();
    });
    root.querySelectorAll("[data-date]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedDate = button.dataset.date;
        render();
      });
    });
  }

  openButton.addEventListener("click", () => {
    calls.hidden = true;
    calendar.hidden = false;
    render();
  });

  closeButton.addEventListener("click", () => {
    calendar.hidden = true;
    calls.hidden = false;
  });
})();
