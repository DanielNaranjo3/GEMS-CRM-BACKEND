const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Activity = require('../models/Activity');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { notifyMentions, notifyAssignment, notifyComment } = require('../services/notificationHelpers');
const { HISTORY_POPULATE, commentSnippet, applyTrackedUpdates } = require('../services/historyService');
const {
  TaskApprovalError,
  guardDueDateUpdate,
  recordAutoApproval,
  deleteOrRequest
} = require('../services/taskApprovalService');
const activityFiles = require('../services/activityFileStore');

// Campos que no se registran como cambio en el historial: internos o con registro propio.
const UNTRACKED_FIELDS = new Set([
  'updatedAt', 'comments', 'activeSessions', 'timeSpent', 'taskId',
  'dueSoonNotified', 'overdueNotified', 'attachments', 'dailyLog'
]);

// Campos cuyo valor no se guarda en el historial (solo que cambiaron), por tamaño.
const VALUELESS_FIELDS = new Set(['description', 'acceptanceCriteria']);

// Los selects del formulario mandan '' cuando no hay valor; para un ObjectId o
// un enum eso es un error de validación, así que se normaliza a null. Una
// feature no puede colgar de otra feature (la cascada es Feature → Tarea).
// Las features son bloques amplios de tiempo: solo Nueva (pending) o Terminada (completed).
const FEATURE_STATUSES = new Set(['pending', 'completed']);

// Etiquetas en minúsculas, sin repetir y con un tope razonable.
function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const clean = list
    .map(t => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40))
    .filter(Boolean);
  return [...new Set(clean)].slice(0, 20);
}

function normalizeActivityBody(body) {
  const clean = { ...body };
  for (const field of ['featureId', 'environment', 'projectId', 'endDate']) {
    if (clean[field] === '') clean[field] = null;
  }
  if (clean.tags !== undefined) clean.tags = normalizeTags(clean.tags);
  if (clean.type === 'feature') {
    clean.featureId = null;
    if (clean.status !== undefined && !FEATURE_STATUSES.has(clean.status)) clean.status = 'pending';
  }
  // Una recurrente no vence: sin fecha de entrega (el cron de vencimientos la ignora)
  if (clean.type === 'recurring') clean.dueDate = null;
  // El registro diario y los adjuntos tienen sus propias rutas
  delete clean.dailyLog;
  delete clean.attachments;
  return clean;
}

// Adjuntos: solo enlaces o capturas en la base (ver models/Activity.js).
// El frontend comprime la captura antes de enviarla; este tope (≈1.5 MB en
// base64) protege el documento, que en MongoDB no puede pasar de 16 MB.
const MAX_IMAGE_DATA_URL_LENGTH = 2_000_000;
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const HTTP_URL = /^https?:\/\/\S+$/i;

// Los listados no necesitan las capturas (pesan); el detalle sí las trae.
const LIST_EXCLUDE = '-history -attachments';

// Al completar una actividad sin fecha de fin real, se pone la de ahora.
function fillEndDate(activity, updates) {
  const completing = updates.status === 'completed' && activity.status !== 'completed';
  const endDate = updates.endDate !== undefined ? updates.endDate : activity.endDate;
  if (completing && !endDate) updates.endDate = new Date();
}

// Fecha "de hoy" para el registro diario, en hora de Costa Rica (el servidor corre en UTC)
function todayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
}

// Populate del detalle completo (GET /:id y respuestas de mutaciones del modal)
function populateActivityDetail(query) {
  return query
    .populate('clientId', 'name email company')
    .populate('assignedTo', 'name email role photo avatar')
    .populate('createdBy', 'name email photo')
    .populate('comments.userId', 'name email photo')
    .populate('attachments.uploadedBy', 'name email photo')
    .populate(HISTORY_POPULATE);
}

