const mongoose = require('mongoose');
const historyPlugin = require('./plugins/history');

const ActivitySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  title: { type: String, required: true },
  description: String,
  date: Date,
  status: { 
    type: String, 
    enum: ['pending', 'in-progress', 'completed', 'cancelled', 'overdue'], 
    default: 'pending' 
  },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  // Proyecto del cliente en el que se trabajó (subdocumento de Client.projects)
  projectId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  // El formulario ya enviaba el tipo, pero sin este campo Mongoose lo descartaba.
  type: {
    type: String,
    // recurring: tarea diaria que no vence ni se completa; se registra con "+" cada día (dailyLog)
    enum: ['task', 'bug', 'feature', 'user-story', 'recurring'],
    default: 'task'
  },
  // Registro de la tarea recurrente: una entrada por persona y por día (fecha de Costa Rica)
  dailyLog: [{
    date: String, // 'YYYY-MM-DD'
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now }
  }],
  // Feature (otra Activity de type 'feature' del mismo proyecto) a la que
  // pertenece esta tarea — arma la cascada Proyecto → Feature → Tarea del Backlog.
  featureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', default: null, index: true },
  acceptanceCriteria: { type: String, default: '' },
  // Etiquetas libres (p. ej. el sprint) para filtrar el backlog y sacar estadísticas.
  // Se guardan en minúsculas y sin espacios sobrantes (ver normalizeTags en routes/activities.js).
  tags: { type: [String], default: [], index: true },
  environment: {
    type: String,
    enum: ['development', 'testing', 'production', null],
    default: null
  },
  // Adjuntos: enlaces externos (Drive, SharePoint...), capturas de pantalla
  // guardadas en la propia base como data URL comprimida, o documentos (PDF,
  // Word, Excel) en GridFS (fileId) — nada en el disco del servidor, que en
  // Render se borra en cada despliegue.
  attachments: [{
    kind: { type: String, enum: ['link', 'image', 'file'], default: 'link' },
    name: String,
    url: String,
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    mimetype: String,
    size: Number,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now }
  }],
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Referencia a múltiples miembros del equipo
  priority: { 
    type: String, 
    enum: ['low', 'medium', 'high', 'urgent'], 
    default: 'medium' 
  },
  // Fecha de entrega pactada: una vez puesta solo la cambia el líder del área
  // o un administrador (ver services/taskApprovalService.js).
  dueDate: { type: Date },
  // Fecha real en que se terminó; se pone sola al completar y se puede ajustar.
  endDate: { type: Date, default: null },
  // Evitan reenviar el mismo recordatorio de vencimiento en cada corrida del cron.
  // Se resetean a false cuando dueDate cambia (ver PUT /:id).
  dueSoonNotified: { type: Boolean, default: false },
  overdueNotified: { type: Boolean, default: false },
  estimatedTime: { type: String }, // Ej: "2 horas", "30 minutos"
  taskId: { type: String }, // ✅ ID de la tarea del board asociada (para sincronización)
  // Vinculación con Casos y artículos de Wiki
  linkedCases: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Case' }],
  linkedWikiArticles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Wiki' }],
  completionPercentage: { type: Number, default: 0, min: 0, max: 100 },
  timeSpent: { type: Number, default: 0 }, // En segundos
  activeSessions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startTime: { type: Date, default: Date.now }
  }],
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: String,
    images: [{ url: String, name: String }],
    createdAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Quien creó la actividad
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Historial de acciones (history, logChange, logAction)
ActivitySchema.plugin(historyPlugin);

// Middleware para actualizar updatedAt en cada modificación
ActivitySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Activity', ActivitySchema);
