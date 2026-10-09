const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Membership = require('../models/Membership');
const Role = require('../models/Role');
const Setting = require('../models/Setting');
const Task = require('../models/Task');
const Activity = require('../models/Activity');
const Case = require('../models/Case');
const Ticket = require('../models/Ticket');
const { authenticateToken, requireRole } = require('../middleware/auth');

// Middleware de autenticación para todas las rutas
router.use(authenticateToken);

// Middleware para verificar permisos de equipo
// Admin de la organización activa: dueño, rol admin en su membresía o super-admin.
// El rol del usuario (User.role) se mantiene por compatibilidad con cuentas viejas.
const isTeamAdmin = (req) => !!(
  req.isSuperAdminSession ||
  req.membership?.isOwner ||
  req.membership?.role === 'admin' ||
  req.user?.role === 'admin'
);

const checkTeamPermissions = (action) => {
  return (req, res, next) => {
    const user = req.user;
    console.log('🔐 Checking team permissions for:', user.email);

    // Admin always has full access
    if (isTeamAdmin(req)) {
      console.log('👑 Admin access granted');
      return next();
    }

    // Permiso de equipo en la membresía de la organización
    if (req.membership?.permissions?.team?.[action]) {
      return next();
    }
    
    // Por ahora, permitir a todos los usuarios autenticados ver el equipo para debugging
    if (action === 'view') {
      console.log('✅ Permitiendo vista de equipo (debug mode)');
      return next();
    }
    
    if (!user.permissions || !user.permissions.team || !user.permissions.team[action]) {
      console.log('❌ Permission denied for team action:', action);
      return res.status(403).json({ 
        success: false, 
        message: `No tienes permisos para realizar esta acción en la gestión de equipo: ${action}` 
      });
    }
    
    console.log('✅ Permission granted for team action:', action);
    next();
  };
};

// Obtener miembros del equipo (Memberships activos en la org) con paginación
router.get('/', checkTeamPermissions('view'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const skip = (page - 1) * limit;

    const baseFilter = { organization: req.organizationId, status: 'active' };

    const total = await Membership.countDocuments(baseFilter);
    const memberships = await Membership.find(baseFilter)
      .populate({ path: 'user', select: '-password', match: { isActive: true } })
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const data = memberships
      .filter(m => m.user) // descartar memberships cuyo user fue desactivado
      .map(m => ({
        _id: m.user._id,
        membershipId: m._id,
        name: m.user.name,
        email: m.user.email,
        role: m.role, // role per-org (del Membership)
        avatar: m.user.avatar,
        photo: m.user.photo,
        department: m.department || m.user.department,
        departmentRole: m.departmentRole || m.user.departmentRole,
        selfApproval: m.selfApproval === true,
        supervisor: m.supervisor || m.user.supervisor,
        position: m.position || m.user.position,
        phone: m.user.phone,
        isOwner: m.isOwner,
        isActive: m.user.isActive,
        lastLogin: m.user.lastLogin,
        createdAt: m.user.createdAt,
        updatedAt: m.user.updatedAt
      }));

    res.json({
      success: true,
      data,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener el equipo',
      error: error.message
    });
  }
});

// Crear nuevo miembro del equipo (usuario)
router.post('/', checkTeamPermissions('create'), async (req, res) => {
  try {
    const { name, email, password, role, department, departmentRole, supervisor, position, phone } = req.body;
    
    // Verificar que el email no exista
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'Ya existe un usuario con este email' 
      });
    }

    // Solo un administrador de la organización crea administradores o da autoaprobación
    if ((role === 'admin' || req.body.selfApproval === true) && !isTeamAdmin(req)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Solo los administradores pueden crear otros administradores' 
      });
    }

    // Asignar contraseña por defecto si no se proporciona
    const defaultPassword = password || 'gems12-';

    let permissions = req.body.permissions;
    if (!permissions) {
      const foundRole = await Role.findOne({ name: role });
      if (foundRole) {
        permissions = foundRole.permissions;
      }
    }

    const member = new User({
      name,
      email,
      password: defaultPassword,
      role: role || 'employee',
      department,
      departmentRole: departmentRole || 'member',
      supervisor: (supervisor && supervisor !== '') ? supervisor : null,
      position,
      phone,
      ...(permissions && { permissions }),
      isActive: true
    });

    await member.save();

    // Crear Membership en la organización activa para que aparezca en el equipo
    await Membership.create({
      user: member._id,
      organization: req.organizationId,
      role: role || 'employee',
      status: 'active',
      department,
      departmentRole: departmentRole || 'member',
      position,
      supervisor: (supervisor && supervisor !== '') ? supervisor : null,
      ...(permissions && { permissions }),
      selfApproval: req.body.selfApproval === true,
      invitedBy: req.user._id,
      acceptedAt: new Date()
    });

    // Remover password de la respuesta
    const memberResponse = member.toJSON();
    
    res.status(201).json({ 
      success: true, 
      message: `Miembro del equipo creado exitosamente${!password ? ' con contraseña por defecto: gems12-' : ''}`,
      data: memberResponse
    });
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      message: 'Error al crear miembro del equipo', 
      error: error.message 
    });
  }
});

