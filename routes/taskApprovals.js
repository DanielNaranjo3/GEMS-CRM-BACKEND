const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const TaskApprovalRequest = require('../models/TaskApprovalRequest');
const { authenticateToken, requireOrganization } = require('../middleware/auth');
const {
  TaskApprovalError,
  classifyDueDateChange,
  isOrgAdmin,
  canManageDirectly,
  resolveApprovers,
  createApprovalRequest,
  describeRequest,
  canReview,
  loadEntity,
  applyDueDate,
  approveRequest,
  rejectRequest
} = require('../services/taskApprovalService');

// Solicitudes de autorización sobre actividades y tareas: ampliar el plazo y eliminar.
// Reglas en services/taskApprovalService.js.

router.use(authenticateToken, requireOrganization);

const USER_FIELDS = 'name email photo department';
const KINDS = ['due-date-extension', 'deletion'];

function populateRequest(query) {
  return query
    .populate('requestedBy', USER_FIELDS)
    .populate('approvers', USER_FIELDS)
    .populate('reviewedBy', USER_FIELDS);
}

function handleError(res, error) {
  if (error instanceof TaskApprovalError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error('[TASK-APPROVALS]', error);
  return res.status(500).json({ error: error.message });
}

// Filtro de la bandeja: lo que me toca aprobar (los admin ven todo) o lo que pedí yo
function boxFilter(req, box) {
  if (box === 'mine') return { requestedBy: req.user._id };
  if (isOrgAdmin(req)) return {};
  return { approvers: req.user._id };
}

// Listar. ?box=inbox|mine (inbox por defecto) &status=pending|approved|rejected|cancelled|all
// &kind=due-date-extension|deletion (opcional)
router.get('/', async (req, res) => {
  try {
    const box = req.query.box === 'mine' ? 'mine' : 'inbox';
    const status = (req.query.status || 'pending').toString();
    const filter = { organizationId: req.organizationId, ...boxFilter(req, box) };
    if (status !== 'all') filter.status = status;
    if (KINDS.includes(req.query.kind)) filter.kind = req.query.kind;

    const requests = await populateRequest(
      TaskApprovalRequest.find(filter).sort({ createdAt: -1 }).limit(200)
    );
    res.json(requests);
  } catch (error) {
    handleError(res, error);
  }
});

// Cantidad de solicitudes pendientes por aprobar (para el badge del menú)
router.get('/pending-count', async (req, res) => {
  try {
    const count = await TaskApprovalRequest.countDocuments({
      organizationId: req.organizationId,
      status: 'pending',
      ...boxFilter(req, 'inbox')
    });
    res.json({ count });
  } catch (error) {
    handleError(res, error);
  }
});

// Estado de una actividad/tarea para el formulario: si puedo ampliar o eliminar
// sin autorización, quién aprobaría y las solicitudes pendientes.
router.get('/entity/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const entity = await loadEntity(entityType, entityId, req.organizationId);
    const [direct, pending] = await Promise.all([
      canManageDirectly(req, entity),
      populateRequest(TaskApprovalRequest.find({
        organizationId: req.organizationId, entityType, entityId: entity._id, status: 'pending'
      }).sort({ createdAt: -1 }))
    ]);

    let approverIds = [];
    let approverSource = null;
    if (!direct) {
      const resolved = await resolveApprovers(req.organizationId, req.user._id);
      approverSource = resolved.source;
      approverIds = resolved.approvers;
    }

    res.json({
      canManageDirectly: direct,
      approverSource,
      approverIds,
      pendingExtension: pending.find(r => r.kind === 'due-date-extension') || null,
      pendingDeletion: pending.find(r => r.kind === 'deletion') || null
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Pedir ampliación de plazo. Si quien la pide puede ampliar directamente, se aplica de una vez.
router.post('/due-date-extension', async (req, res) => {
  try {
    const { entityType, entityId, requestedDueDate, reason } = req.body || {};
    const entity = await loadEntity(entityType, entityId, req.organizationId);

    const change = classifyDueDateChange(entity.dueDate, requestedDueDate ?? null);
    if (change === 'invalid' || !requestedDueDate) {
      return res.status(400).json({ error: 'Indica una fecha de entrega válida', code: 'INVALID_DUE_DATE' });
    }
    if (change !== 'extend' && change !== 'set') {
      return res.status(400).json({
        error: 'La nueva fecha debe ser posterior a la fecha de entrega actual',
        code: 'NOT_AN_EXTENSION'
      });
    }

    if (change === 'set' || await canManageDirectly(req, entity)) {
      await applyDueDate(entityType, entity, requestedDueDate, req.user._id);
      return res.json({ applied: true, dueDate: entity.dueDate, status: entity.status });
    }

    const request = await createApprovalRequest({
      req, kind: 'due-date-extension', entityType, entity, requestedDueDate, reason
    });
    res.status(201).json({ applied: false, request: await describeRequest(request) });
  } catch (error) {
    handleError(res, error);
  }
});

async function findPendingForReview(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Solicitud no encontrada' });
    return null;
  }
  const request = await TaskApprovalRequest.findOne({ _id: req.params.id, organizationId: req.organizationId });
  if (!request) {
    res.status(404).json({ error: 'Solicitud no encontrada' });
    return null;
  }
  if (request.status !== 'pending') {
    res.status(409).json({ error: 'La solicitud ya fue atendida', code: 'NOT_PENDING' });
    return null;
  }
  return request;
}

// Aprobar: aplica la nueva fecha o elimina la actividad/tarea
router.post('/:id/approve', async (req, res) => {
  try {
    const request = await findPendingForReview(req, res);
    if (!request) return;
    if (!canReview(req, request)) {
      return res.status(403).json({ error: 'Solo el líder del área puede aprobar esta solicitud', code: 'NOT_APPROVER' });
    }
    await approveRequest(req, request, req.body?.comment);
    res.json(await populateRequest(TaskApprovalRequest.findById(request._id)));
  } catch (error) {
    handleError(res, error);
  }
});

// Rechazar
router.post('/:id/reject', async (req, res) => {
  try {
    const request = await findPendingForReview(req, res);
    if (!request) return;
    if (!canReview(req, request)) {
      return res.status(403).json({ error: 'Solo el líder del área puede rechazar esta solicitud', code: 'NOT_APPROVER' });
    }
    await rejectRequest(req, request, req.body?.comment);
    res.json(await populateRequest(TaskApprovalRequest.findById(request._id)));
  } catch (error) {
    handleError(res, error);
  }
});

// Cancelar mi propia solicitud pendiente
router.post('/:id/cancel', async (req, res) => {
  try {
    const request = await findPendingForReview(req, res);
    if (!request) return;
    if (String(request.requestedBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Solo quien hizo la solicitud puede cancelarla' });
    }
    request.status = 'cancelled';
    await request.save();
    res.json(await populateRequest(TaskApprovalRequest.findById(request._id)));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
