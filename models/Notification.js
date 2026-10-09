const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  // Destinatario
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  // Categoría de notificación
  category: {
    type: String,
    enum: ['mention', 'assignment', 'comment', 'due-soon', 'overdue', 'info', 'approval'],
    index: true
  },

  // Entidad relacionada
  entityType: { type: String, enum: ['activity', 'task', 'client', 'other'], default: 'other' },
  entityId: { type: mongoose.Schema.Types.ObjectId },

  // Contenido visible
  title: String,
  message: String,

  // Estado
  read: { type: Boolean, default: false, index: true },

  // Quién originó la notificación (autor del comentario, asignador, etc.)
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Metadatos extra para navegación o contexto
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Compatibilidad con notificaciones antiguas
  type: String,
  date: Date,
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },

  createdAt: { type: Date, default: Date.now, index: true },
});

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, read: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
