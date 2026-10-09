/**
 * Autorizaciones sobre actividades y tareas del tablero: ampliar la fecha de
 * entrega y eliminar.
 *
 * - Acortar el plazo o ponerlo por primera vez: lo puede hacer cualquiera.
 * - Ampliar el plazo, quitarlo o eliminar la tarea: solo un administrador de la
 *   organización o el líder del área de alguno de los asignados.
 * - Cualquier otra persona genera una solicitud que debe aprobar el líder del
 *   área a la que pertenece. Si su área no tiene líder, la aprueba su supervisor
 *   y, si tampoco tiene, los administradores de la organización.
 *
 * El área y el rol de líder se leen del Membership de la organización y, si no
 * están ahí, del usuario (la pantalla de Equipo los guardaba solo en el usuario).
 */
const mongoose = require('mongoose');
const Membership = require('../models/Membership');
const User = require('../models/User');
const Activity = require('../models/Activity');
const Task = require('../models/Task');
const Notification = require('../models/Notification');
const TaskApprovalRequest = require('../models/TaskApprovalRequest');

// Diferencias menores a un minuto no cuentan: el formulario manda la fecha sin segundos.
const TOLERANCE_MS = 60 * 1000;

const MODELS = { activity: Activity, task: Task };

class TaskApprovalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function idOf(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function normalizeDepartment(value) {
  return (value || '').toString().trim().toLowerCase();
}

function toTime(value) {
  if (value === null || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? NaN : time;
}

/**
 * Clasifica el cambio de fecha: 'none' | 'set' | 'shorten' | 'extend' | 'remove' | 'invalid'.
 * `incoming === undefined` significa que la petición no toca la fecha.
 */
function classifyDueDateChange(currentDueDate, incoming) {
  if (incoming === undefined) return 'none';
  const current = currentDueDate ? new Date(currentDueDate).getTime() : null;
  const next = toTime(incoming);
  if (Number.isNaN(next)) return 'invalid';
  if (current === null) return next === null ? 'none' : 'set';
  if (next === null) return 'remove';
  if (Math.abs(next - current) <= TOLERANCE_MS) return 'none';
  return next < current ? 'shorten' : 'extend';
}

function isOrgAdmin(req) {
  const m = req.membership;
  return !!(req.isSuperAdminSession || (m && (m.isOwner || m.role === 'admin')));
}

function buildProfile(membership, user) {
  return {
    userId: String(user._id),
    name: user.name,
    email: user.email,
    isActive: user.isActive !== false,
    department: (membership?.department || user.department || null),
    isLeader: membership?.departmentRole === 'leader' || user.departmentRole === 'leader',
    supervisor: idOf(membership?.supervisor || user.supervisor),
    isAdmin: !!(membership && (membership.isOwner || membership.role === 'admin')),
    selfApproval: membership?.selfApproval === true
  };
}

/**
 * Área, rol de líder y supervisor efectivos de cada usuario en la organización.
 * Devuelve Map<userId, perfil>.
 */
async function getProfiles(organizationId, userIds) {
  const ids = [...new Set(userIds.map(idOf).filter(Boolean))];
  const profiles = new Map();
  if (ids.length === 0) return profiles;

  const memberships = await Membership.find({
    organization: organizationId,
    user: { $in: ids },
    status: 'active'
  }).populate('user', 'name email department departmentRole supervisor isActive');

  for (const m of memberships) {
    if (!m.user) continue;
    profiles.set(String(m.user._id), buildProfile(m, m.user));
  }

  // Usuarios sin membership (p. ej. super-admin en sesión virtual)
  const missing = ids.filter(id => !profiles.has(id));
  if (missing.length > 0) {
    const users = await User.find({ _id: { $in: missing } }).select('name email department departmentRole supervisor isActive');
    for (const u of users) profiles.set(String(u._id), buildProfile(null, u));
  }
  return profiles;
}

function assigneeIds(entity) {
  const raw = entity.assignedTo;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(idOf).filter(Boolean);
}

/** ¿Es administrador o líder de un área? (puede recibir solicitudes para aprobar) */
async function isReviewer(req) {
  if (isOrgAdmin(req)) return true;
  const userId = idOf(req.user?._id);
  const me = (await getProfiles(req.organizationId, [userId])).get(userId);
  return !!(me && me.isLeader && normalizeDepartment(me.department));
}

/**
 * ¿Puede quien hace la petición ampliar el plazo o eliminar esta entidad sin
 * pedir autorización, y por qué?
 * - 'admin': administrador de la organización.
 * - 'leader': líder de un área y la tarea es de esa área (algún asignado
 *   pertenece a ella, él mismo está asignado o no hay asignados).
 * - 'self-approval': tiene el permiso especial de autoaprobación; no pide
 *   permiso pero la acción queda registrada como solicitud autoaprobada.
 * - null: debe pedir autorización.
 */
async function getDirectAccess(req, entity) {
  if (isOrgAdmin(req)) return 'admin';
  const userId = idOf(req.user?._id);
  const assignees = assigneeIds(entity);
  const profiles = await getProfiles(req.organizationId, [userId, ...assignees]);
  const me = profiles.get(userId);
  if (!me) return null;

  const myDepartment = normalizeDepartment(me.department);
  if (me.isLeader && myDepartment) {
    const ownsTask = assignees.length === 0 || assignees.includes(userId) ||
      assignees.some(id => normalizeDepartment(profiles.get(id)?.department) === myDepartment);
    if (ownsTask) return 'leader';
  }
  if (me.selfApproval) return 'self-approval';
  return null;
}

async function canManageDirectly(req, entity) {
  return !!(await getDirectAccess(req, entity));
}

/**
 * Deja la traza de una acción hecha con autoaprobación: una solicitud que nace
 * aprobada por la misma persona. Los aprobadores que le habrían tocado quedan
 * registrados para que la vean en su historial; no se les notifica.
 */
async function recordAutoApproval({ req, kind, entityType, entity, currentDueDate = null, requestedDueDate = null, reason = '' }) {
  const requesterId = idOf(req.user._id);
  let department = null;
  let approvers = [];
  try {
    const resolved = await resolveApprovers(req.organizationId, requesterId);
    department = resolved.department;
    approvers = resolved.approvers;
  } catch (e) {
    console.warn('recordAutoApproval: no se pudieron resolver aprobadores:', e.message);
  }

  return TaskApprovalRequest.create({
    organizationId: req.organizationId,
    kind,
    entityType,
    entityId: entity._id,
    entityTitle: entity.title || '',
    requestedBy: requesterId,
    department,
    currentDueDate: kind === 'due-date-extension' ? (currentDueDate || null) : null,
    requestedDueDate: kind === 'due-date-extension' ? new Date(requestedDueDate) : null,
    reason: (reason || '').toString().trim().slice(0, 1000),
    approvers,
    approverSource: 'self-approval',
    autoApproved: true,
    status: 'approved',
    reviewedBy: requesterId,
    reviewedAt: new Date(),
    reviewComment: 'Autoaprobada con permiso especial'
  });
}

/**
 * Quién aprueba una solicitud del usuario: líderes de su área; si no hay, su
 * supervisor; si tampoco, los administradores. Nunca el propio solicitante.
 */
async function resolveApprovers(organizationId, requesterId) {
  const requester = (await getProfiles(organizationId, [requesterId])).get(String(requesterId));
  const department = normalizeDepartment(requester?.department);

  const memberships = await Membership.find({ organization: organizationId, status: 'active' })
    .populate('user', 'name email department departmentRole supervisor isActive');
  const team = memberships
    .filter(m => m.user && m.user.isActive !== false && String(m.user._id) !== String(requesterId))
    .map(m => buildProfile(m, m.user));

  if (department) {
    const leaders = team.filter(p => p.isLeader && normalizeDepartment(p.department) === department);
    if (leaders.length > 0) {
      return { department: requester.department, source: 'department-leader', approvers: leaders.map(p => p.userId) };
    }
  }

  const supervisor = requester?.supervisor && team.find(p => p.userId === requester.supervisor);
  if (supervisor) {
    return { department: requester?.department || null, source: 'supervisor', approvers: [supervisor.userId] };
  }

  const admins = team.filter(p => p.isAdmin);
  return { department: requester?.department || null, source: 'admin', approvers: admins.map(p => p.userId) };
}

function formatDateEs(date) {
  if (!date) return 'sin fecha';
  return new Date(date).toLocaleString('es-CR', {
    timeZone: 'America/Costa_Rica',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

async function notify(organizationId, userIds, { title, message, request, fromUserId }) {
  try {
    const ops = userIds
      .filter(uid => uid && String(uid) !== String(fromUserId))
      .map(uid => ({
        organizationId,
        userId: uid,
        category: 'approval',
        entityType: request.entityType,
        entityId: request.entityId,
        title,
        message,
        read: false,
        fromUserId,
        metadata: {
          requestId: request._id,
          kind: request.kind,
          status: request.status,
          currentDueDate: request.currentDueDate,
          requestedDueDate: request.requestedDueDate
        }
      }));
    if (ops.length > 0) await Notification.insertMany(ops);
  } catch (e) {
    console.warn('taskApproval notify error:', e.message);
  }
}

/**
 * Crea la solicitud (reemplaza la pendiente del mismo tipo, solicitante y
 * entidad) y avisa a quienes la pueden aprobar.
 */
async function createApprovalRequest({ req, kind, entityType, entity, requestedDueDate = null, reason = '' }) {
  const requesterId = idOf(req.user._id);
  const { department, source, approvers } = await resolveApprovers(req.organizationId, requesterId);
  if (approvers.length === 0) {
    throw new TaskApprovalError(409, 'NO_APPROVER',
      'No hay un líder de área, supervisor ni administrador que pueda aprobar la solicitud');
  }

  await TaskApprovalRequest.updateMany(
    { organizationId: req.organizationId, kind, entityType, entityId: entity._id, requestedBy: requesterId, status: 'pending' },
    { $set: { status: 'cancelled', reviewComment: 'Reemplazada por una solicitud nueva', updatedAt: new Date() } }
  );

  const request = await TaskApprovalRequest.create({
    organizationId: req.organizationId,
    kind,
    entityType,
    entityId: entity._id,
    entityTitle: entity.title || '',
    requestedBy: requesterId,
    department,
    currentDueDate: kind === 'due-date-extension' ? (entity.dueDate || null) : null,
    requestedDueDate: kind === 'due-date-extension' ? new Date(requestedDueDate) : null,
    reason: (reason || '').toString().trim().slice(0, 1000),
    approvers,
    approverSource: source
  });

  const who = req.user.name || 'Un miembro del equipo';
  const message = kind === 'deletion'
    ? `${who} pide eliminar "${entity.title}"`
    : `${who} pide mover "${entity.title}" del ${formatDateEs(entity.dueDate)} al ${formatDateEs(request.requestedDueDate)}`;
  await notify(req.organizationId, approvers, {
    title: kind === 'deletion' ? 'Solicitud para eliminar una tarea' : 'Solicitud de ampliación de plazo',
    message,
    request,
    fromUserId: requesterId
  });

  return request;
}

/**
 * Valida el cambio de fecha que trae un PUT de actividad o tarea.
 * Devuelve las actualizaciones a aplicar (sin dueDate si requiere aprobación)
 * y, en ese caso, `pendingExtension` con los datos para crear la solicitud.
 * Lanza TaskApprovalError si se intenta quitar la fecha sin permiso.
 */
async function guardDueDateUpdate({ req, entity, updates }) {
  const clean = { ...updates };
  const reason = clean.dueDateChangeReason;
  delete clean.dueDateChangeReason;

  const change = classifyDueDateChange(entity.dueDate, clean.dueDate);
  if (change === 'invalid') {
    throw new TaskApprovalError(400, 'INVALID_DUE_DATE', 'La fecha de entrega no es válida');
  }
  if (change !== 'extend' && change !== 'remove') {
    return { updates: clean, pendingExtension: null, autoApproval: null };
  }
  const access = await getDirectAccess(req, entity);
  if (access === 'admin' || access === 'leader') {
    return { updates: clean, pendingExtension: null, autoApproval: null };
  }
  // Autoaprobación: amplía sin pedir permiso y deja la traza (quitar la fecha
  // sigue siendo solo de líderes y administradores).
  if (access === 'self-approval' && change === 'extend') {
    return {
      updates: clean,
      pendingExtension: null,
      autoApproval: { currentDueDate: entity.dueDate || null, requestedDueDate: clean.dueDate, reason }
    };
  }
  if (change === 'remove') {
    throw new TaskApprovalError(403, 'DUE_DATE_REMOVAL_FORBIDDEN',
      'Solo el líder del área o un administrador puede quitar la fecha de entrega');
  }

  const requestedDueDate = clean.dueDate;
  delete clean.dueDate;
  return { updates: clean, pendingExtension: { requestedDueDate, reason }, autoApproval: null };
}

/** Resumen que se adjunta a la respuesta para que el frontend avise. */
async function describeRequest(request) {
  const populated = await TaskApprovalRequest.findById(request._id)
    .populate('approvers', 'name email photo')
    .lean();
  return {
    _id: populated._id,
    kind: populated.kind,
    autoApproved: !!populated.autoApproved,
    status: populated.status,
    currentDueDate: populated.currentDueDate,
    requestedDueDate: populated.requestedDueDate,
    approverSource: populated.approverSource,
    approvers: populated.approvers
  };
}

function canReview(req, request) {
  if (isOrgAdmin(req)) return true;
  const me = idOf(req.user._id);
  return (request.approvers || []).some(id => idOf(id) === me);
}

async function loadEntity(entityType, entityId, organizationId) {
  const Model = MODELS[entityType];
  if (!Model) throw new TaskApprovalError(400, 'INVALID_ENTITY', 'Tipo de entidad no válido');
  if (!mongoose.Types.ObjectId.isValid(entityId)) {
    throw new TaskApprovalError(404, 'ENTITY_NOT_FOUND', 'No se encontró la tarea');
  }
  const entity = await Model.findOne({ _id: entityId, organizationId });
  if (!entity) throw new TaskApprovalError(404, 'ENTITY_NOT_FOUND', 'No se encontró la tarea');
  return entity;
}

/** Aplica la nueva fecha a la entidad y deja el cambio en su historial. */
async function applyDueDate(entityType, entity, newDueDate, userId) {
  const previous = entity.dueDate || null;
  entity.dueDate = new Date(newDueDate);
  entity.logChange('dueDate', previous ? previous.toISOString() : null, entity.dueDate.toISOString(), userId);

  if (entityType === 'activity') {
    entity.dueSoonNotified = false;
    entity.overdueNotified = false;
    if (entity.status === 'overdue' && entity.dueDate > new Date()) entity.status = 'pending';
  }
  await entity.save({ validateModifiedOnly: true });
  return entity;
}

/**
 * Elimina la actividad o tarea con los mismos efectos que el DELETE original y
 * cancela las solicitudes pendientes que quedan sin objeto.
 */
async function deleteEntity(entityType, entityId, organizationId) {
  const Model = MODELS[entityType];
  const entity = await Model.findOneAndDelete({ _id: entityId, organizationId });
  if (!entity) return null;

  // Al borrar una feature, sus tareas no se borran: quedan "Sin feature"
  if (entityType === 'activity' && entity.type === 'feature') {
    await Activity.updateMany(
      { featureId: entity._id, organizationId },
      { $set: { featureId: null } }
    );
  }

  await TaskApprovalRequest.updateMany(
    { organizationId, entityType, entityId: entity._id, status: 'pending' },
    { $set: { status: 'cancelled', reviewComment: 'La tarea fue eliminada', updatedAt: new Date() } }
  );
  return entity;
}

/**
 * Para el DELETE de actividades y tareas: elimina si quien pide puede hacerlo;
 * si no, crea la solicitud de autorización.
 * Devuelve { deleted: true } | { deleted: false, request } | null si no existe.
 */
async function deleteOrRequest({ req, entityType, entityId, reason }) {
  const Model = MODELS[entityType];
  if (!mongoose.Types.ObjectId.isValid(entityId)) return null;
  const entity = await Model.findOne({ _id: entityId, organizationId: req.organizationId });
  if (!entity) return null;

  const access = await getDirectAccess(req, entity);
  if (access) {
    // Con autoaprobación queda la traza antes de borrar (después ya no hay título)
    const trace = access === 'self-approval'
      ? await recordAutoApproval({ req, kind: 'deletion', entityType, entity, reason })
      : null;
    await deleteEntity(entityType, entity._id, req.organizationId);
    return { deleted: true, autoApproved: !!trace };
  }

  const request = await createApprovalRequest({ req, kind: 'deletion', entityType, entity, reason });
  return { deleted: false, request: await describeRequest(request) };
}

async function finishReview(req, request, status, comment) {
  request.status = status;
  request.reviewedBy = idOf(req.user._id);
  request.reviewedAt = new Date();
  request.reviewComment = (comment || '').toString().trim().slice(0, 1000);
  await request.save();
}

async function approveRequest(req, request, comment) {
  const reviewerId = idOf(req.user._id);
  const reviewer = req.user.name || 'Tu líder';

  if (request.kind === 'deletion') {
    // Si ya no existe, la solicitud igual se cierra como aprobada
    await deleteEntity(request.entityType, request.entityId, req.organizationId);
    await finishReview(req, request, 'approved', comment);
    await notify(req.organizationId, [request.requestedBy], {
      title: 'Eliminación aprobada',
      message: `${reviewer} aprobó eliminar "${request.entityTitle}"`,
      request,
      fromUserId: reviewerId
    });
    return request;
  }

  const entity = await loadEntity(request.entityType, request.entityId, req.organizationId);
  await applyDueDate(request.entityType, entity, request.requestedDueDate, reviewerId);
  await finishReview(req, request, 'approved', comment);
  await notify(req.organizationId, [request.requestedBy], {
    title: 'Ampliación de plazo aprobada',
    message: `${reviewer} aprobó mover "${request.entityTitle}" al ${formatDateEs(request.requestedDueDate)}`,
    request,
    fromUserId: reviewerId
  });
  return request;
}

async function rejectRequest(req, request, comment) {
  const reviewerId = idOf(req.user._id);
  await finishReview(req, request, 'rejected', comment);

  const detail = request.reviewComment ? `: ${request.reviewComment}` : '';
  const isDeletion = request.kind === 'deletion';
  await notify(req.organizationId, [request.requestedBy], {
    title: isDeletion ? 'Eliminación rechazada' : 'Ampliación de plazo rechazada',
    message: `${req.user.name || 'Tu líder'} rechazó ${isDeletion ? 'eliminar' : 'ampliar'} "${request.entityTitle}"${detail}`,
    request,
    fromUserId: reviewerId
  });
  return request;
}

module.exports = {
  TaskApprovalError,
  classifyDueDateChange,
  isOrgAdmin,
  isReviewer,
  getDirectAccess,
  canManageDirectly,
  recordAutoApproval,
  resolveApprovers,
  guardDueDateUpdate,
  createApprovalRequest,
  describeRequest,
  canReview,
  loadEntity,
  applyDueDate,
  deleteOrRequest,
  approveRequest,
  rejectRequest
};