// Configuración de multer para imágenes de comentarios
const commentsUploadDir = path.join(__dirname, '..', 'uploads', 'activity-comments');
if (!fs.existsSync(commentsUploadDir)) {
  fs.mkdirSync(commentsUploadDir, { recursive: true });
}
const commentImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, commentsUploadDir),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `comment-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  }
});
const commentImageUpload = multer({
  storage: commentImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB por imagen
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes'), false);
    }
    cb(null, true);
  }
});

// Crear nueva actividad
router.post('/', authenticateToken, async (req, res) => {
  console.log('🚀 [ACTIVITIES] Iniciando creación de nueva actividad');
  console.log('📝 [ACTIVITIES] Datos recibidos:', JSON.stringify(req.body, null, 2));

  try {
    const userId = req.user?._id || req.user?.id;
    const activity = new Activity(normalizeActivityBody(req.body));
    // El autor es quien hace la petición, no lo que mande el cliente
    if (userId) activity.createdBy = userId;
    // El historial solo lo escribe el servidor
    activity.history = [];
    activity.logAction('created', userId);
    await activity.save();

    // Notificación: asignación al crear la actividad
    notifyAssignment({
      assignedTo: activity.assignedTo,
      entityType: 'activity',
      entityId: activity._id,
      entityTitle: activity.title,
      fromUserId: req.user?._id || req.user?.id
    });

    console.log('✅ [ACTIVITIES] Activity saved with ID:', activity._id);
    console.log('👤 [ACTIVITIES] Saved assignedTo:', activity.assignedTo);

    // Poblar la actividad creada antes de enviarla
    const populatedActivity = await Activity.findById(activity._id)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo phone avatar')
      .populate('createdBy', 'name email photo');

    console.log('✅ [ACTIVITIES] Actividad creada exitosamente');
    res.json(populatedActivity);
  } catch (error) {
    console.error('❌ [ACTIVITIES] Error creating activity:', error);
    res.status(400).json({ error: error.message });
  }
});

// Obtener actividades pendientes asignadas al usuario logueado
router.get('/mine', async (req, res) => {
  try {
    // El ID del usuario logueado debe estar en req.user._id (middleware de autenticación)
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const activities = await Activity.find({ assignedTo: { $in: [userId] }, status: 'pending' })
      .select(LIST_EXCLUDE)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo')
      .sort({ dueDate: 1 });
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener todas las actividades
router.get('/', async (req, res) => {
  try {
    const { assignedTo, status, projectId, type, tag } = req.query;

    // Construir filtros
    let filter = {};
    if (assignedTo) {
      filter.assignedTo = { $in: [assignedTo] };
    }
    if (status) {
      filter.status = status;
    }
    if (projectId) {
      filter.projectId = projectId;
    }
    if (type) {
      filter.type = type;
    }
    if (tag) {
      filter.tags = String(tag).trim().toLowerCase();
    }

    const activities = await Activity.find(filter)
      .select(LIST_EXCLUDE)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo')
      .populate('comments.userId', 'name email photo')
      .sort({ createdAt: -1 });

    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Etiquetas usadas en la organización, para sugerirlas y filtrar
router.get('/tags', async (req, res) => {
  try {
    const tags = await Activity.distinct('tags', { organizationId: req.organizationId });
    res.json(tags.filter(Boolean).sort((a, b) => a.localeCompare(b, 'es')));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener actividad por ID (con comentarios poblados)
router.get('/:id', async (req, res) => {
  try {
    const activity = await populateActivityDetail(
      Activity.findOne({ _id: req.params.id, organizationId: req.organizationId })
    );

    if (!activity) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }
    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener actividades asignadas a un usuario específico
router.get('/assigned/:userId', async (req, res) => {
  try {
    console.log('[API] Buscando actividades para assignedTo:', req.params.userId);
    const activities = await Activity.find({ assignedTo: { $in: [req.params.userId] } })
      .select(LIST_EXCLUDE)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo')
      .sort({ dueDate: 1 });
    console.log('[API] Actividades encontradas:', activities.length);
    res.json(activities);
  } catch (error) {
    console.error('❌ Error obteniendo actividades asignadas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Actualizar actividad
router.put('/:id', async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });

    if (!activity) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }

    const previousDueDate = activity.dueDate ? activity.dueDate.getTime() : null;

    // La fecha de entrega pactada solo la cambia el líder del área o un
    // administrador (ver taskApprovalService); con autoaprobación queda la traza.
    const { updates, autoApproval } = await guardDueDateUpdate({
      req,
      entity: activity,
      updates: normalizeActivityBody(req.body)
    });
    // Un cambio de tipo a feature también suelta la feature padre que tuviera
    // y la deja en uno de sus dos estados
    if ((updates.type ?? activity.type) === 'feature') {
      updates.featureId = null;
      const status = updates.status ?? activity.status;
      if (!FEATURE_STATUSES.has(status)) updates.status = 'pending';
    }
    fillEndDate(activity, updates);

    await applyTrackedUpdates(activity, updates, userId, {
      untracked: UNTRACKED_FIELDS,
      valueless: VALUELESS_FIELDS
    });

    // Si la fecha límite cambió, vuelve a avisar cuando corresponda en vez de
    // quedarse callado por haber avisado sobre la fecha anterior.
    const newDueDate = activity.dueDate ? activity.dueDate.getTime() : null;
    if (previousDueDate !== newDueDate) {
      activity.dueSoonNotified = false;
      activity.overdueNotified = false;
    }

    // Como el findByIdAndUpdate anterior: no revalidar campos que no se tocaron
    await activity.save({ validateModifiedOnly: true });

    if (autoApproval) {
      await recordAutoApproval({ req, kind: 'due-date-extension', entityType: 'activity', entity: activity, ...autoApproval });
    }

    const populated = await populateActivityDetail(Activity.findById(activity._id));

    if (autoApproval) return res.json({ ...populated.toJSON(), dueDateAutoApproved: true });
    res.json(populated);
  } catch (error) {
    if (error instanceof TaskApprovalError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    res.status(400).json({ error: error.message });
  }
});

// Cambiar estado de actividad
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    
    if (!activity) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }
    if (activity.type === 'feature' && !FEATURE_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Una feature solo puede estar Nueva o Terminada' });
    }

    const updates = { status };
    fillEndDate(activity, updates);
    await applyTrackedUpdates(activity, updates, req.user?._id || req.user?.id);
    activity.updatedAt = new Date();

    // Si se marca como completada, detener todas las sesiones activas
    if (status === 'completed') {
      activity.completionPercentage = 100;
      
      if (activity.activeSessions && activity.activeSessions.length > 0) {
        const now = new Date();
        activity.activeSessions.forEach(session => {
          const elapsedSeconds = Math.floor((now - session.startTime) / 1000);
          activity.timeSpent = (activity.timeSpent || 0) + elapsedSeconds;
        });
        activity.activeSessions = [];
      }
    }

    await activity.save();
    
    const populated = await Activity.findById(activity._id)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo');

    res.json(populated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Reasignar actividad
router.patch('/:id/assign', authenticateToken, async (req, res) => {
  try {
    const { assignedTo } = req.body;

    // Verificar que el usuario existe
    if (assignedTo) {
      const user = await User.findById(assignedTo);
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
    }

    const existing = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!existing) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }

    await applyTrackedUpdates(existing, { assignedTo }, req.user?._id || req.user?.id);
    await existing.save({ validateModifiedOnly: true });

    const activity = await Activity.findById(existing._id)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo');

    // Notificar nueva asignación
    notifyAssignment({
      assignedTo: activity.assignedTo,
      entityType: 'activity',
      entityId: activity._id,
      entityTitle: activity.title,
      fromUserId: req.user?._id || req.user?.id
    });

    res.json(activity);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Actualizar progreso
router.patch('/:id/progress', async (req, res) => {
  try {
    const { completionPercentage } = req.body;
    const existing = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!existing) return res.status(404).json({ error: 'Actividad no encontrada' });

    await applyTrackedUpdates(existing, { completionPercentage }, req.user?._id || req.user?.id);
    await existing.save({ validateModifiedOnly: true });

    const activity = await Activity.findById(existing._id)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo');
    res.json(activity);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Toggle Timer
router.post('/:id/timer', async (req, res) => {
  try {
    const { action, userId, minutes } = req.body; // action: 'start' | 'stop' | 'add_manual'
    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    if (!activity.activeSessions) activity.activeSessions = [];

    if (action === 'start') {
      const isActive = activity.activeSessions.some(s => s.userId.toString() === userId);
      if (!isActive) {
        activity.activeSessions.push({ userId, startTime: new Date() });
      }
    } else if (action === 'stop') {
      const sessionIndex = activity.activeSessions.findIndex(s => s.userId.toString() === userId);
      if (sessionIndex > -1) {
        const session = activity.activeSessions[sessionIndex];
        const elapsedSeconds = Math.floor((new Date() - session.startTime) / 1000);
        activity.timeSpent = (activity.timeSpent || 0) + elapsedSeconds;
        activity.activeSessions.splice(sessionIndex, 1);
      }
    } else if (action === 'add_manual') {
      if (minutes && !isNaN(minutes)) {
        activity.timeSpent = (activity.timeSpent || 0) + (parseInt(minutes) * 60);
      }
    }
    
    await activity.save();
    
    const updatedActivity = await Activity.findById(activity._id)
      .populate('clientId', 'name email company')
      .populate('assignedTo', 'name email role photo avatar')
      .populate('createdBy', 'name email photo');
      
    res.json(updatedActivity);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Eliminar actividad (va a la papelera, ver services/trashService.js)
// Solo el líder del área, un administrador o quien tiene autoaprobación (403 para el resto).
router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteOrRequest({
      req,
      entityType: 'activity',
      entityId: req.params.id,
      reason: req.body?.reason || req.query.reason
    });
    if (!result) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }
    res.json({ success: true, autoApproved: !!result.autoApproved });
  } catch (error) {
    if (error instanceof TaskApprovalError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADJUNTOS ====================

// Body: { kind: 'link', url, name? }  o  { kind: 'image', dataUrl, name? }
router.post('/:id/attachments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { kind, url, dataUrl } = req.body || {};
    const name = (req.body?.name || '').toString().trim().slice(0, 200);

    let attachment;
    if (kind === 'link') {
      const link = (url || '').toString().trim();
      if (!HTTP_URL.test(link) || link.length > 2000) {
        return res.status(400).json({ error: 'El enlace debe empezar con http:// o https://' });
      }
      attachment = { kind: 'link', name: name || new URL(link).hostname, url: link };
    } else if (kind === 'image') {
      const data = (dataUrl || '').toString();
      if (!IMAGE_DATA_URL.test(data)) {
        return res.status(400).json({ error: 'La captura debe ser una imagen PNG, JPG, WEBP o GIF' });
      }
      if (data.length > MAX_IMAGE_DATA_URL_LENGTH) {
        return res.status(413).json({ error: 'La captura es demasiado pesada (máx. ~1.5 MB)' });
      }
      const mimetype = data.slice(5, data.indexOf(';'));
      attachment = { kind: 'image', name: name || 'Captura de pantalla', url: data, mimetype, size: Math.round(data.length * 0.75) };
    } else {
      return res.status(400).json({ error: 'Tipo de adjunto no válido (link o image)' });
    }

    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    activity.attachments.push({ ...attachment, uploadedBy: userId, uploadedAt: new Date() });
    activity.logAction('attachment_added', userId, { newValue: attachment.name });
    await activity.save({ validateModifiedOnly: true });

    res.json(await populateActivityDetail(Activity.findById(activity._id)));
  } catch (error) {
    console.error('Error agregando adjunto a actividad:', error);
    res.status(500).json({ error: error.message });
  }
});

// Documentos (PDF, Word, Excel) en GridFS — multipart con el campo "file"
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: activityFiles.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!activityFiles.isAllowedDocument(file)) {
      return cb(new Error('Solo se permiten archivos PDF, Word o Excel'), false);
    }
    cb(null, true);
  }
});

function handleDocumentUpload(req, res, next) {
  documentUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'El archivo pesa más de 5 MB' });
    }
    return res.status(400).json({ error: err.message });
  });
}

router.post('/:id/attachments/file', authenticateToken, handleDocumentUpload, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    // multer entrega el nombre en latin1; los acentos se recuperan así
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const name = ((req.body?.name || '').toString().trim() || originalName).slice(0, 200);
    const fileId = await activityFiles.saveFile({
      buffer: req.file.buffer,
      filename: originalName,
      mimetype: req.file.mimetype,
      metadata: { activityId: activity._id, organizationId: req.organizationId, uploadedBy: userId }
    });

    activity.attachments.push({
      kind: 'file',
      name,
      fileId,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedBy: userId,
      uploadedAt: new Date()
    });
    activity.logAction('attachment_added', userId, { newValue: name });
    await activity.save({ validateModifiedOnly: true });

    res.json(await populateActivityDetail(Activity.findById(activity._id)));
  } catch (error) {
    console.error('Error subiendo documento a actividad:', error);
    res.status(500).json({ error: error.message });
  }
});

// Descarga del documento (el frontend lo pide con el token y lo abre como blob)
router.get('/:id/attachments/:attachmentId/file', async (req, res) => {
  try {
    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId })
      .select('attachments');
    const attachment = activity?.attachments.id(req.params.attachmentId);
    if (!attachment || !attachment.fileId) return res.status(404).json({ error: 'Adjunto no encontrado' });

    res.set('Content-Type', attachment.mimetype || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.name || 'archivo')}`);
    activityFiles.openDownload(attachment.fileId)
      .on('error', () => {
        if (!res.headersSent) res.status(404).json({ error: 'El archivo ya no existe' });
        else res.end();
      })
      .pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TAREAS RECURRENTES ====================

