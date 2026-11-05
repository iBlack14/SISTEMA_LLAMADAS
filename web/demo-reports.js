(() => {
  const reports = [];
  const years = [2024, 2025, 2026];
  const months = [
    "Automotriz",
    "Construcción",
    "Comercio",
    "Educación",
    "Tecnología",
    "Turismo"
  ];

  for (const year of years) {
    for (let month = 0; month < 12; month++) {
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      for (let day = 1; day <= daysInMonth; day++) {
        const date =
          `${year}-${String(month + 1).padStart(2, "0")}-` +
          `${String(day).padStart(2, "0")}`;
        const rubro = months[(month + day) % months.length];
        const rows = [
          {
            id: `DEMO-${date}-001`,
            name: `Empresa demo ${rubro} 01`,
            phone: "DEMO-NO-MARCAR-001",
            durationSeconds: 48,
            answered: true,
            inoperable: false,
            pending: false
          },
          {
            id: `DEMO-${date}-002`,
            name: `Empresa demo ${rubro} 02`,
            phone: "DEMO-NO-MARCAR-002",
            durationSeconds: 0,
            answered: false,
            inoperable: true,
            pending: false
          },
          {
            id: `DEMO-${date}-003`,
            name: `Empresa demo ${rubro} 03`,
            phone: "DEMO-NO-MARCAR-003",
            durationSeconds: 0,
            answered: false,
            inoperable: false,
            pending: true
          }
        ];

        reports.push({
          id: `DEMO-${date}`,
          date,
          rubro,
          numbers: rows.length,
          totalCalls: 2,
          answered: 1,
          pending: 1,
          rows
        });
      }
    }
  }

  window.VOIP_VC_DEMO_REPORTS = reports;
})();
