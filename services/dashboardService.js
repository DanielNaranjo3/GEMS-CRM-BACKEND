/**
 * Resumen del dashboard, calculado por persona y por alcance:
 *
 * - member: solo lo propio (actividades asignadas a quien consulta).
 * - leader: lo propio + la carga de su área (personas del mismo departamento).
 * - admin (administrador u owner de la organización, o rol manager): lo propio +
 *   la carga de todo el equipo + salud de la organización (clientes, proyectos,
 *   tickets, casos, aprobaciones).
 *
 * Las cubetas de fecha se calculan con la hora de Costa Rica (igual que el
 * registro diario de las tareas recurrentes) y son excluyentes entre sí:
 *   overdue  → fecha de entrega ya pasada, o estado `overdue` (lo pone el cron)
 *   today    → vence más tarde hoy
 *   week     → vence en los próximos 7 días (después de hoy)
 *   later    → vence después
 *   noDate   → activa sin fecha de entrega
 * Las features y las recurrentes no vencen: no entran en las cubetas.
 */
const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Client = require('../models/Client');
const Membership = require('../models/Membership');
const Ticket = require('../models/Ticket');
const Case = require('../models/Case');
const TaskApprovalRequest = require('../models/TaskApprovalRequest');

const TZ = 'America/Costa_Rica';
const TZ_OFFSET = '-06:00'; // Costa Rica no cambia de horario
const DAY_MS = 86400000;
const ACTIVE = ['pending', 'in-progress', 'overdue'];
const DATED_TYPES_EXCLUDED = ['recurring', 'feature'];

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const normalize = (v) => (v || '').toString().trim().toLowerCase();

