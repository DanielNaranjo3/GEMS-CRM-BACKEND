const mongoose = require('mongoose');

const CaseSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  // Información básica del caso
  titulo: { 
    type: String, 
    required: true 
  },
  descripcion: { 
    type: String, 
    required: true 
  },
  tipo: { 
    type: String, 
    required: true,
    enum: ['documento', 'incidencia', 'seguimiento']
  },
  
  // Estado y prioridad
  estado: { 
    type: String, 
    required: true,
    enum: ['abierto', 'en_progreso', 'resuelto', 'cerrado'],
    default: 'abierto'
  },
  prioridad: {
    type: String,
    enum: ['baja', 'media', 'alta', 'critica'],
    default: 'media'
  },
  
  // Relaciones
  cliente_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Client',
    required: false 
  },
  // Subdocumento de Client.projects — se resuelve junto con cliente_id
  proyecto_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: false
  },
  asignado_a: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Team',
    required: false 
  },
  
  // Archivos y documentos
  archivos: [{
    nombre: String,
    url: String,
    tipo: String, // pdf, docx, xlsx, img, etc.
    tamaño: Number,
    fecha_subida: { type: Date, default: Date.now }
  }],
  
  // Fechas importantes
  fecha_limite: {
    type: Date,
    required: false
  },
  fecha_resolucion: {
    type: Date,
    required: false
  },
  
  // Seguimiento y comentarios
  comentarios: [{
    autor: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Team' 
    },
    comentario: String,
    fecha: { type: Date, default: Date.now },
    tipo: {
      type: String,
      enum: ['comentario', 'actualizacion', 'resolucion'],
      default: 'comentario'
    }
  }],
  
  // Tags y categorización
  tags: [String],
  categoria: String,
  
  // Campos específicos para incidencias
  gravedad: {
    type: String,
    enum: ['menor', 'moderada', 'mayor', 'critica'],
    required: false
  },
  impacto: {
    type: String,
    enum: ['bajo', 'medio', 'alto'],
    required: false
  },
  
  // Campos específicos para seguimientos
  progreso: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  hitos: [{
    nombre: String,
    descripcion: String,
    fecha_objetivo: Date,
    fecha_completado: Date,
    completado: { type: Boolean, default: false }
  }],
  
  // Nuevo: Contenido tipo Wiki / Base de Conocimiento
  wikiContent: {
    type: String, // HTML o Markdown enriquecido
    required: false
  },
  metodologia: {
    type: String,
    required: false
  },
  
  // Nuevo: Seguimiento Diario (Daily Logs)
  dailyLogs: [{
    fecha: { type: Date, default: Date.now },
    autor: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    que_se_hizo: String,
    bloqueos: String,
    siguientes_pasos: String,
    sentimiento: { 
      type: String, 
      enum: ['😊', '😐', '😟', '🔥'], // Estado de ánimo del caso
      default: '😐' 
    }
  }],

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
  },

  createdAt: {
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Middleware para actualizar updatedAt
CaseSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

// Índices para búsqueda optimizada
CaseSchema.index({ tipo: 1, estado: 1 });
CaseSchema.index({ cliente_id: 1, proyecto_id: 1 });
CaseSchema.index({ asignado_a: 1 });
CaseSchema.index({ 'tags': 1 });

module.exports = mongoose.model('Case', CaseSchema);
