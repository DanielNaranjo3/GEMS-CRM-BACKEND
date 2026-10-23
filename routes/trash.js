const express = require('express');
const router = express.Router();
const TrashedItem = require('../models/TrashedItem');
const { isReviewer } = require('../services/taskApprovalService');
const { RETENTION_DAYS, TrashError, restoreFromTrash, purgeExpired } = require('../services/trashService');

// Papelera de actividades y tareas eliminadas. Solo la ven y la usan los
// aprobadores: administradores y líderes de área.

router.use(async (req, res, next) => {
  try {
    if (!(await isReviewer(req))) {
      return res.status(403).json({ error: 'Solo los administradores y líderes de área pueden ver la papelera', code: 'NOT_APPROVER' });
    }
    next();
  } catch (error) {
    next(error);
  }
});

// Listado (sin el documento completo): lo más reciente primero
router.get('/', async (req, res) => {
  try {
    await purgeExpired();
    const items = await TrashedItem.find({ organizationId: req.organizationId })
      .select('-data -detachedChildIds')
      .populate('deletedBy', 'name email photo')
      .sort({ deletedAt: -1 })
      .limit(500)
      .lean();
    res.json({ retentionDays: RETENTION_DAYS, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const { entityType, entity } = await restoreFromTrash({
      trashId: req.params.id,
      organizationId: req.organizationId,
      userId: req.user._id
    });
    res.json({ restored: true, entityType, entityId: entity._id, title: entity.title });
  } catch (error) {
    if (error instanceof TrashError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