function todayKey(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Límites del día de Costa Rica en los que cae `now`. */
function dayBounds(now = new Date()) {
  const key = todayKey(now);
  const start = new Date(`${key}T00:00:00${TZ_OFFSET}`);
  const end = new Date(start.getTime() + DAY_MS);
  return { key, start, end };
}

function viewerProfile(req) {
  const m = req.membership || {};
  const u = req.user || {};
  const role = m.role || u.role || 'employee';
  const isAdmin = !!(req.isSuperAdminSession || m.isOwner || role === 'admin' || role === 'manager');
  const department = m.department || u.department || null;
  const isLeader = m.departmentRole === 'leader' || u.departmentRole === 'leader';
  return {
    id: String(u._id),
    name: u.name,
    role,
    isAdmin,
    isLeader: !!isLeader,
    department,
    scope: isAdmin ? 'admin' : isLeader && department ? 'leader' : 'member'
  };
}

/** Expresiones de agregación que clasifican una actividad activa en su cubeta. */
function bucketExprs(now, bounds, weekEnd) {
  const active = { $in: ['$status', ACTIVE] };
  const dated = { $not: [{ $in: ['$type', DATED_TYPES_EXCLUDED] }] };
  const hasDue = { $gt: ['$dueDate', null] };
  const overdue = {
    $and: [active, dated, { $or: [{ $eq: ['$status', 'overdue'] }, { $and: [hasDue, { $lt: ['$dueDate', now] }] }] }]
  };
  const notOverdue = { $not: [overdue] };
  return {
    active,
    overdue,
    today: { $and: [active, dated, hasDue, notOverdue, { $lt: ['$dueDate', bounds.end] }] },
    week: { $and: [active, dated, hasDue, { $gte: ['$dueDate', bounds.end] }, { $lt: ['$dueDate', weekEnd] }] },
    later: { $and: [active, dated, hasDue, { $gte: ['$dueDate', weekEnd] }] },
    noDate: { $and: [active, dated, { $not: [hasDue] }] },
    inProgress: { $eq: ['$status', 'in-progress'] },
    highPriority: { $and: [active, { $in: ['$priority', ['high', 'urgent']] }] },
    completedWeek: { $and: [{ $eq: ['$status', 'completed'] }, { $gte: [{ $ifNull: ['$endDate', '$updatedAt'] }, new Date(now.getTime() - 7 * DAY_MS)] }] }
  };
}

function countFields(ex) {
  const sum = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  return {
    active: sum(ex.active),
    overdue: sum(ex.overdue),
    today: sum(ex.today),
    week: sum(ex.week),
    later: sum(ex.later),
    noDate: sum(ex.noDate),
    inProgress: sum(ex.inProgress),
    highPriority: sum(ex.highPriority),
    completedWeek: sum(ex.completedWeek)
  };
}

const EMPTY_COUNTS = { active: 0, overdue: 0, today: 0, week: 0, later: 0, noDate: 0, inProgress: 0, highPriority: 0, completedWeek: 0 };

function stripCounts(doc) {
  if (!doc) return { ...EMPTY_COUNTS };
  const out = {};
  for (const k of Object.keys(EMPTY_COUNTS)) out[k] = doc[k] || 0;
  return out;
}

/** Conteos de una persona (o de un filtro arbitrario). */
async function countActivities(orgId, match, ex) {
  const [row] = await Activity.aggregate([
    { $match: { organizationId: orgId, ...match } },
    { $group: { _id: null, ...countFields(ex) } }
  ]);
  return stripCounts(row);
}

/** Conteos por persona asignada (una fila por usuario). */
async function countByAssignee(orgId, userIds, ex) {
  const rows = await Activity.aggregate([
    { $match: { organizationId: orgId, status: { $in: [...ACTIVE, 'completed'] }, assignedTo: { $in: userIds } } },
    { $unwind: '$assignedTo' },
    { $match: { assignedTo: { $in: userIds } } },
    { $group: { _id: '$assignedTo', ...countFields(ex) } }
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), stripCounts(r));
  return map;
}

/** Lista corta de las actividades propias con fecha, ya clasificadas. */
async function myActivityLists(orgId, userId, now, bounds, weekEnd) {
  const docs = await Activity.find({
    organizationId: orgId,
    assignedTo: userId,
    status: { $in: ACTIVE },
    type: { $nin: DATED_TYPES_EXCLUDED }
  })
    .select('title status priority dueDate type clientId projectId tags completionPercentage')
    .populate('clientId', 'name company projects.name projects._id')
    .sort({ dueDate: 1 })
    .limit(120)
    .lean();

  const lists = { overdue: [], today: [], upcoming: [], noDate: [] };
  for (const a of docs) {
    const client = a.clientId && typeof a.clientId === 'object' ? a.clientId : null;
    const project = client && a.projectId
      ? (client.projects || []).find(p => String(p._id) === String(a.projectId))
      : null;
    const item = {
      _id: a._id,
      title: a.title,
      status: a.status,
      priority: a.priority,
      type: a.type,
      dueDate: a.dueDate || null,
      tags: a.tags || [],
      completionPercentage: a.completionPercentage || 0,
      client: client ? { _id: client._id, name: client.name, company: client.company } : null,
      project: project ? { _id: project._id, name: project.name } : null
    };
    const due = a.dueDate ? new Date(a.dueDate) : null;
    if (!due) lists.noDate.push(item);
    else if (a.status === 'overdue' || due < now) lists.overdue.push(item);
    else if (due < bounds.end) lists.today.push(item);
    else lists.upcoming.push(item);
  }
  lists.overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  lists.upcoming = lists.upcoming.slice(0, 15);
  lists.noDate = lists.noDate.slice(0, 10);
  return lists;
}

/** Rutinas diarias (recurrentes) asignadas: cuántas ya marcó hoy. */
async function myRoutines(orgId, userId, key) {
  const docs = await Activity.find({
    organizationId: orgId,
    assignedTo: userId,
    type: 'recurring',
    status: { $in: ACTIVE }
  }).select('title dailyLog').lean();
  const items = docs.map(d => ({
    _id: d._id,
    title: d.title,
    doneToday: (d.dailyLog || []).some(l => l.date === key && String(l.userId) === String(userId))
  }));
  return { total: items.length, doneToday: items.filter(i => i.doneToday).length, items: items.slice(0, 8) };
}

async function teamMembers(orgId, department) {
  const memberships = await Membership.find({ organization: orgId, status: 'active' })
    .populate({ path: 'user', select: 'name email photo avatar department departmentRole position isActive', match: { isActive: true } })
    .lean();
  const people = memberships
    .filter(m => m.user)
    .map(m => ({
      _id: String(m.user._id),
      name: m.user.name,
      email: m.user.email,
      photo: m.user.photo || m.user.avatar || null,
      role: m.role,
      department: m.department || m.user.department || null,
      departmentRole: m.departmentRole || m.user.departmentRole || 'member',
      position: m.position || m.user.position || null
    }));
  if (!department) return people;
  const dep = normalize(department);
  return people.filter(p => normalize(p.department) === dep);
}

async function orgHealth(orgId, ex) {
  const [clients, activities, tickets, cases, approvals] = await Promise.all([
    Client.aggregate([
      { $match: { organizationId: orgId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $ne: ['$status', 'inactive'] }, 1, 0] } },
          projects: { $sum: { $size: { $ifNull: ['$projects', []] } } },
          activeProjects: {
            $sum: {
              $size: {
                $filter: { input: { $ifNull: ['$projects', []] }, as: 'p', cond: { $eq: ['$$p.status', 'active'] } }
              }
            }
          }
        }
      }
    ]),
    countActivities(orgId, {}, ex),
    Ticket.countDocuments({ organizationId: orgId, status: { $in: ['new', 'open', 'waiting'] } }).catch(() => 0),
    Case.countDocuments({ organizationId: orgId, estado: { $nin: ['cerrado', 'resuelto', 'closed', 'resolved'] } }).catch(() => 0),
    TaskApprovalRequest.countDocuments({ organizationId: orgId, status: 'pending' })
  ]);
  const c = clients[0] || {};
  return {
    clients: { total: c.total || 0, active: c.active || 0 },
    projects: { total: c.projects || 0, active: c.activeProjects || 0 },
    activities,
    tickets: { open: tickets || 0 },
    cases: { open: cases || 0 },
    approvals: { pending: approvals || 0 }
  };
}