// --- Organigrama (Org Chart) Endpoints ---
// Colocados antes de rutas con parámetros (/:id) para evitar colisiones de rutas

// Obtener organigrama
router.get('/orgchart', authenticateToken, async (req, res) => {
  try {
    // Intentar cargar desde Setting
    let setting = await Setting.findOne({ key: 'orgchart' });
    if (setting && setting.value) {
      try {
        const chart = JSON.parse(setting.value);
        return res.json({ success: true, data: chart });
      } catch (e) {
        // Si json inválido, continuar a fallback
        console.warn('Invalid orgchart JSON in settings, regenerating fallback');
      }
    }

    // Fallback: generar organigrama básico desde usuarios
    const users = await User.find({ isActive: true }).select('-password');
    const findByName = (name) => users.find(u => (u.name || '').toLowerCase().includes(name.toLowerCase()));

    const ceo = findByName('Sebastian') || null;
    const cto = findByName('Jacobo') || null;
    const coo = findByName('Luisa') || null;
    const clo = findByName('Isabella') || null;
    const headPeople = findByName('David') || null;

    const nodes = [];
    const mk = (id, title, name, level, parentId = null, user = null, description = '', isTeam = false) => ({
      id, title, name, level, parentId, description,
      // Multi-asignación compatible: preferimos assignees; userId/name se mantienen por compatibilidad
      assignees: user ? [{ userId: user._id, name: user.name, email: user.email }] : [],
      userId: user?._id || null,
      status: user ? 'filled' : 'vacant',
      isTeam
    });

    // Nivel 1
    nodes.push(mk('ceo', 'CEO & Fundador', ceo?.name || 'Sebastian', 1, null, ceo,
      'Visión estratégica, liderazgo general y toma de decisiones ejecutivas'));

    // Nivel 2
    nodes.push(mk('cto', 'CTO', cto?.name || 'Jacobo', 2, 'ceo', cto, 'Innovación tecnológica y desarrollo técnico'));
    nodes.push(mk('coo', 'COO', coo?.name || 'Luisa', 2, 'ceo', coo, 'Rendimiento de equipos y operaciones'));
    nodes.push(mk('clo', 'CLO', clo?.name || 'Isabella', 2, 'ceo', clo, 'Aspectos legales, contractuales y estructurales'));

    // Nivel 3
    nodes.push(mk('head-people', 'Head of People & Growth', headPeople?.name || 'David', 3, 'ceo', headPeople,
      'Desarrollo y crecimiento del talento humano'));
    nodes.push(mk('head-product', 'Head of Product', 'Por Contratar', 3, 'ceo', null));
    nodes.push(mk('head-sales', 'Head of Sales', 'Por Contratar', 3, 'ceo', null));
    nodes.push(mk('head-marketing', 'Head of Marketing', 'Por Contratar', 3, 'ceo', null));

    // Nivel 4 (equipos base vacantes)
    nodes.push(mk('team-dev', 'Equipo de Desarrollo', 'Equipo', 4, 'head-product', null, 'Developers, DevOps, QA', true));
    nodes.push(mk('team-design', 'Equipo de Diseño', 'Equipo', 4, 'head-product', null, 'UX/UI, Diseño gráfico', true));
    nodes.push(mk('team-sales', 'Equipo Comercial', 'Equipo', 4, 'head-sales', null, 'Ventas, Customer Success', true));
    nodes.push(mk('team-mkt', 'Equipo de Marketing', 'Equipo', 4, 'head-marketing', null, 'Content, Social Media, SEO', true));

    const chart = { nodes, updatedAt: new Date().toISOString() };
    return res.json({ success: true, data: chart, message: 'Fallback org chart generated' });
  } catch (error) {
    console.error('Error getting orgchart:', error);
    res.status(500).json({ success: false, message: 'Error al obtener organigrama', error: error.message });
  }
});

