const cron = require('node-cron');
const Setting = require('../models/Setting');

// ═══════════════════════════════════════════════════════════════════════════
// Task Reports — DESHABILITADO
// El sistema original enviaba estos reportes vía WhatsApp (Baileys). Al eliminar
// la integración de WhatsApp se desactivó esta vía. Si se quiere recuperar la
// funcionalidad, reimplementar contra email (services/emailService.js) o un
// canal alternativo.
// ═══════════════════════════════════════════════════════════════════════════
function initTaskReportsCron(app) {
  console.log('ℹ️ Task reports cron desactivado (eliminada la integración WhatsApp).');
  // Mantener el hook para que las rutas de admin no fallen al llamarlo.
  app.set('updateTaskReportsCron', () => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// Team Report Cron (Email programado) — sigue activo
// ═══════════════════════════════════════════════════════════════════════════

const { sendTeamReport } = require('../services/teamReportService');

function initTeamReportsCron(app) {
  console.log('🔄 Inicializando cron para reportes de equipo por email...');

  let teamReportJob;

  async function updateTeamReportCron() {
    try {
      const settings = await Setting.findOne({ key: 'teamReports' });
      if (!settings?.value?.enabled) {
        if (teamReportJob) { teamReportJob.stop(); teamReportJob = null; }
        console.log('📧 Team report cron: deshabilitado');
        return;
      }

      const cfg = settings.value;
      if (teamReportJob) { teamReportJob.stop(); }

      let cronExpr;
      const h = cfg.hour || 8;
      const m = cfg.minute || 0;

      if (cfg.frequency === 'daily') {
        cronExpr = `0 ${m} ${h} * * 1,2,3,4,5`; // L-V
      } else if (cfg.frequency === 'monthly') {
        cronExpr = `0 ${m} ${h} 1 * *`; // Día 1 de cada mes
      } else {
        // weekly (default)
        const dow = cfg.dayOfWeek ?? 1; // lunes
        cronExpr = `0 ${m} ${h} * * ${dow}`;
      }

      console.log(`📧 Team report cron programado: ${cronExpr} (${cfg.frequency})`);

      teamReportJob = cron.schedule(cronExpr, async () => {
        console.log('⏰ Ejecutando reporte de equipo programado...');
        try {
          const result = await sendTeamReport({
            recipients: cfg.recipients,
            period: cfg.period || 'week',
            department: cfg.department,
          });
          console.log('✅ Reporte de equipo enviado:', result.success);

          settings.value.lastRun = new Date();
          settings.markModified('value');
          await settings.save();
        } catch (err) {
          console.error('❌ Error en reporte de equipo programado:', err.message);
        }
      });
    } catch (error) {
      console.error('❌ Error configurando team report cron:', error);
    }
  }

  updateTeamReportCron();
  app.set('updateTeamReportsCron', updateTeamReportCron);
  console.log('✅ Cron para reportes de equipo inicializado');
}

// ═══════════════════════════════════════════════════════════════════════════
// SLA Alert System Cron
// ═══════════════════════════════════════════════════════════════════════════
function initSlaCron() {
  console.log('🔄 Inicializando cron para SLA Alerts...');

  cron.schedule('*/15 * * * *', async () => {
    try {
      const { notifySLAAlert } = require('../services/emailService');
      const Ticket = require('../models/Ticket');

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const overdueTickets = await Ticket.find({
        status: 'new',
        slaNotified: { $ne: true },
        createdAt: { $lt: twoHoursAgo }
      });

      for (const ticket of overdueTickets) {
        console.log(`[SLA] Ticket #${ticket.ticketNumber} is overdue! Sending alert.`);
        await notifySLAAlert(ticket);
        ticket.slaNotified = true;
        await ticket.save();
      }
    } catch (err) {
      console.error('[SLA] Error running background check:', err);
    }
  });

  console.log('✅ Cron para SLA Alerts inicializado');
}

// ═══════════════════════════════════════════════════════════════════════════
// Vencimientos de Actividades (email + campanita) — solo módulo Actividades,
// no aplica a Soporte/Tickets (tiene su propio SLA arriba) ni al tablero Kanban.
// ═══════════════════════════════════════════════════════════════════════════
const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000; // avisar cuando falten <= 24h
const ACTIVE_STATUSES = ['pending', 'in-progress']; // completed/cancelled/overdue quedan fuera

function formatDueDateEs(date) {
  try {
    return new Date(date).toLocaleString('es-CR', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return String(date);
  }
}

function initActivityDueDateCron() {
  console.log('🔄 Inicializando cron de vencimientos de actividades...');

  cron.schedule('*/30 * * * *', async () => {
    try {
      const Activity = require('../models/Activity');
      const { notifyActivityDueDate } = require('./notificationHelpers');

      const now = new Date();
      const soonThreshold = new Date(now.getTime() + DUE_SOON_WINDOW_MS);

      // Por vencer: dentro de las próximas 24h, sin avisar aún
      const dueSoon = await Activity.find({
        dueDate: { $gte: now, $lte: soonThreshold },
        status: { $in: ACTIVE_STATUSES },
        type: { $nin: ['recurring', 'feature'] }, // las recurrentes y las features no vencen
        dueSoonNotified: { $ne: true }
      }).populate('assignedTo', 'name email');

      for (const activity of dueSoon) {
        await notifyActivityDueDate({ activity, kind: 'due-soon', dueDateLabel: formatDueDateEs(activity.dueDate) });
        activity.dueSoonNotified = true;
        await activity.save();
      }

      // Vencidas: fecha límite ya pasada, sin avisar aún
      const overdue = await Activity.find({
        dueDate: { $lt: now },
        status: { $in: ACTIVE_STATUSES },
        type: { $nin: ['recurring', 'feature'] }, // las recurrentes y las features no vencen
        overdueNotified: { $ne: true }
      }).populate('assignedTo', 'name email');

      for (const activity of overdue) {
        await notifyActivityDueDate({ activity, kind: 'overdue', dueDateLabel: formatDueDateEs(activity.dueDate) });
        activity.overdueNotified = true;
        await activity.save();
      }

      if (dueSoon.length || overdue.length) {
        console.log(`[Vencimientos] ${dueSoon.length} por vencer, ${overdue.length} vencidas — avisadas`);
      }
    } catch (err) {
      console.error('[Vencimientos] Error revisando actividades:', err);
    }
  });

  console.log('✅ Cron de vencimientos de actividades inicializado');
}

module.exports = { initTaskReportsCron, initTeamReportsCron, initSlaCron, initActivityDueDateCron };