/** Actividades activas de la organización o del área, agrupadas por cliente (top). */
async function activeClients(orgId, userIds) {
  const match = { organizationId: orgId, status: { $in: ACTIVE }, clientId: { $ne: null } };
  if (userIds) match.assignedTo = { $in: userIds };
  const rows = await Activity.aggregate([
    { $match: match },
    { $group: { _id: '$clientId', active: { $sum: 1 }, overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } } } },
    { $sort: { active: -1 } },
    { $limit: 6 },
    { $lookup: { from: 'clients', localField: '_id', foreignField: '_id', as: 'client' } },
    { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, active: 1, overdue: 1, name: '$client.name', company: '$client.company' } }
  ]);
  return rows.filter(r => r.name);
}

async function buildSummary(req) {
  const now = new Date();
  const bounds = dayBounds(now);
  const weekEnd = new Date(bounds.end.getTime() + 7 * DAY_MS);
  const ex = bucketExprs(now, bounds, weekEnd);
  const orgId = oid(req.organizationId);
  const viewer = viewerProfile(req);
  const userId = oid(viewer.id);

  const [mine, lists, routines, approvalsInbox, approvalsMine] = await Promise.all([
    countActivities(orgId, { assignedTo: userId }, ex),
    myActivityLists(orgId, userId, now, bounds, weekEnd),
    myRoutines(orgId, userId, bounds.key),
    TaskApprovalRequest.countDocuments({
      organizationId: orgId, status: 'pending',
      ...(viewer.isAdmin ? {} : { approvers: userId })
    }),
    TaskApprovalRequest.countDocuments({ organizationId: orgId, status: 'pending', requestedBy: userId })
  ]);

  const summary = {
    generatedAt: now.toISOString(),
    today: bounds.key,
    viewer,
    mine,
    lists,
    routines,
    approvals: {
      toReview: viewer.isAdmin || viewer.isLeader ? approvalsInbox : 0,
      mine: approvalsMine,
      canReview: viewer.isAdmin || (viewer.isLeader && !!viewer.department)
    }
  };

  if (viewer.scope === 'leader' || viewer.scope === 'admin') {
    const people = await teamMembers(orgId, viewer.scope === 'leader' ? viewer.department : null);
    const ids = people.map(p => oid(p._id));
    const [perPerson, clients] = await Promise.all([
      countByAssignee(orgId, ids, ex),
      activeClients(orgId, viewer.scope === 'leader' ? ids : null)
    ]);
    const members = people.map(p => ({ ...p, stats: perPerson.get(p._id) || { ...EMPTY_COUNTS } }));
    const totals = members.reduce((acc, m) => {
      for (const k of Object.keys(EMPTY_COUNTS)) acc[k] += m.stats[k];
      return acc;
    }, { ...EMPTY_COUNTS });
    summary.team = {
      scope: viewer.scope,
      department: viewer.scope === 'leader' ? viewer.department : null,
      members,
      totals,
      clients
    };
  }

  if (viewer.scope === 'admin') {
    summary.org = await orgHealth(orgId, ex);
  }

  return summary;
}

module.exports = { buildSummary, dayBounds, todayKey };
