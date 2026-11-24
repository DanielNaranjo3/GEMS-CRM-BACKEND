// Clave del período al que pertenece una fecha 'YYYY-MM-DD' según la periodicidad
// de la recurrente: el día, el lunes de esa semana, 'YYYY-MM' o 'YYYY'.
// Misma regla que src/utils/recurring.ts en el frontend.
function periodKey(dateKey, recurrence) {
  if (recurrence === 'yearly') return dateKey.slice(0, 4);
  if (recurrence === 'monthly') return dateKey.slice(0, 7);
  if (recurrence === 'weekly') {
    const d = new Date(`${dateKey}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // lunes de esa semana
    return d.toISOString().slice(0, 10);
  }
  return dateKey;
}

module.exports = { periodKey };