// Guardar/actualizar organigrama (solo admin)
router.put('/orgchart', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const chart = req.body;
    if (!chart || typeof chart !== 'object' || !Array.isArray(chart.nodes)) {
      return res.status(400).json({ success: false, message: 'Formato inválido de organigrama' });
    }
    const toSave = { ...chart, updatedAt: new Date().toISOString() };
    const json = JSON.stringify(toSave);
    await Setting.findOneAndUpdate(
      { key: 'orgchart' },
      { key: 'orgchart', value: json },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: toSave });
  } catch (error) {
    console.error('Error saving orgchart:', error);
    res.status(500).json({ success: false, message: 'Error al guardar organigrama', error: error.message });
  }
});

// Actualizar miembro del equipo
router.put('/:id', checkTeamPermissions('edit'), async (req, res) => {
  try {
    const { id } = req.params;

    // Solo los campos del formulario de Equipo. Nunca contraseña (tiene su ruta),
    // ni isSuperAdmin, isActive, 2FA u otros campos sensibles del usuario.
    const EDITABLE_FIELDS = ['name', 'email', 'phone', 'position', 'department', 'departmentRole', 'supervisor', 'role', 'permissions'];
    const updateData = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body?.[field] !== undefined) updateData[field] = req.body[field];
    }

    // Sanitizar supervisor (convertir string vacío a null para evitar errores de Mongoose)
    if (updateData.supervisor === '') {
      updateData.supervisor = null;
    }

    // Solo un administrador de la organización asigna o quita el rol de administrador
    // y cambia permisos. Antes se miraba User.role, que no es el rol en la organización:
    // un dueño/admin con otro rol global no podía nombrar administradores.
    const touchesAdmin = updateData.role === 'admin' || updateData.permissions !== undefined;
    if (touchesAdmin && !isTeamAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Solo los administradores pueden asignar el rol de administrador'
      });
    }

    // No permitir que un usuario se modifique a sí mismo para evitar auto-bloqueo
    if (id === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'No puedes modificar tu propio usuario'
      });
    }

    // Solo miembros de esta organización
    const targetMembership = await Membership.findOne({ user: id, organization: req.organizationId });
    if (!targetMembership) {
      return res.status(404).json({
        success: false,
        message: 'Miembro del equipo no encontrado'
      });
    }

    // Permiso de autoaprobación (vive en la membresía): solo un administrador lo cambia.
    // El formulario lo manda siempre, así que solo se valida si cambia de valor.
    const wantsSelfApproval = typeof req.body?.selfApproval === 'boolean' ? req.body.selfApproval : undefined;
    const selfApprovalChanged = wantsSelfApproval !== undefined && wantsSelfApproval !== (targetMembership.selfApproval === true);
    if (selfApprovalChanged && !isTeamAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Solo los administradores pueden dar o quitar la autoaprobación'
      });
    }

    // Quitarle el rol de administrador al dueño de la organización lo dejaría sin control
    if (updateData.role && updateData.role !== 'admin' && targetMembership.isOwner) {
      return res.status(400).json({
        success: false,
        message: 'El dueño de la organización debe seguir siendo administrador'
      });
    }

    if (updateData.role && !updateData.permissions) {
      const foundRole = await Role.findOne({ name: updateData.role });
      if (foundRole?.permissions) {
        updateData.permissions = typeof foundRole.permissions.toObject === 'function'
          ? foundRole.permissions.toObject()
          : foundRole.permissions;
      }
    }

    const member = await User.findByIdAndUpdate(
      id, 
      updateData, 
      { new: true, runValidators: true }
    ).select('-password');
    
    if (!member) {
      return res.status(404).json({ 
        success: false, 
        message: 'Miembro del equipo no encontrado'
      });
    }

    // El listado lee área, rol de líder, cargo y supervisor del Membership de la
    // organización; sin esto los cambios hechos aquí no se veían (y el líder de
    // área no podía aprobar ampliaciones de plazo ni eliminaciones).
    const membershipFields = ['department', 'departmentRole', 'position', 'supervisor'];
    const membershipUpdate = {};
    for (const field of membershipFields) {
      if (updateData[field] !== undefined) membershipUpdate[field] = updateData[field] === '' ? null : updateData[field];
    }
    if (membershipUpdate.departmentRole === null) membershipUpdate.departmentRole = 'member';
    if (selfApprovalChanged) membershipUpdate.selfApproval = wantsSelfApproval;
    // El rol que cuenta en la organización (permisos, menú, Autorizaciones) es el de
    // la membresía; antes solo se guardaba en el usuario y el cambio no se veía.
    if (updateData.role) {
      membershipUpdate.role = updateData.role;
      if (updateData.permissions && typeof updateData.permissions === 'object') {
        membershipUpdate.permissions = updateData.permissions;
      }
    }
    if (Object.keys(membershipUpdate).length > 0 && req.organizationId) {
      await Membership.updateOne(
        { user: member._id, organization: req.organizationId },
        { $set: membershipUpdate },
        { runValidators: true }
      );
    }

    // Misma forma que el listado: datos del usuario con lo que vive en la membresía
    const freshMembership = await Membership.findOne({ user: member._id, organization: req.organizationId }).lean();
    const memberData = member.toJSON();
    res.json({
      success: true,
      message: 'Miembro del equipo actualizado exitosamente',
      data: {
        ...memberData,
        membershipId: freshMembership?._id,
        role: freshMembership?.role || memberData.role,
        department: freshMembership?.department || memberData.department,
        departmentRole: freshMembership?.departmentRole || memberData.departmentRole,
        position: freshMembership?.position || memberData.position,
        supervisor: freshMembership?.supervisor || memberData.supervisor,
        isOwner: !!freshMembership?.isOwner,
        selfApproval: freshMembership?.selfApproval === true
      }
    });
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      message: 'Error al actualizar miembro del equipo', 
      error: error.message 
    });
  }
});

