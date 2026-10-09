const mongoose = require('mongoose');

/**
 * Solicitud de autorización sobre una actividad o una tarea del tablero que
 * debe aprobar el líder del área de quien la pide
 * (ver services/taskApprovalService.js):
 *
 * - 'due-date-extension': ampliar la fecha de entrega (dueDate).
 * - 'deletion': eliminar la actividad o tarea.
 */
const TaskApprovalRequestSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },

  kind: { type: String, enum: ['due-date-extension', 'deletion'], required: true, index: true },

  entityType: { type: String, enum: ['activity', 'task'], required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  // Copia del título: sirve para listar y para recordar qué se eliminó
  entityTitle: { type: String, default: '' },

  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Área del solicitante en el momento de pedir la autorización
  department: { type: String, default: null },

  // Solo para 'due-date-extension'
  currentDueDate: { type: Date, default: null },
  requestedDueDate: { type: Date, default: null },

  reason: { type: String, default: '', trim: true, maxlength: 1000 },

  // Quiénes pueden aprobarla: líderes del área del solicitante (o, si el área no
  // tiene líder, su supervisor o los administradores de la organización).
  approvers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
  approverSource: { type: String, enum: ['department-leader', 'supervisor', 'admin'], default: 'department-leader' },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewComment: { type: String, default: '', trim: true, maxlength: 1000 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

TaskApprovalRequestSchema.index({ entityType: 1, entityId: 1, status: 1 });
TaskApprovalRequestSchema.index({ approvers: 1, status: 1, createdAt: -1 });

TaskApprovalRequestSchema.pre('validate', function (next) {
  if (this.kind === 'due-date-extension' && !this.requestedDueDate) {
    return next(new Error('La solicitud de ampliación necesita la nueva fecha de entrega'));
  }
  next();
});

TaskApprovalRequestSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('TaskApprovalRequest', TaskApprovalRequestSchema);
