const mongoose = require('mongoose');

const wikiSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  titulo: {
    type: String,
    required: true,
    trim: true
  },
  categoria: {
    type: String,
    enum: ['proceso', 'codigo', 'manual', 'otros'],
    default: 'proceso'
  },
  contenido: {
    type: String,
    required: true
  },
  descripcion: {
    type: String,
    trim: true
  },
  tags: [String],
  // Vínculo opcional a cliente / proyecto (subdocumento de Client.projects)
  cliente_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: false
  },
  proyecto_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: false
  },
  autor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  archivos: [{
    nombre: String,
    url: String,
    tipo: String
  }],
  vistas: {
    type: Number,
    default: 0
  },
  linkedTickets: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ticket'
  }],
  linkedTasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  }],
  linkedActivities: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Activity'
  }],

  // Enlaces externos (Google Drive, OneDrive, etc.) — sin subir el archivo al servidor
  enlacesExternos: [{
    nombre: String,
    url: String,
    agregadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    fecha: { type: Date, default: Date.now }
  }],

  // Snapshot JSON de la hoja de cálculo embebida (Univer IWorkbookData)
  spreadsheet: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Wiki', wikiSchema);
