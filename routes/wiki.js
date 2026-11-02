const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Wiki = require('../models/Wiki');

// Configuración de multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// multipart manda '' cuando el select queda vacío → null (ObjectId no castea '')
const normalizeLinkIds = (data) => {
  for (const k of ['cliente_id', 'proyecto_id']) if (k in data && !data[k]) data[k] = null;
};

// Obtener todos los artículos de la wiki
router.get('/', async (req, res) => {
  try {
    const { categoria, search, cliente_id, proyecto_id } = req.query;
    // Bug de multi-tenancy: antes esta ruta no filtraba por organización y
    // devolvía artículos de wiki de TODAS las organizaciones.
    let query = { organizationId: req.organizationId };
    if (categoria) query.categoria = categoria;
    if (cliente_id) query.cliente_id = cliente_id;
    if (proyecto_id) query.proyecto_id = proyecto_id;
    if (search) {
      query.$or = [
        { titulo: { $regex: search, $options: 'i' } },
        { descripcion: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } }
      ];
    }
    const articles = await Wiki.find(query)
      .populate('autor', 'name email')
      .populate('cliente_id', 'name company projects')
      .populate('linkedTickets', 'subject ticketNumber status')
      .sort({ updatedAt: -1 });
    res.json(articles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Obtener un artículo por ID
router.get('/:id', async (req, res) => {
  try {
    const article = await Wiki.findOne({ _id: req.params.id, organizationId: req.organizationId })
      .populate('autor', 'name email')
      .populate('cliente_id', 'name company projects')
      .populate('linkedTickets');
    if (!article) return res.status(404).json({ message: 'Artículo no encontrado' });
    article.vistas += 1;
    await article.save();
    res.json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Crear un nuevo artículo
router.post('/', upload.array('archivos', 5), async (req, res) => {
  try {
    const wikiData = { 
      ...req.body, 
      organizationId: req.organizationId,
      autor: req.userId || req.body.autor
    };
    normalizeLinkIds(wikiData);
    console.log('[DEBUG WIKI POST] req.organizationId:', req.organizationId);
    console.log('[DEBUG WIKI POST] wikiData.organizationId:', wikiData.organizationId);
    if (req.files) {
      wikiData.archivos = req.files.map(file => ({
        nombre: file.originalname,
        url: `/uploads/${file.filename}`,
        tipo: file.mimetype
      }));
    }
    const article = new Wiki(wikiData);
    const newArticle = await article.save();
    res.status(201).json(newArticle);
  } catch (err) {
    console.error('Error en POST /api/wiki:', err);
    res.status(500).json({ message: err.message, stack: err.stack });
  }
});

// Actualizar un artículo
router.put('/:id', upload.array('archivos', 5), async (req, res) => {
  try {
    const updateData = { 
      ...req.body,
      organizationId: req.organizationId 
    };
    normalizeLinkIds(updateData);
    const article = await Wiki.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!article) return res.status(404).json({ message: 'Artículo no encontrado' });

    if (req.files && req.files.length > 0) {
      const newFiles = req.files.map(file => ({
        nombre: file.originalname,
        url: `/uploads/${file.filename}`,
        tipo: file.mimetype
      }));
      updateData.archivos = [...(article.archivos || []), ...newFiles];
    }

    const updatedArticle = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      updateData,
      { new: true }
    );
    res.json(updatedArticle);
  } catch (err) {
    console.error('Error en PUT /api/wiki:', err);
    res.status(500).json({ message: err.message });
  }
});

// Eliminar un artículo
router.delete('/:id', async (req, res) => {
  try {
    await Wiki.findOneAndDelete({ _id: req.params.id, organizationId: req.organizationId });
    res.json({ message: 'Artículo eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST - Vincular ticket a un artículo de wiki
router.post('/:id/tickets', async (req, res) => {
  try {
    const { ticketId } = req.body;
    const wiki = await Wiki.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    
    if (!wiki.linkedTickets.includes(ticketId)) {
      wiki.linkedTickets.push(ticketId);
      await wiki.save();
    }
    
    const populated = await Wiki.findById(wiki._id)
      .populate('autor', 'name email')
      .populate('linkedTickets');
      
    res.json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE - Desvincular ticket de un artículo de wiki
router.delete('/:id/tickets/:ticketId', async (req, res) => {
  try {
    const wiki = await Wiki.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    
    wiki.linkedTickets = wiki.linkedTickets.filter(id => id.toString() !== req.params.ticketId);
    await wiki.save();
    
    const populated = await Wiki.findById(wiki._id)
      .populate('autor', 'name email')
      .populate('linkedTickets');
      
    res.json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── Vinculación con tareas ──
router.post('/:id/tasks', async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ message: 'taskId es requerido' });
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $addToSet: { linkedTasks: taskId } },
      { new: true }
    ).populate('linkedTasks', 'title status boardStatus priority');
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json(wiki);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id/tasks/:taskId', async (req, res) => {
  try {
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $pull: { linkedTasks: req.params.taskId } },
      { new: true }
    ).populate('linkedTasks', 'title status boardStatus priority');
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json(wiki);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── Vinculación con actividades ──
router.post('/:id/activities', async (req, res) => {
  try {
    const { activityId } = req.body;
    if (!activityId) return res.status(400).json({ message: 'activityId es requerido' });
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $addToSet: { linkedActivities: activityId } },
      { new: true }
    ).populate('linkedActivities', 'title status priority');
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json(wiki);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id/activities/:activityId', async (req, res) => {
  try {
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $pull: { linkedActivities: req.params.activityId } },
      { new: true }
    ).populate('linkedActivities', 'title status priority');
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json(wiki);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── Enlaces externos (Google Drive, OneDrive, etc. — sin subir archivo) ──
router.post('/:id/links', async (req, res) => {
  try {
    const { nombre, url } = req.body;
    if (!nombre || !url) return res.status(400).json({ message: 'nombre y url son requeridos' });
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $push: { enlacesExternos: { nombre, url, agregadoPor: req.userId, fecha: new Date() } } },
      { new: true }
    );
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.status(201).json(wiki.enlacesExternos[wiki.enlacesExternos.length - 1]);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id/links/:linkId', async (req, res) => {
  try {
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $pull: { enlacesExternos: { _id: req.params.linkId } } },
      { new: true }
    );
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── Hoja de cálculo embebida ──
// Límite de payload propio: el global de la API es 2MB (index.js), insuficiente
// para un snapshot de Univer con estilos y fórmulas aplicados.
const spreadsheetBodyParser = express.json({ limit: '10mb' });

router.get('/:id/spreadsheet', async (req, res) => {
  try {
    const wiki = await Wiki.findOne(
      { _id: req.params.id, organizationId: req.organizationId },
      'spreadsheet'
    );
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json({ spreadsheet: wiki.spreadsheet || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/:id/spreadsheet', spreadsheetBodyParser, async (req, res) => {
  try {
    const { snapshot } = req.body;
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { spreadsheet: snapshot ?? null },
      { new: true, select: '_id updatedAt' }
    );
    if (!wiki) return res.status(404).json({ message: 'Artículo no encontrado' });
    res.json({ success: true, updatedAt: wiki.updatedAt });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