// "+" del día: registra que la persona hizo hoy la tarea recurrente. Pulsarlo
// de nuevo el mismo día lo deshace (por si fue un clic por error).
router.post('/:id/daily-check', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    if (activity.type !== 'recurring') {
      return res.status(400).json({ error: 'Solo las tareas recurrentes tienen registro diario' });
    }

    const today = todayKey();
    const existing = activity.dailyLog.find(e => e.date === today && String(e.userId) === String(userId));
    if (existing) {
      activity.dailyLog.pull(existing._id);
      activity.logAction('daily_unchecked', userId, { newValue: today });
    } else {
      activity.dailyLog.push({ date: today, userId, at: new Date() });
      activity.logAction('daily_checked', userId, { newValue: today });
    }
    await activity.save({ validateModifiedOnly: true });

    res.json(await populateActivityDetail(Activity.findById(activity._id)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id/attachments/:attachmentId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const attachment = activity.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Adjunto no encontrado' });

    activity.logAction('attachment_deleted', userId, { oldValue: attachment.name });
    const fileId = attachment.fileId;
    activity.attachments.pull(req.params.attachmentId);
    await activity.save({ validateModifiedOnly: true });
    if (fileId) await activityFiles.deleteFiles([fileId]);

    res.json(await populateActivityDetail(Activity.findById(activity._id)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== COMENTARIOS ====================

// Agregar comentario a una actividad (soporta texto + imágenes via multipart)
router.post(
  '/:id/comments',
  authenticateToken,
  commentImageUpload.array('images', 10),
  async (req, res) => {
    try {
      const userId = req.user?._id || req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });

      const text = (req.body?.text || '').toString();
      const files = req.files || [];

      if (!text.trim() && files.length === 0) {
        return res.status(400).json({ error: 'El comentario no puede estar vacío' });
      }

      const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
      if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

      // Construir URLs públicas de las imágenes
      const host = `${req.protocol}://${req.get('host')}`;
      const images = files.map(f => ({
        url: `${host}/uploads/activity-comments/${f.filename}`,
        name: f.originalname
      }));

      activity.logAction('comment_added', userId, { newValue: commentSnippet(text) });
      activity.comments.push({ userId, text, images, createdAt: new Date() });
      await activity.save();

      // Notificaciones: menciones + comentario general a otros asignados
      notifyMentions({
        text,
        entityType: 'activity',
        entityId: activity._id,
        entityTitle: activity.title,
        fromUserId: userId
      });
      notifyComment({
        recipients: activity.assignedTo || [],
        entityType: 'activity',
        entityId: activity._id,
        entityTitle: activity.title,
        fromUserId: userId,
        snippet: text.slice(0, 80)
      });

      const populated = await populateActivityDetail(Activity.findById(activity._id));

      res.json(populated);
    } catch (error) {
      console.error('Error agregando comentario a actividad:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Editar comentario (solo el autor)
router.put('/:id/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { text } = req.body;

    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const comment = activity.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comentario no encontrado' });

    if (String(comment.userId) !== String(userId)) {
      return res.status(403).json({ error: 'Solo el autor puede editar su comentario' });
    }

    activity.logAction('comment_edited', userId, {
      oldValue: commentSnippet(comment.text),
      newValue: commentSnippet(text)
    });
    comment.text = text;
    await activity.save();

    const populated = await populateActivityDetail(Activity.findById(activity._id));

    res.json(populated);
  } catch (error) {
    console.error('Error editando comentario:', error);
    res.status(500).json({ error: error.message });
  }
});

// Eliminar comentario (solo el autor)
router.delete('/:id/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;

    const activity = await Activity.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const comment = activity.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comentario no encontrado' });

    if (String(comment.userId) !== String(userId)) {
      return res.status(403).json({ error: 'Solo el autor puede eliminar su comentario' });
    }

    activity.logAction('comment_deleted', userId, { oldValue: commentSnippet(comment.text) });
    activity.comments.pull(req.params.commentId);
    await activity.save();

    const populated = await populateActivityDetail(Activity.findById(activity._id));

    res.json(populated);
  } catch (error) {
    console.error('Error eliminando comentario:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
