const mongoose = require('mongoose');

const modulePerm = {
  view: { type: Boolean, default: false },
  create: { type: Boolean, default: false },
  edit: { type: Boolean, default: false },
  delete: { type: Boolean, default: false }
};

const membershipSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  // Rol textual para compatibilidad con el código existente (admin/manager/user/support/employee).
  role: {
    type: String,
    required: true,
    default: 'employee'
  },
  // Rol referenciado al modelo Role (opcional, por organización).
  roleRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    default: null
  },
  isOwner: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['active', 'invited', 'suspended'],
    default: 'active',
    index: true
  },
  // Per-org overrides de cargo/departamento
  department: { type: String, default: null },
  departmentRole: {
    type: String,
    enum: ['member', 'leader'],
    default: 'member'
  },
  position: { type: String, default: null },
  // Permiso especial (lo activa un administrador): amplía plazos y elimina tareas
  // sin pedir autorización. Cada acción queda registrada como autoaprobada.
  selfApproval: { type: Boolean, default: false },
  supervisor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  permissions: {
    dashboard: { type: Boolean, default: true },
    clients: modulePerm,
    activities: modulePerm,
    reports: {
      view: { type: Boolean, default: false },
      export: { type: Boolean, default: false }
    },
    accounting: modulePerm,
    cases: modulePerm,
    team: modulePerm
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  invitedAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },
  lastActiveAt: { type: Date, default: null }
}, {
  timestamps: true
});

// Un usuario solo puede tener una membership por organización
membershipSchema.index({ user: 1, organization: 1 }, { unique: true });

module.exports = mongoose.model('Membership', membershipSchema);
