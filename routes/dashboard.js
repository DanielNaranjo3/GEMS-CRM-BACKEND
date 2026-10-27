const express = require('express');
const router = express.Router();
const { buildSummary } = require('../services/dashboardService');

// Resumen del dashboard para quien consulta: lo suyo (hoy, vencidas, próximas,
// rutinas, aprobaciones) y, según su alcance, la carga de su área o de toda la
// organización. La autenticación y la organización las pone el wall de /api.
router.get('/summary', async (req, res) => {
  try {
    const summary = await buildSummary(req);
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Error construyendo el resumen del dashboard:', error);
    res.status(500).json({ success: false, message: 'No se pudo construir el resumen del dashboard' });
  }
});

module.exports = router;