// Cambiar contraseña de un usuario (solo admin)
router.patch('/:id/password', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La nueva contraseña debe tener al menos 6 caracteres'
      });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    user.password = password;
    await user.save();

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al cambiar la contraseña',
      error: error.message
    });
  }
});

// Eliminar permanentemente (solo admin)
// COLOCADA ANTES de /:id para evitar que sea capturada por la ruta de soft delete
router.delete('/:id/permanent', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    
    if (id === req.user._id.toString()) {
      return res.status(400).json({ 
        success: false, 
        message: 'No puedes eliminar permanentemente tu propio usuario' 
      });
    }

    const member = await User.findByIdAndDelete(id);
    
    if (!member) {
      return res.status(404).json({ 
        success: false, 
        message: 'Miembro del equipo no encontrado' 
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Miembro del equipo eliminado permanentemente de la base de datos'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar permanentemente al miembro', 
      error: error.message 
    });
  }
});

// Desactivar miembro del equipo (soft delete)
router.delete('/:id', checkTeamPermissions('delete'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // No permitir eliminar al propio usuario
    if (id === req.user._id.toString()) {
      return res.status(400).json({ 
        success: false, 
        message: 'No puedes eliminar tu propio usuario' 
      });
    }

    // Realizar la reasignación de tareas y casos antes de desactivar
    // Esto asegura que el trabajo no quede huérfano y se mantengan las métricas
    
    // 1. Reasignar Casos y Tickets (Asignación única)
    await Case.updateMany({ asignado_a: id }, { asignado_a: req.user._id });
    await Ticket.updateMany({ assignedTo: id }, { assignedTo: req.user._id });

    // 2. Reasignar Tareas (Asignación múltiple)
    // Quitamos al usuario de todas las tareas. Si era el único, asignamos al admin.
    const tasksToReassign = await Task.find({ assignedTo: id });
    for (const task of tasksToReassign) {
      task.assignedTo = task.assignedTo.filter(uid => uid.toString() !== id);
      if (task.assignedTo.length === 0) {
        task.assignedTo.push(req.user._id);
      }
      await task.save();
    }

    // 3. Reasignar Actividades (Asignación múltiple)
    const activitiesToReassign = await Activity.find({ assignedTo: id });
    for (const activity of activitiesToReassign) {
      activity.assignedTo = activity.assignedTo.filter(uid => uid.toString() !== id);
      if (activity.assignedTo.length === 0) {
        activity.assignedTo.push(req.user._id);
      }
      await activity.save();
    }

    const member = await User.findByIdAndUpdate(
      id, 
      { isActive: false }, 
      { new: true }
    ).select('-password');
    
    if (!member) {
      return res.status(404).json({ 
        success: false, 
        message: 'Miembro del equipo no encontrado' 
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Miembro del equipo desactivado y sus responsabilidades han sido reasignadas exitosamente',
      data: member
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar miembro del equipo', 
      error: error.message 
    });
  }
});

// Reactivar miembro del equipo
router.put('/:id/activate', checkTeamPermissions('edit'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const member = await User.findByIdAndUpdate(
      id, 
      { isActive: true }, 
      { new: true }
    ).select('-password');
    
    if (!member) {
      return res.status(404).json({ 
        success: false, 
        message: 'Miembro del equipo no encontrado' 
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Miembro del equipo reactivado exitosamente',
      data: member
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error al reactivar miembro del equipo', 
      error: error.message 
    });
  }
});


module.exports = router;
