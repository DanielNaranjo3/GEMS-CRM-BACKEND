const mongoose = require('mongoose');

/**
 * Papelera: copia completa de una actividad o tarea del tablero eliminada.
 * Se puede restaurar hasta `expiresAt`; después services/trashService.js la
 * borra junto con sus documentos adjuntos.
 */
const TrashedItemSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  entityType: { type: String, enum: ['activity', 'task'], required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  title: { type: String, default: '' },
  // Subtipo de la actividad (feature, task...) para mostrarlo en la lista
  itemType: { type: String, default: null },
  // El documento tal cual estaba (sin populate)
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  // Tareas que colgaban de una feature eliminada: se vuelven a enlazar al restaurarla
  detachedChildIds: [{ type: mongoose.Schema.Types.ObjectId }],
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  deletedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true }
}, { minimize: false });

module.exports = mongoose.model('TrashedItem', TrashedItemSchema);
